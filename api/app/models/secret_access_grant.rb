class SecretAccessGrant < ApplicationRecord
  PERMISSIONS = %w[metadata:read value:read version:create rotate revoke connection:refresh audit:read].freeze

  belongs_to :service_client
  belongs_to :vault_secret

  validates :vault_secret_id, uniqueness: { scope: :service_client_id }
  validate :permissions_are_known
  validate :same_workspace

  # Accepts the contract's comma-separated form; stores canonical order so diffs stay clean.
  def permissions=(value)
    requested = value.is_a?(String) ? value.split(",") : Array(value)
    super(requested.map(&:strip).reject(&:empty?).uniq.sort_by { |p| PERMISSIONS.index(p) || PERMISSIONS.size })
  end

  private

  def permissions_are_known
    unknown = permissions - PERMISSIONS
    errors.add(:permissions, "contains unknown values: #{unknown.join(', ')}") if unknown.any?
    errors.add(:permissions, "must not be empty") if permissions.empty?
  end

  def same_workspace
    return if service_client.nil? || vault_secret.nil?

    errors.add(:base, "client and secret must belong to the same workspace") if service_client.workspace_id != vault_secret.workspace_id
  end
end
