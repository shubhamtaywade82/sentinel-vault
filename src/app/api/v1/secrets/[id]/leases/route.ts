// /api/v1/secrets/[id]/leases — secret leases (short-lived credential delivery).
// GET  → 200 { leases: LeaseListItem[] }
//        admin: all leases for this secret.
//        client: any grant on the secret AND leases for their own client only.
// POST → 201 { lease: LeaseListItem }
//        body { serviceClientId, permissions: string[], ttlSeconds }
//        admin OR the caller is the `serviceClientId` AND has `value:read` on
//        the secret (a client may self-issue for a secret it can read).
//        ttlSeconds clamped to [60, 86400]. Audits `lease.issue`.
import { handle, json, noStore, body, actor, getRequestId, getSourceIp } from '@/lib/vault/api-helpers'
import { db } from '@/lib/db'
import { VaultError } from '@/lib/vault/errors'
import { checkGrant } from '@/lib/vault/authorization'
import { issueLease, listLeases, cleanupExpiredLeases } from '@/lib/vault/leases'
import type { LeaseListItem, SecretLeaseRow } from '@/lib/vault/types'

async function enrichLease(lease: SecretLeaseRow): Promise<LeaseListItem> {
  const [secret, client] = await Promise.all([
    db.vaultSecret.findUnique({ where: { id: lease.vaultSecretId }, select: { path: true } }),
    db.serviceClient.findUnique({ where: { id: lease.serviceClientId }, select: { name: true } }),
  ])
  return {
    ...lease,
    secretPath: secret?.path ?? '',
    serviceClientName: client?.name ?? '',
  }
}

export const GET = handle(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params
  const auth = await actor(req)
  if (auth.kind === 'none') throw new VaultError('unauthorized')

  const secret = await db.vaultSecret.findUnique({ where: { id } })
  if (!secret) throw new VaultError('secret_not_found')

  if (auth.kind === 'client') {
    if (auth.client.workspaceId !== secret.workspaceId) {
      throw new VaultError('secret_access_denied')
    }
    // Client must have ANY grant on the secret to see leases; their view is
    // scoped to leases for their own client id only.
    const grants = await db.secretAccessGrant.findFirst({
      where: { serviceClientId: auth.client.id, vaultSecretId: id },
    })
    if (!grants) throw new VaultError('secret_access_denied')
  }

  // Opportunistic GC before returning.
  void cleanupExpiredLeases().catch(() => {
    /* non-fatal */
  })

  const filter: { vaultSecretId: string; serviceClientId?: string } = { vaultSecretId: id }
  if (auth.kind === 'client') filter.serviceClientId = auth.client.id

  const leases = await listLeases(filter)
  return json({ leases })
})

export const POST = handle(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params
  const auth = await actor(req)
  if (auth.kind === 'none') throw new VaultError('unauthorized')

  const secret = await db.vaultSecret.findUnique({ where: { id } })
  if (!secret) throw new VaultError('secret_not_found')

  const input = await body<{
    serviceClientId?: string
    permissions?: string[]
    ttlSeconds?: number
  }>(req)
  const serviceClientId = (input.serviceClientId || '').trim()
  if (!serviceClientId) {
    throw new VaultError('validation_failed', 'serviceClientId is required')
  }

  // Verify the service client exists + is in the same workspace as the secret.
  const targetClient = await db.serviceClient.findUnique({ where: { id: serviceClientId } })
  if (!targetClient) throw new VaultError('client_not_found')
  if (targetClient.workspaceId !== secret.workspaceId) {
    throw new VaultError('validation_failed', 'service client must be in the same workspace as the secret')
  }

  // Authorization:
  //  - admin: always allowed.
  //  - client: ONLY allowed when the caller IS the serviceClientId AND has
  //            value:read on the secret.
  if (auth.kind === 'client') {
    if (auth.client.workspaceId !== secret.workspaceId) {
      throw new VaultError('secret_access_denied')
    }
    if (auth.client.id !== serviceClientId) {
      throw new VaultError('grant_required', 'clients may only issue leases for themselves')
    }
    const ok = await checkGrant(auth.client.id, id, 'value:read')
    if (!ok) {
      throw new VaultError('grant_required', 'Missing grant: value:read on ' + id)
    }
  }

  const lease = await issueLease({
    vaultSecretId: id,
    serviceClientId,
    permissions: input.permissions ?? [],
    ttlSeconds: input.ttlSeconds ?? 0,
    audit: {
      workspaceId: secret.workspaceId,
      actorClientId: auth.kind === 'client' ? auth.client.id : null,
      requestId: getRequestId(req),
      sourceIp: getSourceIp(req),
    },
  })

  const enriched = await enrichLease(lease)
  return noStore({ lease: enriched }, 201)
})
