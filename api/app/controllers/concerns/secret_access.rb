# Tenant-scoped secret lookup and grant checks shared by every secret endpoint.
module SecretAccess
  extend ActiveSupport::Concern

  private

  # Clients only ever see their own workspace, so a foreign id is "not found",
  # never "forbidden" — existence is not confirmed across tenants.
  def find_secret!(id = params[:secret_id] || params[:id])
    scope = Current.principal.admin? ? VaultSecret.all : Current.principal.client.workspace.vault_secrets
    scope.find_by(id: id) || raise(VaultError.new(:secret_not_found))
  end

  # Admin passes. A client needs `permission`, or any grant when it is nil.
  def authorize_secret!(secret, permission = nil)
    return if Current.principal.admin?

    granted = Current.principal.client.permissions_for(secret)
    return if permission ? granted.include?(permission) : granted.any?

    raise VaultError.new(:grant_required, "Missing grant: #{permission || 'any permission'} on #{secret.id}")
  end

  # Plaintext needs value:read, and admins must confirm explicitly. Denials are audited.
  def authorize_value_read!(secret, action)
    admin = Current.principal.admin?
    allowed = admin ? params[:admin_reveal_ok] == "true" : Current.principal.client.permissions_for(secret).include?("value:read")
    return if allowed

    SecretAccessEvent.record_denial(action, secret: secret, reason_code: admin ? "admin_reveal_required" : "value:read")
    raise VaultError.new(:admin_required, "admin reveal requires admin_reveal_ok=true") if admin

    raise VaultError.new(:grant_required, "Missing grant: value:read on #{secret.id}")
  end

  def created_by_label = Current.principal.admin? ? "admin" : Current.principal.client.id

  # {} when expiresInHours is absent, so the caller keeps the existing expiry.
  def expiry_attributes
    return {} if params[:expiresInHours].blank?

    hours = Float(params[:expiresInHours], exception: false)
    raise VaultError.new(:validation_failed, "expiresInHours must be a positive number") unless hours&.positive?

    { expires_at: hours.hours.from_now }
  end

  def ensure_secret_active!(secret)
    raise VaultError.new(:conflict, "secret is #{secret.status}") unless secret.active?
  end

  # FOR SHARE lets concurrent reads proceed but makes a revoke wait, so the
  # active check cannot go stale between checking and releasing plaintext.
  def with_active_secret(secret)
    VaultSecret.transaction do
      secret.lock!("FOR SHARE")
      ensure_secret_active!(secret)
      yield
    end
  end
end
