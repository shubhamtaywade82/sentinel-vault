module Api
  module V1
    module Secrets
      class RevealsController < ApplicationController
        include SecretAccess

        MAX_REASON_LENGTH = 200

        rate_limit to: 30, within: 1.minute, with: -> { raise VaultError.new(:rate_limited) }

        def create
          secret = find_secret!
          authorize_value_read!(secret, "secret.reveal")
          version, value = with_active_secret(secret) do
            version = secret.current_version || raise(VaultError.new(:version_not_found))
            # Plaintext leaves only after its audit row commits with this transaction.
            SecretAccessEvent.record!("secret.reveal", secret: secret, secret_version_id: version.id, reason_code: reason)
            [ version, version.decrypt_value ]
          end
          render_plaintext({ secret: SecretSerializer.call(secret), version: SecretVersionSerializer.call(version), value: value })
        end

        private

        def reason = params[:reason].presence&.truncate(MAX_REASON_LENGTH)
      end
    end
  end
end
