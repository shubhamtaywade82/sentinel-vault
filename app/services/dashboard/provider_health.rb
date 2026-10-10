module Dashboard
  # Connection and refresh-run health per (provider, adapter), aggregated in SQL.
  module ProviderHealth
    CONNECTION_FIELDS = %i[providerKey adapterKey totalConnections activeConnections reauthRequired lastRefreshAt].freeze

    module_function

    def call(workspace_id)
      connections = Dashboard.scope(IntegrationConnection.all, workspace_id)
      runs = run_stats(connections)
      connection_stats(connections).map { |row| row.merge(runs.fetch([ row[:providerKey], row[:adapterKey] ], empty_runs)) }
                                   .sort_by { |row| [ -row[:totalConnections], row[:providerKey] ] }
    end

    def connection_stats(connections)
      connections.group(:provider_key, :adapter_key)
                 .pluck(:provider_key, :adapter_key, Arel.sql("count(*)"), Arel.sql("count(*) FILTER (WHERE status = 'active')"),
                        Arel.sql("count(*) FILTER (WHERE status = 'reauth_required')"), Arel.sql("max(last_refreshed_at)"))
                 .map { |row| CONNECTION_FIELDS.zip(row).to_h }
    end

    def run_stats(connections)
      RotationRun.where(operation: "refresh", integration_connection_id: connections.select(:id)).joins(:integration_connection)
                 .group("integration_connections.provider_key", "integration_connections.adapter_key")
                 .pluck("integration_connections.provider_key", "integration_connections.adapter_key", Arel.sql("count(*)"),
                        Arel.sql("count(*) FILTER (WHERE rotation_runs.status = 'succeeded')"),
                        Arel.sql("count(*) FILTER (WHERE rotation_runs.status = 'failed')"),
                        Arel.sql("avg(extract(epoch FROM completed_at - started_at) * 1000) FILTER (WHERE rotation_runs.status = 'succeeded')"))
                 .to_h { |row| [ row.first(2), run_row(*row.drop(2)) ] }
    end

    # No refreshes yet counts as healthy, matching the existing UI's expectation.
    def run_row(total, succeeded, failed, avg_ms)
      { totalRefreshes: total, successfulRefreshes: succeeded, failedRefreshes: failed,
        successRate: total.zero? ? 1 : succeeded.fdiv(total), avgRefreshMs: avg_ms&.round }
    end

    def empty_runs = run_row(0, 0, 0, nil)
  end
end
