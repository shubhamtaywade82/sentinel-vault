# Required runtime configuration. Every value is mandatory in every environment:
# there are no built-in defaults, so a missing secret fails at boot, not at first use.
module VaultConfig
  MIN_ADMIN_TOKEN_LENGTH = 32
  KMS_PROVIDERS = %w[local aws_kms].freeze

  class MissingConfiguration < StandardError; end

  module_function

  def validate!
    admin_token
    kms_provider == "local" ? local_master_key : aws_kms_key_id
  end

  def admin_token
    token = fetch("VAULT_ADMIN_TOKEN")
    if token.length < MIN_ADMIN_TOKEN_LENGTH
      raise MissingConfiguration, "VAULT_ADMIN_TOKEN must be at least #{MIN_ADMIN_TOKEN_LENGTH} characters"
    end

    token
  end

  def kms_provider
    provider = fetch("VAULT_KMS_PROVIDER")
    raise MissingConfiguration, "VAULT_KMS_PROVIDER must be one of #{KMS_PROVIDERS.join(', ')}" unless KMS_PROVIDERS.include?(provider)
    raise MissingConfiguration, "VAULT_KMS_PROVIDER=local is refused in production; use aws_kms" if provider == "local" && Rails.env.production?

    provider
  end

  def local_master_key
    key = Base64.strict_decode64(fetch("VAULT_MASTER_KEY"))
    raise MissingConfiguration, "VAULT_MASTER_KEY must be base64 of exactly 32 bytes" unless key.bytesize == 32

    key
  rescue ArgumentError
    raise MissingConfiguration, "VAULT_MASTER_KEY is not valid base64"
  end

  def aws_kms_key_id = fetch("VAULT_KMS_KEY_ID")

  def fetch(name)
    value = ENV[name].to_s.strip
    raise MissingConfiguration, "#{name} is required. Refusing to start." if value.empty?

    value
  end
end
