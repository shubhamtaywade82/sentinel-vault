# Domain error rendered as the contract envelope `{ error: { code, message, details } }`.
class VaultError < StandardError
  STATUS_BY_CODE = {
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
    internal_error: 500
  }.freeze

  attr_reader :code, :details

  def initialize(code, message = nil, details: nil)
    raise ArgumentError, "unknown vault error code: #{code}" unless STATUS_BY_CODE.key?(code)

    super(message || code.to_s)
    @code = code
    @details = details
  end

  def status = STATUS_BY_CODE.fetch(code)

  def to_envelope
    { error: { code: code, message: message, details: details }.compact }
  end
end
