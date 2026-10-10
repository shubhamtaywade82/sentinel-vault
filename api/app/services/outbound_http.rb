require "net/http"
require "resolv"

# HTTPS client for calls to credential providers. Connection URLs are admin
# input, so this resolves the host once, refuses private, loopback, link-local
# and metadata addresses, then connects to that vetted address (TLS still
# verifies the hostname) so DNS rebinding cannot swap the target mid-request.
# No redirects are followed; time and response size are bounded.
module OutboundHttp
  OPEN_TIMEOUT = 3
  READ_TIMEOUT = 10
  MAX_BODY_BYTES = 64.kilobytes
  BLOCKED_RANGES = %w[
    0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24
    192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4 ::/128 ::1/128 ::ffff:0:0/96 fc00::/7 fe80::/10
  ].map { |range| IPAddr.new(range) }.freeze

  # Refused by policy: never retry.
  class Blocked < StandardError; end
  # Network-level failure: retryable.
  class Unavailable < StandardError; end

  Response = Data.define(:status, :body) do
    def json
      JSON.parse(body)
    rescue JSON::ParserError
      nil
    end
  end

  module_function

  def call(method, url, headers: {}, form: nil)
    uri = URI.parse(url)
    raise Blocked, "only https URLs with a host are allowed" unless uri.is_a?(URI::HTTPS) && uri.host.present?

    http = build_http(uri, vetted_address(uri.host))
    read(http, build_request(method, uri, headers, form))
  rescue URI::InvalidURIError => e
    raise Blocked, e.message
  rescue Timeout::Error, SystemCallError, SocketError, IOError, OpenSSL::SSL::SSLError => e
    raise Unavailable, e.class.name
  end

  def vetted_address(host)
    addresses = Resolv.getaddresses(host)
    raise Unavailable, "#{host} did not resolve" if addresses.empty?

    blocked = addresses.find { |address| BLOCKED_RANGES.any? { |range| range.include?(IPAddr.new(address)) } }
    raise Blocked, "#{host} resolves to a non-public address" if blocked

    addresses.first
  end

  def build_http(uri, address)
    Net::HTTP.new(uri.host, uri.port).tap do |http|
      http.use_ssl = true
      http.ipaddr = address
      http.open_timeout = OPEN_TIMEOUT
      http.read_timeout = READ_TIMEOUT
      http.write_timeout = READ_TIMEOUT
    end
  end

  def build_request(method, uri, headers, form)
    request = Net::HTTPGenericRequest.new(method.to_s.upcase, form.present?, true, uri.request_uri, headers)
    if form.present?
      request["Content-Type"] = "application/x-www-form-urlencoded"
      request.body = URI.encode_www_form(form)
    end
    request
  end

  def read(http, request)
    body = +""
    status = nil
    http.request(request) do |response|
      status = response.code.to_i
      response.read_body do |chunk|
        body << chunk
        raise Unavailable, "response exceeded #{MAX_BODY_BYTES} bytes" if body.bytesize > MAX_BODY_BYTES
      end
    end
    Response.new(status: status, body: body)
  end
end
