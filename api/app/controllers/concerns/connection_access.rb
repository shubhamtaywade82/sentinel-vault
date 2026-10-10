# Tenant-scoped connection lookup: a client sees a connection only when it holds
# value:read or connection:refresh on one of its bound secrets.
module ConnectionAccess
  extend ActiveSupport::Concern

  private

  def find_connection!(id = params[:connection_id] || params[:id])
    connection = IntegrationConnection.includes(bindings: :vault_secret).find_by(id: id)
    return connection if connection && (Current.principal.admin? || connection.visible_to?(Current.principal.client))

    raise VaultError.new(:connection_not_found)
  end
end
