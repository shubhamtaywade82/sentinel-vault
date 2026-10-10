require "rails_helper"

RSpec.describe "Connections", type: :request do
  let(:workspace) { create(:workspace) }
  let(:access_token) { create(:vault_secret, workspace: workspace, kind: "access_token", value: "acc-1") }
  let(:refresh_token) { create(:vault_secret, workspace: workspace, kind: "refresh_token", value: "rft-1") }
  let(:connection) { create(:integration_connection, workspace: workspace) }
  let(:reader) { client_with_credential(workspace: workspace) }

  before do
    connection.bindings.create!(vault_secret: access_token, purpose: "access_token")
    connection.bindings.create!(vault_secret: refresh_token, purpose: "refresh_token")
    grant!(reader.first, access_token, "value:read")
  end

  def fetch_credential(purpose = "access_token")
    post "/api/v1/connections/#{connection.id}/credential", params: { purpose: purpose }, headers: bearer(reader.last), as: :json
  end

  it "should deliver the current access token and audit it" do
    fetch_credential

    expect(json["credential"]).to include("value" => "acc-1", "refreshed" => false)
    expect(SecretAccessEvent.where(action: "connection.credential", actor_client_id: reader.first.id)).to exist
  end

  it "should withhold the credential when its audit row cannot be written" do
    allow(SecretAccessEvent).to receive(:create!).and_raise(ActiveRecord::ConnectionFailed)

    fetch_credential

    expect(error_code).to eq("audit_persist_failed")
    expect(response.body).not_to include("acc-1")
  end

  it "should never release a refresh token through a connection" do
    grant!(reader.first, refresh_token, "value:read")

    fetch_credential("refresh_token")

    expect(error_code).to eq("secret_access_denied")
    expect(response.body).not_to include("rft-1")
  end

  it "should refuse an expired credential instead of returning it" do
    connection.update!(access_expires_at: 1.minute.ago)

    fetch_credential

    expect(error_code).to eq("credential_refresh_unavailable")
    expect(response.body).not_to include("acc-1")
  end

  it "should refuse credentials for connections needing reauthorization or revoked" do
    %w[reauth_required revoked].each do |status|
      connection.update!(status: status)
      fetch_credential
      expect(error_code).to eq("reauthorization_required")
    end
  end

  it "should hide connections from clients without a grant on a bound secret" do
    _, outsider = client_with_credential(workspace: workspace)

    get "/api/v1/connections/#{connection.id}/status", headers: bearer(outsider)
    expect(error_code).to eq("connection_not_found")

    get "/api/v1/connections", headers: bearer(outsider)
    expect(json["connections"]).to be_empty
  end

  it "should create a connection with bindings from the same workspace only" do
    params = { workspaceId: workspace.id, providerKey: "dhan", authMethod: "oauth2_refresh", adapterKey: "dhan_v1",
               bindings: [ { purpose: "access_token", secretId: create(:vault_secret).id } ] }

    post "/api/v1/connections", params: params, headers: admin_headers, as: :json

    expect(error_code).to eq("validation_failed")
    expect(IntegrationConnection.count).to eq(1)
  end
end
