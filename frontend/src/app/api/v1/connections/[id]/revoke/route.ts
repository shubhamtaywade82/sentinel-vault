// POST /api/v1/connections/[id]/revoke → 200 { connection }
// admin only. If adapter supports `revoke`, call it (best-effort). Set
// connection status="revoked".
import { handle, json, adminOrThrow, getRequestId, getSourceIp } from '@/lib/vault/api-helpers'
import { db } from '@/lib/db'
import { VaultError } from '@/lib/vault/errors'
import { getAdapter } from '@/lib/vault/providers'
import { recordEvent, recordEventCritical } from '@/lib/vault/audit'

function serializeConnection(c: {
  id: string
  workspaceId: string
  providerKey: string
  authMethod: string
  adapterKey: string
  providerAccountRef: string | null
  status: string
  accessExpiresAt: Date | null
  refreshAfter: Date | null
  lastRefreshedAt: Date | null
  refreshLeaseExpiresAt: Date | null
  refreshGeneration: number
  lastErrorCode: string | null
  reauthRequiredAt: Date | null
  createdAt: Date
  updatedAt: Date
}) {
  return {
    id: c.id,
    workspaceId: c.workspaceId,
    providerKey: c.providerKey,
    authMethod: c.authMethod,
    adapterKey: c.adapterKey,
    providerAccountRef: c.providerAccountRef,
    status: c.status,
    accessExpiresAt: c.accessExpiresAt ? c.accessExpiresAt.toISOString() : null,
    refreshAfter: c.refreshAfter ? c.refreshAfter.toISOString() : null,
    lastRefreshedAt: c.lastRefreshedAt ? c.lastRefreshedAt.toISOString() : null,
    refreshLeaseExpiresAt: c.refreshLeaseExpiresAt ? c.refreshLeaseExpiresAt.toISOString() : null,
    refreshGeneration: c.refreshGeneration,
    lastErrorCode: c.lastErrorCode,
    reauthRequiredAt: c.reauthRequiredAt ? c.reauthRequiredAt.toISOString() : null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  }
}

export const POST = handle(async (req, ctx: { params: Promise<{ id: string }> }) => {
  await adminOrThrow(req)
  const { id } = await ctx.params
  const conn = await db.integrationConnection.findUnique({ where: { id } })
  if (!conn) throw new VaultError('connection_not_found')

  // Best-effort adapter revoke if supported.
  try {
    const adapter = getAdapter(conn.adapterKey)
    if (adapter.revoke) {
      // Build a minimal bindings list. Adapters that use this typically don't
      // need to decrypt anything for revoke, but the API requires the closures.
      const bindingRows = await db.connectionSecretBinding.findMany({
        where: { connectionId: id },
        select: { purpose: true, vaultSecretId: true },
      })
      const secretIds = Array.from(new Set(bindingRows.map((b) => b.vaultSecretId)))
      const secrets = secretIds.length
        ? await db.vaultSecret.findMany({ where: { id: { in: secretIds } } })
        : []
      const secretById = new Map(secrets.map((s) => [s.id, s]))

      const connRow = {
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
      }

      await adapter.revoke({
        connection: connRow,
        bindings: bindingRows.map((b) => {
          const s = secretById.get(b.vaultSecretId)
          return {
            purpose: b.purpose,
            secret: s
              ? {
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
              : (null as unknown as never),
            decrypt: async () => {
              throw new VaultError('decryption_failed', 'decrypt not available during revoke')
            },
          }
        }),
      })
    }
  } catch (e) {
    console.warn('[vault][revoke] adapter revoke failed:', e instanceof Error ? e.message : String(e))
  }

  const now = new Date()
  const updated = await db.integrationConnection.update({
    where: { id },
    data: { status: 'revoked', updatedAt: now },
  })

  await recordEventCritical({
    workspaceId: conn.workspaceId,
    action: 'connection.revoke',
    requestId: getRequestId(req),
    sourceIp: getSourceIp(req),
  })

  return json({ connection: serializeConnection(updated) })
})
