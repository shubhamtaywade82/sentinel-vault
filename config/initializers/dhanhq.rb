# DhanHQ::Auth reads its HTTP timeouts from the environment (gem defaults 10s
# connect / 30s read). Token calls sit on the credential-delivery path, so fail
# faster here unless the deployment sets its own values.
ENV["DHAN_CONNECT_TIMEOUT"] ||= "3"
ENV["DHAN_READ_TIMEOUT"] ||= "10"
ENV["DHAN_WRITE_TIMEOUT"] ||= "10"
