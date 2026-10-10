require "rails_helper"

RSpec.describe "Service clients", type: :request do
  let(:workspace) { create(:workspace) }

  it "should return the credential exactly once and never its digest" do
    post "/api/v1/admin/service_clients", params: { name: "bot", clientType: "bot", workspaceId: workspace.id }, headers: admin_headers, as: :json

    credential = json["credential"]
    expect(credential).to start_with("vlt_live_")
    expect(json["client"]).not_to have_key("credentialDigest")
    expect(response.headers["Cache-Control"]).to include("no-store")

    get "/api/v1/admin/service_clients", headers: admin_headers
    expect(response.body).not_to include(credential)
    expect(response.body).not_to include(ServiceClient.digest(credential))
  end

  it "should invalidate the old credential on rotation" do
    client, old_credential = client_with_credential(workspace: workspace)

    post "/api/v1/admin/service_clients/#{client.id}/rotate_credential", headers: admin_headers, as: :json
    new_credential = json["credential"]

    get "/api/v1/me", headers: bearer(old_credential)
    expect(response).to have_http_status(:unauthorized)
    get "/api/v1/me", headers: bearer(new_credential)
    expect(response).to have_http_status(:ok)
  end

  it "should keep revocation terminal" do
    client, credential = client_with_credential(workspace: workspace)

    post "/api/v1/admin/service_clients/#{client.id}/revoke", headers: admin_headers, as: :json
    post "/api/v1/admin/service_clients/#{client.id}/rotate_credential", headers: admin_headers, as: :json

    expect(response).to have_http_status(:conflict)
    get "/api/v1/me", headers: bearer(credential)
    expect(response).to have_http_status(:unauthorized)
  end
end
