class ApplicationController < ActionController::API
  include ActionController::HttpAuthentication::Token::ControllerMethods
  include Authentication

  # Later rescue_from declarations win, so the catch-all goes first.
  rescue_from StandardError, with: :render_internal_error
  rescue_from VaultError, with: :render_vault_error
  rescue_from ActionController::ParameterMissing do |error|
    render_vault_error(VaultError.new(:validation_failed, error.message))
  end
  rescue_from ActiveRecord::RecordInvalid do |error|
    render_vault_error(VaultError.new(:validation_failed, error.record.errors.full_messages.to_sentence))
  end
  rescue_from ActiveRecord::RecordNotUnique do
    render_vault_error(VaultError.new(:conflict, "resource already exists"))
  end

  before_action :set_request_context, prepend: true

  private

  def set_request_context
    Current.request_id = request.request_id
    # remote_ip only honours X-Forwarded-For from trusted proxies, unlike the raw header.
    Current.source_ip = request.remote_ip
  end

  # Responses carrying plaintext must never be cached by browsers or proxies.
  def render_plaintext(payload, status: :ok)
    response.headers["Cache-Control"] = "no-store, private"
    render json: payload, status: status
  end

  def render_vault_error(error)
    render json: error.to_envelope, status: error.status
  end

  def render_internal_error(error)
    Rails.logger.error("[vault] unhandled #{error.class}: #{error.message}")
    raise error if Rails.env.local? && !Rails.env.test?

    render_vault_error(VaultError.new(:internal_error, "Internal error"))
  end
end
