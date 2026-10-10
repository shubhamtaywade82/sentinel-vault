# The authenticated caller: the vault administrator, or exactly one service client.
Principal = Data.define(:client) do
  def self.admin = new(client: nil)

  def admin? = client.nil?
end
