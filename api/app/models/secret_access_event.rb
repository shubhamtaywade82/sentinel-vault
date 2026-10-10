# Append-only audit trail. Never stores secret values; the database trigger
# rejects updates and deletes even if application code tries.
class SecretAccessEvent < ApplicationRecord
  belongs_to :actor_client, class_name: "ServiceClient", optional: true
  belongs_to :vault_secret, optional: true

  validates :action, presence: true
  validates :outcome, inclusion: { in: %w[success denied error] }

  def readonly? = persisted?

  # Persists the event or raises audit_persist_failed, so a privileged operation
  # never completes without its audit row. Call inside the operation's transaction.
  def self.record!(action, **attributes)
    secret = attributes.delete(:secret)
    create!(
      action: action,
      vault_secret_id: secret&.id,
      workspace_id: secret&.workspace_id,
      actor_client_id: Current.principal&.client&.id,
      request_id: Current.request_id,
      source_ip: Current.source_ip,
      **attributes
    )
  rescue ActiveRecord::ActiveRecordError => e
    Rails.logger.error("[vault] audit write failed for #{action}: #{e.class}")
    raise VaultError.new(:audit_persist_failed, "Audit record could not be persisted; operation refused", details: { action: action })
  end

  # Denials are logged best-effort: the request is already being refused, so a
  # failed audit write must not turn the denial into a different error.
  def self.record_denial(action, **attributes)
    record!(action, outcome: "denied", **attributes)
  rescue VaultError
    nil
  end
end
