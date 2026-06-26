#!/bin/bash
# Restore signal-cli patch and start WhatsApp + Signal after server reboot.
# Runs automatically via cron @reboot.
# Logs to /home/shaen/Armor/SWBot/logs/signal_patch.log

LOG=/home/shaen/Armor/SWBot/logs/signal_patch.log
BOT_URL=http://127.0.0.1:3001
CACHE_DIR=/home/shaen/Armor/SWBot/cache
mkdir -p /home/shaen/Armor/SWBot/logs "$CACHE_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a $LOG; }

log "=== Reboot restore started ==="

# --- 1. Wait for bot to be reachable (max 3 min) ---
log "Waiting for bot API..."
for i in $(seq 1 36); do
    if curl -sf $BOT_URL/api/state > /dev/null 2>&1; then
        log "Bot API ready (attempt $i)"
        break
    fi
    sleep 5
done

# --- 2. Apply signal-cli patch if needed ---
CURRENT=$(docker exec signal-cli-api grep command /etc/supervisor/conf.d/signal-cli-json-rpc-1.conf 2>/dev/null)
if echo "$CURRENT" | grep -q 'signal-cli-0.14'; then
    log "signal-cli patch already active: $CURRENT"
else
    log "Patch missing — looking for cached build..."

    # Try to find cached tar.gz (avoids rebuild and git clone on every reboot)
    CACHED_TAR=$(ls -1 "$CACHE_DIR"/signal-cli-*.tar.gz 2>/dev/null | sort -V | tail -1)

    if [ -n "$CACHED_TAR" ]; then
        VERSION=$(basename "$CACHED_TAR" .tar.gz | sed 's/signal-cli-//')
        log "Using cached build: $CACHED_TAR (version $VERSION)"
        mkdir -p /tmp/signal-cli-new
        tar xzf "$CACHED_TAR" -C /tmp/signal-cli-new

    else
        log "No cache found — cloning and building from GitHub..."

        # Wait for internet (HTTPS) — up to 3 min, in case network is slow to come up at boot
        log "Waiting for internet access..."
        for i in $(seq 1 18); do
            if timeout 5 bash -c "echo > /dev/tcp/github.com/443" 2>/dev/null; then
                log "Internet ready (attempt $i)"
                break
            fi
            log "  no internet yet (attempt $i), waiting 10s..."
            sleep 10
        done

        cd /tmp
        rm -rf signal-cli-patch signal-cli-new
        git clone --depth=1 https://github.com/AsamK/signal-cli.git signal-cli-patch >> $LOG 2>&1

        if [ ! -f /tmp/signal-cli-patch/build.gradle.kts ]; then
            log "git clone FAILED — aborting."
            exit 1
        fi

        VERSION=$(sed -n 's/\s*version\s*=\s*"\(.*\)".*/\1/p' /tmp/signal-cli-patch/build.gradle.kts | tail -1)
        log "Building version $VERSION..."

        docker run --rm -v /tmp/signal-cli-patch:/signal-cli -w /signal-cli \
            -e VERSION=$VERSION -e SOURCE_DATE_EPOCH=1776889382 -e LANG=C.UTF-8 \
            signal-cli:build bash -c './gradlew installDist --no-daemon --max-workers=2 \
            -Dkotlin.compiler.execution.strategy=in-process --no-build-cache \
            -Dorg.gradle.caching=false \
            -Porg.gradle.java.installations.auto-download=false \
            -Porg.gradle.java.installations.auto-detect=false 2>&1 | tail -3' >> $LOG 2>&1

        if [ ! -f /tmp/signal-cli-patch/build/distributions/signal-cli-${VERSION}.tar.gz ]; then
            log "BUILD FAILED — aborting."
            exit 1
        fi

        # Save to persistent cache so next reboot won't need to rebuild
        cp /tmp/signal-cli-patch/build/distributions/signal-cli-${VERSION}.tar.gz \
           "$CACHE_DIR/signal-cli-${VERSION}.tar.gz"
        log "Saved to cache: $CACHE_DIR/signal-cli-${VERSION}.tar.gz"

        mkdir -p /tmp/signal-cli-new
        tar xzf /tmp/signal-cli-patch/build/distributions/signal-cli-${VERSION}.tar.gz \
            -C /tmp/signal-cli-new
    fi

    if [ ! -d /tmp/signal-cli-new/signal-cli-${VERSION} ]; then
        log "Extract FAILED — aborting."
        exit 1
    fi

    docker cp /tmp/signal-cli-new/signal-cli-${VERSION} signal-cli-api:/opt/signal-cli-${VERSION}
    docker exec signal-cli-api chmod +x /opt/signal-cli-${VERSION}/bin/signal-cli
    docker exec signal-cli-api sed -i \
        "s|command=signal-cli-native|command=/opt/signal-cli-${VERSION}/bin/signal-cli|" \
        /etc/supervisor/conf.d/signal-cli-json-rpc-1.conf
    docker exec signal-cli-api supervisorctl reread >> $LOG 2>&1
    docker exec signal-cli-api supervisorctl update >> $LOG 2>&1
    docker exec signal-cli-api supervisorctl restart signal-cli-json-rpc-1 >> $LOG 2>&1
    log "signal-cli $VERSION patch applied"
    sleep 5
