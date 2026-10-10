# Envelope encryption for secret values: a fresh AES-256-GCM data key per value,
# wrapped by the configured KMS. Both layers are bound to the record's identity,
# so a ciphertext copied onto another secret or version fails to decrypt.
module Encryption
  SCHEME = "aes-256-gcm-envelope-v2".freeze
  MAX_PLAINTEXT_BYTES = 64.kilobytes

  Sealed = Data.define(:ciphertext, :encrypted_data_key, :kms_key_ref, :crypto_scheme)

  module_function

  def kms
    @kms ||= if VaultConfig.kms_provider == "aws_kms"
      AwsKms.new(key_id: VaultConfig.aws_kms_key_id)
    else
      LocalKms.new(VaultConfig.local_master_key)
    end
  end

  def kms=(provider)
    @kms = provider
  end

  def encrypt(plaintext, context)
    data_key, wrapped_key = kms.generate_data_key(context)
    Sealed.new(
      ciphertext: Aead.seal(data_key, plaintext, context.to_json),
      encrypted_data_key: wrapped_key,
      kms_key_ref: kms.key_ref,
      crypto_scheme: SCHEME
    )
  rescue Aws::KMS::Errors::ServiceError, Seahorse::Client::NetworkingError => e
    kms_unavailable!(e)
  end

  def decrypt(sealed, context)
    raise VaultError.new(:decryption_failed, "unsupported crypto scheme") unless sealed.crypto_scheme == SCHEME

    data_key = kms.decrypt_data_key(sealed.encrypted_data_key, key_ref: sealed.kms_key_ref, context: context)
    Aead.open(data_key, sealed.ciphertext, context.to_json).force_encoding(Encoding::UTF_8)
  rescue Seahorse::Client::NetworkingError => e
    kms_unavailable!(e)
  rescue Aead::Failure, Aws::KMS::Errors::ServiceError => e
    # Tampering, a wrong key or a moved ciphertext: always worth an alert.
    Rails.error.report(e, handled: true, context: { kms_key_ref: sealed.kms_key_ref })
    raise VaultError.new(:decryption_failed)
  end

  # Timeouts and connection failures are retryable, unlike a decryption failure.
  def kms_unavailable!(error)
    Rails.error.report(error, handled: true)
    raise VaultError.new(:provider_unavailable, "key management service unavailable")
  end
end
