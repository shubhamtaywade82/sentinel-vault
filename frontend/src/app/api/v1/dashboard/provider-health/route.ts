// GET /api/v1/dashboard/provider-health?workspaceId= → 200 { providers: [...] }
// admin only. Aggregates health metrics per unique (providerKey, adapterKey)
// combination in the (workspace-scoped) set of IntegrationConnections.
// Metrics: connection counts (total / active / reauth_required) + refresh-run
// counts (total / succeeded / failed / successRate) + lastRefreshAt +
// avgRefreshMs (from completedAt - startedAt on succeeded runs).
// Audit `dashboard.provider-health`. Value-free.
import {
  handle,
  json,
  adminOrThrow,
  getRequestId,
  getSourceIp,
} from '@/lib/vault/api-helpers'
import { db } from '@/lib/db'
import { recordEvent } from '@/lib/vault/audit'
import type { ProviderHealthRow } from '@/lib/vault/types'

export const GET = handle(async (req) => {
  await adminOrThrow(req)
  const workspaceId = new URL(req.url).searchParams.get('workspaceId') || undefined
  const connWhere = workspaceId ? { workspaceId } : {}

  // 1. Load all connections in scope (id + grouping keys + status + lastRefresh).
  const connections = await db.integrationConnection.findMany({
    where: connWhere,
    select: {
      id: true,
      providerKey: true,
      adapterKey: true,
      status: true,
      lastRefreshedAt: true,
    },
  })

  // 2. Build per-(providerKey, adapterKey) accumulators + a connectionId → accKey
  //    lookup map so we can bucket runs without re-scanning.
  type Acc = {
    providerKey: string
    adapterKey: string
    connectionIds: Set<string>
    totalConnections: number
    activeConnections: number
    reauthRequired: number
    lastRefreshedAt: Date | null
  }
  const accMap = new Map<string, Acc>()
  const connIdToAccKey = new Map<string, string>()
  const key = (p: string, a: string) => `${p}::${a}`

  for (const c of connections) {
    const k = key(c.providerKey, c.adapterKey)
    let acc = accMap.get(k)
    if (!acc) {
      acc = {
        providerKey: c.providerKey,
        adapterKey: c.adapterKey,
        connectionIds: new Set(),
        totalConnections: 0,
        activeConnections: 0,
        reauthRequired: 0,
        lastRefreshedAt: null,
      }
      accMap.set(k, acc)
    }
    acc.connectionIds.add(c.id)
    acc.totalConnections += 1
    if (c.status === 'active') acc.activeConnections += 1
    if (c.status === 'reauth_required') acc.reauthRequired += 1
    if (c.lastRefreshedAt) {
      if (!acc.lastRefreshedAt || c.lastRefreshedAt > acc.lastRefreshedAt) {
        acc.lastRefreshedAt = c.lastRefreshedAt
      }
    }
    connIdToAccKey.set(c.id, k)
  }

  // 3. Load refresh runs for the connection ids we just collected.
  const allConnIds = connections.map((c) => c.id)
  type RunRow = {
    connectionId: string | null
    status: string
    startedAt: Date | null
    completedAt: Date | null
  }
  let runs: RunRow[] = []
  if (allConnIds.length > 0) {
    runs = await db.rotationRun.findMany({
      where: {
        operation: 'refresh',
        connectionId: { in: allConnIds },
      },
      select: {
        connectionId: true,
        status: true,
        startedAt: true,
        completedAt: true,
      },
    })
  }

  // 4. Aggregate runs into the owning accumulator bucket.
  const runStats = new Map<
    string,
    { total: number; success: number; failed: number; durations: number[] }
  >()
  for (const r of runs) {
    if (!r.connectionId) continue
    const ownerKey = connIdToAccKey.get(r.connectionId)
    if (!ownerKey) continue
    let s = runStats.get(ownerKey)
    if (!s) {
      s = { total: 0, success: 0, failed: 0, durations: [] }
      runStats.set(ownerKey, s)
    }
    s.total += 1
    if (r.status === 'succeeded') {
      s.success += 1
      if (r.startedAt && r.completedAt) {
        s.durations.push(r.completedAt.getTime() - r.startedAt.getTime())
      }
    } else if (r.status === 'failed') {
      s.failed += 1
    }
  }

  // 5. Assemble the response rows.
  const rows: ProviderHealthRow[] = []
  for (const acc of accMap.values()) {
    const k = key(acc.providerKey, acc.adapterKey)
    const s = runStats.get(k)
    const totalRefreshes = s?.total ?? 0
    const successfulRefreshes = s?.success ?? 0
    const failedRefreshes = s?.failed ?? 0
    const successRate = totalRefreshes === 0 ? 1 : successfulRefreshes / totalRefreshes
    const durations = s?.durations ?? []
    const avgRefreshMs =
      durations.length > 0
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : null
    rows.push({
      providerKey: acc.providerKey,
      adapterKey: acc.adapterKey,
      totalConnections: acc.totalConnections,
      activeConnections: acc.activeConnections,
      reauthRequired: acc.reauthRequired,
      totalRefreshes,
      successfulRefreshes,
      failedRefreshes,
      successRate,
      lastRefreshAt: acc.lastRefreshedAt ? acc.lastRefreshedAt.toISOString() : null,
      avgRefreshMs,
    })
  }

  // Order by totalConnections desc, then providerKey asc.
  rows.sort((a, b) => {
    if (b.totalConnections !== a.totalConnections) {
      return b.totalConnections - a.totalConnections
    }
    return a.providerKey.localeCompare(b.providerKey)
  })

  // Audit (value-free — no secret material referenced).
  const requestId = getRequestId(req)
  const sourceIp = getSourceIp(req)
  await recordEvent({
    workspaceId: workspaceId ?? null,
    actorClientId: null,
    action: 'dashboard.provider-health',
    outcome: 'success',
    requestId,
    sourceIp,
  })

  return json({ providers: rows })
})
