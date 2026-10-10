module Api
  module V1
    module Connections
      # Re-authorizes when the provider allows it unattended (Dhan with a stored
      # PIN and TOTP seed); otherwise records that a person must do it.
      class ReauthorizationsController < ApplicationController
        include ConnectionAccess

        before_action :require_admin!

        def create
          connection = find_connection!
          connection.ensure_not_revoked!
          run = if connection.provider.reauthorizable?(Providers::Credentials.new(connection))
            ::Connections::Refresh.call(connection, operation: "reauthorize")
          else
            require_manual_reauthorization!(connection)
          end
          render json: { rotationRun: RotationRunSerializer.call(run) }, status: :accepted
        end

        private

        def require_manual_reauthorization!(connection)
          now = Time.current
          IntegrationConnection.transaction do
            connection.update!(status: "reauth_required", reauth_required_at: now, last_error_code: "manual_reauth_required")
            SecretAccessEvent.record!("connection.reauthorize", workspace_id: connection.workspace_id, outcome: "error",
                                                                reason_code: "manual_reauth_required")
            connection.rotation_runs.create!(operation: "reauthorize", status: "failed", error_code: "manual_reauth_required",
                                             attempt_count: 1, started_at: now, completed_at: now)
          end
        end
      end
    end
  end
end
