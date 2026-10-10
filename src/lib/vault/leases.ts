// server-only — secret leases: short-lived credential delivery.
// See VAULT_CONTRACT.md §3 (`SecretLease` model) + Task R1-backend spec.
//
// A `SecretLease` records that a service client has been granted a set of
// permissions on a vault secret for a bounded window (ttlSeconds, capped at
// 24h). Leases are append-only rows that the audit layer can correlate to a
// reveal/credential event. The lease itself never stores the secret value.
//
// All four operations are pure DB+audit calls (no HTTP) so the route handlers
// can compose them with their own auth/authorization logic.

import { db } from '@/lib/db'
import { VaultError } from './errors'
import { recordEvent } from './audit'
import { ALL_PERMISSIONS, type Permission } from './types'
import type { LeaseListItem, SecretLeaseRow } from './types'

/** Hard caps on TTL (matches the task spec). */
export const MIN_TTL_SECONDS = 60
export const MAX_TTL_SECONDS = 86_400 // 24h

/** Audit context passed in by the route handler. */
export interface LeaseAuditCtx {
  workspaceId: string
  actorClientId: string | null
  requestId?: string | null
  sourceIp?: string | null
}

export interface IssueLeaseInput {
  vaultSecretId: string
  serviceClientId: string
  permissions: string[]
  ttlSeconds: number
  audit: LeaseAuditCtx
}

function toIso(d: Date | null | undefined): string | null {
  if (!d) return null
  return d.toISOString()
}

function serializeLease(r: {
  id: string
  vaultSecretId: string
  serviceClientId: string
  grantedPermissions: string
  issuedAt: Date
  expiresAt: Date
  revokedAt: Date | null
  status: string
  createdAt: Date
}): SecretLeaseRow {
  return {
    id: r.id,
    vaultSecretId: r.vaultSecretId,
    serviceClientId: r.serviceClientId,
    grantedPermissions: r.grantedPermissions,
    issuedAt: r.issuedAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    revokedAt: toIso(r.revokedAt),
    status: r.status as 'active' | 'revoked' | 'expired',
    createdAt: r.createdAt.toISOString(),
  }
}

/** Normalize + validate the requested permission list. Throws on unknown tokens. */
export function normalizePermissions(permissions: unknown): Permission[] {
  if (!Array.isArray(permissions)) {
    throw new VaultError('validation_failed', 'permissions must be an array of strings')
  }
  const out: Permission[] = []
  const seen = new Set<Permission>()
  for (const raw of permissions) {
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new VaultError('validation_failed', 'permissions contains a non-string entry')
    }
    const p = raw.trim() as Permission
    if (!(ALL_PERMISSIONS as string[]).includes(p)) {
      throw new VaultError('validation_failed', `unknown permission: ${raw}`)
    }
    if (!seen.has(p)) {
      seen.add(p)
      out.push(p)
    }
  }
  if (out.length === 0) {
    throw new VaultError('validation_failed', 'permissions must contain at least one valid permission')
  }
  // Stable order so stored strings diff cleanly.
  return (ALL_PERMISSIONS as Permission[]).filter((p) => seen.has(p))
}

/** Clamp + validate the TTL. Throws if outside [60, 86400]. */
export function normalizeTtl(ttlSeconds: unknown): number {
  const n = typeof ttlSeconds === 'number' ? ttlSeconds : Number(ttlSeconds)
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new VaultError('validation_failed', 'ttlSeconds must be an integer number of seconds')
  }
  if (n < MIN_TTL_SECONDS) {
    throw new VaultError(
      'validation_failed',
      `ttlSeconds must be >= ${MIN_TTL_SECONDS}`,
    )
  }
  if (n > MAX_TTL_SECONDS) {
    throw new VaultError(
      'validation_failed',
      `ttlSeconds must be <= ${MAX_TTL_SECONDS} (24h)`,
    )
  }
  return n
}

/**
 * Create a new active `SecretLease`. The caller is responsible for authz
 * (admin OR the caller is the serviceClientId with value:read on the secret).
 * Audits `lease.issue` with outcome success. Never stores the secret value.
 */
