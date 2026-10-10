// POST /api/v1/secrets/[id]/reveal → 200 noStore { secret, version, value }
// admin realm:  requires `admin_reveal_ok=true` query param (UI confirm flow).
// client realm: requires `value:read` grant.
// Audit `secret.reveal` with success/denied outcome.
import { handle, noStore, body, actor, getRequestId, getSourceIp } from '@/lib/vault/api-helpers'
import { db } from '@/lib/db'
import { VaultError } from '@/lib/vault/errors'
import { decryptValue } from '@/lib/vault/crypto'
import { checkGrant } from '@/lib/vault/authorization'
import { recordEvent, recordEventCritical } from '@/lib/vault/audit'

function serializeSecret(s: {
  id: string
  workspaceId: string
  path: string
  name: string
  kind: string
  classification: string
  environment: string
  provider: string | null
  status: string
  expiresAt: Date | null
  currentVersionId: string | null
  createdAt: Date
  updatedAt: Date
}) {
  return {
    id: s.id,
    workspaceId: s.workspaceId,
    path: s.path,
    name: s.name,
    kind: s.kind,
    classification: s.classification,
    environment: s.environment,
    provider: s.provider,
    status: s.status,
    expiresAt: s.expiresAt ? s.expiresAt.toISOString() : null,
    currentVersionId: s.currentVersionId,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
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

    const requestId = getRequestId(req)
    const sourceIp = getSourceIp(req)
    // Body is optional (may contain `reason`); ignore parse failures.
    let reason: string | undefined
    try {
      const parsed = await body<{ reason?: string }>(req)
      reason = parsed.reason
    } catch {
      /* ignore — empty body is fine */
    }

    // Authorization
    let denied = false
    if (auth.kind === 'admin') {
      const ok = new URL(req.url).searchParams.get('admin_reveal_ok') === 'true'
      if (!ok) denied = true
    } else if (auth.kind === 'client') {
      if (auth.client.workspaceId !== secret.workspaceId) denied = true
      else {
        const ok = await checkGrant(auth.client.id, id, 'value:read')
        if (!ok) denied = true
      }
    }

    if (denied) {
      await recordEvent({
        workspaceId: secret.workspaceId,
        actorClientId: auth.kind === 'client' ? auth.client.id : null,
        vaultSecretId: id,
        action: 'secret.reveal',
        outcome: 'denied',
        reasonCode: auth.kind === 'admin' ? 'admin_reveal_required' : 'value:read',
        requestId,
        sourceIp,
      })
      if (auth.kind === 'admin') {
        throw new VaultError('admin_required', 'admin reveal requires admin_reveal_ok=true query flag')
      }
      throw new VaultError('grant_required', 'Missing grant: value:read on ' + id)
    }

    if (!secret.currentVersionId) throw new VaultError('version_not_found')
    const version = await db.secretVersion.findUnique({ where: { id: secret.currentVersionId } })
    if (!version) throw new VaultError('version_not_found')

    const aad = { workspaceId: secret.workspaceId, vaultSecretId: id, versionNumber: version.versionNumber }
    const value = await decryptValue(
      { ciphertext: version.ciphertext, encryptedDataKey: version.encryptedDataKey, kmsKeyRef: version.kmsKeyRef },
      aad,
      {
        secretVersionId: version.id,
        actorClientId: auth.kind === 'client' ? auth.client.id : null,
        requestId,
      },
    )

    // SECURITY (R12): reveal is a privileged operation — the audit record MUST
    // be durably persisted. Use recordEventCritical (fail-closed) so a failed
    // audit write refuses the reveal rather than proceeding without a record.
    await recordEventCritical({
      workspaceId: secret.workspaceId,
      actorClientId: auth.kind === 'client' ? auth.client.id : null,
      vaultSecretId: id,
      secretVersionId: version.id,
      action: 'secret.reveal',
      outcome: 'success',
      reasonCode: reason ?? null,
      requestId,
      sourceIp,
    })

    return noStore({
      secret: serializeSecret(secret),
      version: serializeVersion(version),
      value,
    })
  },
  // Tight rate limit — reveal is a privileged read of plaintext. 30 req/min
  // per (token, IP) key to throttle brute-force / scraping of secret values.
  { rateLimitOpts: { requestsPerMinute: 30, burst: 30 } },
)
