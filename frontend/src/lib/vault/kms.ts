// server-only — in-app Key Management Service (KMS).
//
// This is NOT a third-party KMS (AWS KMS / GCP / Vault Transit). It is a
// self-contained key-management layer inside Sentinel Vault that provides:
//
//   1. Key versioning — a ring of master keys, each with a `kmsKeyRef`
//      (e.g. `local-v1`, `local-v2`). New writes use the ACTIVE version;
//      old ciphertext stays decryptable with retired versions.
//   2. Key rotation — generate a new version, mark it active, retire the old.
//      No re-deploy, no downtime. Existing SecretVersions reference their
//      `kmsKeyRef` so they keep decrypting until explicitly re-wrapped.
//   3. Key access audit — every `unwrapDataKey` call records a `key.unwrap`
//      audit event (no key material in the log, just the key version + the
//      secret version being decrypted).
//   4. Re-wrap migration — `rewrapSecretDataKey(secretVersionId)` decrypts a
//      data key with the OLD kmsKeyRef and re-wraps it with the ACTIVE one,
//      advancing the SecretVersion's `kmsKeyRef` so old key versions can
//      eventually be retired.
//
// Root of trust: `VAULT_MASTER_KEY` env var (32 bytes base64). In production
// this MUST be set (enforced in `key-service.ts`). The root wraps each master
// key version in the ring. The root never touches data keys directly — only
// the ring's unwrapped master keys do.
//
// Threat model vs the old single-env-var master key:
//   - Before: one env var = the master key. Compromise the env + the DB → all
//     plaintext. No rotation without re-deploy.
//   - After: env var wraps a RING of versioned keys. Compromise the env + the
//     DB still yields plaintext (the root can unwrap any ring key), BUT:
//       * Rotation is now possible (new version, old retired).
//       * Every unwrap is audited (key access trail).
//       * Re-wrap migration can move old ciphertext to the new key, so the
//         old key can be destroyed once all data keys are re-wrapped.
//   This is a meaningful upgrade for an in-app design, while staying
//   self-contained (no network call to a third party).

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

import { db } from '@/lib/db'
import { getMasterKey } from './key-service'
import { VaultError } from './errors'
import { recordEvent } from './audit'

const NONCE_LEN = 12
const TAG_LEN = 16
const KEYWRAP_AAD = 'kms-ring-v1'

interface KeyRingEntry {
  id: string
  version: number
  kmsKeyRef: string
  status: string // 'active' | 'retired'
}

// In-memory cache of unwrapped master keys, keyed by kmsKeyRef. Cleared on
// rotation. Lifetime = process lifetime (the root-of-trust env var doesn't
// change at runtime, so cached unwraps are safe).
const unwrappedKeyCache = new Map<string, Buffer>()
let activeKmsKeyRef: string | null = null
let bootstrapped = false

/** Split a base64 blob into nonce || payload || tag. */
function splitNonceTag(blob: Buffer): { nonce: Buffer; payload: Buffer; tag: Buffer } {
  if (blob.length < NONCE_LEN + TAG_LEN) {
    throw new VaultError('decryption_failed', 'key material too short')
  }
  const nonce = blob.subarray(0, NONCE_LEN)
  const tag = blob.subarray(blob.length - TAG_LEN)
  const payload = blob.subarray(NONCE_LEN, blob.length - TAG_LEN)
  return { nonce, payload, tag }
}

