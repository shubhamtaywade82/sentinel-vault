class ConnectionSecretBinding < ApplicationRecord
  belongs_to :integration_connection
  belongs_to :vault_secret

  validates :purpose, presence: true, uniqueness: { scope: :integration_connection_id }

  # Composite foreign keys use this to pin both connection and secret to one workspace.
  before_validation { self.workspace_id = integration_connection&.workspace_id }
end