fi

# --- 3. Start WhatsApp — wait for it to become ready, retry on error ---
# AUTO_START_BOT_ON_SERVICE_START=1 already called startBot() at process start,
# so we wait up to 3 min for it to finish (ready/error/awaiting_qr),
# then retry once if it ended in error state.
log "Waiting for WhatsApp to initialize (up to 3 min)..."
WA_STATUS=""
for i in $(seq 1 36); do
    WA_STATUS=$(curl -sf $BOT_URL/api/state | python3 -c \
        "import json,sys; d=json.load(sys.stdin); print(d.get('status',''))" 2>/dev/null)
    if [ "$WA_STATUS" = "ready" ] || [ "$WA_STATUS" = "awaiting_qr" ] || [ "$WA_STATUS" = "error" ]; then
        log "WhatsApp status after ${i}x5s: $WA_STATUS"
        break
    fi
    sleep 5
done

if [ "$WA_STATUS" = "ready" ]; then
    log "WhatsApp ready — no action needed"
elif [ "$WA_STATUS" = "awaiting_qr" ]; then
    log "WhatsApp awaiting QR — user must scan at $BOT_URL"
elif [ "$WA_STATUS" = "error" ]; then
    log "WhatsApp in error state — retrying start..."
    curl -sf -X POST $BOT_URL/api/start >> $LOG 2>&1
    log "WhatsApp restart requested"
    # Wait another 30s and log final status
    sleep 30
    WA_FINAL=$(curl -sf $BOT_URL/api/state | python3 -c \
        "import json,sys; d=json.load(sys.stdin); print(d.get('status',''))" 2>/dev/null)
    log "WhatsApp status after retry: $WA_FINAL"
else
    log "WhatsApp still initializing or unknown status ($WA_STATUS) — calling start just in case..."
    curl -sf -X POST $BOT_URL/api/start >> $LOG 2>&1
    log "WhatsApp start requested"
fi

# --- 4. Start Signal polling if not running ---
SIG_RUNNING=$(curl -sf $BOT_URL/api/state | python3 -c \
    "import json,sys; d=json.load(sys.stdin); print(d.get('signal',{}).get('running',''))" 2>/dev/null)
if [ "$SIG_RUNNING" = "True" ]; then
    log "Signal already running"
else
    log "Starting Signal polling..."
    curl -sf -X POST $BOT_URL/api/signal/start >> $LOG 2>&1
    log "Signal start requested"
fi

log "=== Restore complete ==="
