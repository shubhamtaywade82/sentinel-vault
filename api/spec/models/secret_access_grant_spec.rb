require "rails_helper"

RSpec.describe SecretAccessGrant do
  let(:client) { create(:service_client) }
  let(:secret) { create(:vault_secret, workspace: client.workspace) }

  it "should store permissions from the comma-separated contract form in canonical order" do
    grant = described_class.create!(service_client: client, vault_secret: secret, permissions: "rotate, metadata:read,rotate")

    expect(grant.permissions).to eq(%w[metadata:read rotate])
  end

  it "should reject unknown permissions" do
    grant = described_class.new(service_client: client, vault_secret: secret, permissions: "metadata:read,admin")

    expect(grant).not_to be_valid
    expect(grant.errors[:permissions].first).to include("admin")
  end

  it "should reject a grant across workspaces" do
    foreign_secret = create(:vault_secret)
    grant = described_class.new(service_client: client, vault_secret: foreign_secret, permissions: "value:read")

    expect(grant).not_to be_valid
  end

  it "should reject unknown permissions at the database level" do
    grant = described_class.create!(service_client: client, vault_secret: secret, permissions: "value:read")

    expect { grant.update_column(:permissions, [ "value:write" ]) }.to raise_error(ActiveRecord::StatementInvalid, /permissions_check/)
  end
end
