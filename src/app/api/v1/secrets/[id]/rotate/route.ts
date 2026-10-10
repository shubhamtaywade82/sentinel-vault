// POST /api/v1/secrets/[id]/rotate → 201 { version }
// admin OR `rotate` grant. Body { value?, expiresInHours?, createdByClientId? }.
// If `value` provided use it; otherwise synthesize a kind-appropriate random.
// Create new version (max+1), retire prior active, advance currentVersionId+expiresAt.
import { handle, json, body, actor, getRequestId, getSourceIp } from '@/lib/vault/api-helpers'
import { db } from '@/lib/db'
import { VaultError, assert } from '@/lib/vault/errors'
import { encryptValue } from '@/lib/vault/crypto'
import { checkGrant } from '@/lib/vault/authorization'
import { recordEvent, recordEventCritical, recordEventInTx } from '@/lib/vault/audit'
import { randomBytes } from 'node:crypto'

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex')
}

function syntheticValue(kind: string): string {
  switch (kind) {
    case 'access_token':
      return `ACC_${randomHex(24)}`
    case 'refresh_token':
      return `RFT_${randomHex(24)}`
    case 'api_key':
      return `KEY_${randomHex(20)}`
    case 'client_secret':
      return `SEC_${randomHex(24)}`
    case 'totp_seed':
      return randomBytes(20).toString('base64')
    case 'private_key':
      return `-----BEGIN PRIVATE KEY-----\n${randomHex(64)}\n-----END PRIVATE KEY-----`
    case 'certificate':
      return `-----BEGIN CERTIFICATE-----\n${randomHex(64)}\n-----END CERTIFICATE-----`
    case 'connection_string':
      return `postgresql://user:${randomHex(16)}@db.internal:5432/prod`
    case 'public_key':
      return `-----BEGIN PUBLIC KEY-----\n${randomHex(32)}\n-----END PUBLIC KEY-----`
    default:
      return `ROT_${randomHex(16)}`
  }
}

function serializeVersion(v: {
  id: string
  vaultSecretId: string
  versionNumber: number
  status: string
  cryptoScheme: string
  kmsKeyRef: string
  createdBy: string
  activatedAt: Date
  retiredAt: Date | null
  createdAt: Date
}) {
  return {
    id: v.id,
    vaultSecretId: v.vaultSecretId,
    versionNumber: v.versionNumber,
    status: v.status,
    cryptoScheme: v.cryptoScheme,
    kmsKeyRef: v.kmsKeyRef,
    createdBy: v.createdBy,
    activatedAt: v.activatedAt.toISOString(),
    retiredAt: v.retiredAt ? v.retiredAt.toISOString() : null,
    createdAt: v.createdAt.toISOString(),
  }
}

export const POST = handle(
  async (req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params
    const auth = await actor(req)
    if (auth.kind === 'none') throw new VaultError('unauthorized')

    const secret = await db.vaultSecret.findUnique({ where: { id } })
    if (!secret) throw new VaultError('secret_not_found')

    if (auth.kind === 'client') {
      if (auth.client.workspaceId !== secret.workspaceId) throw new VaultError('secret_access_denied')
      const ok = await checkGrant(auth.client.id, id, 'rotate')
      if (!ok) throw new VaultError('grant_required', 'Missing grant: rotate on ' + id)
    }

    const input = await body<{ value?: string; expiresInHours?: number; createdByClientId?: string }>(req)
    const value = (input.value ?? '').trim() || syntheticValue(secret.kind)
    assert(value.length > 0, 'validation_failed', 'rotated value must not be empty')

    const now = new Date()
    const createdBy = (input.createdByClientId || (auth.kind === 'client' ? auth.client.id : 'admin')).trim()
    const expiresAt =
      typeof input.expiresInHours === 'number' && input.expiresInHours > 0
        ? new Date(now.getTime() + input.expiresInHours * 60 * 60 * 1000)
        : secret.expiresAt

    const version = await db.$transaction(async (tx) => {
      const last = await tx.secretVersion.findFirst({
        where: { vaultSecretId: id },
        orderBy: { versionNumber: 'desc' },
      })
      const nextVersionNumber = (last?.versionNumber ?? 0) + 1

      const aad = { workspaceId: secret.workspaceId, vaultSecretId: id, versionNumber: nextVersionNumber }
      const enc = await encryptValue(value, aad)

      const newVersion = await tx.secretVersion.create({
        data: {
          vaultSecretId: id,
          versionNumber: nextVersionNumber,
          ciphertext: enc.ciphertext,
          encryptedDataKey: enc.encryptedDataKey,
          kmsKeyRef: enc.kmsKeyRef,
          cryptoScheme: enc.cryptoScheme,
          status: 'active',
          createdBy,
          activatedAt: now,
        },
      })

      if (last && last.status === 'active') {
        await tx.secretVersion.update({
          where: { id: last.id },
          data: { status: 'retired', retiredAt: now },
        })
      }

      await tx.vaultSecret.update({
        where: { id },
        data: { currentVersionId: newVersion.id, expiresAt, updatedAt: now },
      })

      // Transactional-outbox audit: persist the `secret.rotate` SUCCESS audit
      // inside the same transaction as the new version + retirement. If the
      // audit write fails, the whole transaction rolls back (no unaudited
      // rotation). If both succeed, they commit together — atomic (R13-outbox).
      await recordEventInTx(tx, {
        workspaceId: secret.workspaceId,
        actorClientId: auth.kind === 'client' ? auth.client.id : null,
        vaultSecretId: id,
        secretVersionId: newVersion.id,
        action: 'secret.rotate',
        requestId: getRequestId(req),
        sourceIp: getSourceIp(req),
      })

      return newVersion
    })

    return json({ version: serializeVersion(version) }, 201)
  },
  // Tight rate limit — rotation mutates the active secret version. 30 req/min
  // per (token, IP) key to throttle brute-force rotation / abuse.
  { rateLimitOpts: { requestsPerMinute: 30, burst: 30 } },
)
