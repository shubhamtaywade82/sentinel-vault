// DELETE /api/v1/admin/grants/[id] → 204
import { handle, adminOrThrow, getRequestId, getSourceIp } from '@/lib/vault/api-helpers'
import { db } from '@/lib/db'
import { VaultError } from '@/lib/vault/errors'
import { recordEvent, recordEventCritical } from '@/lib/vault/audit'

export const DELETE = handle(async (req, ctx: { params: Promise<{ id: string }> }) => {
  await adminOrThrow(req)
  const { id } = await ctx.params
  const existing = await db.secretAccessGrant.findUnique({ where: { id } })
  if (!existing) throw new VaultError('resource_not_found', 'grant not found')

  await db.secretAccessGrant.delete({ where: { id } })
  await recordEventCritical({
    actorClientId: existing.serviceClientId,
    vaultSecretId: existing.vaultSecretId,
    action: 'grant.delete',
    requestId: getRequestId(req),
    sourceIp: getSourceIp(req),
  })

  return new Response(null, { status: 204 })
})
