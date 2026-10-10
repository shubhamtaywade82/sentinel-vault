// POST /api/v1/connections/[id]/recover → 200 { connection: {...} }  (admin only)
// Re-arms a connection stuck in `reauth_required` after an operator manually
// fixed the upstream credential. body { newRefreshToken?: string }.
//
// - Sets connection `status="active"`, `lastErrorCode=null`,
//   `reauthRequiredAt=null`, `refreshGeneration += 1`, `refreshAfter = now`
//   (so the watchdog picks it up immediately), `accessExpiresAt = now + 5min`
//   (temporary, replaced on the next successful refresh).
// - If `newRefreshToken` provided: finds the `refresh_token` binding, creates a
//   new SecretVersion for that secret (encrypt with AAD), retires the old
//   active version, updates `currentVersionId`. This simulates "operator
//   manually obtained a new refresh token and loaded it".
// - Audits `connection.recover`. Creates a `RotationRun` operation="recover"
//   status="succeeded" with `connectionId`, `completedAt=now`, `correlationId`.
import { handle, json, adminOrThrow, body, getRequestId, getSourceIp } from '@/lib/vault/api-helpers'
import { db } from '@/lib/db'
import { VaultError, assert } from '@/lib/vault/errors'
import { encryptValue } from '@/lib/vault/crypto'
import { recordEvent } from '@/lib/vault/audit'
import { randomBytes, randomUUID } from 'node:crypto'

const RECOVER_TEMP_ACCESS_WINDOW_MS = 5 * 60 * 1000 // 5 minutes

function serializeConnection(c: {
  id: string
  workspaceId: string
  providerKey: string
  authMethod: string
  adapterKey: string
  providerAccountRef: string | null
  status: string
  accessExpiresAt: Date | null
  refreshAfter: Date | null
  lastRefreshedAt: Date | null
  refreshLeaseExpiresAt: Date | null
  refreshGeneration: number
  lastErrorCode: string | null
  reauthRequiredAt: Date | null
  createdAt: Date
  updatedAt: Date
}) {
  return {
    id: c.id,
    workspaceId: c.workspaceId,
    providerKey: c.providerKey,
    authMethod: c.authMethod,
    adapterKey: c.adapterKey,
    providerAccountRef: c.providerAccountRef,
    status: c.status,
    accessExpiresAt: c.accessExpiresAt ? c.accessExpiresAt.toISOString() : null,
    refreshAfter: c.refreshAfter ? c.refreshAfter.toISOString() : null,
    lastRefreshedAt: c.lastRefreshedAt ? c.lastRefreshedAt.toISOString() : null,
    refreshLeaseExpiresAt: c.refreshLeaseExpiresAt ? c.refreshLeaseExpiresAt.toISOString() : null,
    refreshGeneration: c.refreshGeneration,
    lastErrorCode: c.lastErrorCode,
    reauthRequiredAt: c.reauthRequiredAt ? c.reauthRequiredAt.toISOString() : null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  }
}

async function loadBindings(connectionId: string) {
  const rows = await db.connectionSecretBinding.findMany({ where: { connectionId } })
  const secretIds = Array.from(new Set(rows.map((b) => b.vaultSecretId)))
  const secrets = secretIds.length
    ? await db.vaultSecret.findMany({ where: { id: { in: secretIds } }, select: { id: true, path: true, name: true } })
    : []
  const byId = new Map(secrets.map((s) => [s.id, s]))
  return rows.map((b) => ({
    id: b.id,
    connectionId: b.connectionId,
    vaultSecretId: b.vaultSecretId,
    purpose: b.purpose,
    secretPath: byId.get(b.vaultSecretId)?.path,
    secretName: byId.get(b.vaultSecretId)?.name,
  }))
}

