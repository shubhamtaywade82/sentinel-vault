require "rails_helper"

RSpec.describe "Rate limiting", type: :request do
  let(:secret) { create(:vault_secret) }

  def reveal(ip: "203.0.113.10")
    post "/api/v1/secrets/#{secret.id}/reveal?admin_reveal_ok=true", headers: admin_headers, as: :json, env: { "REMOTE_ADDR" => ip }
    response
  end

  it "should allow 30 reveals a minute, then answer 429 in the error envelope" do
    statuses = Array.new(30) { reveal.status }

    expect(statuses.uniq).to eq([ 200 ])
    expect(reveal).to have_http_status(:too_many_requests)
    expect(error_code).to eq("rate_limited")
  end

  it "should not audit or decrypt once the limit is hit" do
    30.times { reveal }

    expect { reveal }.not_to(change { SecretAccessEvent.where(action: "secret.reveal").count })
  end

  it "should count each source address separately" do
    30.times { reveal(ip: "203.0.113.10") }

    expect(reveal(ip: "203.0.113.11")).to have_http_status(:ok)
  end

  it "should reset after the window passes" do
    30.times { reveal }

    travel 61.seconds do
      expect(reveal).to have_http_status(:ok)
    end
  end

  it "should leave unthrottled endpoints alone" do
    31.times { get "/api/v1/secrets/#{secret.id}", headers: admin_headers }

    expect(response).to have_http_status(:ok)
  end
end
