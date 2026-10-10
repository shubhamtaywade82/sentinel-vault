# OAuth token endpoints differ per provider, so the URL belongs to the connection,
# not to one process-wide environment variable.
class AddTokenUrlToIntegrationConnections < ActiveRecord::Migration[8.1]
  def change
    add_column :integration_connections, :token_url, :string
    add_check_constraint :integration_connections, "token_url IS NULL OR token_url LIKE 'https://%'",
                         name: "integration_connections_token_url_https"
  end
end
