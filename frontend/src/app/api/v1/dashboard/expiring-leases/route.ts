// GET /api/v1/dashboard/expiring-leases?workspaceId= → 200 { leases }
// admin only. Returns active SecretLease rows expiring within the next hour,
// including any stale active-but-already-expired leases (which should have
// been cleaned up by the opportunistic GC pass that runs as part of this
// request — the response still surfaces them so the operator sees what was
// stale, before the GC transitioned them to status="expired").
//
// For each lease: join the vaultSecretId → secret path + name, and the
// serviceClientId → client name. SecretLease has no Prisma relations
// declared (per R1-backend note), so we resolve via separate queries
// (load all needed secret ids + client ids, fetch them, build maps).
//
// secondsRemaining = max(0, floor((expiresAt - now) / 1000))
// status = "expiring" if secondsRemaining > 0, "expired" if <= 0
// Ordered by expiresAt asc (soonest first). Limit to 10.
// Audit `dashboard.expiring-leases`. Value-free.
import {
  handle,
  json,
  adminOrThrow,
  getRequestId,
  getSourceIp,
} from '@/lib/vault/api-helpers'
import { db } from '@/lib/db'
import { recordEvent } from '@/lib/vault/audit'
import type { ExpiringLeaseRow } from '@/lib/vault/types'

export const GET = handle(async (req) => {
  await adminOrThrow(req)
  const workspaceId = new URL(req.url).searchParams.get('workspaceId') || undefined

  const now = new Date()
  const oneHourAhead = new Date(now.getTime() + 60 * 60 * 1000)

  // 0. Resolve the workspace-scoped set of vault secret IDs (so leases can
  //    be filtered even though SecretLease has no workspaceId column).
  let secretIdFilter: string[] | null = null
  if (workspaceId) {
    const secretsInWs = await db.vaultSecret.findMany({
      where: { workspaceId },
      select: { id: true },
    })
    secretIdFilter = secretsInWs.map((s) => s.id)
    if (secretIdFilter.length === 0) {
      await recordEvent({
        workspaceId: workspaceId ?? null,
        actorClientId: null,
        action: 'dashboard.expiring-leases',
        outcome: 'success',
        requestId: getRequestId(req),
        sourceIp: getSourceIp(req),
      })
      return json({ leases: [] })
    }
  }

  // 1. Query active leases expiring within the next hour OR already expired
  //    but still active (stale). Both are subsets of `expiresAt < now+1h`.
  //    (No lower bound on expiresAt — captures stale ones.)
  const leases = await db.secretLease.findMany({
    where: {
      status: 'active',
      expiresAt: { lt: oneHourAhead },
      ...(secretIdFilter
        ? { vaultSecretId: { in: secretIdFilter } }
        : {}),
    },
    orderBy: { expiresAt: 'asc' },
    take: 50, // fetch a few extra; we'll cap to 10 after enrichment.
  })

  // 2. Opportunistic GC: mark any active-but-expired leases as status="expired".
  //    Runs AFTER the query so the response still surfaces the stale ones for
  //    operator visibility. If the module import fails (not expected in this
  //    build), skip gracefully — the rest of the response is unaffected.
  try {
    const mod = (await import('@/lib/vault/leases')) as {
      cleanupExpiredLeases?: () => Promise<number>
    }
    if (typeof mod.cleanupExpiredLeases === 'function') {
      await mod.cleanupExpiredLeases()
    }
  } catch {
    // Module not found or cleanup threw — skip gracefully.
  }

  // 3. Resolve secret path+name and client name via separate queries (no
  //    Prisma relations on SecretLease per R1-backend note). Build lookup maps.
  const secretIds = Array.from(new Set(leases.map((l) => l.vaultSecretId)))
  const clientIds = Array.from(new Set(leases.map((l) => l.serviceClientId)))

  const [secrets, clients] = await Promise.all([
    secretIds.length > 0
      ? db.vaultSecret.findMany({
          where: { id: { in: secretIds } },
          select: { id: true, path: true, name: true },
        })
      : Promise.resolve([]),
    clientIds.length > 0
      ? db.serviceClient.findMany({
          where: { id: { in: clientIds } },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
  ])
  const secretById = new Map(secrets.map((s) => [s.id, s]))
  const clientById = new Map(clients.map((c) => [c.id, c.name]))

  // 4. Build response rows.
  const rows: ExpiringLeaseRow[] = leases.map((l) => {
    const expiresAtMs = l.expiresAt.getTime()
    const secondsRemaining = Math.max(0, Math.floor((expiresAtMs - now.getTime()) / 1000))
    const status: 'expiring' | 'expired' = secondsRemaining > 0 ? 'expiring' : 'expired'
    const secret = secretById.get(l.vaultSecretId)
    return {
      leaseId: l.id,
      secretPath: secret?.path ?? '',
      secretName: secret?.name ?? '',
      clientName: clientById.get(l.serviceClientId) ?? '',
      expiresAt: l.expiresAt.toISOString(),
      secondsRemaining,
      status,
    }
  })

  // 5. Order by expiresAt asc (soonest first), cap at 10. (Query already
  //    returned in this order, but re-sort post-enrichment to be safe.)
  rows.sort((a, b) => a.expiresAt.localeCompare(b.expiresAt))
  const capped = rows.slice(0, 10)

  // 6. Audit (value-free — no secret material referenced).
  await recordEvent({
    workspaceId: workspaceId ?? null,
    actorClientId: null,
    action: 'dashboard.expiring-leases',
    outcome: 'success',
    requestId: getRequestId(req),
    sourceIp: getSourceIp(req),
  })

  return json({ leases: capped })
})
