#!/bin/bash
# Check for signal-cli-rest-api:latest-dev updates.
# Applies update only after 21:00 Kyiv time (18:00 UTC).
# Logs to logs/signal_update.log

LOG=/home/shaen/Armor/SWBot/logs/signal_update.log
COMPOSE=/home/shaen/Armor/SWBot/docker-compose.signal.yml
IMAGE=bbernhard/signal-cli-rest-api:latest-dev

mkdir -p /home/shaen/Armor/SWBot/logs

OLD_DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' $IMAGE 2>/dev/null || echo 'none')

PULL_OUT=$(docker pull $IMAGE 2>&1)

NEW_DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' $IMAGE 2>/dev/null || echo 'none')

TS=$(date '+%Y-%m-%d %H:%M:%S')

if echo "$PULL_OUT" | grep -q 'Status: Downloaded newer image'; then
    echo "[$TS] NEW IMAGE AVAILABLE: ${NEW_DIGEST##*@}" >> $LOG

    # Apply only after 21:00 Kyiv (UTC+3), i.e. 18:00 UTC
    HOUR_UTC=$(date -u '+%H')
    if [ "$HOUR_UTC" -ge 18 ]; then
        echo "[$TS] Applying update (after 21:00 Kyiv)..." >> $LOG
        cd /home/shaen/Armor/SWBot
        docker compose -f $COMPOSE up -d --no-build signal-cli-api >> $LOG 2>&1
        echo "[$TS] Done." >> $LOG
    else
        echo "[$TS] Waiting for 21:00 Kyiv to apply. Will retry next hour." >> $LOG
    fi
else
    SHORT=${NEW_DIGEST##*@}
    echo "[$TS] No update. digest=${SHORT:0:16}" >> $LOG
fi
