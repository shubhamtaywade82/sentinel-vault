class RefreshSweepJob < ApplicationJob
  queue_as :default

  def perform = Connections::Sweep.call
end
