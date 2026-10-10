// GET /api/v1/leases → 200 { leases: LeaseListItem[] }  (admin only)
// Query: ?activeOnly=true&serviceClientId=&workspaceId=
// Includes secretPath + serviceClientName. Runs `cleanupExpiredLeases()`
// opportunistically before returning so the caller never sees stale active
// rows past their expiry.
import { handle, json, adminOrThrow, query } from '@/lib/vault/api-helpers'
import { db } from '@/lib/db'
import { listLeases, cleanupExpiredLeases } from '@/lib/vault/leases'
import type { LeaseListItem, SecretLeaseRow } from '@/lib/vault/types'

export const GET = handle(async (req) => {
  await adminOrThrow(req)
  const sp = query(req)
  const activeOnly = sp.get('activeOnly') === 'true'
  const serviceClientId = sp.get('serviceClientId') || undefined
  const workspaceId = sp.get('workspaceId') || undefined

  // Opportunistic GC.
  void cleanupExpiredLeases().catch(() => {
    /* non-fatal */
  })

  // When a workspace filter is requested, scope by the secrets in that
  // workspace. We resolve the matching secret ids first then filter leases.
  let vaultSecretIds: string[] | undefined
  if (workspaceId) {
    const secrets = await db.vaultSecret.findMany({
      where: { workspaceId },
      select: { id: true },
    })
    vaultSecretIds = secrets.map((s) => s.id)
    if (vaultSecretIds.length === 0) return json({ leases: [] })
  }

  // listLeases doesn't support an `OR vaultSecretId IN [...]` filter directly,
  // so we post-filter when a workspace was requested.
  const leases = await listLeases({
    activeOnly,
    serviceClientId,
  })

  const filtered: LeaseListItem[] = vaultSecretIds
    ? leases.filter((l) => vaultSecretIds!.includes(l.vaultSecretId))
    : leases

  // Re-shape to ensure the response always carries SecretLeaseRow fields
  // (listLeases returns LeaseListItem which already extends SecretLeaseRow).
  const out: (SecretLeaseRow & { secretPath: string; serviceClientName: string })[] = filtered
  return json({ leases: out })
})
