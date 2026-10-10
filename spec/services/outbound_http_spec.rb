require "rails_helper"

RSpec.describe OutboundHttp do
  before { resolve_publicly }

  it "should send a form POST and return status and body" do
    stub_request(:post, "https://idp.example.com/token").with(body: { "a" => "1" }).to_return(status: 200, body: '{"ok":true}')

    response = described_class.call(:post, "https://idp.example.com/token", form: { a: "1" })

    expect(response.status).to eq(200)
    expect(response.json).to eq("ok" => true)
  end

  it "should refuse plain http" do
    expect { described_class.call(:get, "http://idp.example.com/") }.to raise_error(OutboundHttp::Blocked, /https/)
  end

  it "should refuse hosts resolving to private, loopback or metadata addresses" do
    %w[10.0.0.5 127.0.0.1 169.254.169.254 192.168.1.1 ::1 fd00::1].each do |address|
      resolve_publicly(address)

      expect { described_class.call(:get, "https://idp.example.com/") }.to raise_error(OutboundHttp::Blocked)
    end
  end

  it "should not follow redirects" do
    stub_request(:get, "https://idp.example.com/").to_return(status: 302, headers: { "Location" => "https://169.254.169.254/" })

    expect(described_class.call(:get, "https://idp.example.com/").status).to eq(302)
  end

  it "should treat timeouts as retryable" do
    stub_request(:get, "https://idp.example.com/").to_timeout

    expect { described_class.call(:get, "https://idp.example.com/") }.to raise_error(OutboundHttp::Unavailable)
  end

  it "should cap the response size" do
    stub_request(:get, "https://idp.example.com/").to_return(status: 200, body: "x" * (OutboundHttp::MAX_BODY_BYTES + 1))

    expect { described_class.call(:get, "https://idp.example.com/") }.to raise_error(OutboundHttp::Unavailable, /exceeded/)
  end
end
