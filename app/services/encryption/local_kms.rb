module Encryption
  # Wraps data keys with a single master key held in process memory.
  # Development and test only: VaultConfig refuses this provider in production.
  class LocalKms
    attr_reader :key_ref

    def initialize(master_key)
      @master_key = master_key
      # The fingerprint names the key without revealing it, so a ciphertext
      # written under a different master key fails loudly instead of garbling.
      @key_ref = "local:#{Digest::SHA256.hexdigest(master_key).first(12)}"
    end

    def generate_data_key(context)
      data_key = SecureRandom.random_bytes(32)
      [ data_key, Aead.seal(@master_key, data_key, aad_for(context)) ]
    end

    def decrypt_data_key(wrapped_key, key_ref:, context:)
      raise Aead::Failure, "data key was wrapped by #{key_ref}, not #{@key_ref}" unless key_ref == @key_ref

      Aead.open(@master_key, wrapped_key, aad_for(context))
    end

    private

    def aad_for(context) = "keywrap:#{context.to_json}"
  end
end
