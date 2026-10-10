// /api/v1/workspaces — admin only.
// GET  → 200 { workspaces: [...] }            (all, ordered by slug)
// POST → 201 { workspace: {...} }             (body { slug, name })
import { handle, json, body, adminOrThrow, getRequestId, getSourceIp } from '@/lib/vault/api-helpers'
import { db } from '@/lib/db'
import { VaultError, assert } from '@/lib/vault/errors'
import { recordEvent } from '@/lib/vault/audit'

function serialize(ws: {
  id: string
  slug: string
  name: string
  status: string
  createdAt: Date
  updatedAt: Date
}) {
  return {
    id: ws.id,
    slug: ws.slug,
    name: ws.name,
    status: ws.status,
    createdAt: ws.createdAt.toISOString(),
    updatedAt: ws.updatedAt.toISOString(),
  }
}

export const GET = handle(async (req) => {
  await adminOrThrow(req)
  const rows = await db.workspace.findMany({ orderBy: { slug: 'asc' } })
  return json({ workspaces: rows.map(serialize) })
})

export const POST = handle(async (req) => {
  await adminOrThrow(req)
  const input = await body<{ slug?: string; name?: string }>(req)
  const slug = (input.slug || '').trim()
  const name = (input.name || '').trim()
  assert(slug && name, 'validation_failed', 'slug and name are required')

  const existing = await db.workspace.findUnique({ where: { slug } })
  if (existing) throw new VaultError('conflict', 'workspace slug already exists')

  const ws = await db.workspace.create({ data: { slug, name, status: 'active' } })

  await recordEvent({
    action: 'workspace.create',
    requestId: getRequestId(req),
    sourceIp: getSourceIp(req),
  })

  return json({ workspace: serialize(ws) }, 201)
})
