# Read-only aggregates behind the admin dashboard. Each takes an optional
# workspace id; nil means across all workspaces.
module Dashboard
  RANGES = { "1h" => 1.hour, "24h" => 24.hours, "7d" => 7.days, "30d" => 30.days }.freeze

  module_function

  def scope(relation, workspace_id, column: :workspace_id)
    workspace_id.present? ? relation.where(column => workspace_id) : relation
  end

  def range_key(raw) = RANGES.key?(raw) ? raw : "24h"
end
