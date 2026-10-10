# Renders unhandled exceptions in the contract's error envelope. Rails has
# already logged them and reported them to Rails.error by the time this runs;
# it only shapes the response, so no defect is hidden behind a rescue.
module ErrorEnvelopeApp
  CODES_BY_STATUS = { 400 => :validation_failed, 404 => :resource_not_found, 422 => :validation_failed }.freeze

  module_function

  def call(env)
    status = env["PATH_INFO"].delete_prefix("/").to_i
    status = 500 unless Rack::Utils::HTTP_STATUS_CODES.key?(status)
    error = VaultError.new(CODES_BY_STATUS.fetch(status, :internal_error), Rack::Utils::HTTP_STATUS_CODES.fetch(status))
    [ status, { "content-type" => "application/json" }, [ error.to_envelope.to_json ] ]
  end
end
