// GET /api/v1/dashboard/client-preview?workspaceId= → 200 { clients: [...] }
// admin only. Returns a per-service-client least-privilege proof: which
// secrets the client CAN access (via SecretAccessGrant rows, with parsed
// permissions) and a sample of 5 secrets it CANNOT access (just metadata,
// no permissions). Powers the "Client Preview" dashboard panel.
// All clients in scope are returned (even revoked ones — status field set).
// Audit `dashboard.client-preview`. Value-free.
import {
  handle,
  json,
  adminOrThrow,
  getRequestId,
  getSourceIp,
} from '@/lib/vault/api-helpers'
import { db } from '@/lib/db'
import { recordEvent } from '@/lib/vault/audit'
import { parsePermissions } from '@/lib/vault/authorization'
import type {
  ClientPreviewRow,
  ClientPreviewSecret,
} from '@/lib/vault/types'

export const GET = handle(async (req) => {
  await adminOrThrow(req)
  const workspaceId = new URL(req.url).searchParams.get('workspaceId') || undefined
  const clientWhere = workspaceId ? { workspaceId } : {}
  const secretWhere = workspaceId ? { workspaceId } : {}

  // 1. Load all service clients in scope (incl. revoked).
  const clients = await db.serviceClient.findMany({
    where: clientWhere,
    select: {
      id: true,
      name: true,
      clientType: true,
      publicId: true,
      status: true,
    },
  })

  const clientIds = clients.map((c) => c.id)

  // 2. Load all secrets in scope + all grants owned by these clients.
  //    Run in parallel — both are independent reads.
  const [allSecrets, allGrants] = await Promise.all([
    db.vaultSecret.findMany({
      where: secretWhere,
      select: { id: true, path: true, name: true, kind: true },
    }),
    clientIds.length === 0
      ? Promise.resolve([])
      : db.secretAccessGrant.findMany({
          where: { serviceClientId: { in: clientIds } },
          select: {
            serviceClientId: true,
            vaultSecretId: true,
            permissions: true,
          },
        }),
  ])

  // 3. Index secrets for quick lookup by id.
  const secretById = new Map(allSecrets.map((s) => [s.id, s]))

  // 4. Index grants by client id.
  const grantsByClient = new Map<
    string,
    { vaultSecretId: string; permissions: string }[]
  >()
  for (const g of allGrants) {
    const arr = grantsByClient.get(g.serviceClientId)
    if (arr) {
      arr.push({ vaultSecretId: g.vaultSecretId, permissions: g.permissions })
    } else {
      grantsByClient.set(g.serviceClientId, [
        { vaultSecretId: g.vaultSecretId, permissions: g.permissions },
      ])
    }
  }

  // 5. Assemble per-client rows.
  const rows: ClientPreviewRow[] = clients.map((c) => {
    const grants = grantsByClient.get(c.id) ?? []
    const grantedIds = new Set<string>()
    const accessibleSecrets: ClientPreviewSecret[] = []
    for (const g of grants) {
      grantedIds.add(g.vaultSecretId)
      const s = secretById.get(g.vaultSecretId)
      if (!s) continue // grant refers to a deleted secret — skip silently
      accessibleSecrets.push({
        secretId: s.id,
        path: s.path,
        name: s.name,
        kind: s.kind,
        permissions: parsePermissions(g.permissions).map((p) => p as string),
      })
    }

    // Inaccessible: every workspace secret NOT in grants. Cap at 5 per client
    // to keep the payload small (the point is to *showcase* the restriction,
    // not enumerate every missing secret).
    const inaccessibleSecrets: ClientPreviewSecret[] = allSecrets
      .filter((s) => !grantedIds.has(s.id))
      .slice(0, 5)
      .map((s) => ({
        secretId: s.id,
        path: s.path,
        name: s.name,
        kind: s.kind,
      }))

    return {
      clientId: c.id,
      clientName: c.name,
      clientType: c.clientType,
      publicId: c.publicId,
      status: c.status,
      grantsCount: grants.length,
      accessibleSecrets,
      inaccessibleSecrets,
    }
  })

  // Audit (value-free).
  const requestId = getRequestId(req)
  const sourceIp = getSourceIp(req)
  await recordEvent({
    workspaceId: workspaceId ?? null,
    actorClientId: null,
    action: 'dashboard.client-preview',
    outcome: 'success',
    requestId,
    sourceIp,
  })

  return json({ clients: rows })
})
