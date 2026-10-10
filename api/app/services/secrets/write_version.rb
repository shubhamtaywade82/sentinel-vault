module Secrets
  # Appends a new active version and retires the previous one in one transaction,
  # committing the audit row with it. The row lock on the secret serialises
  # concurrent writers, so version numbers never collide.
  module WriteVersion
    module_function

    # attributes: { value:, created_by:, expires_at: } — expires_at is kept when absent.
    def call(secret, action, attributes)
      value = attributes.fetch(:value)
      validate_value!(value)

      secret.with_lock do
        raise VaultError.new(:conflict, "secret is #{secret.status}") unless secret.active?

        version = append_version(secret, value, attributes.fetch(:created_by))
        secret.update!(current_version: version, expires_at: attributes.fetch(:expires_at, secret.expires_at))
        SecretAccessEvent.record!(action, secret: secret, secret_version_id: version.id)
        version
      end
    end

    def append_version(secret, value, created_by)
      number = (secret.versions.maximum(:version_number) || 0) + 1
      now = Time.current
      secret.versions.active.update_all(status: "retired", retired_at: now)
      sealed = Encryption.encrypt(value, SecretVersion.encryption_context(secret, number))
      secret.versions.create!(version_number: number, status: "active", created_by: created_by, activated_at: now, **sealed.to_h)
    end

    def validate_value!(value)
      raise VaultError.new(:validation_failed, "value is required (non-empty string)") unless value.is_a?(String) && value.present?
      return if value.bytesize <= Encryption::MAX_PLAINTEXT_BYTES

      raise VaultError.new(:validation_failed, "value exceeds #{Encryption::MAX_PLAINTEXT_BYTES} bytes")
    end
  end
end
