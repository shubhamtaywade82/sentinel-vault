module Connections
  # One refresh (or re-authorization) attempt for a connection.
  #
  # Concurrency: a lease claimed by bumping refresh_generation lets exactly one
  # attempt run; the provider is called outside any transaction, and results are
  # persisted only if the generation is unchanged, so a stale attempt can never
  # overwrite a newer credential. Transient failures retry via Solid Queue with
  # linear backoff, up to MAX_ATTEMPTS.
  class Refresh
    LEASE = 60.seconds
    MAX_ATTEMPTS = 5
    BACKOFF_STEP = 30.seconds
    BACKOFF_CAP = 5.minutes

    def self.call(connection, **options) = new(connection, **options).call

    # idempotency_key: caller-supplied replay key; run: a pending run being retried.
    def initialize(connection, operation: "refresh", idempotency_key: nil, run: nil)
      @connection = connection
      @operation = operation
      @idempotency_key = idempotency_key && "#{connection.id}:#{idempotency_key}"
      @run = run
    end

    def call
      replay = @idempotency_key && RotationRun.find_by(idempotency_key: @idempotency_key)
      return replay if replay

      claim_lease!
      start_run!
      Outcome.apply(@connection, @run, provider_result, expected_generation: @expected_generation)
      @run
    ensure
      release_abandoned_lease
    end

    private

    def claim_lease!
      now = Time.current
      @expected_generation = @connection.refresh_generation + 1
      claimed = IntegrationConnection.where(id: @connection.id, refresh_generation: @connection.refresh_generation)
                                     .where("refresh_lease_expires_at IS NULL OR refresh_lease_expires_at < ?", now)
                                     .update_all(refresh_generation: @expected_generation, refresh_lease_expires_at: now + LEASE, updated_at: now)
      raise VaultError.new(:rotation_in_progress, "a refresh is already running for this connection") if claimed.zero?

      @lease_held = true
    end

    def start_run!
      attributes = { status: "running", started_at: Time.current, attempt_count: (@run&.attempt_count || 0) + 1, lease_expires_at: LEASE.from_now }
      if @run
        @run.update!(attributes)
      else
        @run = @connection.rotation_runs.create!(operation: @operation, idempotency_key: @idempotency_key, **attributes)
      end
    end

    def provider_result
      credentials = Providers::Credentials.new(@connection)
      provider = @connection.provider
      @operation == "reauthorize" ? provider.reauthorize(@connection, credentials) : provider.refresh(@connection, credentials)
    end

    # Outcome.apply clears the lease; this only fires when something raised first.
    def release_abandoned_lease
      return unless @lease_held && @run&.running?

      @run.update!(status: "failed", error_code: "internal_error", completed_at: Time.current, lease_expires_at: nil)
      IntegrationConnection.where(id: @connection.id).update_all(refresh_lease_expires_at: nil)
    end
  end
end
