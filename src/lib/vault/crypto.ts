// server-only — AES-256-GCM envelope encryption with AAD binding.
// See VAULT_CONTRACT.md §5.
//
// R12 in-app KMS: encrypt/decrypt now go through the key ring in `kms.ts`.
// Each SecretVersion records the `kmsKeyRef` of the master key version that
// wrapped its data key, so rotation + re-wrap work. The wrap/unwrap of data
// keys uses the SAME nonce||payload||tag convention as before (AAD='keywrap')
// so existing ciphertext (wrapped under `local-master-v1` before the KMS
// migration) stays decryptable via a backwards-compat shim.
//
// Ciphertext layout (base64):  12-byte nonce || ciphertext || 16-byte auth tag
// EncryptedDataKey layout (base64): 12-byte wrap-nonce || 32-byte wrapped key || 16-byte auth tag

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

import { getActiveKmsKeyRef, unwrapMasterKey } from './kms'
import { VaultError } from './errors'

export interface AadInput {
  workspaceId: string
  vaultSecretId: string
  versionNumber: number
}

export interface EncryptResult {
  ciphertext: string
  encryptedDataKey: string
  kmsKeyRef: string
  cryptoScheme: string
}

export interface DecryptInput {
  ciphertext: string
  encryptedDataKey: string
  kmsKeyRef: string
}

export interface DecryptContext {
  secretVersionId?: string
  actorClientId?: string | null
  requestId?: string | null
}

export const CRYPTO_SCHEME = 'aes-256-gcm-envelope-v1'
const KEYWRAP_AAD = 'keywrap'

const NONCE_LEN = 12
const TAG_LEN = 16

/**
 * Canonical AAD string for a (workspaceId, vaultSecretId, versionNumber) tuple.
 * Stable key order, no whitespace, so the same triple always produces the same
 * AAD bytes on both encrypt and decrypt.
 */
export function buildAad(aad: AadInput): string {
  const canonical = {
    workspaceId: aad.workspaceId,
    vaultSecretId: aad.vaultSecretId,
    versionNumber: aad.versionNumber,
  }
  return JSON.stringify(canonical, Object.keys(canonical).sort())
}

/** Convenience alias kept for the spec's `AAD` helper name. */
export const AAD = buildAad

function splitNonceTag(blob: Buffer): { nonce: Buffer; payload: Buffer; tag: Buffer } {
  if (blob.length < NONCE_LEN + TAG_LEN) {
    throw new VaultError('decryption_failed', 'ciphertext too short')
  }
  const nonce = blob.subarray(0, NONCE_LEN)
  const tag = blob.subarray(blob.length - TAG_LEN)
  const payload = blob.subarray(NONCE_LEN, blob.length - TAG_LEN)
  return { nonce, payload, tag }
}

/**
 * Encrypts a plaintext secret value under a fresh per-record data key, which
 * is itself wrapped by the ACTIVE master key from the in-app KMS ring.
 * Returns the strings to persist on the `SecretVersion` row.
 *
 * ASYNC because the KMS ring lookup is async (DB read on first call, then
 * cached).
 */
