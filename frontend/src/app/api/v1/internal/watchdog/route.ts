// POST /api/v1/internal/watchdog → 200 { checked, refreshed, reauthRequired, errors }
// admin only. Calls runWatchdog() (see VAULT_CONTRACT.md §4.10). Audits watchdog.run.
import { handle, json, adminOrThrow, getRequestId, getSourceIp } from '@/lib/vault/api-helpers'
import { runWatchdog } from '@/lib/vault/refresh'
import { recordEvent } from '@/lib/vault/audit'

export const POST = handle(async (req) => {
  await adminOrThrow(req)
  const result = await runWatchdog()

  await recordEvent({
    action: 'watchdog.run',
    requestId: getRequestId(req),
    sourceIp: getSourceIp(req),
  })

  return json(result)
})
