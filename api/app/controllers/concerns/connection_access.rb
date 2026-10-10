# Tenant-scoped connection lookup: a client sees a connection only when it holds
# value:read or connection:refresh on one of its bound secrets.
module ConnectionAccess
  extend ActiveSupport::Concern

  private

  def find_connection!(id = params[:connection_id] || params[:id])
    scope = Current.principal.admin? ? IntegrationConnection.all : IntegrationConnection.visible_to(Current.principal.client)
    scope.includes(bindings: :vault_secret).find_by(id: id) || raise(VaultError.new(:connection_not_found))
  end
end
