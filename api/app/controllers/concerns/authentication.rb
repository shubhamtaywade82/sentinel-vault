# Resolves `Authorization: Bearer <token>` to the admin or a usable service client.
module Authentication
  extend ActiveSupport::Concern

  included do
    before_action :authenticate!
  end

  private

  def authenticate!
    Current.principal = resolve_principal || raise(VaultError.new(:unauthorized))
  end

  def require_admin!
    raise VaultError.new(:admin_required) unless Current.principal.admin?
  end

  def resolve_principal
    authenticate_with_http_token do |token, _options|
      next Principal.admin if admin_token?(token)

      client = ServiceClient.authenticate(token)
      Principal.new(client: client) if client
    end
  end

  # Digests first: secure_compare short-circuits on length, which would leak it.
  def admin_token?(token)
    ActiveSupport::SecurityUtils.secure_compare(
      Digest::SHA256.hexdigest(token), Digest::SHA256.hexdigest(VaultConfig.admin_token)
    )
  end
end
