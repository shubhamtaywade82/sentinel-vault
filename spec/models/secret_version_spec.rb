require "rails_helper"

RSpec.describe SecretVersion do
  let(:secret) { create(:vault_secret, value: "hunter2") }
  let(:version) { secret.current_version }

  it "should decrypt its own value" do
    expect(version.decrypt_value).to eq("hunter2")
  end

  it "should fail to decrypt when its ciphertext is moved to another version" do
    other = create(:vault_secret, workspace: secret.workspace).current_version
    other.update_columns(ciphertext: version.ciphertext, encrypted_data_key: version.encrypted_data_key)

    expect { other.reload.decrypt_value }.to raise_error(VaultError) { |error| expect(error.code).to eq(:decryption_failed) }
  end

  it "should keep ciphertext and wrapped keys out of inspect output" do
    expect(version.inspect).not_to include(version.ciphertext)
    expect(version.inspect).not_to include(version.encrypted_data_key)
  end

  it "should bind the encryption context to workspace, secret and version" do
    expect(described_class.encryption_context(secret, 3))
      .to eq("workspace_id" => secret.workspace_id, "vault_secret_id" => secret.id, "version_number" => "3")
  end

  it "should reject unknown statuses at the database level" do
    expect { version.update_column(:status, "deleted") }.to raise_error(ActiveRecord::StatementInvalid, /status_check/)
  end
end
