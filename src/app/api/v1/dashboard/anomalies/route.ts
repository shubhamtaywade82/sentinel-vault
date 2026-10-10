// GET /api/v1/dashboard/anomalies?workspaceId=&range=24h
// admin only. Analyzes SecretAccessEvent rows in the requested time range for
// anomalous access patterns and returns up to 15 anomalies, ordered by
// severity (high → medium → low) then ts desc.
//
// Anomaly rules:
//   1. denied_spike (high)
//      ≥3 denied outcomes on the same secret by the same (actor, sourceIp)
//      in the range. One anomaly per (secret, actor, ip) group with ≥3.
//   2. new_ip (medium)
//      An actor accessing from a sourceIp they have NOT used in the 7 days
//      prior to the range start. One anomaly per (actor, sourceIp) pair —
//      the first occurrence in the range.
//   3. off_hours (low)
//      Access whose local hour ∈ [02, 05) (i.e. 02:00–05:00). One anomaly
//      per (secret, actor, day) to avoid spamming.
//   4. burst (medium)
//      ≥10 successful reads (`secret.reveal*` action with outcome=success)
//      on the same secret by the same actor within a 1-hour sliding window.
//      One anomaly per (secret, actor) per burst.
//   5. cross_workspace_attempt (high)
//      An actor (client) attempting to access a secret in a DIFFERENT
//      workspace (i.e. actorClient.workspaceId !== vaultSecret.workspaceId)
//      with outcome=denied. One anomaly per event (deduped per
//      actor + secret + workspace + day).
//
// Audit `dashboard.anomalies`. Value-free — no secret material referenced.
import {
  handle,
  json,
  adminOrThrow,
  getRequestId,
  getSourceIp,
} from '@/lib/vault/api-helpers'
import { db } from '@/lib/db'
import { recordEvent } from '@/lib/vault/audit'
import type {
  AnomalyRow,
  AnomaliesResponse,
  AuditRange,
} from '@/lib/vault/types'

const MIN_MS = 60 * 1000
const HOUR_MS = 60 * MIN_MS
const DAY_MS = 24 * HOUR_MS

const VALID_RANGES = new Set<AuditRange>(['1h', '24h', '7d', '30d'])

function rangeToMs(range: AuditRange): number {
  switch (range) {
    case '1h':
      return HOUR_MS
    case '24h':
      return DAY_MS
    case '7d':
      return 7 * DAY_MS
    case '30d':
      return 30 * DAY_MS
  }
}

const SEVERITY_RANK: Record<'high' | 'medium' | 'low', number> = {
  high: 0,
  medium: 1,
  low: 2,
}

interface RawEvent {
  id: string
  workspaceId: string | null
  actorClientId: string | null
  vaultSecretId: string | null
  action: string
  outcome: string
  sourceIp: string | null
  createdAt: Date
}

// Day key in YYYY-MM-DD form (UTC) for deduplication. We deliberately use
// UTC rather than local server time for deterministic grouping across hosts.
function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10)
}

