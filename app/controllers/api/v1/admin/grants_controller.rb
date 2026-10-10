module Api
  module V1
    module Admin
      class GrantsController < ApplicationController
        before_action :require_admin!

        # Upserts: granting again replaces the permission set.
        def create
          client = ServiceClient.find_by(id: params.require(:serviceClientId)) || raise(VaultError.new(:client_not_found))
          secret = VaultSecret.find_by(id: params.require(:vaultSecretId)) || raise(VaultError.new(:secret_not_found))
          grant = SecretAccessGrant.find_or_initialize_by(service_client: client, vault_secret: secret)
          grant.permissions = params.require(:permissions)
          SecretAccessGrant.transaction do
            grant.save!
            SecretAccessEvent.record!("grant.create", secret: secret, reason_code: "#{client.public_id}:#{grant.permissions.join(',')}")
          end
          render json: { grant: GrantSerializer.call(grant) }, status: :created
        end

        def destroy
          grant = SecretAccessGrant.includes(:service_client, :vault_secret).find_by(id: params[:id])
          raise VaultError.new(:resource_not_found, "grant not found") unless grant

          SecretAccessGrant.transaction do
            grant.destroy!
            SecretAccessEvent.record!("grant.delete", secret: grant.vault_secret, reason_code: grant.service_client.public_id)
          end
          head :no_content
        end
      end
    end
  end
end