export const POST = handle(async (req, ctx: { params: Promise<{ id: string }> }) => {
  await adminOrThrow(req)
  const { id } = await ctx.params

  const conn = await db.integrationConnection.findUnique({ where: { id } })
  if (!conn) throw new VaultError('connection_not_found')

  const input = await body<{ newRefreshToken?: string }>(req).catch(() => ({}) as { newRefreshToken?: string })
  const newRefreshToken = typeof input.newRefreshToken === 'string' ? input.newRefreshToken : undefined
  assert(
    newRefreshToken === undefined || newRefreshToken.length > 0,
    'validation_failed',
    'newRefreshToken must be a non-empty string when provided',
  )

  const now = new Date()
  const nextGen = conn.refreshGeneration + 1
  const tempAccessExpiresAt = new Date(now.getTime() + RECOVER_TEMP_ACCESS_WINDOW_MS)

  // If a new refresh token was supplied, persist it as a new SecretVersion on
  // the secret bound to this connection with purpose="refresh_token". This
  // runs in the same transaction as the connection update so the recover is
  // atomic from an observer's point of view.
  let resultVersionId: string | null = null
  await db.$transaction(async (tx) => {
    if (newRefreshToken) {
      const binding = await tx.connectionSecretBinding.findFirst({
        where: { connectionId: id, purpose: 'refresh_token' },
      })
      if (!binding) {
        throw new VaultError(
          'validation_failed',
          'connection has no binding with purpose="refresh_token" to load the new refresh token into',
        )
      }
      const secret = await tx.vaultSecret.findUnique({ where: { id: binding.vaultSecretId } })
      if (!secret) throw new VaultError('secret_not_found')

      const last = await tx.secretVersion.findFirst({
        where: { vaultSecretId: secret.id },
        orderBy: { versionNumber: 'desc' },
      })
      const nextVersionNumber = (last?.versionNumber ?? 0) + 1
      const aad = {
        workspaceId: secret.workspaceId,
        vaultSecretId: secret.id,
        versionNumber: nextVersionNumber,
      }
      const enc = await encryptValue(newRefreshToken, aad)
      const newVersion = await tx.secretVersion.create({
        data: {
          vaultSecretId: secret.id,
          versionNumber: nextVersionNumber,
          ciphertext: enc.ciphertext,
          encryptedDataKey: enc.encryptedDataKey,
          kmsKeyRef: enc.kmsKeyRef,
          cryptoScheme: enc.cryptoScheme,
          status: 'active',
          createdBy: 'recover',
          activatedAt: now,
        },
      })
      if (last && last.status === 'active') {
        await tx.secretVersion.update({
          where: { id: last.id },
          data: { status: 'retired', retiredAt: now },
        })
      }
      await tx.vaultSecret.update({
        where: { id: secret.id },
        data: { currentVersionId: newVersion.id, updatedAt: now },
      })
      resultVersionId = newVersion.id
    }

    await tx.integrationConnection.update({
      where: { id },
      data: {
        status: 'active',
        lastErrorCode: null,
        reauthRequiredAt: null,
        refreshGeneration: nextGen,
        refreshAfter: now,
        accessExpiresAt: tempAccessExpiresAt,
        refreshLeaseExpiresAt: null,
        updatedAt: now,
      },
    })
  })

  // Record a `recover` rotation run.
  const run = await db.rotationRun.create({
    data: {
      connectionId: id,
      operation: 'recover',
      status: 'succeeded',
      attemptCount: 1,
      idempotencyKey: `recover-${id}-${now.getTime()}-${randomBytes(4).toString('hex')}`,
      runAfter: now,
      startedAt: now,
      completedAt: now,
      resultVersionId,
      errorCode: null,
      leaseToken: null,
      leaseExpiresAt: null,
      correlationId: randomUUID(),
      createdAt: now,
    },
  })

  await recordEvent({
    workspaceId: conn.workspaceId,
    action: 'connection.recover',
    outcome: 'success',
    reasonCode: newRefreshToken ? 'refresh_token_replaced' : 'manual_recover',
    requestId: getRequestId(req),
    sourceIp: getSourceIp(req),
  })

  // Reload the updated connection + bindings for the response.
  const updated = await db.integrationConnection.findUnique({ where: { id } })
  if (!updated) throw new VaultError('connection_not_found')
  const bindings = await loadBindings(id)

  // Touch `run` so the linter doesn't complain about an unused value — the
  // row exists for audit-trail completeness (visible via /rotation_runs).
  void run

  return json({ connection: { ...serializeConnection(updated), bindings } })
})
