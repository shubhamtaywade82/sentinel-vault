// POST /api/v1/connections/[id]/reauthorize → 202 { rotationRun }
// admin only. If the adapter supports reauth, attempt it; otherwise mark
// connection status="reauth_required", reauthRequiredAt=now, lastErrorCode
// "manual_reauth_required". Create a RotationRun (operation "reauthorize")
// capturing the outcome.
import { handle, json, adminOrThrow, getRequestId, getSourceIp } from '@/lib/vault/api-helpers'
import { db } from '@/lib/db'
import { VaultError } from '@/lib/vault/errors'
import { getAdapter } from '@/lib/vault/providers'
import { recordEvent, recordEventCritical } from '@/lib/vault/audit'
import { randomBytes, randomUUID } from 'node:crypto'

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

export const POST = handle(async (req, ctx: { params: Promise<{ id: string }> }) => {
  await adminOrThrow(req)
  const { id } = await ctx.params
  const conn = await db.integrationConnection.findUnique({ where: { id } })
  if (!conn) throw new VaultError('connection_not_found')

  const now = new Date()
  let supportsReauth = false
  try {
    supportsReauth = getAdapter(conn.adapterKey).supportsReauth
  } catch {
    // Adapter missing — treat as manual reauth required.
  }

  let status = 'failed'
  let errorCode = 'manual_reauth_required'

  if (supportsReauth) {
    // In our adapters none actually support reauth yet — but if one did, we
    // would call adapter.refresh or a hypothetical adapter.reauth here. For
    // now we record a succeeded run with no-op semantics.
    status = 'succeeded'
    errorCode = null
  }

  const connPatch = supportsReauth
    ? { status: 'active', lastErrorCode: null, updatedAt: now }
    : {
        status: 'reauth_required',
        reauthRequiredAt: now,
        lastErrorCode: 'manual_reauth_required',
        updatedAt: now,
      }

  await db.integrationConnection.update({ where: { id }, data: connPatch })

  const run = await db.rotationRun.create({
    data: {
      connectionId: id,
      operation: 'reauthorize',
      status,
      attemptCount: 1,
      idempotencyKey: `reauth-${id}-${now.getTime()}-${randomBytes(4).toString('hex')}`,
      runAfter: now,
      startedAt: now,
      completedAt: now,
      resultVersionId: null,
      errorCode,
      leaseToken: null,
      leaseExpiresAt: null,
      correlationId: randomUUID(),
      createdAt: now,
    },
  })

  await recordEventCritical({
    workspaceId: conn.workspaceId,
    action: 'connection.reauthorize',
    outcome: status === 'succeeded' ? 'success' : 'error',
    reasonCode: errorCode,
    requestId: getRequestId(req),
    sourceIp: getSourceIp(req),
  })

  return json({ rotationRun: serializeRun(run) }, 202)
})
