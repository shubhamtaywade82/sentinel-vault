require "rails_helper"

RSpec.describe IntegrationConnection do
  let(:workspace) { create(:workspace) }
  let(:connection) { create(:integration_connection, workspace: workspace) }
  let(:secret) { create(:vault_secret, workspace: workspace) }
  let(:client) { create(:service_client, workspace: workspace) }

  before { connection.bindings.create!(vault_secret: secret, purpose: "access_token") }

  it "should reject adapters the provider layer does not implement" do
    expect(build(:integration_connection, adapter_key: "custom")).not_to be_valid
  end

  it "should know when its access credential has expired" do
    expect(build(:integration_connection, access_expires_at: 1.second.ago)).to be_access_expired
    expect(build(:integration_connection, access_expires_at: nil)).not_to be_access_expired
  end

  describe ".visible_to" do
    it "should include connections bound to a secret the client can read or refresh" do
      %w[value:read connection:refresh].each do |permission|
        SecretAccessGrant.where(service_client: client).delete_all
        create(:secret_access_grant, service_client: client, vault_secret: secret, permissions: [ permission ])

        expect(described_class.visible_to(client)).to contain_exactly(connection)
      end
    end

    it "should exclude connections the client only has metadata access to" do
      create(:secret_access_grant, service_client: client, vault_secret: secret, permissions: [ "metadata:read" ])

      expect(described_class.visible_to(client)).to be_empty
    end
  end
end
