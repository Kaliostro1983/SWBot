#!/bin/sh
# Wrapper around jsonrpc2-helper.
# 1. Call the original binary to generate the supervisor config.
# 2. If a newer signal-cli is available in /cache, patch the generated config
#    to use it instead of signal-cli-native.

/usr/bin/jsonrpc2-helper-orig "$@"

CONF=/etc/supervisor/conf.d/signal-cli-json-rpc-1.conf
CACHED=$(ls -1 /cache/signal-cli-*.tar.gz 2>/dev/null | sort -V | tail -1)

if [ -n "$CACHED" ] && [ -f "$CONF" ]; then
    VER=$(basename "$CACHED" .tar.gz | sed 's/signal-cli-//')
    BIN=/opt/signal-cli-$VER/bin/signal-cli
    if [ ! -x "$BIN" ]; then
        echo "[jsonrpc2-wrapper] Installing signal-cli $VER from /cache"
        tar xzf "$CACHED" -C /opt
        chmod +x "$BIN"
    fi
    if ! grep -q "$BIN" "$CONF"; then
        echo "[jsonrpc2-wrapper] Patching supervisor config: command -> $BIN"
        sed -i "s|^command=.*|command=$BIN --output=json --config /home/.local/share/signal-cli/ daemon --tcp 127.0.0.1:6001|" "$CONF"
    fi
fi
