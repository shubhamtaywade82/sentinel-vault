// server-only — master key / KMS provider abstraction.
// See VAULT_CONTRACT.md §5 and the security audit (R12) for the production
// hardening rationale.
//
// This module exposes a `KeyProvider` interface so production can plug in a
// real KMS (AWS KMS, GCP KMS, HashiCorp Vault Transit, Azure Key Vault) without
// changing the crypto call sites. The default `LocalMasterKeyProvider` is
// DEV-ONLY: it derives a key from a constant passphrase when
// `VAULT_MASTER_KEY` is unset. In production, a missing or malformed
// `VAULT_MASTER_KEY` causes startup to FAIL (no silent dev fallback).

import { randomBytes, scryptSync } from 'node:crypto'

import { assertProductionSecret, isProduction } from './env'

// Lazily computed, memoized master key. Once initialized it is reused for the
// lifetime of the process so that all envelope operations agree on the same key.
let cachedMasterKey: Buffer | null = null
let warnedAboutDevKey = false
let startupAssertionDone = false

const DEV_PASSPHRASE = 'vault-dev-master-key'
const DEV_SALT = 'vault-v1'
const KEY_LEN = 32
const KMS_KEY_REF_LOCAL = 'local-master-v1'

function base64DecodeOrNull(s: string | undefined): Buffer | null {
  if (!s) return null
  try {
    const buf = Buffer.from(s, 'base64')
    // Must decode to exactly 32 bytes; otherwise the env value is malformed.
    if (buf.length !== KEY_LEN) return null
    return buf
  } catch {
    return null
  }
}

/**
 * Run the production startup assertions once. In production:
 *   - `VAULT_MASTER_KEY` MUST be present and a valid base64 of 32 bytes.
 *   - It MUST NOT be the known dev default.
 * If the assertion fails we throw — the process must not start in a degraded
 * state.
 */
function assertStartupOnce(): void {
  if (startupAssertionDone) return
  startupAssertionDone = true
  if (isProduction()) {
    const envKey = process.env.VAULT_MASTER_KEY
    if (!envKey) {
      throw new Error(
        '[vault][key-service] VAULT_MASTER_KEY is required in production. Refusing to start.',
      )
    }
    const decoded = base64DecodeOrNull(envKey)
    if (!decoded) {
      throw new Error(
        '[vault][key-service] VAULT_MASTER_KEY is malformed in production (must be base64 of 32 bytes). Refusing to start.',
      )
    }
    // In production the local provider is still acceptable only if the operator
    // explicitly opts in via VAULT_KEY_PROVIDER=local. Otherwise we warn that
    // a real KMS is recommended (but do not fail — the key is valid).
    if (process.env.VAULT_KEY_PROVIDER !== 'local') {
      console.warn(
        '[vault][key-service] Production is using the LOCAL master key provider. A real KMS (AWS KMS / GCP / Vault Transit) is strongly recommended. Set VAULT_KEY_PROVIDER=local to acknowledge and silence this warning.',
      )
    }
  }
}

/**
 * Returns the 32-byte master key used to wrap per-record data keys.
 *
 * - If `process.env.VAULT_MASTER_KEY` is set, it MUST be the base64 encoding of
 *   32 raw bytes (e.g. `base64(crypto.randomBytes(32))`). In production a
 *   missing/malformed key FAILS startup. In demo/dev it falls back to a
 *   derived dev key with a loud `console.warn` exactly once.
 * - The dev fallback is ONLY available when `isProduction()` is false.
 */
export function getMasterKey(): Buffer {
  if (cachedMasterKey) return cachedMasterKey
  assertStartupOnce()

  const envKey = base64DecodeOrNull(process.env.VAULT_MASTER_KEY)
  if (envKey) {
    cachedMasterKey = envKey
    return cachedMasterKey
  }

  // Production should have already thrown in `assertStartupOnce`. Belt + braces.
  if (isProduction()) {
    throw new Error(
      '[vault][key-service] VAULT_MASTER_KEY missing in production. Refusing to use dev fallback.',
    )
  }

  if (!warnedAboutDevKey) {
    console.warn(
      '[vault][key-service] VAULT_MASTER_KEY missing or malformed — deriving a DEV-ONLY master key via scrypt. Do NOT use in production.',
    )
    warnedAboutDevKey = true
  }

  cachedMasterKey = scryptSync(DEV_PASSPHRASE, DEV_SALT, KEY_LEN)
  return cachedMasterKey
}

/**
 * Stable identifier for the (simulated) KMS key backing the envelope scheme.
 * Persisted on every `SecretVersion` row so future rotations can detect a
 * key change (and refuse / migrate appropriately).
 */
export function getKmsKeyRef(): string {
  return KMS_KEY_REF_LOCAL
}

/**
 * Returns a freshly generated 32-byte random key. Used for per-record data
 * keys; never reused across secrets/versions.
 */
export function generateDataKey(): Buffer {
  return randomBytes(KEY_LEN)
}

/**
 * Forces re-initialization of the cached master key. Exposed for tests and
 * for the rare case of an explicit key rotation hook in the future. Not
 * intended to be called from request handlers.
 */
export function __resetMasterKeyForTests(): void {
  cachedMasterKey = null
  warnedAboutDevKey = false
  startupAssertionDone = false
}

// ---------------------------------------------------------------------------
// KeyProvider interface — for plugging in a real KMS in production.
//
// The interface is intentionally minimal: `unwrapDataKey` takes the wrapped
// (encrypted) data key + its KMS key reference and returns the raw 32-byte
// data key. `wrapDataKey` takes a raw data key and returns the wrapped form
// + the KMS key ref to persist. A real KMS implementation would call the
// provider's Encrypt/Decrypt APIs here; the local implementation just uses
// the master key with AES-256-GCM.
//
// To wire a real KMS:
//   1. Implement `KeyProvider` (e.g. `AwsKmsProvider`).
//   2. Set `VAULT_KEY_PROVIDER=awskms` + the provider's env vars.
//   3. In `getActiveKeyProvider()` below, return your provider based on the env.
// The crypto module (`crypto.ts`) currently uses `getMasterKey()` directly
// for local envelope encryption; migrating it to call `getActiveKeyProvider()`
// is the production path. The interface is documented here so the boundary
// is explicit.
// ---------------------------------------------------------------------------

export interface KeyProvider {
  readonly name: string
  /** Unwrap (decrypt) a wrapped data key. Returns 32 raw bytes. */
  unwrapDataKey(wrapped: Buffer, kmsKeyRef: string): Promise<Buffer>
  /** Wrap (encrypt) a raw data key. Returns wrapped bytes + the KMS key ref. */
  wrapDataKey(raw: Buffer): Promise<{ wrapped: Buffer; kmsKeyRef: string }>
}

/**
 * Returns the active key provider based on `VAULT_KEY_PROVIDER`. Defaults to
 * the local provider. Production should override this to return a real KMS.
 * This is the integration point for the P1 audit finding "The encryption key
 * is not a real KMS integration".
 */
export function getActiveKeyProviderName(): string {
  return process.env.VAULT_KEY_PROVIDER || 'local'
}
