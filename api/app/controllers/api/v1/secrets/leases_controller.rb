module Api
  module V1
    module Secrets
      class LeasesController < ApplicationController
        include SecretAccess

        # Clients see only their own leases on secrets they hold a grant for.
        def index
          secret = find_secret!
          authorize_secret!(secret)
          leases = secret_leases(secret).includes(:vault_secret, :service_client).order(created_at: :desc)
          render json: { leases: leases.map { |lease| LeaseSerializer.call(lease) } }
        end

        def create
          secret = find_secret!
          client = lease_holder!(secret)
          lease = SecretLease.transaction do
            SecretLease.create!(vault_secret: secret, service_client: client, granted_permissions: requested_permissions,
                                expires_at: requested_ttl.seconds.from_now).tap { |created| audit!(created) }
          end
          render json: { lease: LeaseSerializer.call(lease) }, status: :created
        end

        private

        def secret_leases(secret)
          Current.principal.admin? ? secret.leases : secret.leases.where(service_client: Current.principal.client)
        end

        # Admins lease to any client in the secret's workspace; clients only to themselves.
        def lease_holder!(secret)
          holder = secret.workspace.service_clients.find_by(id: params.require(:serviceClientId))
          raise VaultError.new(:client_not_found, "client not found in this secret's workspace") unless holder
          return holder if Current.principal.admin?
          raise VaultError.new(:grant_required, "clients may only lease for themselves") unless holder == Current.principal.client

          authorize_secret!(secret, "value:read")
          holder
        end

        def requested_permissions
          permissions = params.require(:permissions)
          valid = permissions.is_a?(Array) && permissions.all?(String) && (permissions - SecretAccessGrant::PERMISSIONS).empty?
          raise VaultError.new(:validation_failed, "permissions must be a list of known permission names") unless valid

          permissions.uniq
        end

        def requested_ttl
          ttl = Integer(params.require(:ttlSeconds).to_s, exception: false)
          return ttl if SecretLease::TTL_RANGE.cover?(ttl)

          raise VaultError.new(:validation_failed, "ttlSeconds must be an integer from #{SecretLease::TTL_RANGE.min} to #{SecretLease::TTL_RANGE.max}")
        end

        def audit!(lease)
          SecretAccessEvent.record!("lease.issue", secret: lease.vault_secret,
                                                   reason_code: "ttl=#{(lease.expires_at - lease.issued_at).round}s;perms=#{lease.granted_permissions.join(',')}")
        end
      end
    end
  end
end
