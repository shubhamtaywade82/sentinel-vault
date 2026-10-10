// server-only — shared ProviderAdapter interfaces (see VAULT_CONTRACT.md §6).
// Defined locally because the shared `types.ts` is owned by the contract layer
// and must not be modified by this task.

import type {
  IntegrationConnectionRow,
  VaultSecretRow,
} from '../types'

export interface RefreshBinding {
  purpose: string
  secret: VaultSecretRow
  /** Decrypts the current active version's ciphertext to plaintext.
   *  Adapters MUST call this lazily only for the bindings they actually need,
   *  so plaintext stays in memory for the minimum time. */
  decrypt: () => Promise<string>
}

export interface RefreshArgs {
  connection: IntegrationConnectionRow
  bindings: RefreshBinding[]
}

export interface RefreshResultCredential {
  purpose: string
  value: string
  expiresAt?: string
}

export interface RefreshResultRotatedToken {
  purpose: string
  newValue: string
}

export interface RefreshResult {
  ok: boolean
  newCredentials?: RefreshResultCredential[]
  refreshTokensRotated?: RefreshResultRotatedToken[]
  /** "invalid_grant" (permanent) | "transient" | "rate_limited" | "provider_error" (transient) */
  errorCode?: string
}

export interface RevokeArgs {
  connection: IntegrationConnectionRow
  bindings: RefreshBinding[]
}

export interface RevokeResult {
  ok: boolean
  code?: string
}

export interface ProviderAdapter {
  /** Adapter key as persisted on IntegrationConnection.adapterKey. */
  key: string
  /** Provider key (dhan / oauth-generic / api-key). */
  providerKey: string
  supportsRefresh: boolean
  supportsReauth: boolean
  refresh(args: RefreshArgs): Promise<RefreshResult>
  revoke?(args: RevokeArgs): Promise<RevokeResult>
}
