module Api
  module V1
    module Secrets
      # Blast radius: every client, connection and lease that depends on a secret.
      class UsagesController < ApplicationController
        include SecretAccess

        def show
          secret = find_secret!
          authorize_secret!(secret)
          usage = { grants: grant_usage(secret), connections: connection_usage(secret), leases: lease_usage(secret) }
          SecretAccessEvent.record!("secret.usage", secret: secret)
          render json: { secretId: secret.id, path: secret.path, usage: usage, blastRadius: blast_radius(usage) }
        end

        private

        def grant_usage(secret)
          secret.grants.includes(:service_client).order(:created_at).map do |grant|
            client = grant.service_client
            { clientId: client.id, clientName: client.name, clientType: client.client_type,
              permissions: grant.permissions, lastUsedAt: client.last_used_at }
          end
        end

        def connection_usage(secret)
          secret.bindings.includes(:integration_connection).order(:created_at).map do |binding|
            connection = binding.integration_connection
            { connectionId: connection.id, providerKey: connection.provider_key, adapterKey: connection.adapter_key,
              status: connection.status, purpose: binding.purpose, providerAccountRef: connection.provider_account_ref }
          end
        end

        def lease_usage(secret)
          secret.leases.includes(:service_client).order(expires_at: :desc).map do |lease|
            { leaseId: lease.id, clientName: lease.service_client.name, expiresAt: lease.expires_at, status: lease.effective_status }
          end
        end

        def blast_radius(usage)
          { clientCount: usage[:grants].pluck(:clientId).uniq.size,
            connectionCount: usage[:connections].pluck(:connectionId).uniq.size,
            activeLeaseCount: usage[:leases].count { |lease| lease[:status] == "active" } }
        end
      end
    end
  end
end
