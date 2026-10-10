require "rails_helper"

RSpec.describe VaultSecret do
  let(:secret) { create(:vault_secret) }

  it "should reject paths containing whitespace" do
    expect(build(:vault_secret, path: "db/prod url")).not_to be_valid
  end

  it "should reject unknown kinds and classifications" do
    expect(build(:vault_secret, kind: "password")).not_to be_valid
    expect(build(:vault_secret, classification: "secret")).not_to be_valid
  end

  it "should enforce unique paths per workspace in the database" do
    duplicate = build(:vault_secret, workspace: secret.workspace, path: secret.path)

    expect { duplicate.save(validate: false) }.to raise_error(ActiveRecord::RecordNotUnique)
  end

  it "should allow the same path in another workspace" do
    expect(build(:vault_secret, path: secret.path)).to be_valid
  end

  describe "#revoke!" do
    it "should retire the active version, mark the secret revoked and audit it" do
      secret.revoke!

      expect(secret.reload).to be_revoked
      expect(secret.revoked_at).to be_present
      expect(secret.versions.active).to be_empty
      expect(SecretAccessEvent.where(action: "secret.revoke", vault_secret_id: secret.id)).to exist
    end

    it "should refuse a second revocation" do
      secret.revoke!

      expect { secret.revoke! }.to raise_error(VaultError) { |error| expect(error.code).to eq(:conflict) }
    end
  end
end
