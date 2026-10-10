// POST /api/v1/dashboard/remediate body { secretId, violation }
// admin only. One-click compliance remediation: generates a new value for the
// violating secret, creates a new active SecretVersion (retires the prior),
// updates VaultSecret.currentVersionId + expiresAt, records a `secret.remediate`
// audit event with reasonCode=violation, and creates a `RotationRun` row with
// operation="remediate", status="succeeded".
//
// DEMO ONLY — in production this would require operator approval + a real
// provider-side rotation. The synthesized value is a kind-appropriate random
// string with a stable prefix so the new material is visually identifiable as
// remediation output. The plaintext is NEVER logged.
//
// Violation set (reasonCode): stale_rotation | never_rotated | expired_secret
// | expiring_soon. For `expired_secret` / `expiring_soon`, the secret gets a
// fresh 24h lease; for the other two, `expiresAt` is left null (rotation
// itself is the remediation, not a new expiry).
import {
  handle,
  json,
  body,
  adminOrThrow,
  getRequestId,
  getSourceIp,
} from '@/lib/vault/api-helpers'
import { db } from '@/lib/db'
import { VaultError } from '@/lib/vault/errors'
import { encryptValue } from '@/lib/vault/crypto'
import { recordEvent, recordEventCritical, recordEventInTx } from '@/lib/vault/audit'
import { randomBytes } from 'node:crypto'

const HOUR_MS = 60 * 60 * 1000
const REMEDIATION_LEASE_HOURS = 24

const VALID_VIOLATIONS = new Set<string>([
  'stale_rotation',
  'never_rotated',
  'expired_secret',
  'expiring_soon',
])

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex')
}

/**
 * Kind-appropriate synthetic remediation value. Prefixes are deliberately
 * distinct from the rotate-route's syntheticValue so audit / diff tooling can
 * tell a remediation pass apart from a manual rotation. Lengths per task
 * spec (R6-backend).
 */
function syntheticRemediationValue(kind: string): string {
  switch (kind) {
    case 'access_token':
      return `ROT_${randomHex(16)}`
    case 'api_key':
      return `RK_${randomHex(20)}`
    case 'refresh_token':
      return `RT_${randomHex(24)}`
    case 'private_key':
      return `PK_${randomHex(32)}`
    default:
      return `VAL_${randomHex(16)}`
  }
}

function serializeSecret(s: {
  id: string
  workspaceId: string
  path: string
  name: string
  kind: string
  classification: string
  environment: string
  provider: string | null
  status: string
  expiresAt: Date | null
  currentVersionId: string | null
  createdAt: Date
  updatedAt: Date
}) {
  return {
    id: s.id,
    workspaceId: s.workspaceId,
    path: s.path,
    name: s.name,
    kind: s.kind,
    classification: s.classification,
    environment: s.environment,
    provider: s.provider,
    status: s.status,
    expiresAt: s.expiresAt ? s.expiresAt.toISOString() : null,
    currentVersionId: s.currentVersionId,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  }
}

function serializeVersion(v: {
  id: string
  vaultSecretId: string
  versionNumber: number
  status: string
  cryptoScheme: string
  kmsKeyRef: string
  createdBy: string
  activatedAt: Date
  retiredAt: Date | null
  createdAt: Date
}) {
  return {
    id: v.id,
    vaultSecretId: v.vaultSecretId,
    versionNumber: v.versionNumber,
    status: v.status,
    cryptoScheme: v.cryptoScheme,
    kmsKeyRef: v.kmsKeyRef,
    createdBy: v.createdBy,
    activatedAt: v.activatedAt.toISOString(),
    retiredAt: v.retiredAt ? v.retiredAt.toISOString() : null,
    createdAt: v.createdAt.toISOString(),
  }
}

