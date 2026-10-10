module Connections
  # Refreshes every connection whose refresh_after has passed. Runs from the
  # recurring RefreshSweepJob and from the admin "Run Watchdog" action.
  module Sweep
    BATCH_SIZE = 50

    module_function

    # Returns the watchdog contract: { checked:, refreshed:, reauthRequired:, errors: }.
    def call
      summary = { checked: 0, refreshed: [], reauthRequired: [], errors: [] }
      # ponytail: sequential and capped per run; enqueue per-connection jobs if volume outgrows a minute.
      IntegrationConnection.due_for_refresh.order(:refresh_after).limit(BATCH_SIZE).each do |connection|
        summary[:checked] += 1
        bucket, entry = outcome(connection)
        summary[bucket] << entry.merge(connectionId: connection.id)
      end
      summary
    end

    def outcome(connection)
      return [ :reauthRequired, { errorCode: manual_rotation!(connection) } ] unless connection.provider.refreshable?

      run = Refresh.call(connection)
      return [ :refreshed, { status: run.status } ] if run.succeeded? || run.pending?
      return [ :reauthRequired, { errorCode: run.error_code } ] if run.error_code.in?(Providers::PERMANENT_ERRORS)

      [ :errors, { errorCode: run.error_code } ]
    rescue VaultError => e
      [ :errors, { errorCode: e.code.to_s } ]
    end

    def manual_rotation!(connection)
      connection.update!(status: "reauth_required", reauth_required_at: Time.current, last_error_code: "manual_rotation_required")
      SecretAccessEvent.record!("refresh.failed", workspace_id: connection.workspace_id, outcome: "error", reason_code: "manual_rotation_required")
      "manual_rotation_required"
    end
  end
end
