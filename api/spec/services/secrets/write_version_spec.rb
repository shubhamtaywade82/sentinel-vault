require "rails_helper"

RSpec.describe Secrets::WriteVersion do
  let(:secret) { create(:vault_secret, value: "v1") }

  def write(value, **attributes) = described_class.call(secret, "secret.rotate", { value: value, created_by: "admin", **attributes })

  it "should number versions sequentially and point the secret at the newest" do
    version = write("v2")

    expect(version.version_number).to eq(2)
    expect(secret.reload.current_version).to eq(version)
    expect(secret.versions.order(:version_number).pluck(:status)).to eq(%w[retired active])
  end

  it "should keep the existing expiry unless a new one is given" do
    secret.update!(expires_at: 3.days.from_now)

    expect { write("v2") }.not_to(change { secret.reload.expires_at })
    write("v3", expires_at: 1.hour.from_now)
    expect(secret.reload.expires_at).to be_within(1.minute).of(1.hour.from_now)
  end

  it "should reject empty, non-string and oversized values" do
    [ "", nil, 42, "x" * (Encryption::MAX_PLAINTEXT_BYTES + 1) ].each do |value|
      expect { write(value) }.to raise_error(VaultError) { |error| expect(error.code).to eq(:validation_failed) }
    end
  end

  it "should refuse to write to a revoked secret" do
    secret.revoke!

    expect { write("v2") }.to raise_error(VaultError) { |error| expect(error.code).to eq(:conflict) }
  end

  it "should leave nothing behind when encryption fails" do
    secret
    allow(Encryption).to receive(:encrypt).and_raise(VaultError.new(:provider_unavailable))

    expect { write("v2") }.to raise_error(VaultError)
    expect(secret.reload.current_version.version_number).to eq(1)
    expect(secret.versions.active.count).to eq(1)
  end
end
