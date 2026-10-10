require "rails_helper"

RSpec.describe ServiceClient do
  let(:client) { create(:service_client) }

  describe "#issue_credential!" do
    it "should store only the digest and a short prefix" do
      credential = client.issue_credential!

      expect(credential).to match(/\Avlt_live_\h{64}\z/)
      expect(client.reload.credential_digest).to eq(described_class.digest(credential))
      expect(client.credential_prefix).to eq(credential.first(10))
      expect(client.attributes.values).not_to include(credential)
    end
  end

  describe ".authenticate" do
    it "should return the client for its current credential" do
      credential = client.issue_credential!

      expect(described_class.authenticate(credential)).to eq(client)
    end

    it "should return nil for an unknown credential" do
      expect(described_class.authenticate("vlt_live_#{SecureRandom.hex(32)}")).to be_nil
    end

    it "should return nil once the client is expired" do
      credential = client.issue_credential!
      client.update!(expires_at: 1.second.ago)

      expect(described_class.authenticate(credential)).to be_nil
    end
  end

  describe "#rotate_credential!" do
    it "should replace the credential and audit the rotation" do
      old_credential = client.issue_credential!

      new_credential = client.rotate_credential!

      expect(described_class.authenticate(old_credential)).to be_nil
      expect(described_class.authenticate(new_credential)).to eq(client)
      expect(SecretAccessEvent.find_by(action: "client.rotate").reason_code).to eq(client.public_id)
    end

    it "should refuse a revoked client" do
      client.revoke!

      expect { client.rotate_credential! }.to raise_error(VaultError) { |error| expect(error.code).to eq(:conflict) }
    end
  end

  describe "#revoke!" do
    it "should be terminal and audited once" do
      client.revoke!

      expect(client.reload).to be_revoked
      expect { client.revoke! }.to raise_error(VaultError)
      expect(SecretAccessEvent.where(action: "client.revoke").count).to eq(1)
    end
  end

  it "should enforce unique names per workspace in the database" do
    duplicate = build(:service_client, workspace: client.workspace, name: client.name, public_id: "clt_#{SecureRandom.hex(8)}")

    expect { duplicate.save(validate: false) }.to raise_error(ActiveRecord::RecordNotUnique)
  end

  it "should reject unknown client types at the database level" do
    expect { client.update_column(:client_type, "robot") }.to raise_error(ActiveRecord::StatementInvalid, /type_check/)
  end
end
