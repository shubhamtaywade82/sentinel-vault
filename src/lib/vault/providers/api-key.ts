// server-only — static API-key adapter (no refresh supported).
// See VAULT_CONTRACT.md §6.

import type { ProviderAdapter, RefreshArgs, RefreshResult } from './types'

/**
 * Static API keys never expire at the provider and cannot be auto-refreshed.
 * The refresh engine maps this `manual_rotation_required` outcome to a
 * `reauth_required` connection state and emits an audit event.
 */
export async function refresh(_args: RefreshArgs): Promise<RefreshResult> {
  return { ok: false, errorCode: 'manual_rotation_required' }
}

export const apiKeyAdapter: ProviderAdapter = {
  key: 'api_key_static',
  providerKey: 'api-key',
  supportsRefresh: false,
  supportsReauth: false,
  refresh,
}
