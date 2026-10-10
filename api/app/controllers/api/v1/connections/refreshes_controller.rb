module Api
  module V1
    module Connections
      class RefreshesController < ApplicationController
        include ConnectionAccess

        rate_limit to: 30, within: 1.minute, with: -> { raise VaultError.new(:rate_limited) }

        # Runs synchronously (provider calls are time-bounded) so the caller sees the outcome.
        def create
          connection = find_connection!
          authorize_refresh!(connection)
          connection.ensure_not_revoked!
          run = ::Connections::Refresh.call(connection, idempotency_key: request.headers["Idempotency-Key"].presence)
          render json: { rotationRun: RotationRunSerializer.call(run) }, status: :accepted
        end

        private

        def authorize_refresh!(connection)
          return if Current.principal.admin?

          allowed = Current.principal.client.grants.where(vault_secret_id: connection.bindings.select(:vault_secret_id))
                                                .where("'connection:refresh' = ANY(permissions)").exists?
          raise VaultError.new(:grant_required, "Missing grant: connection:refresh on a bound secret") unless allowed
        end
      end
    end
  end
end
