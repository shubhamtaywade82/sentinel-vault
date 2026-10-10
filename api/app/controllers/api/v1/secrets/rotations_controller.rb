module Api
  module V1
    module Secrets
      # Manual rotation with a caller-supplied value. Provider-driven rotation
      # arrives with the provider adapters; until then no value is ever invented.
      class RotationsController < ApplicationController
        include SecretAccess

        rate_limit to: 30, within: 1.minute, with: -> { raise VaultError.new(:rate_limited) }

        def create
          secret = find_secret!
          authorize_secret!(secret, "rotate")
          attributes = { value: params.require(:value), created_by: created_by_label, **expiry_attributes }
          version = ::Secrets::WriteVersion.call(secret, "secret.rotate", attributes)
          render json: { version: SecretVersionSerializer.call(version) }, status: :created
        end
      end
    end
  end
end
