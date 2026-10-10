// POST /api/v1/secrets/[id]/revoke → 200 { secret }
// admin OR `revoke` grant. Body { revokeUpstream? }.
// Marks secret status="revoked", retires the current active version. If
// `revokeUpstream` and the secret is bound to a connection whose adapter
// supports revoke, attempt provider-side revoke (best-effort).
import { handle, json, body, actor, getRequestId, getSourceIp } from '@/lib/vault/api-helpers'
import { db } from '@/lib/db'
import { VaultError } from '@/lib/vault/errors'
import { checkGrant } from '@/lib/vault/authorization'
import { getAdapter } from '@/lib/vault/providers'
import { decryptValue } from '@/lib/vault/crypto'
import { recordEvent, recordEventCritical, recordEventInTx } from '@/lib/vault/audit'

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

export const POST = handle(
  async (req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params
    const auth = await actor(req)
    if (auth.kind === 'none') throw new VaultError('unauthorized')

    const secret = await db.vaultSecret.findUnique({ where: { id } })
    if (!secret) throw new VaultError('secret_not_found')

    if (auth.kind === 'client') {
      if (auth.client.workspaceId !== secret.workspaceId) throw new VaultError('secret_access_denied')
      const ok = await checkGrant(auth.client.id, id, 'revoke')
      if (!ok) throw new VaultError('grant_required', 'Missing grant: revoke on ' + id)
    }

    let revokeUpstream = false
    try {
      const parsed = await body<{ revokeUpstream?: boolean }>(req)
      revokeUpstream = !!parsed.revokeUpstream
    } catch {
      /* ignore — empty body */
    }

    const now = new Date()

    // Transactional-outbox: retire the active version + set status=revoked +
    // persist the `secret.revoke` SUCCESS audit INSIDE one transaction so the
    // revocation and its audit commit atomically. A crash mid-flight can no
    // longer leave a revoked secret without a durable audit trail (R13-outbox).
    const updated = await db.$transaction(async (tx) => {
      if (secret.currentVersionId) {
        await tx.secretVersion.updateMany({
          where: { id: secret.currentVersionId, status: 'active' },
          data: { status: 'retired', retiredAt: now },
        })
      }
      const updatedSecret = await tx.vaultSecret.update({
        where: { id },
        data: { status: 'revoked', updatedAt: now },
      })
      await recordEventInTx(tx, {
        workspaceId: secret.workspaceId,
        actorClientId: auth.kind === 'client' ? auth.client.id : null,
        vaultSecretId: id,
        action: 'secret.revoke',
        requestId: getRequestId(req),
        sourceIp: getSourceIp(req),
      })
      return updatedSecret
    })

    // Best-effort upstream provider revoke if requested and the secret is bound
    // to a connection whose adapter supports revoke.
    if (revokeUpstream) {
      try {
        const bindings = await db.connectionSecretBinding.findMany({
          where: { vaultSecretId: id },
          select: { connectionId: true, purpose: true },
        })
        for (const b of bindings) {
          const conn = await db.integrationConnection.findUnique({ where: { id: b.connectionId } })
          if (!conn || conn.status === 'revoked') continue
          try {
            const adapter = getAdapter(conn.adapterKey)
            if (!adapter.revoke) continue
            // Build a minimal decrypt closure for this binding.
            const currentVersion = await db.secretVersion.findUnique({
              where: { id: secret.currentVersionId ?? '' },
            })
            await adapter.revoke({
              connection: {
                id: conn.id,
                workspaceId: conn.workspaceId,
                providerKey: conn.providerKey,
                authMethod: conn.authMethod,
                adapterKey: conn.adapterKey,
                providerAccountRef: conn.providerAccountRef,
                status: conn.status,
                accessExpiresAt: conn.accessExpiresAt ? conn.accessExpiresAt.toISOString() : null,
                refreshAfter: conn.refreshAfter ? conn.refreshAfter.toISOString() : null,
                lastRefreshedAt: conn.lastRefreshedAt ? conn.lastRefreshedAt.toISOString() : null,
                refreshLeaseExpiresAt: conn.refreshLeaseExpiresAt ? conn.refreshLeaseExpiresAt.toISOString() : null,
                refreshGeneration: conn.refreshGeneration,
                lastErrorCode: conn.lastErrorCode,
                reauthRequiredAt: conn.reauthRequiredAt ? conn.reauthRequiredAt.toISOString() : null,
                createdAt: conn.createdAt.toISOString(),
                updatedAt: conn.updatedAt.toISOString(),
              },
              bindings: [
                {
                  purpose: b.purpose,
                  secret: {
                    id: secret.id,
                    workspaceId: secret.workspaceId,
                    path: secret.path,
                    name: secret.name,
                    kind: secret.kind,
                    classification: secret.classification,
                    environment: secret.environment,
                    provider: secret.provider,
                    status: secret.status,
                    expiresAt: secret.expiresAt ? secret.expiresAt.toISOString() : null,
                    currentVersionId: secret.currentVersionId,
                    createdAt: secret.createdAt.toISOString(),
                    updatedAt: secret.updatedAt.toISOString(),
                  },
                  decrypt: async () => {
                    if (!currentVersion) throw new VaultError('version_not_found')
                    return await decryptValue(
                      {
                        ciphertext: currentVersion.ciphertext,
                        encryptedDataKey: currentVersion.encryptedDataKey,
                        kmsKeyRef: currentVersion.kmsKeyRef,
                      },
                      { workspaceId: secret.workspaceId, vaultSecretId: secret.id, versionNumber: currentVersion.versionNumber },
                      {
                        secretVersionId: currentVersion.id,
                        actorClientId: auth.kind === 'client' ? auth.client.id : null,
                      },
                    )
                  },
                },
              ],
            })
          } catch (e) {
            console.warn('[vault][revoke] provider revoke failed:', e instanceof Error ? e.message : String(e))
          }
        }
      } catch (e) {
        console.warn('[vault][revoke] upstream revoke lookup failed:', e instanceof Error ? e.message : String(e))
      }
    }

    return json({ secret: serializeSecret(updated) })
  },
  // Tight rate limit — revoke is a privileged destructive mutation. 30 req/min
  // per (token, IP) key to throttle accidental / abusive mass revocation.
  { rateLimitOpts: { requestsPerMinute: 30, burst: 30 } },
)
