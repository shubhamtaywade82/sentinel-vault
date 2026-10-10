module ProviderHelpers
  PUBLIC_TEST_ADDRESS = "203.0.113.10".freeze

  # Provider hosts resolve to a public address so OutboundHttp's guard passes;
  # WebMock still blocks every real connection.
  def resolve_publicly(address = PUBLIC_TEST_ADDRESS)
    allow(Resolv).to receive(:getaddresses).and_return([ address ])
  end

  # A connection plus encrypted secrets bound by purpose, e.g. bind_secrets(c, "client_id" => "1100").
  def bind_secrets(connection, values)
    values.each do |purpose, value|
      kind = purpose.in?(VaultSecret::KINDS) ? purpose : "api_key"
      secret = create(:vault_secret, workspace: connection.workspace, kind: kind, value: value)
      connection.bindings.create!(vault_secret: secret, purpose: purpose)
    end
    connection
  end

  def credentials_for(connection) = Providers::Credentials.new(connection.reload)
end

RSpec.configure { |config| config.include ProviderHelpers }
