module Encryption
  # Data keys generated and unwrapped by AWS KMS; plaintext master keys never leave KMS.
  # The record context is passed as the KMS EncryptionContext, so CloudTrail logs
  # every unwrap against the record it belongs to.
  class AwsKms
    REF_PREFIX = "aws-kms:".freeze

    def initialize(key_id:, client: Aws::KMS::Client.new)
      @key_id = key_id
      @client = client
    end

    def key_ref = "#{REF_PREFIX}#{@key_id}"

    def generate_data_key(context)
      response = @client.generate_data_key(key_id: @key_id, key_spec: "AES_256", encryption_context: context)
      [ response.plaintext, Base64.strict_encode64(response.ciphertext_blob) ]
    end

    def decrypt_data_key(wrapped_key, key_ref:, context:)
      raise Aead::Failure, "not an AWS KMS key ref: #{key_ref}" unless key_ref.start_with?(REF_PREFIX)

      @client.decrypt(
        ciphertext_blob: Base64.strict_decode64(wrapped_key),
        key_id: key_ref.delete_prefix(REF_PREFIX),
        encryption_context: context
      ).plaintext
    end
  end
end
