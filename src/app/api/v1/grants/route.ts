// GET /api/v1/grants → 200 { grants: GrantListItem[] }
// Admin only. Optional ?workspaceId= filters on the secret's workspace.
import { handle, json, adminOrThrow } from '@/lib/vault/api-helpers'
import { db } from '@/lib/db'
import { parsePermissions } from '@/lib/vault/authorization'

export const GET = handle(async (req) => {
  await adminOrThrow(req)
  const workspaceId = new URL(req.url).searchParams.get('workspaceId') || undefined

  const grants = await db.secretAccessGrant.findMany({
    include: {
      serviceClient: { select: { name: true } },
      vaultSecret: { select: { path: true, name: true, workspaceId: true } },
    },
  })

  const filtered = workspaceId
    ? grants.filter((g) => g.vaultSecret && g.vaultSecret.workspaceId === workspaceId)
    : grants

  const out = filtered.map((g) => ({
    id: g.id,
    serviceClientId: g.serviceClientId,
    serviceClientName: g.serviceClient.name,
    vaultSecretId: g.vaultSecretId,
    secretPath: g.vaultSecret?.path ?? '',
    secretName: g.vaultSecret?.name ?? '',
    permissions: g.permissions,
    createdAt: g.createdAt.toISOString(),
    updatedAt: g.updatedAt.toISOString(),
  }))

  return json({ grants: out })
})

// Re-export parsePermissions so callers can rely on the canonical shape; the
// API returns the raw comma-separated string (per the contract) but the
// frontend immediately parses via this helper.
export { parsePermissions }
