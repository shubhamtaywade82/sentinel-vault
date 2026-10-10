module Api
  module V1
    class AuditEventsController < ApplicationController
      DEFAULT_LIMIT = 100
      MAX_LIMIT = 500
      EXPORT_LIMIT = 10_000
      CSV_COLUMNS = %w[id createdAt actor action resource outcome reasonCode requestId sourceIp workspaceId].freeze
      # Spreadsheet apps execute cells starting with these; reason codes are caller-supplied.
      FORMULA_PREFIX = /\A[=+\-@\t\r]/

      before_action :require_admin!

      def index
        events = filtered_events.includes(:actor_client, :vault_secret).order(created_at: :desc)
                                .limit(params.fetch(:limit, DEFAULT_LIMIT).to_i.clamp(1, MAX_LIMIT))
                                .offset([ params[:offset].to_i, 0 ].max)
        render json: { events: events.map { |event| AuditEventSerializer.call(event) } }
      end

      def export
        events = filtered_events.includes(:actor_client, :vault_secret).order(created_at: :desc).limit(EXPORT_LIMIT)
        response.headers["Cache-Control"] = "no-store, private"
        send_data audit_csv(events), type: "text/csv; charset=utf-8", filename: "vault-audit-events.csv"
      end

      private

      def audit_csv(events)
        CSV.generate(row_sep: "\r\n") do |csv|
          csv << CSV_COLUMNS
          events.each { |event| csv << csv_row(event).map { |cell| neutralise_formula(cell) } }
        end
      end

      def csv_row(event)
        [ event.id, event.created_at.iso8601(3), event.actor_client&.name || "admin", event.action, event.vault_secret&.path || "-",
          event.outcome, event.reason_code, event.request_id, event.source_ip, event.workspace_id ]
      end

      def neutralise_formula(cell) = cell.is_a?(String) && cell.match?(FORMULA_PREFIX) ? "'#{cell}" : cell

      def filtered_events
        events = SecretAccessEvent.all
        events = events.where(workspace_id: params[:workspaceId]) if params[:workspaceId].present?
        events = events.where(outcome: params[:outcome]) if params[:outcome].present?
        events = events.where("action LIKE ?", "#{SecretAccessEvent.sanitize_sql_like(action_filter)}%") if action_filter.present?
        events
      end

      # params[:action] is always the controller action name; the UI's ?action=
      # filter is only reachable through the raw query string.
      def action_filter = request.query_parameters["action"]
    end
  end
end
