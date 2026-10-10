module Api
  module V1
    module Connections
      # Vault-side revocation only; provider-side revocation arrives with the adapters.
      class RevocationsController < ApplicationController
        include ConnectionAccess

        before_action :require_admin!

        def create
          connection = find_connection!
          connection.with_lock do
            raise VaultError.new(:conflict, "connection is already revoked") if connection.revoked?

            connection.update!(status: "revoked")
            SecretAccessEvent.record!("connection.revoke", workspace_id: connection.workspace_id, reason_code: connection.id)
          end
          render json: { connection: ConnectionSerializer.call(connection) }
        end
      end
    end
  end
end
