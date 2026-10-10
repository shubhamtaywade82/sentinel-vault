// GET /api/v1/rotation_runs → 200 { runs }  (admin only)
// Query: status, connectionId, limit (default 50).
import { handle, json, adminOrThrow, asInt } from '@/lib/vault/api-helpers'
import { db } from '@/lib/db'

function serializeRun(r: {
  id: string
  connectionId: string | null
  vaultSecretId: string | null
  operation: string
  status: string
  attemptCount: number
  idempotencyKey: string
  runAfter: Date
  startedAt: Date | null
  completedAt: Date | null
  resultVersionId: string | null
  errorCode: string | null
  leaseToken: string | null
  leaseExpiresAt: Date | null
  correlationId: string | null
  createdAt: Date
}) {
  return {
    id: r.id,
    connectionId: r.connectionId,
    vaultSecretId: r.vaultSecretId,
    operation: r.operation,
    status: r.status,
    attemptCount: r.attemptCount,
    idempotencyKey: r.idempotencyKey,
    runAfter: r.runAfter.toISOString(),
    startedAt: r.startedAt ? r.startedAt.toISOString() : null,
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    resultVersionId: r.resultVersionId,
    errorCode: r.errorCode,
    leaseToken: r.leaseToken,
    leaseExpiresAt: r.leaseExpiresAt ? r.leaseExpiresAt.toISOString() : null,
    correlationId: r.correlationId,
    createdAt: r.createdAt.toISOString(),
  }
}

export const GET = handle(async (req) => {
  await adminOrThrow(req)
  const sp = new URL(req.url).searchParams
  const status = sp.get('status') || undefined
  const connectionId = sp.get('connectionId') || undefined
  const limit = Math.min(asInt(sp.get('limit'), 50), 500)

  const where: { status?: string; connectionId?: string } = {}
  if (status) where.status = status
  if (connectionId) where.connectionId = connectionId

  const rows = await db.rotationRun.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
  })

  return json({ runs: rows.map(serializeRun) })
})
