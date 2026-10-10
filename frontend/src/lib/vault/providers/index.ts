// server-only — provider adapter registry.
// See VAULT_CONTRACT.md §6.
//
// Adapters are keyed by the `adapterKey` string persisted on
// `IntegrationConnection.adapterKey`. Unknown keys throw
// `VaultError("validation_failed", "Unknown adapter")`.

import { VaultError } from '../errors'
import { apiKeyAdapter } from './api-key'
import { dhanAdapter } from './dhan'
import { oauthGenericAdapter } from './oauth-generic'
import type { ProviderAdapter } from './types'

export type { ProviderAdapter, RefreshArgs, RefreshResult, RefreshBinding, RevokeArgs, RevokeResult } from './types'

export const ADAPTERS: Record<string, ProviderAdapter> = {
  dhan_v1: dhanAdapter,
  oauth2_generic: oauthGenericAdapter,
  api_key_static: apiKeyAdapter,
}

export function getAdapter(adapterKey: string): ProviderAdapter {
  const adapter = ADAPTERS[adapterKey]
  if (!adapter) {
    throw new VaultError('validation_failed', `Unknown adapter: ${adapterKey}`)
  }
  return adapter
}

export function listAdapters(): ProviderAdapter[] {
  return Object.values(ADAPTERS)
}

export { VaultError }
