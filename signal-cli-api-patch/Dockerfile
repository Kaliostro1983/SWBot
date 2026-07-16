FROM bbernhard/signal-cli-rest-api:latest

# Replace jsonrpc2-helper (which regenerates supervisor config) with a wrapper
# that calls the original binary first, then patches the generated config to
# use a newer signal-cli version from the mounted /cache volume.
RUN mv /usr/bin/jsonrpc2-helper /usr/bin/jsonrpc2-helper-orig

COPY jsonrpc2-wrapper.sh /usr/bin/jsonrpc2-helper
RUN chmod +x /usr/bin/jsonrpc2-helper
