# Provider adapters refresh or re-authorize a connection's credentials.
# Each returns a Providers::Result and never raises for provider-side failures.
module Providers
  # Codes that need a human: the refresh engine stops retrying and flags reauth.
  PERMANENT_ERRORS = %w[invalid_grant manual_rotation_required].freeze

  # credentials: { purpose => { value:, expires_at: } } to store as new versions.
  Result = Data.define(:ok, :credentials, :error_code) do
    def self.success(credentials) = new(ok: true, credentials: credentials, error_code: nil)

    def self.failure(code) = new(ok: false, credentials: {}, error_code: code)

    def permanent? = Providers::PERMANENT_ERRORS.include?(error_code)
  end

  module_function

  def for(adapter_key)
    { "dhan_v1" => DhanV1, "oauth2_generic" => Oauth2Generic, "api_key_static" => ApiKeyStatic }.fetch(adapter_key)
  end

  # Maps a provider HTTP status onto the engine's retry classes.
  def failure_for_status(status)
    code = case status
    when 401, 403 then "invalid_grant"
    when 429 then "rate_limited"
    when 500..599 then "transient"
    else "provider_error"
    end
    Result.failure(code)
  end

  # Runs a provider call, turning network trouble into retryable results.
  def guarded
    yield
  rescue OutboundHttp::Unavailable
    Result.failure("transient")
  rescue OutboundHttp::Blocked
    Result.failure("provider_error")
  end
end
