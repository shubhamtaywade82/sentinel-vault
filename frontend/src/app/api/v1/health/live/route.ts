// GET /api/v1/health/live → 200 { status:"alive", ts }
import { handle, json } from '@/lib/vault/api-helpers'

export const GET = handle(async () => {
  return json({ status: 'alive', ts: new Date().toISOString() })
})
