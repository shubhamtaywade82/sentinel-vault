class Workspace < ApplicationRecord
  has_many :service_clients
  has_many :vault_secrets
  has_many :integration_connections

  enum :status, { active: "active", suspended: "suspended", archived: "archived" }, validate: true

  validates :slug, presence: true, uniqueness: true, format: { with: /\A[a-z0-9][a-z0-9-]{0,62}\z/ }
  validates :name, presence: true
end
