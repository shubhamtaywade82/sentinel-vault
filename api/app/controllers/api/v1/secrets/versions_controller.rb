module Api
  module V1
    module Secrets
      class VersionsController < ApplicationController
        include SecretAccess

        def index
          secret = find_secret!
          authorize_secret!(secret)
          render json: { versions: secret.versions.order(version_number: :desc).map { |version| SecretVersionSerializer.call(version) } }
        end

        def create
          secret = find_secret!
          authorize_secret!(secret, "version:create")
          version = ::Secrets::WriteVersion.call(secret, "secret.version.create", version_attributes)
          render json: { version: SecretVersionSerializer.call(version) }, status: :created
        end

        private

        def version_attributes = { value: params.require(:value), created_by: created_by_label, **expiry_attributes }
      end
    end
  end
end
