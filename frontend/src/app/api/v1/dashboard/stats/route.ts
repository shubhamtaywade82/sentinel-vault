// GET /api/v1/dashboard/stats → 200 { ...DashboardStats }
// admin only. Optional ?workspaceId= filter.
// KPIs: totalSecrets, activeConnections, pendingRotations (runs pending or
// running), reauthRequired (connections reauth_required), auditEvents24h,
// activeClients, totalClients, totalWorkspaces. Plus expiringSoon: merge
// connection.accessExpiresAt and secret.expiresAt (where in the future),
// take 6 sorted asc.
import { handle, json, adminOrThrow } from '@/lib/vault/api-helpers'
import { db } from '@/lib/db'

export const GET = handle(async (req) => {
  await adminOrThrow(req)
  const workspaceId = new URL(req.url).searchParams.get('workspaceId') || undefined

  const connWhere = workspaceId ? { workspaceId } : {}
  const secretWhere = workspaceId ? { workspaceId } : {}
  const eventWhere = workspaceId ? { workspaceId } : {}
  const clientWhere = workspaceId ? { workspaceId } : {}

  const now = new Date()
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)

  const [
    totalSecrets,
    activeConnections,
    pendingRotations,
    reauthRequired,
    auditEvents24h,
    activeClients,
    totalClients,
    totalWorkspaces,
  ] = await Promise.all([
    db.vaultSecret.count({ where: secretWhere }),
    db.integrationConnection.count({ where: { ...connWhere, status: 'active' } }),
    db.rotationRun.count({ where: { status: { in: ['pending', 'running'] } } }),
    db.integrationConnection.count({ where: { ...connWhere, status: 'reauth_required' } }),
    db.secretAccessEvent.count({ where: { ...eventWhere, createdAt: { gte: twentyFourHoursAgo } } }),
    db.serviceClient.count({ where: { ...clientWhere, status: 'active' } }),
    db.serviceClient.count({ where: clientWhere }),
    db.workspace.count(),
  ])

  // Expiring soon: union connection.accessExpiresAt + secret.expiresAt that are
  // in the future. Take 6 sorted ascending by expiry.
  const soonExpiringConns = await db.integrationConnection.findMany({
    where: { ...connWhere, accessExpiresAt: { gt: now, not: null } },
    select: { id: true, providerKey: true, providerAccountRef: true, accessExpiresAt: true, status: true },
    take: 50,
  })
  const soonExpiringSecrets = await db.vaultSecret.findMany({
    where: { ...secretWhere, expiresAt: { gt: now, not: null } },
    select: { id: true, path: true, expiresAt: true, status: true },
    take: 50,
  })

  const merged: {
    id: string
    kind: 'connection' | 'secret'
    ref: string
    expiresAt: string
    status: string
  }[] = []
  for (const c of soonExpiringConns) {
    merged.push({
      id: c.id,
      kind: 'connection',
      ref: `${c.providerKey}${c.providerAccountRef ? '/' + c.providerAccountRef : ''}`,
      expiresAt: c.accessExpiresAt!.toISOString(),
      status: c.status,
    })
  }
  for (const s of soonExpiringSecrets) {
    merged.push({
      id: s.id,
      kind: 'secret',
      ref: s.path,
      expiresAt: s.expiresAt!.toISOString(),
      status: s.status,
    })
  }
  merged.sort((a, b) => a.expiresAt.localeCompare(b.expiresAt))

  return json({
    totalSecrets,
    activeConnections,
    pendingRotations,
    reauthRequired,
    auditEvents24h,
    activeClients,
    totalClients,
    totalWorkspaces,
    expiringSoon: merged.slice(0, 6),
  })
})