export async function issueLease(input: IssueLeaseInput): Promise<SecretLeaseRow> {
  const { vaultSecretId, serviceClientId, audit } = input
  const permissions = normalizePermissions(input.permissions)
  const ttlSeconds = normalizeTtl(input.ttlSeconds)

  // Verify the secret + client exist (and the client is in the same workspace).
  const secret = await db.vaultSecret.findUnique({ where: { id: vaultSecretId } })
  if (!secret) throw new VaultError('secret_not_found')
  const client = await db.serviceClient.findUnique({ where: { id: serviceClientId } })
  if (!client) throw new VaultError('client_not_found')
  if (client.workspaceId !== secret.workspaceId) {
    throw new VaultError(
      'validation_failed',
      'service client and secret must belong to the same workspace',
    )
  }

  const now = new Date()
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000)
  const grantedPermissions = permissions.join(',')

  const row = await db.secretLease.create({
    data: {
      vaultSecretId,
      serviceClientId,
      grantedPermissions,
      issuedAt: now,
      expiresAt,
      revokedAt: null,
      status: 'active',
      createdAt: now,
    },
  })

  await recordEvent({
    workspaceId: audit.workspaceId,
    actorClientId: audit.actorClientId,
    vaultSecretId,
    action: 'lease.issue',
    outcome: 'success',
    reasonCode: `ttl=${ttlSeconds}s;perms=${grantedPermissions}`,
    requestId: audit.requestId ?? null,
    sourceIp: audit.sourceIp ?? null,
  })

  return serializeLease(row)
}

/**
 * List leases with optional filters. Always includes the related
 * `secretPath` + `serviceClientName` so route handlers can return
 * `LeaseListItem[]` directly.
 *
 * NOTE: the `SecretLease` model has no Prisma relations declared (the schema
 * only stores FK columns), so we resolve the path + client name with two
 * parallel `findMany` calls and join in code. With ≤ a few hundred active
 * leases this is cheap; if it ever becomes a hotspot we'd add `@relation`
 * to the schema.
 */
export async function listLeases(filter: {
  vaultSecretId?: string
  serviceClientId?: string
  activeOnly?: boolean
}): Promise<LeaseListItem[]> {
  const where: {
    vaultSecretId?: string
    serviceClientId?: string
    status?: string
  } = {}
  if (filter.vaultSecretId) where.vaultSecretId = filter.vaultSecretId
  if (filter.serviceClientId) where.serviceClientId = filter.serviceClientId
  if (filter.activeOnly) where.status = 'active'

  const rows = await db.secretLease.findMany({
    where,
    orderBy: { createdAt: 'desc' },
  })

  if (rows.length === 0) return []

  const secretIds = Array.from(new Set(rows.map((r) => r.vaultSecretId)))
  const clientIds = Array.from(new Set(rows.map((r) => r.serviceClientId)))
  const [secrets, clients] = await Promise.all([
    db.vaultSecret.findMany({ where: { id: { in: secretIds } }, select: { id: true, path: true } }),
    db.serviceClient.findMany({ where: { id: { in: clientIds } }, select: { id: true, name: true } }),
  ])
  const secretById = new Map(secrets.map((s) => [s.id, s.path]))
  const clientById = new Map(clients.map((c) => [c.id, c.name]))

  return rows.map((r) => ({
    ...serializeLease(r),
    secretPath: secretById.get(r.vaultSecretId) ?? '',
    serviceClientName: clientById.get(r.serviceClientId) ?? '',
  }))
}

/**
 * Revoke a lease: sets `status="revoked"`, `revokedAt=now`. Audits
 * `lease.revoke`. Throws `resource_not_found` when the lease doesn't exist.
 */
export async function revokeLease(
  leaseId: string,
  audit: LeaseAuditCtx,
): Promise<LeaseListItem> {
  const existing = await db.secretLease.findUnique({ where: { id: leaseId } })
  if (!existing) throw new VaultError('resource_not_found', 'lease not found')

  const now = new Date()
  const updated = await db.secretLease.update({
    where: { id: leaseId },
    data: {
      status: 'revoked',
      revokedAt: now,
    },
  })

  await recordEvent({
    workspaceId: audit.workspaceId,
    actorClientId: audit.actorClientId,
    vaultSecretId: existing.vaultSecretId,
    action: 'lease.revoke',
    outcome: 'success',
    requestId: audit.requestId ?? null,
    sourceIp: audit.sourceIp ?? null,
  })

  // Resolve secret path + client name manually (no Prisma relations on this model).
  const [secret, client] = await Promise.all([
    db.vaultSecret.findUnique({
      where: { id: existing.vaultSecretId },
      select: { path: true },
    }),
    db.serviceClient.findUnique({
      where: { id: existing.serviceClientId },
      select: { name: true },
    }),
  ])

  return {
    ...serializeLease(updated),
    secretPath: secret?.path ?? '',
    serviceClientName: client?.name ?? '',
  }
}

/**
 * Opportunistic GC: mark any active leases past their `expiresAt` as
 * `status="expired"`. Returns the number of rows transitioned.
 */
export async function cleanupExpiredLeases(): Promise<number> {
  const now = new Date()
  const result = await db.secretLease.updateMany({
    where: {
      status: 'active',
      expiresAt: { lt: now },
    },
    data: { status: 'expired' },
  })
  return result.count
}
