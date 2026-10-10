module Api
  module V1
    class AuditEventsController < ApplicationController
      DEFAULT_LIMIT = 100
      MAX_LIMIT = 500

      before_action :require_admin!

      def index
        events = filtered_events.includes(:actor_client, :vault_secret).order(created_at: :desc)
                                .limit(params.fetch(:limit, DEFAULT_LIMIT).to_i.clamp(1, MAX_LIMIT))
                                .offset([ params[:offset].to_i, 0 ].max)
        render json: { events: events.map { |event| AuditEventSerializer.call(event) } }
      end

      private

      def filtered_events
        events = SecretAccessEvent.all
        events = events.where(workspace_id: params[:workspaceId]) if params[:workspaceId].present?
        events = events.where(outcome: params[:outcome]) if params[:outcome].present?
        events = events.where("action LIKE ?", "#{SecretAccessEvent.sanitize_sql_like(params[:action])}%") if params[:action].present?
        events
      end
    end
  end
end
