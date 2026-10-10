module WorkspaceSerializer
  module_function

  def call(workspace)
    workspace.slice(:id, :slug, :name, :status).merge(createdAt: workspace.created_at, updatedAt: workspace.updated_at)
  end
end
