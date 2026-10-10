// GET /api/v1/secrets/[id]/events → 200 { events: AuditEventListItem[] }
// Per-secret activity timeline. `?limit=50` (capped at 200).
// admin; client with any grant on the secret. Returns audit events where
// `vaultSecretId = id`, ordered `createdAt desc`, limit 50. Joins
// actorClient.name + vaultSecret.path (same shape as /audit_events).
import { handle, json, actor, asInt, query } from '@/lib/vault/api-helpers'
import { db } from '@/lib/db'
import { VaultError } from '@/lib/vault/errors'

export const GET = handle(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params
  const auth = await actor(req)
  if (auth.kind === 'none') throw new VaultError('unauthorized')

  const secret = await db.vaultSecret.findUnique({ where: { id } })
  if (!secret) throw new VaultError('secret_not_found')

  if (auth.kind === 'client') {
    if (auth.client.workspaceId !== secret.workspaceId) {
      throw new VaultError('secret_access_denied')
    }
    // Client must have ANY grant on the secret to read its activity timeline.
    const grant = await db.secretAccessGrant.findFirst({
      where: { serviceClientId: auth.client.id, vaultSecretId: id },
    })
    if (!grant) throw new VaultError('secret_access_denied')
  }

  const limit = Math.min(asInt(query(req).get('limit'), 50), 200)

  const rows = await db.secretAccessEvent.findMany({
    where: { vaultSecretId: id },
    include: {
      actorClient: { select: { name: true } },
      vaultSecret: { select: { path: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })

  const events = rows.map((e) => ({
    id: e.id,
    workspaceId: e.workspaceId,
    actorClientId: e.actorClientId,
    actorClientName: e.actorClient?.name ?? null,
    vaultSecretId: e.vaultSecretId,
    secretPath: e.vaultSecret?.path ?? null,
    secretVersionId: e.secretVersionId,
    action: e.action,
    outcome: e.outcome as 'success' | 'denied' | 'error',
    reasonCode: e.reasonCode,
    requestId: e.requestId,
    sourceIp: e.sourceIp,
    createdAt: e.createdAt.toISOString(),
  }))

  return json({ events })
})