export async function encryptValue(plaintext: string, aad: AadInput): Promise<EncryptResult> {
  if (typeof plaintext !== 'string') {
    throw new VaultError('validation_failed', 'plaintext must be a string')
  }
  const dataKey = randomBytes(32)
  const kmsKeyRef = await getActiveKmsKeyRef()
  const masterKey = await unwrapMasterKey(kmsKeyRef)
  const aadBuf = Buffer.from(buildAad(aad), 'utf8')

  // ---- Encrypt the value with the data key (AAD bound to record identity) ----
  const valueNonce = randomBytes(NONCE_LEN)
  const valueCipher = createCipheriv('aes-256-gcm', dataKey, valueNonce)
  valueCipher.setAAD(aadBuf)
  const enc = Buffer.concat([valueCipher.update(plaintext, 'utf8'), valueCipher.final()])
  const tag = valueCipher.getAuthTag()
  const ciphertextBuf = Buffer.concat([valueNonce, enc, tag])

  // ---- Wrap the data key with the master key (constant AAD) ----
  const wrapNonce = randomBytes(NONCE_LEN)
  const wrapCipher = createCipheriv('aes-256-gcm', masterKey, wrapNonce)
  wrapCipher.setAAD(Buffer.from(KEYWRAP_AAD, 'utf8'))
  const wrappedEnc = Buffer.concat([wrapCipher.update(dataKey), wrapCipher.final()])
  const wrapTag = wrapCipher.getAuthTag()
  const encryptedDataKeyBuf = Buffer.concat([wrapNonce, wrappedEnc, wrapTag])

  return {
    ciphertext: ciphertextBuf.toString('base64'),
    encryptedDataKey: encryptedDataKeyBuf.toString('base64'),
    kmsKeyRef,
    cryptoScheme: CRYPTO_SCHEME,
  }
}

/**
 * Decrypts a SecretVersion back to plaintext. Any tampering — including a
 * moved ciphertext bound to a different (workspaceId, vaultSecretId, versionNumber)
 * — produces a GCM auth-tag failure and is mapped to `VaultError("decryption_failed")`.
 *
 * ASYNC because unwrapping the data key goes through the KMS ring (which may
 * need to unwrap a master key version with the root-of-trust).
 *
 * Supports both the new KMS key ring (`local-v1`, `local-v2`, ...) and the
 * legacy `local-master-v1` ref from before the KMS migration (backwards-compat:
 * legacy refs use the root-of-truth master key directly, since that's what
 * wrapped them originally).
 */
export async function decryptValue(
  input: DecryptInput,
  aad: AadInput,
  context?: DecryptContext,
): Promise<string> {
  const aadBuf = Buffer.from(buildAad(aad), 'utf8')

  // ---- Unwrap the data key via the KMS ring ----
  let dataKey: Buffer
  try {
    const wrapBuf = Buffer.from(input.encryptedDataKey, 'base64')
    const { nonce: wnonce, payload: wpayload, tag: wtag } = splitNonceTag(wrapBuf)

    // Backwards-compat: the legacy `local-master-v1` ref (from before the KMS
    // migration) was wrapped by the root-of-trust master key directly, not by
    // a ring master key. For that ref, use the root key. For all `local-vN`
    // refs, use the KMS ring.
    let masterKey: Buffer
    if (input.kmsKeyRef === 'local-master-v1') {
      // Legacy path — root master key wraps data keys directly.
      const { getMasterKey } = await import('./key-service')
      masterKey = getMasterKey()
    } else {
      masterKey = await unwrapMasterKey(input.kmsKeyRef, {
        secretVersionId: context?.secretVersionId,
        actorClientId: context?.actorClientId,
        requestId: context?.requestId,
      })
    }

    const wrapDecipher = createDecipheriv('aes-256-gcm', masterKey, wnonce)
    wrapDecipher.setAAD(Buffer.from(KEYWRAP_AAD, 'utf8'))
    wrapDecipher.setAuthTag(wtag)
    dataKey = Buffer.concat([wrapDecipher.update(wpayload), wrapDecipher.final()])
  } catch (err) {
    if (err instanceof VaultError) throw err
    throw new VaultError('decryption_failed')
  }

  if (dataKey.length !== 32) {
    throw new VaultError('decryption_failed')
  }

  // ---- Decrypt the value with the data key, AAD verified ----
  try {
    const valueBuf = Buffer.from(input.ciphertext, 'base64')
    const { nonce, payload, tag } = splitNonceTag(valueBuf)
    const valueDecipher = createDecipheriv('aes-256-gcm', dataKey, nonce)
    valueDecipher.setAAD(aadBuf)
    valueDecipher.setAuthTag(tag)
    const plain = Buffer.concat([valueDecipher.update(payload), valueDecipher.final()])
    return plain.toString('utf8')
  } catch {
    throw new VaultError('decryption_failed')
  }
}

export { VaultError }
