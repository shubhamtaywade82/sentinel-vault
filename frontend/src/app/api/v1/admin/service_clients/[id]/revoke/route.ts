// POST /api/v1/admin/service_clients/[id]/revoke → 200 { client: {..., status:"revoked", revokedAt } }
import { handle, json, adminOrThrow, getRequestId, getSourceIp } from '@/lib/vault/api-helpers'
import { db } from '@/lib/db'
import { VaultError } from '@/lib/vault/errors'
import { recordEvent, recordEventCritical } from '@/lib/vault/audit'

function serializeClient(c: {
  id: string
  workspaceId: string
  publicId: string
  name: string
  clientType: string
  credentialDigest: string
  credentialPrefix: string
  status: string
  expiresAt: Date | null
  lastUsedAt: Date | null
  revokedAt: Date | null
  createdAt: Date
  updatedAt: Date
}) {
  return {
    id: c.id,
    workspaceId: c.workspaceId,
    publicId: c.publicId,
    name: c.name,
    clientType: c.clientType,
    credentialDigest: c.credentialDigest,
    credentialPrefix: c.credentialPrefix,
    status: c.status,
    expiresAt: c.expiresAt ? c.expiresAt.toISOString() : null,
    lastUsedAt: c.lastUsedAt ? c.lastUsedAt.toISOString() : null,
    revokedAt: c.revokedAt ? c.revokedAt.toISOString() : null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  }
}

export const POST = handle(
  async (req, ctx: { params: Promise<{ id: string }> }) => {
    await adminOrThrow(req)
    const { id } = await ctx.params
    const existing = await db.serviceClient.findUnique({ where: { id } })
    if (!existing) throw new VaultError('client_not_found')

    const now = new Date()
    const updated = await db.serviceClient.update({
      where: { id },
      data: { status: 'revoked', revokedAt: now, updatedAt: now },
    })

    await recordEventCritical({
      workspaceId: updated.workspaceId,
      actorClientId: updated.id,
      action: 'client.revoke',
      requestId: getRequestId(req),
      sourceIp: getSourceIp(req),
    })

    return json({ client: serializeClient(updated) })
  },
  // Tight rate limit — revoking a service-client credential immediately
  // invalidates that client's auth. 30 req/min per (token, IP) key to throttle
  // accidental / abusive mass-revocation of clients.
  { rateLimitOpts: { requestsPerMinute: 30, burst: 30 } },
)