export const POST = handle(
  async (req) => {
    await adminOrThrow(req)

    const input = await body<{ secretId?: string; violation?: string }>(req)
    const secretId = (input.secretId || '').trim()
    const violation = (input.violation || '').trim()

    if (!secretId) throw new VaultError('validation_failed', 'secretId is required')
    if (!VALID_VIOLATIONS.has(violation)) {
      throw new VaultError(
        'validation_failed',
        `violation must be one of: ${Array.from(VALID_VIOLATIONS).join(', ')}`,
      )
    }

    const secret = await db.vaultSecret.findUnique({ where: { id: secretId } })
    if (!secret) throw new VaultError('secret_not_found')

    const now = new Date()
    // For expired_secret / expiring_soon, give a fresh 24h lease so the
    // operator gets a window to actually rotate upstream. For the rotation-
    // policy violations (stale_rotation / never_rotated), the remediation IS
    // the rotation — leave expiresAt alone so we don't accidentally expire a
    // currently-valid credential.
    const expiresAt =
      violation === 'expired_secret' || violation === 'expiring_soon'
        ? new Date(now.getTime() + REMEDIATION_LEASE_HOURS * HOUR_MS)
        : secret.expiresAt

    const result = await db.$transaction(async (tx) => {
      const last = await tx.secretVersion.findFirst({
        where: { vaultSecretId: secret.id },
        orderBy: { versionNumber: 'desc' },
      })
      const nextVersionNumber = (last?.versionNumber ?? 0) + 1

      // Encrypt the synthesized value with AAD bound to the record identity
      // (workspaceId, vaultSecretId, versionNumber) so the new ciphertext can't
      // be moved to a different record without a GCM auth-tag failure.
      const aad = {
        workspaceId: secret.workspaceId,
        vaultSecretId: secret.id,
        versionNumber: nextVersionNumber,
      }
      const enc = await encryptValue(syntheticRemediationValue(secret.kind), aad)

      const newVersion = await tx.secretVersion.create({
        data: {
          vaultSecretId: secret.id,
          versionNumber: nextVersionNumber,
          ciphertext: enc.ciphertext,
          encryptedDataKey: enc.encryptedDataKey,
          kmsKeyRef: enc.kmsKeyRef,
          cryptoScheme: enc.cryptoScheme,
          status: 'active',
          createdBy: 'admin',
          activatedAt: now,
        },
      })

      if (last && last.status === 'active') {
        await tx.secretVersion.update({
          where: { id: last.id },
          data: { status: 'retired', retiredAt: now },
        })
      }

      const updatedSecret = await tx.vaultSecret.update({
        where: { id: secret.id },
        data: { currentVersionId: newVersion.id, expiresAt, updatedAt: now },
      })

      // Durable record of the remediation run. Idempotency key + correlation
      // id are random — this is a fresh run, not a retry of an existing one.
      const idempotencyKey = randomHex(16)
      const correlationId = randomHex(16)
      const run = await tx.rotationRun.create({
        data: {
          vaultSecretId: secret.id,
          operation: 'remediate',
          status: 'succeeded',
          attemptCount: 1,
          idempotencyKey,
          runAfter: now,
          startedAt: now,
          completedAt: now,
          resultVersionId: newVersion.id,
          correlationId,
        },
      })

      // Value-free audit trail — never log the synthesized plaintext. The
      // violation kind rides along as the reasonCode so compliance tooling can
      // correlate the remediation with the original violation.
      //
      // Transactional-outbox: the `secret.remediate` SUCCESS audit is
      // persisted inside the same transaction as the new version +
      // retirement + run row. If the audit write fails, the whole
      // transaction rolls back (no unaudited remediation). If all succeed,
      // they commit together — atomic (R13-outbox).
      await recordEventInTx(tx, {
        workspaceId: secret.workspaceId,
        actorClientId: null,
        vaultSecretId: secret.id,
        secretVersionId: newVersion.id,
        action: 'secret.remediate',
        outcome: 'success',
        reasonCode: violation,
        requestId: getRequestId(req),
        sourceIp: getSourceIp(req),
      })

      return { secret: updatedSecret, version: newVersion, run }
    })

    return json({
      secret: serializeSecret(result.secret),
      version: serializeVersion(result.version),
      remediated: violation,
    })
  },
  // Tight rate limit — remediate is a one-click privileged mutation that
  // synthesizes + activates a new secret version. 30 req/min per (token, IP)
  // key to throttle accidental / automated mass remediation.
  { rateLimitOpts: { requestsPerMinute: 30, burst: 30 } },
)
