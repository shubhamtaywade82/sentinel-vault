// GET /api/v1/health/ready → 200 { status:"ready", db:"ok", crypto:"ok", kms:"ok", ts }
// → 503 { status:"unready", db, crypto, kms, ts } when DB/crypto/KMS unavailable.
// Per VAULT_CONTRACT.md §4.1: do NOT fail on provider availability.
// R12: also bootstraps + checks the in-app KMS key ring so the first encrypt
// inside a transaction doesn't deadlock trying to create the EncryptionKey row.
import { handle, json } from '@/lib/vault/api-helpers'
import { db } from '@/lib/db'
import { getMasterKey } from '@/lib/vault/key-service'
import { bootstrapKeyRing, getActiveKmsKeyRef } from '@/lib/vault/kms'

export const GET = handle(async () => {
  const ts = new Date().toISOString()
  let dbOk = 'ok'
  let cryptoOk = 'ok'
  let kmsOk = 'ok'
  try {
    await db.workspace.count()
  } catch {
    dbOk = 'error'
  }
  try {
    const key = getMasterKey()
    if (!Buffer.isBuffer(key) || key.length !== 32) cryptoOk = 'error'
  } catch {
    cryptoOk = 'error'
  }
  try {
    // Bootstrap the KMS key ring OUTSIDE any transaction so the first
    // encrypt-in-transaction doesn't deadlock on the EncryptionKey row create.
    await bootstrapKeyRing()
    await getActiveKmsKeyRef()
  } catch {
    kmsOk = 'error'
  }
  if (dbOk !== 'ok' || cryptoOk !== 'ok' || kmsOk !== 'ok') {
    return json({ status: 'unready', db: dbOk, crypto: cryptoOk, kms: kmsOk, ts }, 503)
  }
  return json({ status: 'ready', db: dbOk, crypto: cryptoOk, kms: kmsOk, ts })
})
