// POST /api/v1/connections/[id]/refresh → 202 { rotationRun }
// admin OR client with `connection:refresh` grant on a bound secret.
// Reads `Idempotency-Key` header and passes through to refreshConnection,
// which returns the matching existing run instead of re-running.
import { handle, json, actor, getRequestId, getSourceIp } from '@/lib/vault/api-helpers'
import { db } from '@/lib/db'
import { VaultError } from '@/lib/vault/errors'
import { checkGrant } from '@/lib/vault/authorization'
import { refreshConnection } from '@/lib/vault/refresh'

// `refreshConnection` returns a fully-serialized `RotationRunRow` (all Date
// fields already converted to ISO strings by its `serializeRun` helper). Pass
// it through unchanged. A defensive `toIso` keeps us safe if the contract
// ever changes to return raw Date objects.
function toIso(v: unknown): string | null {
  if (v == null) return null
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'string') return v
  try {
    return new Date(v as never).toISOString()
  } catch {
    return null
  }
}

function serializeRun(r: Record<string, unknown>) {
  return {
    id: r.id,
    connectionId: r.connectionId ?? null,
    vaultSecretId: r.vaultSecretId ?? null,
    operation: r.operation,
    status: r.status,
    attemptCount: typeof r.attemptCount === 'number' ? r.attemptCount : Number(r.attemptCount ?? 0),
    idempotencyKey: r.idempotencyKey,
    runAfter: toIso(r.runAfter),
    startedAt: toIso(r.startedAt),
    completedAt: toIso(r.completedAt),
    resultVersionId: r.resultVersionId ?? null,
    errorCode: r.errorCode ?? null,
    leaseToken: r.leaseToken ?? null,
    leaseExpiresAt: toIso(r.leaseExpiresAt),
    correlationId: r.correlationId ?? null,
    createdAt: toIso(r.createdAt),
  }
}

export const POST = handle(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params
  const auth = await actor(req)
  if (auth.kind === 'none') throw new VaultError('unauthorized')

  const conn = await db.integrationConnection.findUnique({ where: { id } })
  if (!conn) throw new VaultError('connection_not_found')

  if (auth.kind === 'client') {
    if (auth.client.workspaceId !== conn.workspaceId) throw new VaultError('connection_not_found')
    const bindings = await db.connectionSecretBinding.findMany({
      where: { connectionId: id },
      select: { vaultSecretId: true },
    })
    let allowed = false
    for (const b of bindings) {
      if (await checkGrant(auth.client.id, b.vaultSecretId, 'connection:refresh')) {
        allowed = true
        break
      }
    }
    if (!allowed) throw new VaultError('grant_required', 'Missing grant: connection:refresh on a bound secret')
  }

  const idempotencyKey = req.headers.get('idempotency-key') || undefined
  const run = await refreshConnection(id, {
    idempotencyKey,
    actorClientId: auth.kind === 'client' ? auth.client.id : null,
    requestId: getRequestId(req),
  })

  // Note: sourceIp is recorded inside the refresh engine's audit events via the
  // requestId correlation; the engine does not accept sourceIp directly.
  void getSourceIp

  return json({ rotationRun: serializeRun(run) }, 202)
})
