module Api
  module V1
    class LeasesController < ApplicationController
      before_action :require_admin!, only: :index

      def index
        leases = SecretLease.includes(:vault_secret, :service_client).order(created_at: :desc)
        leases = leases.current if params[:activeOnly] == "true"
        leases = leases.where(service_client_id: params[:serviceClientId]) if params[:serviceClientId].present?
        leases = leases.joins(:vault_secret).where(vault_secrets: { workspace_id: params[:workspaceId] }) if params[:workspaceId].present?
        render json: { leases: leases.map { |lease| LeaseSerializer.call(lease) } }
      end

      # Admins revoke any lease; a client only its own.
      def destroy
        lease = SecretLease.includes(:vault_secret, :service_client).find_by(id: params[:id])
        raise VaultError.new(:resource_not_found, "lease not found") unless lease && revocable_by_caller?(lease)

        SecretLease.transaction do
          lease.revoke!
          SecretAccessEvent.record!("lease.revoke", secret: lease.vault_secret, reason_code: lease.id)
        end
        render json: { lease: LeaseSerializer.call(lease) }
      end

      private

      def revocable_by_caller?(lease) = Current.principal.admin? || lease.service_client_id == Current.principal.client.id
    end
  end
end
