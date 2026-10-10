module Connections
  # Persists one provider result. Credential versions, connection lifecycle,
  # run status and the audit row commit together under the connection's row
  # lock, and only if no newer attempt has claimed the connection since.
  module Outcome
    # Refresh this long before expiry (or half the lifetime, if shorter).
    SAFETY_MARGIN = 15.minutes

    module_function

    def apply(connection, run, result, expected_generation:)
      connection.with_lock do
        if connection.refresh_generation != expected_generation then cancel(connection, run)
        elsif result.ok then succeed(connection, run, result)
        elsif result.permanent? then require_reauthorization(connection, run, result.error_code)
        else record_transient(connection, run, result.error_code)
        end
      end
      RefreshConnectionJob.set(wait_until: run.run_after).perform_later(connection.id, run.id) if run.pending?
    end

    def succeed(connection, run, result)
      versions = store_credentials(connection, result.credentials)
      expiry = result.credentials.dig("access_token", :expires_at)
      connection.update!(status: "active", last_refreshed_at: Time.current, access_expires_at: expiry, refresh_after: refresh_after(expiry),
                         last_error_code: nil, reauth_required_at: nil, refresh_lease_expires_at: nil)
      finish(run, "succeeded", result_version: versions["access_token"])
      audit(connection, "refresh.succeeded", run, outcome: "success", secret_version_id: versions["access_token"]&.id)
    end

    def store_credentials(connection, credentials)
      credentials.each_with_object({}) do |(purpose, credential), versions|
        binding = connection.bindings.find_by(purpose: purpose)
        next unless binding

        attributes = { value: credential[:value], created_by: "refresh-engine", expires_at: credential[:expires_at] }.compact
        versions[purpose] = Secrets::WriteVersion.call(binding.vault_secret, "secret.refresh", attributes)
      end
    end

    def require_reauthorization(connection, run, code)
      connection.update!(status: "reauth_required", reauth_required_at: Time.current, last_error_code: code, refresh_lease_expires_at: nil)
      finish(run, "failed", error_code: code)
      audit(connection, "refresh.failed", run, reason_code: code)
    end

    def record_transient(connection, run, code)
      if run.attempt_count >= Refresh::MAX_ATTEMPTS
        connection.update!(status: "error", last_error_code: code, refresh_lease_expires_at: nil)
        finish(run, "failed", error_code: "retries_exhausted")
        return audit(connection, "refresh.failed", run, reason_code: "retries_exhausted:#{code}")
      end

      backoff = [ Refresh::BACKOFF_STEP * run.attempt_count, Refresh::BACKOFF_CAP ].min
      connection.update!(last_error_code: code, refresh_lease_expires_at: nil)
      run.update!(status: "pending", error_code: code, run_after: backoff.from_now, lease_expires_at: nil)
      audit(connection, "refresh.transient", run, reason_code: code)
    end

    # A newer attempt owns the connection now; leave its lease alone.
    def cancel(connection, run)
      finish(run, "cancelled", error_code: "stale_generation")
      audit(connection, "refresh.cancelled", run, reason_code: "stale_generation")
    end

    def finish(run, status, error_code: nil, result_version: nil)
      run.update!(status: status, error_code: error_code, result_version: result_version, completed_at: Time.current, lease_expires_at: nil)
    end

    # Earlier than the margin by a random fifth, so connections sharing an expiry
    # do not all hit the provider in the same second.
    def refresh_after(expiry)
      return unless expiry

      margin = [ SAFETY_MARGIN, (expiry - Time.current) / 2 ].min
      expiry - margin - rand * margin / 5
    end

    # details may override outcome (default "error") and reason_code (default "<operation>:<run id>").
    def audit(connection, action, run, details = {})
      defaults = { workspace_id: connection.workspace_id, outcome: "error", reason_code: "#{run.operation}:#{run.id}" }
      SecretAccessEvent.record!(action, **defaults, **details)
    end
  end
end
