module Dashboard
  # Event counts bucketed in PostgreSQL (date_bin), so a 30-day range never
  # loads individual events into memory.
  module AuditActivity
    PLANS = {
      "1h" => [ 5.minutes, 12 ], "24h" => [ 1.hour, 24 ], "7d" => [ 6.hours, 28 ], "30d" => [ 1.day, 30 ]
    }.freeze

    module_function

    def call(workspace_id, range)
      step, count = PLANS.fetch(range)
      start = Time.current - (step * count)
      events = Dashboard.scope(SecretAccessEvent.where(created_at: start..), workspace_id)
      { range: range, buckets: buckets(events, start, step, count), totals: totals(events) }
    end

    def buckets(events, start, step, count)
      bin = ActiveRecord::Base.sanitize_sql_array([ "date_bin(?::interval, created_at, ?)", "#{step.to_i} seconds", start ])
      counts = events.group(Arel.sql(bin)).count.transform_keys(&:to_i)
      Array.new(count) { |index| (start + (step * index)) }.map { |ts| { ts: ts, count: counts.fetch(ts.to_i, 0) } }
    end

    def totals(events)
      events.pick(Arel.sql("count(*)"), Arel.sql("count(*) FILTER (WHERE action LIKE 'secret.reveal%')"),
                  Arel.sql("count(*) FILTER (WHERE action LIKE 'secret.rotate%' OR action = 'refresh.succeeded')"),
                  Arel.sql("count(*) FILTER (WHERE outcome = 'denied')"))
            .then { |all, reveals, rotations, denied| { events: all, reveals: reveals, rotations: rotations, denied: denied } }
    end
  end
end
