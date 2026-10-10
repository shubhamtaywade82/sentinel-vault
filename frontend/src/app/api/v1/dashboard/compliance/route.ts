// GET /api/v1/dashboard/compliance?workspaceId= → 200 { summary, violations }
// admin only. Aggregates per-secret rotation-policy violations across the
// (workspace-scoped, non-revoked) VaultSecret set.
//
// Violation rules:
//   - stale_rotation  : daysStale > 90  (rotation-eligible kinds only)
//   - never_rotated  : versionCount === 1 (only one version exists)
//                       (rotation-eligible kinds only)
//   - expired_secret : secret.expiresAt set AND expiresAt < now
//   - expiring_soon  : secret.expiresAt set AND expiresAt > now
//                       AND expiresAt < now + 7 days
//
// A secret may have multiple violation rows; `summary.violations` is the
// distinct count of secrets with at least one violation.
// `compliant = totalSecrets - distinctViolations`.
// `complianceScore = round(compliant / totalSecrets * 100)` (or 100 when 0).
// Violations ordered by daysStale desc, capped at 20.
// Audit `dashboard.compliance`. Value-free.
import {
  handle,
  json,
  adminOrThrow,
  getRequestId,
  getSourceIp,
} from '@/lib/vault/api-helpers'
import { db } from '@/lib/db'
import { recordEvent } from '@/lib/vault/audit'
import type { ComplianceViolation } from '@/lib/vault/types'

// Kinds that participate in rotation-policy enforcement. Secrets of other
// kinds (e.g. public_key, totp_seed) are not rotation-eligible and are
// skipped for the stale_rotation / never_rotated rules (but still subject
// to expiry rules).
const ROTATION_ELIGIBLE_KINDS = new Set<string>([
  'api_key',
  'access_token',
  'refresh_token',
  'client_secret',
  'connection_string',
  'private_key',
  'certificate',
])

const DAY_MS = 24 * 60 * 60 * 1000

export const GET = handle(async (req) => {
  await adminOrThrow(req)
  const workspaceId = new URL(req.url).searchParams.get('workspaceId') || undefined
  const secretWhere = workspaceId ? { workspaceId } : {}

  const now = new Date()
  const nowMs = now.getTime()
  const sevenDaysMs = 7 * DAY_MS

  // 1. Load all non-revoked secrets in scope + their version counts.
  const secrets = await db.vaultSecret.findMany({
    where: { ...secretWhere, status: { not: 'revoked' } },
    select: {
      id: true,
      path: true,
      name: true,
      kind: true,
      expiresAt: true,
      _count: { select: { versions: true } },
    },
  })

  const totalSecrets = secrets.length

  if (totalSecrets === 0) {
    // Empty workspace — fully compliant by definition.
    await recordEvent({
      workspaceId: workspaceId ?? null,
      actorClientId: null,
      action: 'dashboard.compliance',
      outcome: 'success',
      requestId: getRequestId(req),
      sourceIp: getSourceIp(req),
    })
    return json({
      summary: {
        totalSecrets: 0,
        compliant: 0,
        violations: 0,
        complianceScore: 100,
      },
      violations: [],
    })
  }

  // 2. Load all active versions for these secrets, then pick the highest
  //    versionNumber per secret (its `activatedAt` = "last rotated" date).
  const secretIds = secrets.map((s) => s.id)
  const activeVersions = await db.secretVersion.findMany({
    where: { vaultSecretId: { in: secretIds }, status: 'active' },
    select: {
      vaultSecretId: true,
      versionNumber: true,
      activatedAt: true,
    },
    orderBy: { versionNumber: 'desc' },
  })
  // First occurrence per secret = highest versionNumber (sorted desc).
  const lastRotatedBySecret = new Map<
    string,
    { versionNumber: number; activatedAt: Date }
  >()
  for (const v of activeVersions) {
    if (!lastRotatedBySecret.has(v.vaultSecretId)) {
      lastRotatedBySecret.set(v.vaultSecretId, {
        versionNumber: v.versionNumber,
        activatedAt: v.activatedAt,
      })
    }
  }

  // 3. Compute violations per secret.
  const violations: ComplianceViolation[] = []
  const violatingSecretIds = new Set<string>()

  for (const s of secrets) {
    const lastRotated = lastRotatedBySecret.get(s.id)
    const lastRotatedAt = lastRotated ? lastRotated.activatedAt.toISOString() : null
    const daysStale = lastRotated
      ? Math.floor((nowMs - lastRotated.activatedAt.getTime()) / DAY_MS)
      : 0
    const versionCount = s._count.versions
    const isRotationEligible = ROTATION_ELIGIBLE_KINDS.has(s.kind)
    const expiresAtMs = s.expiresAt ? s.expiresAt.getTime() : null

    let hasViolation = false

    if (isRotationEligible && lastRotated && daysStale > 90) {
      violations.push({
        secretId: s.id,
        path: s.path,
        kind: s.kind,
        violation: 'stale_rotation',
        daysStale,
        lastRotatedAt,
        expiresAt: s.expiresAt ? s.expiresAt.toISOString() : null,
      })
      hasViolation = true
    }

    if (isRotationEligible && versionCount === 1) {
      violations.push({
        secretId: s.id,
        path: s.path,
        kind: s.kind,
        violation: 'never_rotated',
        daysStale,
        lastRotatedAt,
        expiresAt: s.expiresAt ? s.expiresAt.toISOString() : null,
      })
      hasViolation = true
    }

    if (expiresAtMs !== null && expiresAtMs < nowMs) {
      violations.push({
        secretId: s.id,
        path: s.path,
        kind: s.kind,
        violation: 'expired_secret',
        daysStale,
        lastRotatedAt,
        expiresAt: s.expiresAt ? s.expiresAt.toISOString() : null,
      })
      hasViolation = true
    }

    if (
      expiresAtMs !== null &&
      expiresAtMs > nowMs &&
      expiresAtMs < nowMs + sevenDaysMs
    ) {
      violations.push({
        secretId: s.id,
        path: s.path,
        kind: s.kind,
        violation: 'expiring_soon',
        daysStale,
        lastRotatedAt,
        expiresAt: s.expiresAt ? s.expiresAt.toISOString() : null,
      })
      hasViolation = true
    }

    if (hasViolation) violatingSecretIds.add(s.id)
  }

  // 4. Order by daysStale desc (most stale first), then path asc for determinism.
  violations.sort((a, b) => {
    if (b.daysStale !== a.daysStale) return b.daysStale - a.daysStale
    return a.path.localeCompare(b.path)
  })
  const cappedViolations = violations.slice(0, 20)

  const distinctViolations = violatingSecretIds.size
  const compliant = totalSecrets - distinctViolations
  const complianceScore = Math.round((compliant / totalSecrets) * 100)

  // 5. Audit (value-free — no secret material referenced).
  await recordEvent({
    workspaceId: workspaceId ?? null,
    actorClientId: null,
    action: 'dashboard.compliance',
    outcome: 'success',
    requestId: getRequestId(req),
    sourceIp: getSourceIp(req),
  })

  return json({
    summary: {
      totalSecrets,
      compliant,
      violations: distinctViolations,
      complianceScore,
    },
    violations: cappedViolations,
  })
})
