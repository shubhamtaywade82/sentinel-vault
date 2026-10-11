module Providers
  # Dhan has no refresh tokens. A live access token is renewed with RenewToken;
  # Dhan refuses to renew a lapsed one, so the fallback is a fresh token from the
  # account PIN and a TOTP code. Both calls go through DhanHQ::Auth (DhanHQ gem
  # >= 4.1.1). Dhan's hosts are fixed, so the admin-URL guard in OutboundHttp
  # is not needed here.
  module DhanV1
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

      dhan_call do
        DhanHQ::Auth.generate_access_token(dhan_client_id: client_id, pin: pin, totp: DhanHQ::Auth.generate_totp(seed))
      end
    rescue ROTP::Base32::Base32Error
      Result.failure("invalid_grant")
    end

    def renew(client_id, access_token)
      dhan_call { DhanHQ::Auth.renew_token(access_token: access_token, client_id: client_id) }
    end

    # Maps DhanHQ::Auth's typed failures onto the refresh engine's retry classes.
    def dhan_call
      issued(yield)
    rescue DhanHQ::RateLimitError
      Result.failure("rate_limited")
    rescue DhanHQ::InternalServerError, DhanHQ::NetworkError
      Result.failure("transient")
    rescue DhanHQ::InvalidAuthenticationError
      Result.failure("invalid_grant")
    rescue DhanHQ::Error
      Result.failure("provider_error")
    end

    def issued(body)
      token = body["accessToken"]
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
