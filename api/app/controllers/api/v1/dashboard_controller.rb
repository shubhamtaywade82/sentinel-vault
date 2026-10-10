module Api
  module V1
    # Read-only admin aggregates. Not audited per request: the UI polls these,
    # and an append-only trail flooded with dashboard refreshes hides real events.
    class DashboardController < ApplicationController
      before_action :require_admin!

      def stats = render(json: ::Dashboard::Stats.call(workspace_id))

      def provider_health = render(json: { providers: ::Dashboard::ProviderHealth.call(workspace_id) })

      def client_preview = render(json: { clients: ::Dashboard::ClientPreview.call(workspace_id) })

      def compliance = render(json: ::Dashboard::Compliance.call(workspace_id))

      def expiring_leases = render(json: { leases: ::Dashboard::ExpiringLeases.call(workspace_id) })

      def audit_activity = render(json: ::Dashboard::AuditActivity.call(workspace_id, range))

      def anomalies = render(json: { anomalies: ::Dashboard::Anomalies.call(workspace_id, range) })

      private

      def workspace_id = params[:workspaceId].presence

      def range = ::Dashboard.range_key(params[:range])
    end
  end
end
