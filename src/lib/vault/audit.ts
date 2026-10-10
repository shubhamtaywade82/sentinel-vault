// server-only — append-only, value-free audit trail.
// See VAULT_CONTRACT.md §10 ("NEVER log/echo plaintext secret values").
//
// This module MUST refuse to accept or store any secret value. It only records
// metadata: who did what, against which (secret / connection / version) row,
// with what outcome and reason code.
//
// Security-audit hardening (R12): audit persistence is now fail-closed for
// privileged operations via `recordEventCritical`. A privileged reveal, rotation,
// revocation, remediation, credential delivery, client-credential rotation,
// or grant change MUST durably persist its audit record; if the audit write
// fails, the operation itself fails (throws) rather than proceeding without a
// reliable record. Ordinary telemetry (`recordEvent`) keeps the best-effort
// swallow behaviour so a flaky DB doesn't take down list/read endpoints.

import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { VaultError } from './errors'
import type { Outcome } from './types'

/**
 * The transaction client (`tx`) handed to the callback of `db.$transaction`.
 * Uses the same `tx` for both the domain mutation AND the audit write so the
 * audit row commits or rolls back atomically with the domain change. This is
 * the transactional-outbox pattern — a crash between the domain mutation and
 * the audit write can no longer leave an unaudited change (R13-outbox).
 */
export type PrismaTransaction = Prisma.TransactionClient

export interface AuditEventInput {
  workspaceId?: string | null
  actorClientId?: string | null
  vaultSecretId?: string | null
  secretVersionId?: string | null
  action: string
  outcome?: Outcome
  reasonCode?: string | null
  requestId?: string | null
  sourceIp?: string | null
}

/**
 * Persist a `SecretAccessEvent` row. Best-effort: an audit write failure is
 * logged via `console.warn` but NEVER rethrown, so ordinary request paths
 * (list, read, dashboard aggregations) are unaffected even if the DB is briefly
 * unavailable. Use `recordEventCritical` for privileged operations that must
 * fail closed when auditing is unavailable.
 */
export async function recordEvent(input: AuditEventInput): Promise<void> {
  try {
    await db.secretAccessEvent.create({
      data: {
        workspaceId: input.workspaceId ?? null,
        actorClientId: input.actorClientId ?? null,
        vaultSecretId: input.vaultSecretId ?? null,
        secretVersionId: input.secretVersionId ?? null,
        action: input.action,
        outcome: (input.outcome ?? 'success') as string,
        reasonCode: input.reasonCode ?? null,
        requestId: input.requestId ?? null,
        sourceIp: input.sourceIp ?? null,
      },
    })
  } catch (err) {
    // Audit must NEVER break the main flow for ordinary telemetry. Log a
    // non-value-bearing warning.
    console.warn('[vault][audit] failed to record event:', {
      action: input.action,
      outcome: input.outcome,
      reasonCode: input.reasonCode,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Persist a `SecretAccessEvent` row with FAIL-CLOSED semantics. For privileged
 * operations (secret.reveal, secret.rotate, secret.revoke, secret.remediate,
 * connection.credential, client.rotate_credential, client.revoke, grant.create,
 * grant.delete, secret.diff), a durable audit record is part of the security
 * contract. If the audit write fails, the operation itself must fail — we
 * throw `VaultError('audit_persist_failed')` so the caller's mutation is
 * rolled back / not committed, rather than proceeding without a reliable
 * audit trail.
 *
 * Callers should invoke this AFTER the domain mutation succeeds but BEFORE
 * returning the response. If this throws, the caller should propagate the
 * error so the HTTP response is an error (and the mutation's effect is
 * surfaced as failed to the operator, who can retry).
 */
export async function recordEventCritical(
  input: AuditEventInput,
): Promise<void> {
  try {
    await db.secretAccessEvent.create({
      data: {
        workspaceId: input.workspaceId ?? null,
        actorClientId: input.actorClientId ?? null,
        vaultSecretId: input.vaultSecretId ?? null,
        secretVersionId: input.secretVersionId ?? null,
        action: input.action,
        outcome: (input.outcome ?? 'success') as string,
        reasonCode: input.reasonCode ?? null,
        requestId: input.requestId ?? null,
        sourceIp: input.sourceIp ?? null,
      },
    })
  } catch (err) {
    console.error('[vault][audit] CRITICAL: failed to record privileged event:', {
      action: input.action,
      outcome: input.outcome,
      reasonCode: input.reasonCode,
      error: err instanceof Error ? err.message : String(err),
    })
    throw new VaultError(
      'audit_persist_failed',
      'Failed to persist a durable audit record for a privileged operation. The operation is refused to guarantee a reliable audit trail.',
      { action: input.action },
    )
  }
}

/**
 * Best-effort audit emit from a sync-without-await context. Useful when the
 * audit context is computed inside a DB transaction where we don't want to
 * extend the transaction with a separate write. NOT for privileged ops —
 * use `recordEventCritical` (awaited) for those.
 */
export function emitAuditEvent(input: AuditEventInput): void {
  void recordEvent(input)
}

/**
 * Transactional-outbox audit write. Use this to persist a privileged audit
 * event INSIDE the same `db.$transaction(async (tx) => { ... })` block as
 * the domain mutation. The audit row commits or rolls back atomically with
 * the domain change: if the domain mutation succeeds but the audit write
 * fails, the whole transaction rolls back (fail-closed, atomic — no
 * unaudited change can survive). If both succeed, they commit together.
 *
 * This is the strongest audit durability guarantee we can provide with a
 * single SQLite file — no window between "mutation committed" and "audit
 * committed" exists for a process crash to exploit. Use this in preference
 * to `recordEventCritical` whenever the caller is already inside a
 * `db.$transaction` block.
 *
 * Behaviour on failure: rethrows the underlying Prisma error. Prisma
 * interactive transactions roll back on any throw from the callback, so
 * the domain mutation is automatically reverted as well — exactly the
 * fail-closed contract callers expect from `recordEventCritical`.
 */
export async function recordEventInTx(
  tx: PrismaTransaction,
  input: AuditEventInput,
): Promise<void> {
  await tx.secretAccessEvent.create({
    data: {
      workspaceId: input.workspaceId ?? null,
      actorClientId: input.actorClientId ?? null,
      vaultSecretId: input.vaultSecretId ?? null,
      secretVersionId: input.secretVersionId ?? null,
      action: input.action,
      outcome: (input.outcome ?? 'success') as string,
      reasonCode: input.reasonCode ?? null,
      requestId: input.requestId ?? null,
      sourceIp: input.sourceIp ?? null,
    },
  })
}