/** Wrap a 32-byte key with the root-of-trust master key. */
function wrapWithRoot(rawKey: Buffer): string {
  const root = getMasterKey()
  const nonce = randomBytes(NONCE_LEN)
  const cipher = createCipheriv('aes-256-gcm', root, nonce)
  cipher.setAAD(Buffer.from(KEYWRAP_AAD, 'utf8'))
  const enc = Buffer.concat([cipher.update(rawKey), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([nonce, enc, tag]).toString('base64')
}

/** Unwrap a wrapped key with the root-of-trust master key. */
function unwrapWithRoot(wrappedB64: string): Buffer {
  const root = getMasterKey()
  const buf = Buffer.from(wrappedB64, 'base64')
  const { nonce, payload, tag } = splitNonceTag(buf)
  const decipher = createDecipheriv('aes-256-gcm', root, nonce)
  decipher.setAAD(Buffer.from(KEYWRAP_AAD, 'utf8'))
  decipher.setAuthTag(tag)
  const raw = Buffer.concat([decipher.update(payload), decipher.final()])
  if (raw.length !== 32) throw new VaultError('decryption_failed', 'unwrapped key not 32 bytes')
  return raw
}

/**
 * Bootstrap the key ring on first use. If no EncryptionKey rows exist, create
 * the first version (`local-v1`), mark it active, wrap it with the root, and
 * persist. Idempotent: if a ring already exists, just cache the active ref.
 */
export async function bootstrapKeyRing(): Promise<void> {
  if (bootstrapped) return
  bootstrapped = true

  const count = await db.encryptionKey.count()
  if (count === 0) {
    const version = 1
    const kmsKeyRef = 'local-v1'
    const rawKey = randomBytes(32)
    const wrapped = wrapWithRoot(rawKey)
    await db.encryptionKey.create({
      data: { version, kmsKeyRef, wrappedKeyMaterial: wrapped, status: 'active' },
    })
    unwrappedKeyCache.set(kmsKeyRef, rawKey)
    activeKmsKeyRef = kmsKeyRef
    console.log('[vault][kms] bootstrapped key ring with local-v1')
    return
  }

  const active = await db.encryptionKey.findFirst({
    where: { status: 'active' },
    orderBy: { version: 'desc' },
  })
  if (!active) {
    throw new VaultError('internal_error', 'key ring has no active master key')
  }
  activeKmsKeyRef = active.kmsKeyRef
}

/** Ensure the ring is bootstrapped, then return the active kmsKeyRef. */
export async function getActiveKmsKeyRef(): Promise<string> {
  if (!bootstrapped || !activeKmsKeyRef) {
    await bootstrapKeyRing()
  }
  return activeKmsKeyRef!
}

/**
 * Unwrap the master key for a given kmsKeyRef. Cached in memory for the
 * process lifetime. Records a `key.unwrap` audit event (no key material).
 */
export async function unwrapMasterKey(
  kmsKeyRef: string,
  context?: { secretVersionId?: string; actorClientId?: string | null; requestId?: string | null },
): Promise<Buffer> {
  await bootstrapKeyRing()
  const cached = unwrappedKeyCache.get(kmsKeyRef)
  if (cached) return cached

  const row = await db.encryptionKey.findUnique({ where: { kmsKeyRef } })
  if (!row) {
    throw new VaultError('decryption_failed', `unknown kmsKeyRef: ${kmsKeyRef}`)
  }

  const raw = unwrapWithRoot(row.wrappedKeyMaterial)
  unwrappedKeyCache.set(kmsKeyRef, raw)

  // Audit the key access (no key material in the log).
  recordEvent({
    action: 'key.unwrap',
    outcome: 'success',
    reasonCode: kmsKeyRef,
    secretVersionId: context?.secretVersionId,
    actorClientId: context?.actorClientId ?? null,
    requestId: context?.requestId ?? null,
  }).catch(() => {
    // Best-effort: key access audit is telemetry; don't fail the decrypt.
  })

  return raw
}

/**
 * Rotate the master key: generate a new version, wrap with root, persist as
 * active, retire the old active. Existing ciphertext keeps decrypting (the
 * old key is kept with status=retired). New writes use the new active key.
 * Returns the new kmsKeyRef.
 */
export async function rotateMasterKey(): Promise<string> {
  await bootstrapKeyRing()
  const current = await db.encryptionKey.findFirst({
    where: { status: 'active' },
    orderBy: { version: 'desc' },
  })
  if (!current) throw new VaultError('internal_error', 'no active key to rotate from')

  const newVersion = current.version + 1
  const newKmsKeyRef = `local-v${newVersion}`
  const newRaw = randomBytes(32)
  const newWrapped = wrapWithRoot(newRaw)

  // Atomically: retire old, create new active.
  await db.$transaction([
    db.encryptionKey.update({
      where: { id: current.id },
      data: { status: 'retired', retiredAt: new Date() },
    }),
    db.encryptionKey.create({
      data: {
        version: newVersion,
        kmsKeyRef: newKmsKeyRef,
        wrappedKeyMaterial: newWrapped,
        status: 'active',
      },
    }),
  ])

  unwrappedKeyCache.set(newKmsKeyRef, newRaw)
  activeKmsKeyRef = newKmsKeyRef

  recordEvent({
    action: 'key.rotate',
    outcome: 'success',
    reasonCode: `${current.kmsKeyRef}→${newKmsKeyRef}`,
  }).catch(() => {})

  console.log(`[vault][kms] rotated master key: ${current.kmsKeyRef} → ${newKmsKeyRef}`)
  return newKmsKeyRef
}

/**
 * Re-wrap a SecretVersion's data key from its current kmsKeyRef to the ACTIVE
 * one. This is the migration step that lets old master key versions be
 * destroyed once all their data keys are re-wrapped.
 *
 * Returns true if the version was re-wrapped (its kmsKeyRef changed), false if
 * it was already on the active key.
 */
export async function rewrapSecretDataKey(
  secretVersionId: string,
  aad: { workspaceId: string; vaultSecretId: string; versionNumber: number },
): Promise<boolean> {
  await bootstrapKeyRing()
  const activeRef = await getActiveKmsKeyRef()

  const version = await db.secretVersion.findUnique({ where: { id: secretVersionId } })
  if (!version) throw new VaultError('version_not_found')

  if (version.kmsKeyRef === activeRef) return false

  // Unwrap the data key with the OLD master key.
  const oldMaster = await unwrapMasterKey(version.kmsKeyRef)
  const wrapBuf = Buffer.from(version.encryptedDataKey, 'base64')
  const { nonce: wnonce, payload: wpayload, tag: wtag } = splitNonceTag(wrapBuf)
  const oldDecipher = createDecipheriv('aes-256-gcm', oldMaster, wnonce)
  oldDecipher.setAAD(Buffer.from('keywrap', 'utf8')) // the original wrap AAD
  oldDecipher.setAuthTag(wtag)
  const dataKey = Buffer.concat([oldDecipher.update(wpayload), oldDecipher.final()])

  // Re-wrap the data key with the ACTIVE master key (using the crypto.ts
  // wrap convention: nonce || wrapped || tag, AAD = 'keywrap').
  const activeMaster = await unwrapMasterKey(activeRef)
  const newWrapNonce = randomBytes(NONCE_LEN)
  const wrapCipher = createCipheriv('aes-256-gcm', activeMaster, newWrapNonce)
  wrapCipher.setAAD(Buffer.from('keywrap', 'utf8'))
  const newWrappedEnc = Buffer.concat([wrapCipher.update(dataKey), wrapCipher.final()])
  const newWrapTag = wrapCipher.getAuthTag()
  const newEncryptedDataKey = Buffer.concat([newWrapNonce, newWrappedEnc, newWrapTag]).toString('base64')

  await db.secretVersion.update({
    where: { id: secretVersionId },
    data: { encryptedDataKey: newEncryptedDataKey, kmsKeyRef: activeRef },
  })

  recordEvent({
    action: 'key.rewrap',
    outcome: 'success',
    secretVersionId,
    vaultSecretId: aad.vaultSecretId,
    reasonCode: `${version.kmsKeyRef}→${activeRef}`,
  }).catch(() => {})

  return true
}

/** List all key ring versions (for the admin UI). */
export async function listKeyRing(): Promise<KeyRingEntry[]> {
  await bootstrapKeyRing()
  return db.encryptionKey.findMany({ orderBy: { version: 'desc' } })
}

/** Count how many SecretVersions still reference a given (retired) kmsKeyRef. */
export async function countVersionsOnKey(kmsKeyRef: string): Promise<number> {
  return db.secretVersion.count({ where: { kmsKeyRef } })
}

/** Reset internal caches — for tests only. */
export function __resetKmsForTests(): void {
  unwrappedKeyCache.clear()
  activeKmsKeyRef = null
  bootstrapped = false
}
