require "rails_helper"

RSpec.describe Providers::Oauth2Generic do
  let(:token_url) { "https://idp.example.com/oauth/token" }
  let(:connection) { create(:integration_connection, adapter_key: "oauth2_generic", token_url: token_url) }

  before do
    resolve_publicly
    bind_secrets(connection, "refresh_token" => "rt-1", "client_id" => "app", "client_secret" => "shh")
  end

  def refresh = described_class.refresh(connection, credentials_for(connection))

  it "should exchange the refresh token and keep a rotated one" do
    stub_request(:post, token_url)
      .with(body: { grant_type: "refresh_token", refresh_token: "rt-1", client_id: "app", client_secret: "shh" })
      .to_return(status: 200, body: { access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 }.to_json)

    credentials = refresh.credentials

    expect(credentials["access_token"]).to include(value: "at-2")
    expect(credentials["access_token"][:expires_at]).to be_within(1.minute).of(1.hour.from_now)
    expect(credentials["refresh_token"][:value]).to eq("rt-2")
  end

  it "should treat a dead grant as permanent" do
    stub_request(:post, token_url).to_return(status: 400, body: { error: "invalid_grant" }.to_json)

    expect(refresh).to be_permanent
  end

  it "should treat other 400s and missing tokens as provider errors" do
    stub_request(:post, token_url).to_return(status: 400, body: { error: "invalid_request" }.to_json)
    expect(refresh.error_code).to eq("provider_error")

    stub_request(:post, token_url).to_return(status: 200, body: {}.to_json)
    expect(refresh.error_code).to eq("provider_error")
  end

  it "should refuse a token endpoint on a private network" do
    resolve_publicly("10.1.2.3")

    expect(refresh.error_code).to eq("provider_error")
  end
end
