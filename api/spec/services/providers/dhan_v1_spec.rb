require "rails_helper"

RSpec.describe Providers::DhanV1 do
  let(:connection) { create(:integration_connection, adapter_key: "dhan_v1") }

  before { resolve_publicly }

  def refresh = described_class.refresh(connection, credentials_for(connection))

  def stub_renew(status:, body: {})
    stub_request(:get, described_class::RENEW_URL)
      .with(headers: { "access-token" => "old-token", "dhanClientId" => "1100" })
      .to_return(status: status, body: body.to_json)
  end

  it "should renew a live token with RenewToken and parse IST expiry" do
    bind_secrets(connection, "client_id" => "1100", "access_token" => "old-token")
    stub_renew(status: 200, body: { accessToken: "new-token", expiryTime: "2026-10-12T09:30:00" })

    result = refresh

    expect(result.credentials["access_token"][:value]).to eq("new-token")
    expect(result.credentials["access_token"][:expires_at]).to eq(Time.utc(2026, 10, 12, 4, 0, 0))
  end

  it "should regenerate from PIN and TOTP when the token can no longer be renewed" do
    bind_secrets(connection, "client_id" => "1100", "access_token" => "old-token", "pin" => "1234", "totp_seed" => ROTP::Base32.random)
    stub_renew(status: 401)
    generate = stub_request(:post, %r{\Ahttps://auth\.dhan\.co/app/generateAccessToken\?dhanClientId=1100&pin=1234&totp=\d{6}\z})
               .to_return(status: 200, body: { accessToken: "fresh", expiryTime: 1_791_000_000 }.to_json)

    expect(refresh.credentials["access_token"][:value]).to eq("fresh")
    expect(generate).to have_been_requested
  end

  it "should need re-authorization when renewal is refused and no PIN/TOTP is stored" do
    bind_secrets(connection, "client_id" => "1100", "access_token" => "old-token")
    stub_renew(status: 401)

    expect(refresh).to have_attributes(ok: false, error_code: "invalid_grant")
  end

  it "should report provider outages as transient without regenerating" do
    bind_secrets(connection, "client_id" => "1100", "access_token" => "old-token", "pin" => "1234", "totp_seed" => ROTP::Base32.random)
    stub_renew(status: 503)

    expect(refresh.error_code).to eq("transient")
    expect(a_request(:post, /generateAccessToken/)).not_to have_been_made
  end

  it "should fall back to Dhan's documented 24h validity when expiryTime is missing" do
    bind_secrets(connection, "client_id" => "1100", "access_token" => "old-token")
    stub_renew(status: 200, body: { accessToken: "new-token" })

    expect(refresh.credentials["access_token"][:expires_at]).to be_within(1.minute).of(24.hours.from_now)
  end

  it "should treat a malformed TOTP seed as a dead credential, not a crash" do
    bind_secrets(connection, "client_id" => "1100", "pin" => "1234", "totp_seed" => "not base32!")

    expect(described_class.reauthorize(connection, credentials_for(connection)).error_code).to eq("invalid_grant")
  end

  it "should be reauthorizable only with both PIN and TOTP seed bound" do
    bind_secrets(connection, "client_id" => "1100", "pin" => "1234")

    expect(described_class.reauthorizable?(credentials_for(connection))).to be(false)
  end
end
