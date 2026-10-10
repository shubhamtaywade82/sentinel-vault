// GET /api/v1/audit_events → 200 { events: AuditEventListItem[] }
// admin only (clients get `admin_required` for MVP). Filtered by workspaceId,
// limit (default 100), offset (default 0), action (prefix match), outcome.
// Joined with actorClient.name and vaultSecret.path. Ordered by createdAt desc.
import { handle, json, adminOrThrow, asInt } from '@/lib/vault/api-helpers'
import { db } from '@/lib/db'

export const GET = handle(async (req) => {
  await adminOrThrow(req)

  const sp = new URL(req.url).searchParams
  const workspaceId = sp.get('workspaceId') || undefined
  const limit = Math.min(asInt(sp.get('limit'), 100), 500)
  const offset = asInt(sp.get('offset'), 0)
  const action = sp.get('action') || undefined
  const outcome = sp.get('outcome') || undefined

  const where: {
    workspaceId?: string
    action?: { startsWith?: string }
    outcome?: string
  } = {}
  if (workspaceId) where.workspaceId = workspaceId
  if (action) where.action = { startsWith: action }
  if (outcome) where.outcome = outcome

  const rows = await db.secretAccessEvent.findMany({
    where,
    include: {
      actorClient: { select: { name: true } },
      vaultSecret: { select: { path: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    skip: offset,
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
