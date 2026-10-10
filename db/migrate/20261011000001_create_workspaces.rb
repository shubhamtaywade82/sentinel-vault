class CreateWorkspaces < ActiveRecord::Migration[8.1]
  def change
    create_table :workspaces, id: :uuid do |t|
      t.string :slug, null: false, index: { unique: true }
      t.string :name, null: false
      t.string :status, null: false, default: "active"
      t.timestamps
    end
    add_check_constraint :workspaces, "status IN ('active','suspended','archived')", name: "workspaces_status_check"
  end
end
