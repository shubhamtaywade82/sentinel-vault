module Api
  module V1
    module Secrets
      class RevocationsController < ApplicationController
        include SecretAccess

        rate_limit to: 30, within: 1.minute, with: -> { raise VaultError.new(:rate_limited) }

        def create
          secret = find_secret!
          authorize_secret!(secret, "revoke")
          # Refuse rather than silently skip: the caller must know nothing was revoked upstream.
          if ActiveModel::Type::Boolean.new.cast(params[:revokeUpstream])
            raise VaultError.new(:validation_failed, "revokeUpstream is unavailable until provider adapters are migrated")
          end

          secret.revoke!
          render json: { secret: SecretSerializer.call(secret) }
        end
      end
    end
  end
end
