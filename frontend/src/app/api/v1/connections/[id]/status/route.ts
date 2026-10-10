// GET /api/v1/connections/[id]/status → 200 { connection: IntegrationConnectionRow }
// Auth: admin or client with access (same scoping as list — value:read or
// connection:refresh on a bound secret).
import { handle, json, actor } from '@/lib/vault/api-helpers'
import { db } from '@/lib/db'
import { VaultError } from '@/lib/vault/errors'
import { checkGrant } from '@/lib/vault/authorization'

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

export const GET = handle(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params
  const auth = await actor(req)
  if (auth.kind === 'none') throw new VaultError('unauthorized')

  const conn = await db.integrationConnection.findUnique({ where: { id } })
  if (!conn) throw new VaultError('connection_not_found')

  if (auth.kind === 'client') {
    if (auth.client.workspaceId !== conn.workspaceId) throw new VaultError('connection_not_found')
    const bindings = await db.connectionSecretBinding.findMany({
      where: { connectionId: id },
      select: { vaultSecretId: true },
    })
    let visible = false
    for (const b of bindings) {
      const vr = await checkGrant(auth.client.id, b.vaultSecretId, 'value:read')
      const cr = await checkGrant(auth.client.id, b.vaultSecretId, 'connection:refresh')
      if (vr || cr) {
        visible = true
        break
      }
    }
    if (!visible) throw new VaultError('connection_not_found')
  }

  return json({ connection: serializeConnection(conn) })
})
