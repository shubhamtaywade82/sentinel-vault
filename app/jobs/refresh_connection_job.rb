# Retries a pending refresh run, or refreshes a connection that is due.
class RefreshConnectionJob < ApplicationJob
  queue_as :default

  def perform(connection_id, run_id = nil)
    connection = IntegrationConnection.find_by(id: connection_id)
    return unless connection&.active?

    Connections::Refresh.call(connection, run: run_id && RotationRun.pending.find_by(id: run_id))
  rescue VaultError => e
    # Another attempt holds the lease; it will reschedule itself if it fails.
    raise unless e.code == :rotation_in_progress
  end
end
