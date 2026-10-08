#!/usr/bin/env bash
# Wait until 23:00 America/Toronto, then run the six-seat batch
# across the whole developed-world universe.
# Does not change the GPU power limit. vLLM is not started here.
# It has to already be listening on the host.
# Set BATCH_LIMIT to a positive number only to cap one night.
set -uo pipefail

export TZ="${TZ:-America/Toronto}"
cd /app

seconds_until_eleven() {
  local now target
  now=$(date +%s)
  target=$(date -d "today 23:00:00" +%s)
  if [ "$now" -ge "$target" ]; then
    target=$(date -d "tomorrow 23:00:00" +%s)
  fi
  echo $((target - now))
}

echo "Mole Intel desk waiting for 23:00 ${TZ} (whole universe)"
while true; do
  wait=$(seconds_until_eleven)
  if [ "$wait" -lt 90 ]; then
    echo "$(date -Is) starting six-seat batch for the whole universe"
    if [ -n "${BATCH_LIMIT:-}" ] && [ "${BATCH_LIMIT}" != "0" ]; then
      node /app/scripts/debate-batch.mjs --limit "${BATCH_LIMIT}" || echo "batch exited $?"
    else
      node /app/scripts/debate-batch.mjs || echo "batch exited $?"
    fi
    sleep 120
    continue
  fi
  # Wake at least once an hour so a clock change is not missed.
  if [ "$wait" -gt 3600 ]; then wait=3600; fi
  sleep "$wait"
done
