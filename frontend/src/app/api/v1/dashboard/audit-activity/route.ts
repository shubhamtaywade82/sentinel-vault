// GET /api/v1/dashboard/audit-activity?workspaceId=&range=1h|24h|7d|30d
// admin only. Aggregates SecretAccessEvent rows in the requested time range
// into fixed-width buckets + a totals object. Powers the "Audit Activity"
// compliance drill-down panel.
//
// Range → (bucket width, bucket count) matrix:
//   1h  → 5-min buckets,  12 buckets (covers the last hour)
//   24h → 1-hour buckets, 24 buckets (covers the last day)
//   7d  → 6-hour buckets, 28 buckets (covers the last week)
//   30d → 1-day buckets,  30 buckets (covers the last 30 days)
//
// Buckets are emitted oldest → newest. Each bucket's `ts` is the ISO start
// of the bucket window (UTC).
//
// totals:
//   events    = total events in range
//   reveals   = events with action startsWith `secret.reveal`
//   rotations = events with action startsWith `secret.rotate` OR `refresh.succeeded`
//   denied    = events with outcome === 'denied'
//
// Audit `dashboard.audit-activity`. Value-free.
import {
  handle,
  json,
  adminOrThrow,
  getRequestId,
  getSourceIp,
} from '@/lib/vault/api-helpers'
import { db } from '@/lib/db'
import { recordEvent } from '@/lib/vault/audit'
import type { AuditActivityBucket, AuditActivityResponse, AuditRange } from '@/lib/vault/types'

const MIN_MS = 60 * 1000
const HOUR_MS = 60 * MIN_MS
const DAY_MS = 24 * HOUR_MS

const VALID_RANGES = new Set<AuditRange>(['1h', '24h', '7d', '30d'])

interface RangePlan {
  range: AuditRange
  start: Date
  bucketMs: number
  bucketCount: number
}

function planRange(range: AuditRange, now: Date): RangePlan {
  switch (range) {
    case '1h':
      return { range, start: new Date(now.getTime() - HOUR_MS), bucketMs: 5 * MIN_MS, bucketCount: 12 }
    case '24h':
      return { range, start: new Date(now.getTime() - DAY_MS), bucketMs: HOUR_MS, bucketCount: 24 }
    case '7d':
      return { range, start: new Date(now.getTime() - 7 * DAY_MS), bucketMs: 6 * HOUR_MS, bucketCount: 28 }
    case '30d':
      return { range, start: new Date(now.getTime() - 30 * DAY_MS), bucketMs: DAY_MS, bucketCount: 30 }
  }
}

export const GET = handle(async (req) => {
  await adminOrThrow(req)

  const sp = new URL(req.url).searchParams
  const workspaceId = sp.get('workspaceId') || undefined
  const rawRange = sp.get('range') || '24h'
  const range: AuditRange = VALID_RANGES.has(rawRange as AuditRange)
    ? (rawRange as AuditRange)
    : '24h'

  const now = new Date()
  const plan = planRange(range, now)
  const startMs = plan.start.getTime()

  // 1. Load all events in range (optionally workspace-scoped). We only need
  //    createdAt, action, outcome for the bucketing + totals, so select just
  //    those columns to keep the payload small even for 30d / busy vaults.
  const where: { createdAt: { gte: Date }; workspaceId?: string } = {
    createdAt: { gte: plan.start },
  }
  if (workspaceId) where.workspaceId = workspaceId

  const rows = await db.secretAccessEvent.findMany({
    where,
    select: { createdAt: true, action: true, outcome: true },
    orderBy: { createdAt: 'asc' },
  })

  // 2. Initialize N empty buckets (oldest → newest).
  const buckets: AuditActivityBucket[] = []
  for (let i = 0; i < plan.bucketCount; i++) {
    const bucketStart = new Date(startMs + i * plan.bucketMs)
    buckets.push({ ts: bucketStart.toISOString(), count: 0 })
  }

  // 3. Tally each event into its bucket + accumulate totals in one pass.
  let reveals = 0
  let rotations = 0
  let denied = 0
  for (const ev of rows) {
    // Assign to bucket index = floor((eventMs - startMs) / bucketMs). Clamp
    // to [0, bucketCount - 1] defensively — the `createdAt >= start` filter
    // means index should never go negative, but clock skew / DB rounding
    // could push an event past the upper edge by a hair.
    const idx = Math.min(
      plan.bucketCount - 1,
      Math.max(0, Math.floor((ev.createdAt.getTime() - startMs) / plan.bucketMs)),
    )
    buckets[idx].count++

    if (ev.action.startsWith('secret.reveal')) reveals++
    if (ev.action.startsWith('secret.rotate') || ev.action.startsWith('refresh.succeeded')) {
      rotations++
    }
    if (ev.outcome === 'denied') denied++
  }

  // 4. Audit (value-free — no secret material referenced).
  await recordEvent({
    workspaceId: workspaceId ?? null,
    actorClientId: null,
    action: 'dashboard.audit-activity',
    outcome: 'success',
    requestId: getRequestId(req),
    sourceIp: getSourceIp(req),
  })

  const response: AuditActivityResponse = {
    range: plan.range,
    buckets,
    totals: {
      events: rows.length,
      reveals,
      rotations,
      denied,
    },
  }
  return json(response)
})
