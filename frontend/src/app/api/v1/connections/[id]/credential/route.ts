// POST /api/v1/connections/[id]/credential → 200 noStore { credential }
// admin OR client with `value:read` grant on the bound secret for that purpose.
// Resolves the binding's current active version, decrypts (audited as
// `connection.credential`). If the connection accessExpiresAt is past AND
// refreshable AND refreshAfter is due, refresh first, then resolve the new
// version. Returns the access_token value (plaintext) — never other bindings.
import { handle, noStore, body, actor, getRequestId, getSourceIp } from '@/lib/vault/api-helpers'
import { db } from '@/lib/db'
import { VaultError } from '@/lib/vault/errors'
import { checkGrant } from '@/lib/vault/authorization'
import { decryptValue } from '@/lib/vault/crypto'
import { refreshConnection } from '@/lib/vault/refresh'
import { recordEvent, recordEventCritical } from '@/lib/vault/audit'

const ACCESS_TOKEN_PURPOSE = 'access_token'

export const POST = handle(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params
  const auth = await actor(req)
  if (auth.kind === 'none') throw new VaultError('unauthorized')

  const conn = await db.integrationConnection.findUnique({ where: { id } })
  if (!conn) throw new VaultError('connection_not_found')

  let purpose = ACCESS_TOKEN_PURPOSE
  try {
    const parsed = await body<{ purpose?: string }>(req)
    if (parsed.purpose) purpose = parsed.purpose.trim() || ACCESS_TOKEN_PURPOSE
  } catch {
    /* ignore — empty body */
  }

  const binding = await db.connectionSecretBinding.findFirst({
    where: { connectionId: id, purpose },
  })
  if (!binding) {
    throw new VaultError('resource_not_found', `no binding for purpose "${purpose}" on this connection`)
  }

  if (auth.kind === 'client') {
    if (auth.client.workspaceId !== conn.workspaceId) throw new VaultError('connection_not_found')
    const ok = await checkGrant(auth.client.id, binding.vaultSecretId, 'value:read')
    if (!ok) throw new VaultError('grant_required', `Missing grant: value:read on ${binding.vaultSecretId}`)
  }

  const requestId = getRequestId(req)
  const sourceIp = getSourceIp(req)

  // Auto-refresh if the access is expired AND the connection is refreshable
  // (refreshAfter <= now) — the runtime path demo.
  let refreshed = false
  const now = new Date()
  const isExpired = conn.accessExpiresAt ? conn.accessExpiresAt.getTime() <= now.getTime() : false
  const refreshDue = conn.refreshAfter ? conn.refreshAfter.getTime() <= now.getTime() : false
  if (isExpired && refreshDue && conn.status === 'active') {
    try {
      await refreshConnection(id, {
        actorClientId: auth.kind === 'client' ? auth.client.id : null,
        requestId,
      })
      refreshed = true
    } catch (e) {
      console.warn('[vault][credential] auto-refresh failed:', e instanceof Error ? e.message : String(e))
    }
  }

  // Reload connection to get the freshest refreshGeneration / accessExpiresAt.
  const freshConn = (await db.integrationConnection.findUnique({ where: { id } })) ?? conn

  // Resolve the binding's current active version.
  const secret = await db.vaultSecret.findUnique({ where: { id: binding.vaultSecretId } })
  if (!secret || !secret.currentVersionId) throw new VaultError('version_not_found')
  const version = await db.secretVersion.findUnique({ where: { id: secret.currentVersionId } })
  if (!version) throw new VaultError('version_not_found')

  const aad = {
    workspaceId: secret.workspaceId,
    vaultSecretId: secret.id,
    versionNumber: version.versionNumber,
  }
  const value = await decryptValue(
    { ciphertext: version.ciphertext, encryptedDataKey: version.encryptedDataKey, kmsKeyRef: version.kmsKeyRef },
    aad,
    {
      secretVersionId: version.id,
      actorClientId: auth.kind === 'client' ? auth.client.id : null,
      requestId,
    },
  )

  await recordEventCritical({
    workspaceId: freshConn.workspaceId,
    actorClientId: auth.kind === 'client' ? auth.client.id : null,
    vaultSecretId: secret.id,
    secretVersionId: version.id,
    action: 'connection.credential',
    requestId,
    sourceIp,
  })

  return noStore({
    credential: {
      value,
      expiresAt: freshConn.accessExpiresAt ? freshConn.accessExpiresAt.toISOString() : null,
      generation: freshConn.refreshGeneration,
      refreshed,
      versionId: version.id,
    },
  })
})
