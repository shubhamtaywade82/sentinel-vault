module ApiHelpers
  def admin_headers = { "Authorization" => "Bearer #{ENV.fetch('VAULT_ADMIN_TOKEN')}" }

  def bearer(credential) = { "Authorization" => "Bearer #{credential}" }

  def json = response.parsed_body

  def error_code = json.dig("error", "code")

  # A client plus its one-time plaintext credential.
  def client_with_credential(**attributes)
    client = build(:service_client, **attributes)
    credential = client.issue_credential!
    [ client, credential ]
  end

  def grant!(client, secret, *permissions)
    create(:secret_access_grant, service_client: client, vault_secret: secret, permissions: permissions)
  end
end
