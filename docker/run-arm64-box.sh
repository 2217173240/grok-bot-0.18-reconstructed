#!/bin/bash
# Run the arm64-native exec lab: the v2 staged host + reconstructed daemon
# inside the custom image, host spawning the daemon itself (no
# SAND_USE_EXISTING_BOX_EXEC_DAEMON). Gateway published on 127.0.0.1:1341 so a
# concurrently running Mac-host deployment keeps 1340.
#
#   docker/run-arm64-box.sh [seconds-to-wait]
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DATA_ROOT="${GROKBOT_DATA_ROOT:-$HOME/.grokbot-local}"
NAME=grok-bot-exec-eval
IMAGE=grok-bot-exec-box:arm64
WAIT="${1:-90}"
GATEWAY_PORT="${GROKBOT_EVAL_PORT:-1341}"

V2DIR="$(ls -td "$DATA_ROOT"/local-docker-runtime/v2-* 2>/dev/null | head -1)"
if [ -z "$V2DIR" ]; then
  echo "no staged v2 runtime under $DATA_ROOT — start the app once first" >&2
  exit 1
fi
echo "staged runtime: $(basename "$V2DIR" | cut -c1-24)…"

TOKEN_FILE="$DATA_ROOT/local-docker-vm.json"
TOKEN=$(python3 -c "import json; print(json.load(open('$TOKEN_FILE'))['token'])")

docker rm -f "$NAME" >/dev/null 2>&1 || true
# The custom image has no supervisor; the bind-mounted host IS the container
# process (desktop stays available for a later P1 run mode via box-init).
docker run --detach --name "$NAME" \
  --entrypoint /usr/local/bin/node \
  --env SAND_GATEWAY_BIND_HOST=0.0.0.0 \
  --env SAND_HOST_PORT=1340 \
  --env "SAND_GATEWAY_TOKEN=$TOKEN" \
  --env SAND_GATEWAY_REQUIRE_AUTH=1 \
  --env SAND_DATA_ROOT=/home/box/sand-data \
  --publish "127.0.0.1:${GATEWAY_PORT}:1340" \
  --mount "type=bind,src=$V2DIR/sand-host/host-main.cjs,dst=/home/box/sand-host/host-main.cjs,readonly" \
  --mount "type=bind,src=$V2DIR/box-exec-daemon,dst=/home/box/box-exec-daemon,readonly" \
  --volume grok-bot-exec-eval-data:/home/box/sand-data \
  --volume grok-bot-exec-eval-workspace:/home/box/workspace \
  "$IMAGE" /home/box/sand-host/host-main.cjs >/dev/null

echo "container $NAME up; waiting up to ${WAIT}s for the gateway (host spawns the daemon itself)"
START=$(date +%s)
while [ $(( $(date +%s) - START )) -lt "$WAIT" ]; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 \
    -H "authorization: Bearer $TOKEN" "http://127.0.0.1:${GATEWAY_PORT}/health" || true)
  if [ "$CODE" = "200" ]; then
    ELAPSED=$(( $(date +%s) - START ))
    echo "gateway READY in ${ELAPSED}s (arm64 native)"
    exit 0
  fi
  if [ "$(docker inspect -f '{{.State.Status}}' "$NAME" 2>/dev/null)" != "running" ]; then
    echo "container exited early; logs:" >&2
    docker logs "$NAME" >&2 || true
    exit 1
  fi
  sleep 2
done
echo "gateway not ready within ${WAIT}s; last logs:" >&2
docker logs --tail 40 "$NAME" >&2 || true
exit 1
