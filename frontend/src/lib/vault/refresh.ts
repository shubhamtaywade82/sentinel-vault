// server-only — credential refresh engine + watchdog.
// See VAULT_CONTRACT.md §7 (refreshConnection) and §4.10 (watchdog).
//
// The engine implements a 10-step flow:
//   1. Load connection + bindings + secrets.
//   2. Atomic lease claim (optimistic concurrency on refreshGeneration).
//   3. Create a RotationRun (status running, leaseToken, leaseExpiresAt, correlationId).
//   4. If adapter.supportsRefresh === false → permanent failure.
//   5. Build bindings with lazy decrypt closures.
//   6. Call adapter.refresh(...).
//   7. Success → short TX: new SecretVersion(s), retire prior active, activate,
//      advance connection.refreshAfter / accessExpiresAt, run.status=succeeded.
//   8. Permanent failure (invalid_grant | manual_rotation_required) →
//      connection.status=reauth_required, run.status=failed.
//   9. Transient failure (transient | rate_limited | provider_error) →
//      run.status=pending, runAfter=now+backoff, connection stays active.
//  10. Generation guard: re-read connection; if refreshGeneration !== expectedGen
//      → run.status=cancelled (stale_generation), don't persist new version.
//
// Lease is always cleared at the end (success/fail/cancel) by setting
// `refreshLeaseExpiresAt = null`.

import { randomBytes, randomUUID } from 'node:crypto'

import { db } from '@/lib/db'
import { VaultError } from './errors'
import { recordEvent, recordEventInTx } from './audit'
import { getAdapter } from './providers'
import type { ProviderAdapter, RefreshBinding } from './providers'
import { decryptValue, encryptValue } from './crypto'
import type {
  IntegrationConnectionRow,
  RotationRunRow,
  VaultSecretRow,
  WatchdogResponse,
} from './types'

// ---- Timing constants (scaled-down demo values; see VAULT_CONTRACT.md §7) ----
const LEASE_WINDOW_MS = 60_000 // 60 seconds
const SAFETY_MARGIN_MS = 2 * 60_000 // 2 minutes (access TTL - 2min = refreshAfter)
const JITTER_MS = 60_000 // 0..1 minute jitter added on top
const BACKOFF_BASE_MS = 15_000 // attemptCount * 15s
const BACKOFF_CAP_MS = 5 * 60_000 // capped at 5 minutes

const PERMANENT_ERROR_CODES = new Set(['invalid_grant', 'manual_rotation_required'])
const TRANSIENT_ERROR_CODES = new Set(['transient', 'rate_limited', 'provider_error'])

const ACCESS_TOKEN_PURPOSE = 'access_token'

function randomToken(bytes = 16): string {
  return randomBytes(bytes).toString('hex')
}

