require "rails_helper"

RSpec.describe Encryption do
  let(:context) { { "workspace_id" => "ws-1", "vault_secret_id" => "sec-1", "version_number" => "1" } }

  def tamper(sealed, **changes) = sealed.with(**changes)

  it "should round-trip a value without storing the plaintext" do
    sealed = described_class.encrypt("s3cr3t-value", context)

    expect(sealed.ciphertext).not_to include("s3cr3t")
    expect(described_class.decrypt(sealed, context)).to eq("s3cr3t-value")
  end

  it "should use a fresh nonce and data key for every encryption" do
    first = described_class.encrypt("same", context)
    second = described_class.encrypt("same", context)

    expect(first.ciphertext).not_to eq(second.ciphertext)
    expect(first.encrypted_data_key).not_to eq(second.encrypted_data_key)
  end

  it "should refuse a ciphertext moved to another record" do
    sealed = described_class.encrypt("value", context)

    expect { described_class.decrypt(sealed, context.merge("vault_secret_id" => "sec-2")) }
      .to raise_error(VaultError) { |error| expect(error.code).to eq(:decryption_failed) }
  end

  it "should refuse a tampered ciphertext" do
    sealed = described_class.encrypt("value", context)
    bytes = Base64.strict_decode64(sealed.ciphertext)
    bytes.setbyte(14, bytes.getbyte(14) ^ 0x01)

    expect { described_class.decrypt(tamper(sealed, ciphertext: Base64.strict_encode64(bytes)), context) }.to raise_error(VaultError)
  end

  it "should refuse a truncated authentication tag" do
    sealed = described_class.encrypt("value", context)
    truncated = Base64.strict_encode64(Base64.strict_decode64(sealed.ciphertext)[0...-4])

    expect { described_class.decrypt(tamper(sealed, ciphertext: truncated), context) }.to raise_error(VaultError)
  end

  it "should refuse data keys wrapped by a different master key" do
    sealed = described_class.encrypt("value", context)
    original = described_class.kms
    described_class.kms = Encryption::LocalKms.new(SecureRandom.random_bytes(32))

    expect { described_class.decrypt(sealed, context) }.to raise_error(VaultError)
  ensure
    described_class.kms = original
  end

  it "should refuse an unknown crypto scheme" do
    sealed = tamper(described_class.encrypt("value", context), crypto_scheme: "aes-256-gcm-envelope-v1")

    expect { described_class.decrypt(sealed, context) }.to raise_error(VaultError)
  end

  describe Encryption::AwsKms do
    let(:client) { Aws::KMS::Client.new(stub_responses: true) }
    let(:data_key) { SecureRandom.random_bytes(32) }
    let(:kms) { described_class.new(key_id: "arn:aws:kms:eu-west-1:123:key/abc", client: client) }

    before do
      client.stub_responses(:generate_data_key, plaintext: data_key, ciphertext_blob: "wrapped-by-kms")
      client.stub_responses(:decrypt, plaintext: data_key)
    end

    it "should pass the record context to KMS as the encryption context" do
      plaintext, wrapped = kms.generate_data_key(context)
      kms.decrypt_data_key(wrapped, key_ref: kms.key_ref, context: context)

      expect(plaintext).to eq(data_key)
      expect(client.api_requests.map { |req| req[:params][:encryption_context] }).to all(eq(context))
    end

    it "should refuse key refs from another provider" do
      expect { kms.decrypt_data_key("x", key_ref: "local:abc", context: context) }.to raise_error(Encryption::Aead::Failure)
    end
  end
end
