// GET /api/v1/admin/keys — admin-only. Lists the in-app KMS key ring: each
// version, its kmsKeyRef, status (active/retired), createdAt, retiredAt, and
// how many SecretVersions still reference it (so the operator knows when a
// retired key is safe to destroy after re-wrap migration).
import { handle, json, adminOrThrow } from '@/lib/vault/api-helpers'
import { listKeyRing, countVersionsOnKey, getActiveKmsKeyRef } from '@/lib/vault/kms'

export const GET = handle(async (req) => {
  await adminOrThrow(req)
  const ring = await listKeyRing()
  const active = await getActiveKmsKeyRef()
  const withCounts = await Promise.all(
    ring.map(async (k) => ({
      id: k.id,
      version: k.version,
      kmsKeyRef: k.kmsKeyRef,
      status: k.status,
      active: k.kmsKeyRef === active,
      versionCount: await countVersionsOnKey(k.kmsKeyRef),
      createdAt: k.createdAt.toISOString(),
      retiredAt: k.retiredAt ? k.retiredAt.toISOString() : null,
    })),
  )
  return json({ keys: withCounts, activeKmsKeyRef: active })
})
