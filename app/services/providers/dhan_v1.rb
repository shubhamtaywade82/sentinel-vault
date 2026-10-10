module Providers
  # Dhan has no refresh tokens. A live access token is renewed with RenewToken;
  # once it has lapsed, a new one is generated from the account PIN and a TOTP
  # code (endpoints as used by the official dhanhq SDK, auth.py).
  module DhanV1
    RENEW_URL = "https://api.dhan.co/v2/RenewToken".freeze
    GENERATE_URL = "https://auth.dhan.co/app/generateAccessToken".freeze
    # Dhan documents 24h validity; used only when a response omits expiryTime.
    DEFAULT_VALIDITY = 24.hours
    # Dhan reports expiryTime in Indian Standard Time without an offset.
    PROVIDER_TIME_ZONE = "Asia/Kolkata".freeze

    module_function

    def refreshable? = true

    def reauthorizable?(credentials) = credentials.bound?("pin") && credentials.bound?("totp_seed")

    def refresh(connection, credentials)
      client_id = credentials["client_id"]
      return Result.failure("invalid_grant") if client_id.blank?

      renewed = renew(client_id, credentials["access_token"]) if credentials["access_token"].present?
      return renewed if renewed && (renewed.ok || !renewed.permanent?)

      reauthorizable?(credentials) ? reauthorize(connection, credentials) : (renewed || Result.failure("invalid_grant"))
    end

    def reauthorize(_connection, credentials)
      client_id, pin, seed = credentials["client_id"], credentials["pin"], credentials["totp_seed"]
      return Result.failure("invalid_grant") if [ client_id, pin, seed ].any?(&:blank?)

      Providers.guarded do
        query = URI.encode_www_form(dhanClientId: client_id, pin: pin, totp: ROTP::TOTP.new(seed).now)
        interpret(OutboundHttp.call(:post, "#{GENERATE_URL}?#{query}"))
      end
    rescue ROTP::Base32::Base32Error
      Result.failure("invalid_grant")
    end

    def renew(client_id, access_token)
      Providers.guarded do
        interpret(OutboundHttp.call(:get, RENEW_URL, headers: { "access-token" => access_token, "dhanClientId" => client_id }))
      end
    end

    def interpret(response)
      return Providers.failure_for_status(response.status) unless response.status == 200

      body = response.json || {}
      token = body["accessToken"] || body["access_token"]
      return Result.failure("provider_error") if token.blank?

      Result.success("access_token" => { value: token, expires_at: parse_expiry(body["expiryTime"]) })
    end

    def parse_expiry(raw)
      case raw
      when Numeric, /\A\d+\z/ then epoch_time(raw.to_i)
      when String then Time.find_zone!(PROVIDER_TIME_ZONE).parse(raw) || DEFAULT_VALIDITY.from_now
      else DEFAULT_VALIDITY.from_now
      end
    end

    # Accepts seconds or milliseconds since the epoch.
    def epoch_time(value) = Time.zone.at(value > 10**11 ? value / 1000.0 : value)
  end
end
