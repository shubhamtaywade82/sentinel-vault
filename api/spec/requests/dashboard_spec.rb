require "rails_helper"

RSpec.describe "Dashboard", type: :request do
  let(:workspace) { create(:workspace) }

  def dashboard(name, **params)
    get "/api/v1/dashboard/#{name}", params: { workspaceId: workspace.id, **params }, headers: admin_headers
    json
  end

  it "should count workspace totals and list the soonest expiries" do
    create(:vault_secret, workspace: workspace).update!(expires_at: 2.days.from_now)
    create(:integration_connection, workspace: workspace, access_expires_at: 1.hour.from_now)
    create(:integration_connection, workspace: workspace, status: "reauth_required", access_expires_at: nil)
    create(:vault_secret)

    stats = dashboard("stats")

    expect(stats).to include("totalSecrets" => 1, "activeConnections" => 1, "reauthRequired" => 1)
    expect(stats["expiringSoon"].pluck("kind")).to eq(%w[connection secret])
  end

  it "should aggregate provider health from refresh runs" do
    connection = create(:integration_connection, workspace: workspace)
    connection.rotation_runs.create!(operation: "refresh", status: "succeeded", started_at: 2.seconds.ago, completed_at: Time.current)
    connection.rotation_runs.create!(operation: "refresh", status: "failed")

    row = dashboard("provider-health")["providers"].first

    expect(row).to include("providerKey" => "dhan", "totalRefreshes" => 2, "successfulRefreshes" => 1, "successRate" => 0.5)
    expect(row["avgRefreshMs"]).to be_within(200).of(2000)
  end

  it "should flag never-rotated, expired and expiring secrets" do
    create(:vault_secret, workspace: workspace).update!(expires_at: 1.day.ago)
    create(:vault_secret, workspace: workspace, kind: "public_key").update!(expires_at: 2.days.from_now)

    compliance = dashboard("compliance")

    expect(compliance["violations"].pluck("violation")).to contain_exactly("never_rotated", "expired_secret", "expiring_soon")
    expect(compliance["summary"]).to include("totalSecrets" => 2, "violations" => 2, "complianceScore" => 0)
  end

  it "should split each client's reachable and unreachable secrets" do
    client, = client_with_credential(workspace: workspace)
    granted = create(:vault_secret, workspace: workspace)
    create(:vault_secret, workspace: workspace)
    grant!(client, granted, "value:read")

    row = dashboard("client-preview")["clients"].first

    expect(row["accessibleSecrets"]).to eq([ { "secretId" => granted.id, "path" => granted.path, "name" => granted.name,
                                               "kind" => granted.kind, "permissions" => [ "value:read" ] } ])
    expect(row["inaccessibleSecrets"].size).to eq(1)
  end

  it "should bucket audit activity in the database" do
    secret = create(:vault_secret, workspace: workspace)
    Current.principal = Principal.admin
    3.times { SecretAccessEvent.record!("secret.reveal", secret: secret) }

    activity = dashboard("audit-activity", range: "1h")

    expect(activity["buckets"].size).to eq(12)
    expect(activity["buckets"].sum { |bucket| bucket["count"] }).to eq(activity.dig("totals", "events"))
    expect(activity["totals"]).to include("reveals" => 3)
  end

  it "should list leases expiring within the hour" do
    client, = client_with_credential(workspace: workspace)
    secret = create(:vault_secret, workspace: workspace)
    grant!(client, secret, "value:read")
    SecretLease.create!(vault_secret: secret, service_client: client, granted_permissions: [ "value:read" ], expires_at: 10.minutes.from_now)

    lease = dashboard("expiring-leases")["leases"].first

    expect(lease).to include("status" => "expiring", "clientName" => client.name)
    expect(lease["secondsRemaining"]).to be_within(5).of(600)
  end

  it "should not write an audit row for dashboard reads" do
    expect { dashboard("stats") }.not_to(change(SecretAccessEvent, :count))
  end
end
