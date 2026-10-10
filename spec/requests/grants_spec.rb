require "rails_helper"

RSpec.describe "Grants", type: :request do
  let(:client) { create(:service_client) }
  let(:secret) { create(:vault_secret, workspace: client.workspace) }

  def grant(permissions)
    post "/api/v1/admin/grants", params: { serviceClientId: client.id, vaultSecretId: secret.id, permissions: permissions },
                                 headers: admin_headers, as: :json
  end

  it "should upsert the permission set and audit it" do
    grant("metadata:read")
    grant("value:read,metadata:read")

    expect(json.dig("grant", "permissions")).to eq("metadata:read,value:read")
    expect(SecretAccessGrant.count).to eq(1)
    expect(SecretAccessEvent.where(action: "grant.create").count).to eq(2)
  end

  it "should reject unknown permissions" do
    grant("value:read,superuser")

    expect(error_code).to eq("validation_failed")
  end

  it "should delete a grant and keep its audit trail" do
    grant("value:read")

    delete "/api/v1/admin/grants/#{json.dig('grant', 'id')}", headers: admin_headers

    expect(response).to have_http_status(:no_content)
    expect(SecretAccessEvent.where(action: "grant.delete")).to exist
  end

  it "should list grants filtered by workspace" do
    grant("value:read")
    create(:secret_access_grant)

    get "/api/v1/grants", params: { workspaceId: client.workspace_id }, headers: admin_headers

    expect(json["grants"].pluck("serviceClientName")).to eq([ client.name ])
  end
end
