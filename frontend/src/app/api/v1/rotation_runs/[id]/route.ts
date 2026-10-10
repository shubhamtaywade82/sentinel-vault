// GET /api/v1/rotation_runs/[id] → 200 { run }  (admin only). 404 if missing.
import { handle, json, adminOrThrow } from '@/lib/vault/api-helpers'
import { db } from '@/lib/db'
import { VaultError } from '@/lib/vault/errors'

export const GET = handle(async (req, ctx: { params: Promise<{ id: string }> }) => {
  await adminOrThrow(req)
  const { id } = await ctx.params
  const run = await db.rotationRun.findUnique({ where: { id } })
  if (!run) throw new VaultError('resource_not_found', 'rotation run not found')
  return json({
    run: {
      id: run.id,
      connectionId: run.connectionId,
      vaultSecretId: run.vaultSecretId,
      operation: run.operation,
      status: run.status,
      attemptCount: run.attemptCount,
      idempotencyKey: run.idempotencyKey,
      runAfter: run.runAfter.toISOString(),
      startedAt: run.startedAt ? run.startedAt.toISOString() : null,
      completedAt: run.completedAt ? run.completedAt.toISOString() : null,
      resultVersionId: run.resultVersionId,
      errorCode: run.errorCode,
      leaseToken: run.leaseToken,
      leaseExpiresAt: run.leaseExpiresAt ? run.leaseExpiresAt.toISOString() : null,
      correlationId: run.correlationId,
      createdAt: run.createdAt.toISOString(),
    },
  })
})
