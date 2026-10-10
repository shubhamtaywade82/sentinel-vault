// GET /api/v1/audit_events/export → 200 text/csv  (admin only)
// Streams a CSV with columns:
//   id,createdAt,actor,action,resource,outcome,reasonCode,requestId,sourceIp,workspaceId
// Actor = actorClient.name | "admin" | "system".
// Resource = vaultSecret.path | "-" (the audit table has no connectionId
// column, so non-secret events surface as "-").
// NO secret values (the table has none). Properly escapes fields containing
// commas / quotes / newlines (RFC 4180 quoting).
//
// Query: ?workspaceId=&action=&outcome=&limit=10000
import { handle, adminOrThrow, asInt, query } from '@/lib/vault/api-helpers'
import { db } from '@/lib/db'

const CSV_COLUMNS = [
  'id',
  'createdAt',
  'actor',
  'action',
  'resource',
  'outcome',
  'reasonCode',
  'requestId',
  'sourceIp',
  'workspaceId',
] as const

/**
 * RFC 4180 CSV field escaping: quote any field containing a comma, double
 * quote, newline, or carriage return; escape inner double quotes by doubling.
 */
function csvField(v: string | null | undefined): string {
  const s = v == null ? '' : String(v)
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

function actorName(input: {
  actorClientId: string | null
  actorClientName: string | null
  action: string
}): string {
  if (input.actorClientName) return input.actorClientName
  if (input.actorClientId) return input.actorClientId
  // Null actorClientId → admin or system. Watchdog / seed are system-driven.
  if (input.action.startsWith('watchdog.') || input.action.startsWith('seed.')) {
    return 'system'
  }
  return 'admin'
}

export const GET = handle(async (req) => {
  await adminOrThrow(req)
  const sp = query(req)
  const workspaceId = sp.get('workspaceId') || undefined
  const action = sp.get('action') || undefined
  const outcome = sp.get('outcome') || undefined
  const limit = Math.min(asInt(sp.get('limit'), 10_000), 10_000)

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
      workspace: { select: { id: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })

  const head = CSV_COLUMNS.join(',')
  const lines = [head]
  for (const e of rows) {
    const actor = actorName({
      actorClientId: e.actorClientId,
      actorClientName: e.actorClient?.name ?? null,
      action: e.action,
    })
    const resource = e.vaultSecret?.path ?? '-'
    const fields = [
      e.id,
      e.createdAt.toISOString(),
      actor,
      e.action,
      resource,
      e.outcome,
      e.reasonCode,
      e.requestId,
      e.sourceIp,
      // Prefer the workspace join; fall back to the FK column on the row.
      e.workspace?.id ?? e.workspaceId ?? '',
    ]
    lines.push(fields.map(csvField).join(','))
  }

  const csv = lines.join('\r\n') + '\r\n'

  return new Response(csv, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="vault-audit-events.csv"',
      'cache-control': 'no-store, private',
    },
  })
})
