module Providers
  # RFC 6749 refresh_token grant against the connection's own token endpoint.
  # Re-authorization needs the resource owner's consent, so it is never automatic.
  module Oauth2Generic
    # RFC 6749 §5.2 errors meaning the grant itself is dead, not a hiccup.
    DEAD_GRANT_ERRORS = %w[invalid_grant invalid_client unauthorized_client].freeze

    module_function

    def refreshable? = true

    def reauthorizable?(_credentials) = false

    def refresh(connection, credentials)
      refresh_token = credentials["refresh_token"]
      return Result.failure("invalid_grant") if connection.token_url.blank? || refresh_token.blank?

      Providers.guarded do
        response = OutboundHttp.call(:post, connection.token_url, headers: { "Accept" => "application/json" },
                                                                   form: grant_form(refresh_token, credentials))
        interpret(response)
      end
    end

    def grant_form(refresh_token, credentials)
      { grant_type: "refresh_token", refresh_token: refresh_token,
        client_id: credentials["client_id"], client_secret: credentials["client_secret"] }.compact
    end

    def interpret(response)
      body = response.json || {}
      return Result.failure("invalid_grant") if response.status == 400 && DEAD_GRANT_ERRORS.include?(body["error"])
      return Providers.failure_for_status(response.status) unless response.status == 200
      return Result.failure("provider_error") if body["access_token"].blank?

      Result.success(issued_credentials(body))
    end

    def issued_credentials(body)
      expires_at = body["expires_in"].to_i.positive? ? body["expires_in"].to_i.seconds.from_now : nil
      credentials = { "access_token" => { value: body["access_token"], expires_at: expires_at } }
      # Providers that rotate refresh tokens invalidate the old one; keep the new one.
      credentials["refresh_token"] = { value: body["refresh_token"], expires_at: nil } if body["refresh_token"].present?
      credentials
    end
  end
end