// Format a Date as HH:MM (UTC) for the off_hours description. The "local"
// hour check uses getUTCHours for determinism (no actor TZ tracking yet).
function hhmm(d: Date): string {
  return d.toISOString().slice(11, 16)
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
  const rangeMs = rangeToMs(range)
  const rangeStart = new Date(now.getTime() - rangeMs)
  const baselineStart = new Date(rangeStart.getTime() - 7 * DAY_MS)

  // 1. Load all events in the range (optionally workspace-scoped).
  const where: { createdAt: { gte: Date }; workspaceId?: string } = {
    createdAt: { gte: rangeStart },
  }
  if (workspaceId) where.workspaceId = workspaceId

  const events: RawEvent[] = await db.secretAccessEvent.findMany({
    where,
    select: {
      id: true,
      workspaceId: true,
      actorClientId: true,
      vaultSecretId: true,
      action: true,
      outcome: true,
      sourceIp: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  })

  if (events.length === 0) {
    await recordEvent({
      workspaceId: workspaceId ?? null,
      actorClientId: null,
      action: 'dashboard.anomalies',
      outcome: 'success',
      requestId: getRequestId(req),
      sourceIp: getSourceIp(req),
    })
    const empty: AnomaliesResponse = { anomalies: [] }
    return json(empty)
  }

  // 2. Resolve all referenced actor + secret + workspace rows in parallel.
  const actorIds = new Set<string>()
  const secretIds = new Set<string>()
  const workspaceIds = new Set<string>()
  for (const e of events) {
    if (e.actorClientId) actorIds.add(e.actorClientId)
    if (e.vaultSecretId) secretIds.add(e.vaultSecretId)
    if (e.workspaceId) workspaceIds.add(e.workspaceId)
  }

  const [actorRows, secretRows, workspaceRows] = await Promise.all([
    actorIds.size === 0
      ? Promise.resolve([])
      : db.serviceClient.findMany({
          where: { id: { in: Array.from(actorIds) } },
          select: { id: true, name: true, workspaceId: true },
        }),
    secretIds.size === 0
      ? Promise.resolve([])
      : db.vaultSecret.findMany({
          where: { id: { in: Array.from(secretIds) } },
          select: { id: true, path: true, workspaceId: true },
        }),
    workspaceIds.size === 0
      ? Promise.resolve([])
      : db.workspace.findMany({
          where: { id: { in: Array.from(workspaceIds) } },
          select: { id: true, slug: true },
        }),
  ])

  const actorById = new Map<
    string,
    { name: string; workspaceId: string }
  >()
  for (const a of actorRows) {
    actorById.set(a.id, { name: a.name, workspaceId: a.workspaceId })
  }
  const secretById = new Map<
    string,
    { path: string; workspaceId: string }
  >()
  for (const s of secretRows) {
    secretById.set(s.id, { path: s.path, workspaceId: s.workspaceId })
  }
  const wsSlugById = new Map<string, string>()
  for (const w of workspaceRows) {
    wsSlugById.set(w.id, w.slug)
  }

  const actorName = (id: string | null): string | null => {
    if (!id) return null
    return actorById.get(id)?.name ?? null
  }
  const secretPath = (id: string | null): string | null => {
    if (!id) return null
    return secretById.get(id)?.path ?? null
  }

  const anomalies: AnomalyRow[] = []
  let seq = 0
  const nextId = () => `anom_${(seq++).toString(36).padStart(3, '0')}`

  // ---- Rule 1: denied_spike ----------------------------------------------
  // Group denied events by (vaultSecretId, actorClientId, sourceIp). For each
  // group with ≥3 events, emit one anomaly using the most-recent event in
  // that group as the canonical ts/actor/ip.
  type SpikeKey = string
  const spikeGroups = new Map<
    SpikeKey,
    {
      secretId: string | null
      actorId: string | null
      sourceIp: string | null
      count: number
      lastTs: Date
    }
  >()
  const spikeKey = (s: string | null, a: string | null, ip: string | null) =>
    `${s ?? '_'}::${a ?? '_'}::${ip ?? '_'}`
  for (const e of events) {
    if (e.outcome !== 'denied') continue
    const k = spikeKey(e.vaultSecretId, e.actorClientId, e.sourceIp)
    let g = spikeGroups.get(k)
    if (!g) {
      g = {
        secretId: e.vaultSecretId,
        actorId: e.actorClientId,
        sourceIp: e.sourceIp,
        count: 0,
        lastTs: e.createdAt,
      }
      spikeGroups.set(k, g)
    }
    g.count++
    if (e.createdAt > g.lastTs) g.lastTs = e.createdAt
  }
  for (const g of spikeGroups.values()) {
    if (g.count < 3) continue
    const path = secretPath(g.secretId) ?? 'unknown'
    const name = actorName(g.actorId) ?? 'unknown actor'
    const ip = g.sourceIp ?? 'unknown IP'
    anomalies.push({
      id: nextId(),
      type: 'denied_spike',
      severity: 'high',
      title: `Denied access spike on ${path}`,
      description: `${g.count} denied attempts by ${name} from ${ip}`,
      secretPath: path,
      actorName: actorName(g.actorId),
      sourceIp: g.sourceIp,
      ts: g.lastTs.toISOString(),
      metadata: {
        secretId: g.secretId,
        actorClientId: g.actorId,
        deniedCount: g.count,
      },
    })
  }

  // ---- Rule 2: new_ip ----------------------------------------------------
  // For each event in the range with actorClientId + sourceIp, check whether
  // the actor used that sourceIp in the 7-day baseline window BEFORE the range
  // start. If not → emit one anomaly (first occurrence in range per actor+ip).
  // To keep the baseline query bounded, we only look up sourceIps for actors
  // that appear in the range.
  const actorsInEvents = Array.from(actorIds)
  const baselineEvents =
    actorsInEvents.length === 0
      ? []
      : await db.secretAccessEvent.findMany({
          where: {
            createdAt: { gte: baselineStart, lt: rangeStart },
            actorClientId: { in: actorsInEvents },
          },
          select: { actorClientId: true, sourceIp: true },
        })
  const baselineIps = new Map<string, Set<string>>()
  for (const be of baselineEvents) {
    if (!be.actorClientId || !be.sourceIp) continue
    let s = baselineIps.get(be.actorClientId)
    if (!s) {
      s = new Set()
      baselineIps.set(be.actorClientId, s)
    }
    s.add(be.sourceIp)
  }
  const newIpSeen = new Set<string>()
  for (const e of events) {
    if (!e.actorClientId || !e.sourceIp) continue
    const seen = baselineIps.get(e.actorClientId)
    if (seen && seen.has(e.sourceIp)) continue
    const k = `${e.actorClientId}::${e.sourceIp}`
    if (newIpSeen.has(k)) continue
    newIpSeen.add(k)
    const path = secretPath(e.vaultSecretId) ?? 'unknown'
    const name = actorName(e.actorClientId) ?? 'unknown actor'
    anomalies.push({
      id: nextId(),
      type: 'new_ip',
      severity: 'medium',
      title: `New source IP for ${name}`,
      description: `First access from ${e.sourceIp} on ${path}`,
      secretPath: path,
      actorName: actorName(e.actorClientId),
      sourceIp: e.sourceIp,
      ts: e.createdAt.toISOString(),
      metadata: {
        actorClientId: e.actorClientId,
        secretId: e.vaultSecretId,
        baselineWindowDays: 7,
      },
    })
  }

  // ---- Rule 3: off_hours -------------------------------------------------
  // Local hour ∈ [02, 05). We use UTC hours since we have no actor TZ. Dedupe
  // per (secret, actor, day) so we don't spam the same combo.
  const offHoursSeen = new Set<string>()
  for (const e of events) {
    const hour = e.createdAt.getUTCHours()
    if (hour < 2 || hour >= 5) continue
    const dk = dayKey(e.createdAt)
    const k = `${e.vaultSecretId ?? '_'}::${e.actorClientId ?? '_'}::${dk}`
    if (offHoursSeen.has(k)) continue
    offHoursSeen.add(k)
    const path = secretPath(e.vaultSecretId) ?? 'unknown'
    const name = actorName(e.actorClientId) ?? 'unknown actor'
    anomalies.push({
      id: nextId(),
      type: 'off_hours',
      severity: 'low',
      title: `Off-hours access on ${path}`,
      description: `Access at ${hhmm(e.createdAt)} by ${name}`,
      secretPath: path,
      actorName: actorName(e.actorClientId),
      sourceIp: e.sourceIp,
      ts: e.createdAt.toISOString(),
      metadata: {
        secretId: e.vaultSecretId,
        actorClientId: e.actorClientId,
        hourUTC: hour,
      },
    })
  }

  // ---- Rule 4: burst -----------------------------------------------------
  // ≥10 successful reads on the same secret by the same actor within a 1-hour
  // sliding window. "read" = action startsWith `secret.reveal` OR `secret.read`.
  // We process per (secret, actor) group, then slide a window.
  const readsByPair = new Map<
    string,
    { ts: number; secretId: string; actorId: string }[]
  >()
  const pairKey = (s: string, a: string) => `${s}::${a}`
  for (const e of events) {
    if (e.outcome !== 'success') continue
    if (!e.actorClientId || !e.vaultSecretId) continue
    if (
      !e.action.startsWith('secret.reveal') &&
      !e.action.startsWith('secret.read')
    ) {
      continue
    }
    const k = pairKey(e.vaultSecretId, e.actorClientId)
    let arr = readsByPair.get(k)
    if (!arr) {
      arr = []
      readsByPair.set(k, arr)
    }
    arr.push({
      ts: e.createdAt.getTime(),
      secretId: e.vaultSecretId,
      actorId: e.actorClientId,
    })
  }
  for (const [k, arr] of readsByPair) {
    arr.sort((a, b) => a.ts - b.ts)
    let i = 0
    while (i < arr.length) {
      let j = i
      while (
        j + 1 < arr.length &&
        arr[j + 1].ts - arr[i].ts < HOUR_MS
      ) {
        j++
      }
      const count = j - i + 1
      if (count >= 10) {
        const { secretId, actorId, ts } = arr[i]
        const path = secretPath(secretId) ?? 'unknown'
        const name = actorName(actorId) ?? 'unknown actor'
        anomalies.push({
          id: nextId(),
          type: 'burst',
          severity: 'medium',
          title: `Access burst on ${path}`,
          description: `${count} reads in 1h by ${name}`,
          secretPath: path,
          actorName: actorName(actorId),
          sourceIp: null,
          ts: new Date(ts).toISOString(),
          metadata: {
            secretId,
            actorClientId: actorId,
            readCount: count,
            windowSeconds: HOUR_MS / 1000,
          },
        })
        // Skip past this window to avoid emitting overlapping bursts.
        i = j + 1
      } else {
        i++
      }
    }
    // Use `k` to avoid "unused" — pairKey returned from map iteration.
    void k
  }

  // ---- Rule 5: cross_workspace_attempt -----------------------------------
  // An actor (client) attempting to access a secret in a DIFFERENT workspace
  // (i.e. the actor's workspaceId ≠ the secret's workspaceId) with outcome=
  // 'denied'. Dedupe per (actor, secret, workspace, day) so a sustained
  // repeat offender doesn't dominate the list.
  const crossWsSeen = new Set<string>()
  for (const e of events) {
    if (e.outcome !== 'denied') continue
    if (!e.actorClientId || !e.vaultSecretId) continue
    const actor = actorById.get(e.actorClientId)
    const secret = secretById.get(e.vaultSecretId)
    if (!actor || !secret) continue
    if (actor.workspaceId === secret.workspaceId) continue
    const dk = dayKey(e.createdAt)
    const key = `${e.actorClientId}::${e.vaultSecretId}::${secret.workspaceId}::${dk}`
    if (crossWsSeen.has(key)) continue
    crossWsSeen.add(key)
    const path = secret.path
    const name = actor.name
    const wsSlug = wsSlugById.get(secret.workspaceId) ?? secret.workspaceId
    anomalies.push({
      id: nextId(),
      type: 'cross_workspace_attempt',
      severity: 'high',
      title: 'Cross-workspace access attempt',
      description: `${name} tried to access ${path} in workspace ${wsSlug}`,
      secretPath: path,
      actorName: name,
      sourceIp: e.sourceIp,
      ts: e.createdAt.toISOString(),
      metadata: {
        actorClientId: e.actorClientId,
        actorWorkspaceId: actor.workspaceId,
        secretId: e.vaultSecretId,
        secretWorkspaceId: secret.workspaceId,
        workspaceSlug: wsSlug,
      },
    })
  }

  // 3. Order by severity (high → medium → low), then ts desc.
  anomalies.sort((a, b) => {
    const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    if (s !== 0) return s
    return b.ts.localeCompare(a.ts)
  })

  const capped = anomalies.slice(0, 15)

  // 4. Audit (value-free — no secret material referenced).
  await recordEvent({
    workspaceId: workspaceId ?? null,
    actorClientId: null,
    action: 'dashboard.anomalies',
    outcome: 'success',
    requestId: getRequestId(req),
    sourceIp: getSourceIp(req),
  })

  const response: AnomaliesResponse = { anomalies: capped }
  return json(response)
})
