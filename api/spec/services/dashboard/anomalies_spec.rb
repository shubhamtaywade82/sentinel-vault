require "rails_helper"

RSpec.describe Dashboard::Anomalies do
  let(:secret) { create(:vault_secret) }
  let(:client) { create(:service_client, workspace: secret.workspace) }

  def record(action, at: Time.current, ip: "198.51.100.7", **attributes)
    Current.principal = Principal.new(client: client)
    Current.source_ip = ip
    travel_to(at) { SecretAccessEvent.record!(action, secret: secret, **attributes) }
  end

  def types = described_class.call(nil, "24h").pluck(:type)

  # A moment inside the last 24h at the given UTC hour.
  def recent_at_hour(hour)
    candidate = Time.current.utc.change(hour: hour)
    candidate > Time.current ? candidate - 1.day : candidate
  end

  it "should flag three denials from the same actor and address as a high-severity spike" do
    3.times { record("secret.reveal", outcome: "denied", at: recent_at_hour(12)) }

    expect(described_class.call(nil, "24h").first).to include(type: "denied_spike", severity: "high")
  end

  it "should flag an address the actor has not used in the baseline week" do
    record("secret.reveal", at: 3.days.ago.utc.change(hour: 12), ip: "198.51.100.7")
    record("secret.reveal", at: recent_at_hour(12), ip: "198.51.100.99")

    expect(described_class.call(nil, "24h").select { |a| a[:type] == "new_ip" }.pluck(:sourceIp)).to eq([ "198.51.100.99" ])
  end

  it "should flag ten reveals within an hour as a burst" do
    start = recent_at_hour(12)
    10.times { |minute| record("secret.reveal", at: start + minute.minutes) }

    expect(types).to include("burst")
  end

  it "should flag off-hours access" do
    record("secret.reveal", at: recent_at_hour(3))

    expect(types).to include("off_hours")
  end

  it "should flag recorded cross-workspace probes" do
    record("secret.lookup", outcome: "denied", reason_code: "cross_workspace", at: recent_at_hour(12))

    expect(types).to include("cross_workspace_attempt")
  end

  it "should report nothing for ordinary traffic" do
    record("secret.reveal", at: 3.days.ago.utc.change(hour: 12))
    record("secret.reveal", at: recent_at_hour(12))

    expect(types).to be_empty
  end
end
