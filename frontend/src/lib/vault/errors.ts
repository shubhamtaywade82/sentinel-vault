// Error model for Sentinel Vault. See VAULT_CONTRACT.md §10.

export type VaultErrorCode =
  | 'unauthorized'
  | 'admin_required'
  | 'secret_access_denied'
  | 'grant_required'
  | 'resource_not_found'
  | 'workspace_not_found'
  | 'secret_not_found'
  | 'connection_not_found'
  | 'version_not_found'
  | 'client_not_found'
  | 'conflict'
  | 'rotation_in_progress'
  | 'stale_generation'
  | 'credential_refresh_unavailable'
  | 'reauthorization_required'
  | 'manual_rotation_required'
  | 'validation_failed'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'decryption_failed'
  | 'audit_persist_failed'
  | 'production_mode_violation'
  | 'internal_error'

const STATUS_BY_CODE: Record<VaultErrorCode, number> = {
  unauthorized: 401,
  admin_required: 403,
  secret_access_denied: 403,
  grant_required: 403,
  resource_not_found: 404,
  workspace_not_found: 404,
  secret_not_found: 404,
  connection_not_found: 404,
  version_not_found: 404,
  client_not_found: 404,
  conflict: 409,
  rotation_in_progress: 409,
  stale_generation: 409,
  credential_refresh_unavailable: 422,
  reauthorization_required: 422,
  manual_rotation_required: 422,
  validation_failed: 422,
  rate_limited: 429,
  provider_unavailable: 503,
  decryption_failed: 500,
  audit_persist_failed: 500,
  production_mode_violation: 501,
  internal_error: 500,
}

export class VaultError extends Error {
  code: VaultErrorCode
  status: number
  details?: Record<string, unknown>

  constructor(
    code: VaultErrorCode,
    message?: string,
    details?: Record<string, unknown>,
  ) {
    super(message || code)
    this.name = 'VaultError'
    this.code = code
    this.status = STATUS_BY_CODE[code]
    this.details = details
  }
}

export function assert(
  cond: unknown,
  code: VaultErrorCode,
  message?: string,
  details?: Record<string, unknown>,
): asserts cond {
  if (!cond) throw new VaultError(code, message, details)
}

export function errorEnvelope(error: unknown) {
  if (error instanceof VaultError) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      },
    }
  }
  console.error('[vault] unhandled error:', error)
  return {
    status: 500,
    body: {
      error: {
        code: 'internal_error' as VaultErrorCode,
        message: 'Internal error',
      },
    },
  }
}

export function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      ...(headers || {}),
    },
  })
}

export function errorResponse(error: unknown) {
  const { status, body } = errorEnvelope(error)
  return jsonResponse(body, status)
}

export function noStore(body: unknown, status = 200) {
  return jsonResponse(body, status, { 'cache-control': 'no-store, private' })
}