function uuid(): string {
  if (typeof randomUUID === 'function') return randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function isPermanent(code: string): boolean {
  return PERMANENT_ERROR_CODES.has(code)
}
function isTransient(code: string): boolean {
  return TRANSIENT_ERROR_CODES.has(code)
}

// ---------------------------------------------------------------------------
// Prisma ↔ contract serialization
// ---------------------------------------------------------------------------
//
// The contract's `*Row` types use ISO strings for DateTime fields (so the API
// envelope is JSON-friendly). Prisma returns Date objects. We bridge the two
// here. All Prisma writes use Date objects directly.

function toIso(v: unknown): string {
  if (!v) return new Date().toISOString()
  if (v instanceof Date) return v.toISOString()
  return new Date(v as string).toISOString()
}

function serializeRun(row: Record<string, unknown>): RotationRunRow {
  return {
    id: String(row.id),
    connectionId: (row.connectionId as string) ?? null,
    vaultSecretId: (row.vaultSecretId as string) ?? null,
    operation: String(row.operation),
    status: String(row.status),
    attemptCount:
      typeof row.attemptCount === 'number' ? row.attemptCount : Number(row.attemptCount ?? 0),
    idempotencyKey: String(row.idempotencyKey),
    runAfter: toIso(row.runAfter),
    startedAt: row.startedAt ? toIso(row.startedAt) : null,
    completedAt: row.completedAt ? toIso(row.completedAt) : null,
    resultVersionId: (row.resultVersionId as string) ?? null,
    errorCode: (row.errorCode as string) ?? null,
    leaseToken: (row.leaseToken as string) ?? null,
    leaseExpiresAt: row.leaseExpiresAt ? toIso(row.leaseExpiresAt) : null,
    correlationId: (row.correlationId as string) ?? null,
    createdAt: toIso(row.createdAt),
  }
}

function serializeConnection(c: Record<string, unknown>): IntegrationConnectionRow {
  return {
    id: String(c.id),
    workspaceId: String(c.workspaceId),
    providerKey: String(c.providerKey),
    authMethod: String(c.authMethod),
    adapterKey: String(c.adapterKey),
    providerAccountRef: (c.providerAccountRef as string) ?? null,
    status: String(c.status),
    accessExpiresAt: c.accessExpiresAt ? toIso(c.accessExpiresAt) : null,
    refreshAfter: c.refreshAfter ? toIso(c.refreshAfter) : null,
    lastRefreshedAt: c.lastRefreshedAt ? toIso(c.lastRefreshedAt) : null,
    refreshLeaseExpiresAt: c.refreshLeaseExpiresAt ? toIso(c.refreshLeaseExpiresAt) : null,
    refreshGeneration:
      typeof c.refreshGeneration === 'number'
        ? c.refreshGeneration
        : Number(c.refreshGeneration ?? 0),
    lastErrorCode: (c.lastErrorCode as string) ?? null,
    reauthRequiredAt: c.reauthRequiredAt ? toIso(c.reauthRequiredAt) : null,
    createdAt: toIso(c.createdAt),
    updatedAt: toIso(c.updatedAt),
  }
}

function serializeSecret(s: Record<string, unknown>): VaultSecretRow {
  return {
    id: String(s.id),
    workspaceId: String(s.workspaceId),
    path: String(s.path),
    name: String(s.name),
    kind: String(s.kind),
    classification: String(s.classification ?? 'confidential'),
    environment: String(s.environment ?? 'production'),
    provider: (s.provider as string) ?? null,
    status: String(s.status ?? 'active'),
    expiresAt: s.expiresAt ? toIso(s.expiresAt) : null,
    currentVersionId: (s.currentVersionId as string) ?? null,
    createdAt: toIso(s.createdAt),
    updatedAt: toIso(s.updatedAt),
  }
}

// ---------------------------------------------------------------------------
// refreshConnection
// ---------------------------------------------------------------------------

export interface RefreshConnectionOptions {
  manual?: boolean
  idempotencyKey?: string
  actorClientId?: string | null
  requestId?: string | null
}

interface RunFinalPatch {
  status: string
  errorCode?: string | null
  attemptCount?: number
  runAfter?: Date
  resultVersionId?: string | null
}

interface ConnectionFinalPatch {
  status?: string
  lastRefreshedAt?: Date | null
  accessExpiresAt?: Date | null
  refreshAfter?: Date | null
  lastErrorCode?: string | null
  reauthRequiredAt?: Date | null
}

export async function refreshConnection(
  connectionId: string,
  opts: RefreshConnectionOptions = {},
): Promise<RotationRunRow> {
  const now = new Date()
  const idempotencyKey =
    opts.idempotencyKey || `refresh-${connectionId}-${now.getTime()}-${randomToken(4)}`

  // Idempotency: if a run with this key already exists, return it (no new work).
  if (opts.idempotencyKey) {
    const existing = await db.rotationRun.findUnique({
      where: { idempotencyKey: opts.idempotencyKey },
    })
    if (existing) return serializeRun(existing as unknown as Record<string, unknown>)
  }

  // ---- 1. Load connection ----
  const connectionRow = await db.integrationConnection.findUnique({
    where: { id: connectionId },
  })
  if (!connectionRow) throw new VaultError('connection_not_found')
  const connection = serializeConnection(connectionRow as unknown as Record<string, unknown>)
  const workspaceId = connection.workspaceId

  // ---- 2. Atomic lease claim (optimistic concurrency on refreshGeneration) ----
  // Bump generation + set lease expires to now+60s ONLY when the current
  // lease is null or already expired. 0 updated rows → someone else holds it.
  const expectedGen = connection.refreshGeneration + 1
  const leaseExpiresAt = new Date(now.getTime() + LEASE_WINDOW_MS)
  const leaseToken = randomToken(16)

  const claim = await db.integrationConnection.updateMany({
    where: {
      id: connectionId,
      refreshGeneration: connection.refreshGeneration,
      OR: [
        { refreshLeaseExpiresAt: null },
        { refreshLeaseExpiresAt: { lt: now } },
      ],
    },
    data: {
      refreshGeneration: expectedGen,
      refreshLeaseExpiresAt: leaseExpiresAt,
      updatedAt: now,
    },
  })

  if (claim.count === 0) {
    // Lease held by another in-flight run. Find that run, or create a
    // placeholder "running" run so the caller gets a coherent row back.
    const inflight = await db.rotationRun.findFirst({
      where: { connectionId, status: { in: ['running', 'pending'] } },
      orderBy: { createdAt: 'desc' },
    })
    if (inflight) return serializeRun(inflight as unknown as Record<string, unknown>)

    const placeholder = await db.rotationRun.create({
      data: {
        connectionId,
        operation: 'refresh',
        status: 'running',
        attemptCount: 0,
        idempotencyKey,
        runAfter: now,
        startedAt: now,
        completedAt: null,
        resultVersionId: null,
        errorCode: 'rotation_in_progress',
        leaseToken,
        leaseExpiresAt,
        correlationId: uuid(),
        createdAt: now,
      },
    })
    await recordEvent({
      workspaceId,
      actorClientId: opts.actorClientId ?? null,
      action: 'refresh.run',
      outcome: 'denied',
      reasonCode: 'rotation_in_progress',
      requestId: opts.requestId ?? null,
    })
    return serializeRun(placeholder as unknown as Record<string, unknown>)
  }

  // ---- 3. Create the RotationRun (status running) ----
  const runRow = await db.rotationRun.create({
    data: {
      connectionId,
      operation: 'refresh',
      status: 'running',
      attemptCount: 1,
      idempotencyKey,
      runAfter: now,
      startedAt: now,
      completedAt: null,
      resultVersionId: null,
      errorCode: null,
      leaseToken,
      leaseExpiresAt,
      correlationId: uuid(),
      createdAt: now,
    },
  })
  const runId = String(runRow.id)
  const attemptCountStart = Number(runRow.attemptCount ?? 1)

  await recordEvent({
    workspaceId,
    actorClientId: opts.actorClientId ?? null,
    action: 'refresh.run',
    outcome: 'success',
    requestId: opts.requestId ?? null,
  })

  // Helper used by every terminal branch to clear the lease + finalize the run.
  async function finalize(
    runPatch: RunFinalPatch,
    connectionPatch: ConnectionFinalPatch,
  ): Promise<RotationRunRow> {
    const completedAt = new Date()
    await db.integrationConnection.update({
      where: { id: connectionId },
      data: {
        ...connectionPatch,
        refreshLeaseExpiresAt: null,
        updatedAt: completedAt,
      },
    })
    const updated = await db.rotationRun.update({
      where: { id: runId },
      data: {
        status: runPatch.status,
        errorCode: runPatch.errorCode ?? null,
        attemptCount: runPatch.attemptCount,
        runAfter: runPatch.runAfter,
        resultVersionId: runPatch.resultVersionId ?? null,
        completedAt,
        leaseExpiresAt: null,
      },
    })
    return serializeRun(updated as unknown as Record<string, unknown>)
  }

  try {
    // ---- 4. Resolve adapter; if it can't refresh, mark permanent failure ----
    const adapter: ProviderAdapter = getAdapter(connection.adapterKey)
    if (!adapter.supportsRefresh) {
      const finalRun = await finalize(
        { status: 'failed', errorCode: 'manual_rotation_required' },
        {
          status: 'reauth_required',
          reauthRequiredAt: now,
          lastErrorCode: 'manual_rotation_required',
        },
      )
      await recordEvent({
        workspaceId,
        actorClientId: opts.actorClientId ?? null,
        action: 'refresh.failed',
        outcome: 'error',
        reasonCode: 'manual_rotation_required',
        requestId: opts.requestId ?? null,
      })
      return finalRun
    }

    // ---- 5. Build bindings with lazy decrypt closures ----
    const bindings = await buildRefreshBindings(connectionId, workspaceId)

    // ---- 6. Call the adapter ----
    let result
    try {
      result = await adapter.refresh({ connection, bindings })
    } catch (err) {
      // Unexpected adapter throw → treat as transient provider error.
      console.warn(
        '[vault][refresh] adapter threw:',
        err instanceof Error ? err.message : String(err),
      )
      result = { ok: false, errorCode: 'provider_error' }
    }

    // ---- 7. Success path ----
    if (result.ok) {
      // Generation guard BEFORE persisting.
      const recheck = await db.integrationConnection.findUnique({
        where: { id: connectionId },
        select: { refreshGeneration: true },
      })
      if (!recheck || recheck.refreshGeneration !== expectedGen) {
        const finalRun = await finalize(
          { status: 'cancelled', errorCode: 'stale_generation' },
          { lastErrorCode: 'stale_generation' },
        )
        await recordEvent({
          workspaceId,
          actorClientId: opts.actorClientId ?? null,
          action: 'refresh.cancelled',
          outcome: 'error',
          reasonCode: 'stale_generation',
          requestId: opts.requestId ?? null,
        })
        return finalRun
      }

      // Short TX: create new versions, retire prior actives, activate, update secret.
      const persisted = await persistSuccessfulRefresh({
        workspaceId,
        newCredentials: result.newCredentials ?? [],
        rotatedTokens: result.refreshTokensRotated ?? [],
        bindings,
        startedAt: now,
        actorClientId: opts.actorClientId ?? null,
        requestId: opts.requestId ?? null,
      })

      const finalRun = await finalize(
        { status: 'succeeded', resultVersionId: persisted.accessVersionId },
        {
          status: 'active',
          lastRefreshedAt: now,
          accessExpiresAt: persisted.accessExpiresAt,
          refreshAfter: persisted.refreshAfter,
          lastErrorCode: null,
        },
      )
      // `refresh.succeeded` is now persisted INSIDE the persistSuccessfulRefresh
      // transaction via `recordEventInTx` (R13-outbox) — the audit row commits
      // or rolls back atomically with the new versions. No follow-up audit emit
      // is needed here.
      return finalRun
    }

    // ---- 8. Permanent failure ----
    if (result.errorCode && isPermanent(result.errorCode)) {
      const finalRun = await finalize(
        { status: 'failed', errorCode: result.errorCode },
        {
          status: 'reauth_required',
          reauthRequiredAt: now,
          lastErrorCode: result.errorCode,
        },
      )
      await recordEvent({
        workspaceId,
        actorClientId: opts.actorClientId ?? null,
        action: 'refresh.failed',
        outcome: 'error',
        reasonCode: result.errorCode,
        requestId: opts.requestId ?? null,
      })
      return finalRun
    }

    // ---- 9. Transient failure (transient | rate_limited | provider_error) ----
    const errorCode = result.errorCode ?? 'transient'
    const newAttempt = attemptCountStart + 1
    const backoff = Math.min(newAttempt * BACKOFF_BASE_MS, BACKOFF_CAP_MS)
    const runAfter = new Date(now.getTime() + backoff)

    const finalRun = await finalize(
      { status: 'pending', errorCode, attemptCount: newAttempt, runAfter },
      { status: 'active', lastErrorCode: errorCode },
    )
    await recordEvent({
      workspaceId,
      actorClientId: opts.actorClientId ?? null,
      action: 'refresh.transient',
      outcome: 'error',
      reasonCode: errorCode,
      requestId: opts.requestId ?? null,
    })
    return finalRun
  } catch (err) {
    // Defensive: never leave a run stuck in `running` or a lease held.
    try {
      await db.integrationConnection.update({
        where: { id: connectionId },
        data: { refreshLeaseExpiresAt: null, updatedAt: new Date() },
      })
    } catch {
      /* ignore */
    }
    if (err instanceof VaultError) {
      try {
        const updated = await db.rotationRun.update({
          where: { id: runId },
          data: {
            status: 'failed',
            errorCode: err.code,
            completedAt: new Date(),
            leaseExpiresAt: null,
          },
        })
        return serializeRun(updated as unknown as Record<string, unknown>)
      } catch {
        // Fall through to return a placeholder row.
      }
    } else {
      console.warn(
        '[vault][refresh] unhandled error:',
        err instanceof Error ? err.message : String(err),
      )
    }
    try {
      const updated = await db.rotationRun.update({
        where: { id: runId },
        data: {
          status: 'pending',
          errorCode: 'transient',
          completedAt: new Date(),
          leaseExpiresAt: null,
          attemptCount: attemptCountStart + 1,
        },
      })
      return serializeRun(updated as unknown as Record<string, unknown>)
    } catch {
      return serializeRun(runRow as unknown as Record<string, unknown>)
    }
  }
}

// ---------------------------------------------------------------------------
// Bindings: load + lazy decrypt closures
// ---------------------------------------------------------------------------

async function buildRefreshBindings(
  connectionId: string,
  workspaceId: string,
): Promise<RefreshBinding[]> {
  const bindingRows = await db.connectionSecretBinding.findMany({
    where: { connectionId },
  })
  const secretIds = Array.from(new Set(bindingRows.map((b) => b.vaultSecretId)))
  if (secretIds.length === 0) return []
  const secrets = await db.vaultSecret.findMany({ where: { id: { in: secretIds } } })
  const secretById = new Map<string, VaultSecretRow>()
  for (const s of secrets) {
    secretById.set(s.id, serializeSecret(s as unknown as Record<string, unknown>))
  }

  const out: RefreshBinding[] = []
  for (const b of bindingRows) {
    const secret = secretById.get(b.vaultSecretId)
    if (!secret) continue

    // Lazy decrypt closure: fetches + decrypts only when the adapter asks.
    // Memoize per binding so the same plaintext isn't computed twice.
    let cached: string | null = null
    let cachedErr: unknown = null
    const decryptFn = async (): Promise<string> => {
      if (cached !== null) return cached
      if (cachedErr) throw cachedErr
      try {
        const secretRow = await db.vaultSecret.findUnique({ where: { id: b.vaultSecretId } })
        if (!secretRow || !secretRow.currentVersionId) {
          throw new VaultError('version_not_found')
        }
        const version = await db.secretVersion.findUnique({
          where: { id: secretRow.currentVersionId },
        })
        if (!version) throw new VaultError('version_not_found')
        const aad = {
          workspaceId,
          vaultSecretId: b.vaultSecretId,
          versionNumber: version.versionNumber,
        }
        cached = await decryptValue(
          {
            ciphertext: version.ciphertext,
            encryptedDataKey: version.encryptedDataKey,
            kmsKeyRef: version.kmsKeyRef,
          },
          aad,
        )
        return cached
      } catch (err) {
        cachedErr = err
        throw err
      }
    }

    out.push({ purpose: b.purpose, secret, decrypt: decryptFn })
  }
  return out
}

// ---------------------------------------------------------------------------
// Persist successful refresh
// ---------------------------------------------------------------------------

interface PersistResult {
  accessVersionId: string | null
  accessSecretId: string | null
  accessExpiresAt: Date | null
  refreshAfter: Date | null
}

async function persistSuccessfulRefresh(args: {
  workspaceId: string
  newCredentials: { purpose: string; value: string; expiresAt?: string }[]
  rotatedTokens: { purpose: string; newValue: string }[]
  bindings: RefreshBinding[]
  startedAt: Date
  actorClientId: string | null
  requestId: string | null
}): Promise<PersistResult> {
  const {
    workspaceId,
    newCredentials,
    rotatedTokens,
    bindings,
    startedAt,
    actorClientId,
    requestId,
  } = args

  // Combine new credentials + rotated tokens into a unified write plan.
  // Both kinds end up as a fresh SecretVersion on the corresponding secret.
  type PlanEntry = {
    purpose: string
    value: string
    expiresAt?: string
  }
  const plan: PlanEntry[] = [
    ...newCredentials.map((c) => ({ purpose: c.purpose, value: c.value, expiresAt: c.expiresAt })),
    ...rotatedTokens.map((t) => ({ purpose: t.purpose, value: t.newValue })),
  ]

  let accessVersionId: string | null = null
  let accessSecretId: string | null = null
  let accessExpiresAt: Date | null = null

  await db.$transaction(async (tx) => {
    for (const entry of plan) {
      const binding = bindings.find((b) => b.purpose === entry.purpose)
      if (!binding) {
        // Adapter returned a credential for a purpose the connection doesn't
        // have a binding for. Skip silently — the secret simply isn't tracked.
        continue
      }
      const secretId = binding.secret.id

      // Compute the next version number for this secret.
      const lastVersion = await tx.secretVersion.findFirst({
        where: { vaultSecretId: secretId },
        orderBy: { versionNumber: 'desc' },
        select: { versionNumber: true, id: true, status: true },
      })
      const nextVersionNumber = (lastVersion?.versionNumber ?? 0) + 1

      // Encrypt with AAD bound to (workspaceId, vaultSecretId, versionNumber).
      const aad = { workspaceId, vaultSecretId: secretId, versionNumber: nextVersionNumber }
      const enc = await encryptValue(entry.value, aad)

      // Create the new version row.
      const newVersion = await tx.secretVersion.create({
        data: {
          vaultSecretId: secretId,
          versionNumber: nextVersionNumber,
          ciphertext: enc.ciphertext,
          encryptedDataKey: enc.encryptedDataKey,
          kmsKeyRef: enc.kmsKeyRef,
          cryptoScheme: enc.cryptoScheme,
          status: 'active',
          createdBy: 'refresh-engine',
          activatedAt: startedAt,
          retiredAt: null,
        },
      })

      // Retire the prior active version (if any) atomically.
      if (lastVersion && lastVersion.status === 'active') {
        await tx.secretVersion.update({
          where: { id: lastVersion.id },
          data: { status: 'retired', retiredAt: startedAt },
        })
      }

      // Update the secret's currentVersionId (+ expiresAt if provided).
      const secretUpdate: { currentVersionId: string; updatedAt: Date; expiresAt?: Date } = {
        currentVersionId: newVersion.id,
        updatedAt: startedAt,
      }
      if (entry.expiresAt) {
        secretUpdate.expiresAt = new Date(entry.expiresAt)
      }
      await tx.vaultSecret.update({ where: { id: secretId }, data: secretUpdate })

      // Remember the access_token's new version id + expiry for the run row.
      if (entry.purpose === ACCESS_TOKEN_PURPOSE) {
        accessVersionId = newVersion.id
        accessSecretId = secretId
        accessExpiresAt = entry.expiresAt ? new Date(entry.expiresAt) : null
      }
    }

    // Transactional-outbox audit: persist the `refresh.succeeded` SUCCESS audit
    // INSIDE this same transaction as the new versions + retiral + secret
    // updates. If the audit write fails, the whole transaction rolls back
    // (no unaudited refresh). If both succeed, they commit together — atomic
    // (R13-outbox). The audit correlates with the access_token's new version
    // (accessSecretId / accessVersionId) when an access_token credential was
    // part of the refresh; otherwise the correlation fields are left null.
    await recordEventInTx(tx, {
      workspaceId,
      actorClientId: actorClientId ?? null,
      vaultSecretId: accessSecretId,
      secretVersionId: accessVersionId,
      action: 'refresh.succeeded',
      outcome: 'success',
      requestId: requestId ?? null,
    })
  })

  // refreshAfter = accessExpiresAt - safetyMargin + 0..jitter.
  let refreshAfter: Date | null = null
  if (accessExpiresAt) {
    const jitter = Math.floor(Math.random() * JITTER_MS)
    refreshAfter = new Date(accessExpiresAt.getTime() - SAFETY_MARGIN_MS + jitter)
  }

  return { accessVersionId, accessSecretId, accessExpiresAt, refreshAfter }
}

// ---------------------------------------------------------------------------
// Watchdog (VAULT_CONTRACT.md §4.10)
// ---------------------------------------------------------------------------

export async function runWatchdog(): Promise<WatchdogResponse> {
  const now = new Date()
  // Due = active + refreshAfter in the past + lease not held.
  const due = await db.integrationConnection.findMany({
    where: {
      status: 'active',
      refreshAfter: { lte: now },
      OR: [
        { refreshLeaseExpiresAt: null },
        { refreshLeaseExpiresAt: { lt: now } },
      ],
    },
    select: { id: true },
  })

  const refreshed: { connectionId: string; status: string }[] = []
  const reauthRequired: { connectionId: string; errorCode: string | null }[] = []
  const errors: { connectionId: string; errorCode: string | null }[] = []

  for (const conn of due) {
    try {
      const run = await refreshConnection(conn.id, {
        manual: false,
        actorClientId: null,
        requestId: `watchdog-${now.getTime()}`,
      })
      if (run.status === 'succeeded') {
        refreshed.push({ connectionId: conn.id, status: run.status })
      } else if (run.status === 'pending') {
        // Transient — still an attempted refresh, surface as refreshed w/ status.
        refreshed.push({ connectionId: conn.id, status: run.status })
      } else if (run.status === 'failed' && run.errorCode && isPermanent(run.errorCode)) {
        reauthRequired.push({ connectionId: conn.id, errorCode: run.errorCode })
      } else {
        // cancelled / running / unknown → errors bucket
        errors.push({ connectionId: conn.id, errorCode: run.errorCode })
      }
    } catch (err) {
      const code = err instanceof VaultError ? err.code : 'internal_error'
      errors.push({ connectionId: conn.id, errorCode: code })
    }
  }

  return {
    checked: due.length,
    refreshed,
    reauthRequired,
    errors,
  }
}

// Re-export to keep the symbol available to callers.
export { VaultError }
