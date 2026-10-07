#!/usr/bin/env bash
# Wait until 00:00 America/Toronto, then run the six-seat batch.
# vLLM is not started here. It has to already be listening on the host.
set -uo pipefail

export TZ="${TZ:-America/Toronto}"
cd /app

if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi -pl 250 || echo "warning: could not set GPU power limit"
fi

seconds_until_midnight() {
  local now target
  now=$(date +%s)
  target=$(date -d "tomorrow 00:00:00" +%s)
  echo $((target - now))
}

echo "Mole Intel desk waiting for 00:00 ${TZ}"
while true; do
  wait=$(seconds_until_midnight)
  if [ "$wait" -lt 90 ]; then
    echo "$(date -Is) starting six-seat batch"
    node /app/scripts/debate-batch.mjs --limit "${BATCH_LIMIT:-500}" || echo "batch exited $?"
    sleep 120
    continue
  fi
  # Wake at least once an hour so a clock change is not missed.
  if [ "$wait" -gt 3600 ]; then wait=3600; fi
  sleep "$wait"
done
