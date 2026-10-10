module Dashboard
  # Rule-based anomaly detection over the audit trail.
  class Anomalies
    MAX_EVENTS = 20_000
    BASELINE = 7.days
    DENIED_SPIKE = 3
    BURST_READS = 10
    BURST_WINDOW = 1.hour
    OFF_HOURS_UTC = (2...5)
    LIMIT = 15
    SEVERITY_ORDER = %w[high medium low].freeze
    SEVERITY_BY_TYPE = {
      "denied_spike" => "high", "cross_workspace_attempt" => "high", "new_ip" => "medium", "burst" => "medium", "off_hours" => "low"
    }.freeze

    def self.call(workspace_id, range) = new(workspace_id, range).call

    def initialize(workspace_id, range)
      @start = Dashboard::RANGES.fetch(range).ago
      # ponytail: in-memory rules over at most MAX_EVENTS rows; move to SQL window functions if ranges outgrow it.
      @events = Dashboard.scope(SecretAccessEvent.where(created_at: @start..), workspace_id)
                         .includes(:actor_client, :vault_secret).order(:created_at).limit(MAX_EVENTS).to_a
      @sequence = 0
    end

    def call
      anomalies = denied_spikes + new_ips + off_hours + bursts + cross_workspace_attempts
      anomalies.sort_by { |anomaly| [ SEVERITY_ORDER.index(anomaly[:severity]), -anomaly[:ts].to_f ] }.first(LIMIT)
    end

    private

    def denied_spikes
      denied.group_by { |event| [ event.vault_secret_id, event.actor_client_id, event.source_ip ] }.filter_map do |_key, group|
        next if group.size < DENIED_SPIKE

        last = group.last
        anomaly(last, "denied_spike", [ "Denied access spike on #{path(last)}",
                "#{group.size} denied attempts by #{actor(last)} from #{last.source_ip || 'unknown IP'}" ], deniedCount: group.size)
      end
    end

    def new_ips
      known = SecretAccessEvent.where(created_at: (@start - BASELINE)...@start, actor_client_id: @events.filter_map(&:actor_client_id).uniq)
                               .where.not(source_ip: nil).distinct.pluck(:actor_client_id, :source_ip).to_set
      firsts = @events.select { |event| event.actor_client_id && event.source_ip }
                      .uniq { |event| [ event.actor_client_id, event.source_ip ] }
      firsts.reject { |event| known.include?([ event.actor_client_id, event.source_ip ]) }.map do |event|
        anomaly(event, "new_ip", [ "New source IP for #{actor(event)}", "First access from #{event.source_ip} on #{path(event)}" ],
                baselineWindowDays: BASELINE.in_days.to_i)
      end
    end

    def off_hours
      late = @events.select { |event| OFF_HOURS_UTC.cover?(event.created_at.utc.hour) }
      late.uniq { |event| [ event.vault_secret_id, event.actor_client_id, event.created_at.utc.to_date ] }.map do |event|
        anomaly(event, "off_hours", [ "Off-hours access on #{path(event)}",
                "Access at #{event.created_at.utc.strftime('%H:%M')} UTC by #{actor(event)}" ], hourUTC: event.created_at.utc.hour)
      end
    end

    def bursts
      reads = @events.select { |event| event.outcome == "success" && event.actor_client_id && event.action.start_with?("secret.reveal") }
      reads.group_by { |event| [ event.vault_secret_id, event.actor_client_id ] }.flat_map { |_key, group| burst_windows(group) }
    end

    # Greedy windows: each burst starts at a read and swallows reads within the next hour.
    def burst_windows(reads)
      found = []
      index = 0
      while index < reads.size
        window = reads[index..].take_while { |read| read.created_at - reads[index].created_at < BURST_WINDOW }
        if window.size >= BURST_READS
          found << anomaly(reads[index], "burst", [ "Access burst on #{path(reads[index])}",
                           "#{window.size} reads in 1h by #{actor(reads[index])}" ], readCount: window.size)
          index += window.size
        else
          index += 1
        end
      end
      found
    end

    # Recorded by SecretAccess#find_secret! when a client probes another tenant's id.
    def cross_workspace_attempts
      probes = denied.select { |event| event.reason_code == "cross_workspace" }
      probes.uniq { |event| [ event.actor_client_id, event.vault_secret_id, event.created_at.utc.to_date ] }.map do |event|
        anomaly(event, "cross_workspace_attempt", [ "Cross-workspace access attempt",
                "#{actor(event)} tried to access #{path(event)} in another workspace" ],
                actorWorkspaceId: event.actor_client&.workspace_id, secretWorkspaceId: event.vault_secret&.workspace_id)
      end
    end

    def denied = @events.select { |event| event.outcome == "denied" }

    # text: [ title, description ]
    def anomaly(event, type, text, metadata = {})
      title, description = text
      { id: "anom_#{(@sequence += 1).to_s(36).rjust(3, '0')}", type: type, severity: SEVERITY_BY_TYPE.fetch(type), title: title, description: description,
        secretPath: event.vault_secret&.path, actorName: event.actor_client&.name, sourceIp: event.source_ip, ts: event.created_at,
        metadata: { secretId: event.vault_secret_id, actorClientId: event.actor_client_id, **metadata } }
    end

    def path(event) = event.vault_secret&.path || "unknown"

    def actor(event) = event.actor_client&.name || "unknown actor"
  end
end
