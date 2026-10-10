module Api
  module V1
    module Dashboard
      # Fixes a compliance violation with a real new credential: the provider
      # refreshes connection-bound access tokens; anything else needs the new
      # value from the caller. A random placeholder would "pass" compliance while
      # breaking every consumer of the secret, so none is ever generated.
      class RemediationsController < ApplicationController
        include SecretAccess

        VIOLATIONS = %w[stale_rotation never_rotated expired_secret expiring_soon].freeze

        before_action :require_admin!
        rate_limit to: 30, within: 1.minute, with: -> { raise VaultError.new(:rate_limited) }

        def create
          violation = params.require(:violation)
          raise VaultError.new(:validation_failed, "violation must be one of: #{VIOLATIONS.join(', ')}") unless violation.in?(VIOLATIONS)

          secret = find_secret!(params.require(:secretId))
          version = params[:value].present? ? write_value(secret, violation) : refresh_through_connection(secret)
          render json: { secret: SecretSerializer.call(secret.reload), version: SecretVersionSerializer.call(version), remediated: violation }
        end

        private

        # The old expiry belonged to the old value; keep only an expiry the caller states.
        def write_value(secret, violation)
          expiry = expiry_attributes.presence || (violation.in?(%w[expired_secret expiring_soon]) ? { expires_at: nil } : {})
          ::Secrets::WriteVersion.call(secret, "secret.remediate", { value: params[:value], created_by: created_by_label, **expiry })
        end

        def refresh_through_connection(secret)
          connection = secret.bindings.where(purpose: IntegrationConnection::ACCESS_TOKEN_PURPOSE).map(&:integration_connection)
                             .find { |candidate| candidate.active? && candidate.provider.refreshable? }
          raise VaultError.new(:validation_failed, "value is required: this secret is not refreshed by a provider") unless connection

          run = ::Connections::Refresh.call(connection)
          raise VaultError.new(:credential_refresh_unavailable, "provider refresh did not succeed (#{run.error_code})") unless run.succeeded?

          run.result_version
        end
      end
    end
  end
end
