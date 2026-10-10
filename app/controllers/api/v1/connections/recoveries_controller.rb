module Api
  module V1
    module Connections
      # Re-arms a connection after a person re-authorized it at the provider:
      # stores the new token material and makes the connection due for refresh.
      class RecoveriesController < ApplicationController
        include ConnectionAccess

        before_action :require_admin!

        def create
          connection = find_connection!
          connection.ensure_not_revoked!
          IntegrationConnection.transaction do
            connection.lock!
            versions = store_material!(connection)
            connection.update!(rearmed_attributes(connection))
            record_recovery!(connection, versions)
          end
          render json: { connection: ConnectionSerializer.call(connection) }
        end

        private

        def recovered_material
          @recovered_material ||= parse_material
        end

        def parse_material
          material = {}
          material["refresh_token"] = { value: params[:newRefreshToken] } if params[:newRefreshToken].present?
          if params[:newAccessToken].present?
            expiry = params[:accessExpiresAt].present? ? Time.iso8601(params[:accessExpiresAt].to_s) : nil
            material["access_token"] = { value: params[:newAccessToken], expires_at: expiry }
          end
          material
        rescue ArgumentError
          raise VaultError.new(:validation_failed, "accessExpiresAt is not a valid ISO 8601 time")
        end

        def store_material!(connection)
          material = recovered_material
          versions = ::Connections::Outcome.store_credentials(connection, material)
          missing = material.keys - versions.keys
          raise VaultError.new(:validation_failed, "connection has no binding for: #{missing.join(', ')}") if missing.any?

          versions
        end

        # A new access token sets its own schedule; otherwise refresh as soon as possible.
        def rearmed_attributes(connection)
          expiry = recovered_material.dig("access_token", :expires_at)
          attributes = { status: "active", last_error_code: nil, reauth_required_at: nil, refresh_lease_expires_at: nil,
                         refresh_generation: connection.refresh_generation + 1, refresh_after: Time.current }
          return attributes unless recovered_material.key?("access_token")

          attributes.merge(access_expires_at: expiry, refresh_after: ::Connections::Outcome.refresh_after(expiry))
        end

        def record_recovery!(connection, versions)
          now = Time.current
          connection.rotation_runs.create!(operation: "recover", status: "succeeded", attempt_count: 1, started_at: now, completed_at: now,
                                           result_version: versions["access_token"] || versions["refresh_token"])
          SecretAccessEvent.record!("connection.recover", workspace_id: connection.workspace_id, outcome: "success",
                                                          reason_code: versions.keys.join(",").presence || "rearm")
        end
      end
    end
  end
end
