// /api/v1/secrets/[id]/versions — admin OR client with appropriate grant.
// GET  → 200 { versions: SecretVersionRow[] }   (admin OR `metadata:read` grant)
// POST → 201 { version }                        (admin OR `version:create` grant)
//   body { value, expiresInHours?, createdByClientId? }
//   Creates a new version (versionNumber = max+1), retires prior active.
import { handle, json, body, actor, getRequestId, getSourceIp } from '@/lib/vault/api-helpers'
import { db } from '@/lib/db'
import { VaultError, assert } from '@/lib/vault/errors'
import { encryptValue } from '@/lib/vault/crypto'
import { checkGrant } from '@/lib/vault/authorization'
import { recordEvent, recordEventCritical, recordEventInTx } from '@/lib/vault/audit'

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

export const GET = handle(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params
  const auth = await actor(req)
  if (auth.kind === 'none') throw new VaultError('unauthorized')

  const secret = await db.vaultSecret.findUnique({ where: { id } })
  if (!secret) throw new VaultError('secret_not_found')

  if (auth.kind === 'client') {
    if (auth.client.workspaceId !== secret.workspaceId) throw new VaultError('secret_access_denied')
    const hasMeta = await checkGrant(auth.client.id, id, 'metadata:read')
    const hasValue = await checkGrant(auth.client.id, id, 'value:read')
    if (!hasMeta && !hasValue) throw new VaultError('secret_access_denied')
  }

  const versions = await db.secretVersion.findMany({
    where: { vaultSecretId: id },
    orderBy: { versionNumber: 'desc' },
  })
  return json({ versions: versions.map(serializeVersion) })
})

export const POST = handle(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params
  const auth = await actor(req)
  if (auth.kind === 'none') throw new VaultError('unauthorized')

  const secret = await db.vaultSecret.findUnique({ where: { id } })
  if (!secret) throw new VaultError('secret_not_found')

  if (auth.kind === 'client') {
    if (auth.client.workspaceId !== secret.workspaceId) throw new VaultError('secret_access_denied')
    const ok = await checkGrant(auth.client.id, id, 'version:create')
    if (!ok) throw new VaultError('grant_required', 'Missing grant: version:create on ' + id)
  }

  const input = await body<{ value?: string; expiresInHours?: number; createdByClientId?: string }>(req)
  const value = input.value ?? ''
  assert(typeof value === 'string' && value.length > 0, 'validation_failed', 'value is required (non-empty string)')

  const now = new Date()
  const createdBy = (input.createdByClientId || (auth.kind === 'client' ? auth.client.id : 'admin')).trim()
  const expiresAt =
    typeof input.expiresInHours === 'number' && input.expiresInHours > 0
      ? new Date(now.getTime() + input.expiresInHours * 60 * 60 * 1000)
      : null

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

    // Transactional-outbox audit: persist the `secret.version.create` SUCCESS
    // audit inside the same transaction as the new version + retirement. If
    // the audit write fails, the whole transaction rolls back (no unaudited
    // new version). If both succeed, they commit together — atomic (R13-outbox).
    await recordEventInTx(tx, {
      workspaceId: secret.workspaceId,
      actorClientId: auth.kind === 'client' ? auth.client.id : null,
      vaultSecretId: id,
      secretVersionId: newVersion.id,
      action: 'secret.version.create',
      requestId: getRequestId(req),
      sourceIp: getSourceIp(req),
    })

    return newVersion
  })

  return json({ version: serializeVersion(version) }, 201)
})
