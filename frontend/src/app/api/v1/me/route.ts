// GET /api/v1/me → 200 { client, grants } per VAULT_CONTRACT.md §4.2.
// admin realm:    permissions:["admin"], empty grants, clientType "worker".
// client realm:  permissions:[] (client has no implicit perms), grants
//                 resolved from the DB with secret path/name included.
import { handle, json, actor } from '@/lib/vault/api-helpers'
import { db } from '@/lib/db'
import { parsePermissions } from '@/lib/vault/authorization'
import { VaultError } from '@/lib/vault/errors'

export const GET = handle(async (req) => {
  const auth = await actor(req)
  if (auth.kind === 'none') throw new VaultError('unauthorized')

  if (auth.kind === 'admin') {
    return json({
      client: {
        id: 'admin',
        publicId: 'admin',
        name: 'Vault Administrator',
        clientType: 'worker',
        workspaceId: '',
        workspaceSlug: 'all',
        status: 'active',
        permissions: ['admin'],
      },
      grants: [],
    })
  }

  const client = auth.client
  // Load grants + secret metadata for this client.
  const grantRows = await db.secretAccessGrant.findMany({
    where: { serviceClientId: client.id },
    include: { vaultSecret: { select: { path: true, name: true } } },
  })

  const grants = grantRows
    .filter((g) => g.vaultSecret)
    .map((g) => ({
      secretId: g.vaultSecretId,
      secretPath: g.vaultSecret!.path,
      secretName: g.vaultSecret!.name,
      permissions: parsePermissions(g.permissions),
    }))

  return json({
    client: {
      id: client.id,
      publicId: client.publicId,
      name: client.name,
      clientType: client.clientType,
      workspaceId: client.workspaceId,
      workspaceSlug: client.workspace.slug,
      status: client.status,
      permissions: [],
    },
    grants,
  })
})
