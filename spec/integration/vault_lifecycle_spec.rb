require "rails_helper"

# One operator-to-client journey over HTTP only, the way the UI and a bot use the API.
RSpec.describe "Vault lifecycle", type: :request do
  def admin_post(path, **params)
    post path, params: params, headers: admin_headers, as: :json
    json
  end

  def reveal_as(credential, secret_id)
    post "/api/v1/secrets/#{secret_id}/reveal", headers: bearer(credential), as: :json
    response
  end

  it "should carry a secret from creation to revocation with a complete audit trail" do
    workspace_id = admin_post("/api/v1/workspaces", slug: "payments", name: "Payments").dig("workspace", "id")
    secret_id = admin_post("/api/v1/secrets", workspaceId: workspace_id, path: "stripe/key", name: "Stripe", kind: "api_key",
                                              value: "sk_one").dig("secret", "id")
    issued = admin_post("/api/v1/admin/service_clients", name: "checkout", clientType: "app", workspaceId: workspace_id)
    client_id, credential = issued.dig("client", "id"), issued["credential"]
    grant_id = admin_post("/api/v1/admin/grants", serviceClientId: client_id, vaultSecretId: secret_id, permissions: "value:read")
                 .dig("grant", "id")

    expect(reveal_as(credential, secret_id).parsed_body["value"]).to eq("sk_one")

    admin_post("/api/v1/secrets/#{secret_id}/rotate", value: "sk_two")
    expect(reveal_as(credential, secret_id).parsed_body["value"]).to eq("sk_two")

    delete "/api/v1/admin/grants/#{grant_id}", headers: admin_headers
    expect(reveal_as(credential, secret_id)).to have_http_status(:forbidden)

    admin_post("/api/v1/admin/service_clients/#{client_id}/revoke")
    expect(reveal_as(credential, secret_id)).to have_http_status(:unauthorized)

    get "/api/v1/audit_events", params: { workspaceId: workspace_id }, headers: admin_headers
    trail = json["events"].reverse.map { |event| [ event["action"], event["outcome"], event["actorClientName"] ] }
    expect(trail).to eq([
      [ "workspace.create", "success", nil ],
      [ "secret.create", "success", nil ],
      [ "client.create", "success", nil ],
      [ "grant.create", "success", nil ],
      [ "secret.reveal", "success", "checkout" ],
      [ "secret.rotate", "success", nil ],
      [ "secret.reveal", "success", "checkout" ],
      [ "grant.delete", "success", nil ],
      [ "secret.reveal", "denied", "checkout" ],
      [ "client.revoke", "success", nil ]
    ])
    expect(response.body).not_to include("sk_one", "sk_two", credential)
  end
end
