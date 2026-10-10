import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { adminOrThrow, json } from '@/lib/vault/api-helpers'
import { isProduction } from '@/lib/vault/env'
import { VaultError } from '@/lib/vault/errors'

// GET /api/v1/internal/demo-credentials — admin-only.
// Returns the demo client credential map so the "View as Client" playground
// can switch identity without making the user copy-paste from a file.
//
// SECURITY (R12): This endpoint is DISABLED in production. Client credentials
// are issued ONCE at creation time and must never be re-readable. Returning
// them from a JSON file on disk in production would violate the "shown once"
// contract. In production this returns 501 `production_mode_violation`.
export async function GET(req: Request) {
  await adminOrThrow(req)

  // Production guard: demo credential recovery is a dev/staging convenience.
  if (isProduction()) {
    throw new VaultError(
      'production_mode_violation',
      'Demo credential recovery is disabled in production. Client credentials are issued once and never re-readable.',
    )
  }

  try {
    const path = resolve(process.cwd(), 'vault-demo-credentials.json')
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as {
      admin?: string
      clients?: Record<string, string>
    }
    return json({
      admin: parsed.admin ?? '',
      clients: parsed.clients ?? {},
    })
  } catch {
    throw new VaultError(
      'resource_not_found',
      'Demo credentials file not found. Run POST /api/v1/internal/seed first.',
    )
  }
}
