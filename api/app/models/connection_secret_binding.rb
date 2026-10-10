class ConnectionSecretBinding < ApplicationRecord
  belongs_to :integration_connection
  belongs_to :vault_secret

  validates :purpose, presence: true, uniqueness: { scope: :integration_connection_id }
end
