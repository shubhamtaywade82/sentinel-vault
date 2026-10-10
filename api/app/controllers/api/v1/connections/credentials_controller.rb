module Api
  module V1
    module Connections
      # Runtime credential delivery. Fails closed: an expired, revoked or
      # reauth-pending credential is refused, never returned as if it were valid.
      class CredentialsController < ApplicationController
        include ConnectionAccess
        include SecretAccess

        rate_limit to: 60, within: 1.minute, with: -> { raise VaultError.new(:rate_limited) }

        def create
          connection = find_connection!
          secret = readable_secret!(connection)
          ensure_deliverable!(connection)
          refreshed = refresh_if_expired!(connection)
          version, value = with_active_secret(secret) do
            version = secret.current_version || raise(VaultError.new(:version_not_found))
            SecretAccessEvent.record!("connection.credential", secret: secret, secret_version_id: version.id, reason_code: connection.id)
            [ version, version.decrypt_value ]
          end
          render_plaintext({ credential: credential_payload(connection, version, value).merge(refreshed: refreshed) })
        end

        private

        def readable_secret!(connection)
          purpose = params[:purpose].presence || IntegrationConnection::ACCESS_TOKEN_PURPOSE
          unless IntegrationConnection::READABLE_PURPOSES.include?(purpose)
            raise VaultError.new(:secret_access_denied, "#{purpose} credentials are never released through a connection")
          end

          binding = connection.bindings.find { |candidate| candidate.purpose == purpose }
          raise VaultError.new(:resource_not_found, "no #{purpose} binding on this connection") unless binding

          binding.vault_secret.tap { |secret| authorize_secret!(secret, "value:read") }
        end

        def ensure_deliverable!(connection)
          raise VaultError.new(:reauthorization_required, "connection is #{connection.status}") unless connection.active?
        end

        # An expired token is renewed first; if that fails the caller gets an
        # error, never the expired value.
        def refresh_if_expired!(connection)
          return false unless connection.access_expired?

          run = ::Connections::Refresh.call(connection) if connection.provider.refreshable?
          raise VaultError.new(:credential_refresh_unavailable, "access credential has expired and could not be refreshed") unless run&.succeeded?

          connection.reload
          true
        rescue VaultError => e
          raise unless e.code == :rotation_in_progress

          raise VaultError.new(:credential_refresh_unavailable, "access credential is being refreshed; retry shortly")
        end

        def credential_payload(connection, version, value)
          { value: value, expiresAt: connection.access_expires_at, generation: connection.refresh_generation, versionId: version.id }
        end
      end
    end
  end
end
