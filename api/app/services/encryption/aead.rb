module Encryption
  # AES-256-GCM sealed as base64(12-byte nonce || ciphertext || 16-byte tag).
  module Aead
    CIPHER = "aes-256-gcm".freeze
    NONCE_BYTES = 12
    TAG_BYTES = 16

    class Failure < StandardError; end

    module_function

    def seal(key, plaintext, aad)
      cipher = OpenSSL::Cipher.new(CIPHER).encrypt
      cipher.key = key
      nonce = cipher.random_iv
      cipher.auth_data = aad
      ciphertext = cipher.update(plaintext) + cipher.final
      Base64.strict_encode64(nonce + ciphertext + cipher.auth_tag)
    end

    def open(key, sealed, aad)
      blob = Base64.strict_decode64(sealed)
      raise Failure, "sealed value too short" if blob.bytesize < NONCE_BYTES + TAG_BYTES

      cipher = OpenSSL::Cipher.new(CIPHER).decrypt
      cipher.key = key
      cipher.iv = blob.byteslice(0, NONCE_BYTES)
      # Explicit full-length tag: OpenSSL would otherwise accept a truncated one.
      cipher.auth_tag = blob.byteslice(-TAG_BYTES, TAG_BYTES)
      cipher.auth_data = aad
      cipher.update(blob.byteslice(NONCE_BYTES...-TAG_BYTES)) + cipher.final
    rescue OpenSSL::Cipher::CipherError, ArgumentError => e
      raise Failure, e.class.name
    end
  end
end
