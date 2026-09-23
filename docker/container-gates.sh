#!/bin/bash
# Container gates: the "real container" acceptance layer. Wraps
# run-arm64-box.sh and asserts behavior, not just exit codes.
#
#   docker/container-gates.sh [--profile exec|desktop] [ready-wait-seconds]
#
# Gates (both profiles):
#   G0  image deps pin matches the repository's canonical inputs
#   G1  gateway answers authenticated /health within the bounded wait, and on
#       native arm64 the cold start stays under the 15s performance sentinel
#   G2  the reconstructed exec-daemon reached ready on 1337 (host spawned it)
#   G3  a real exec round-trips through the daemon's ConnectRPC service on
#       1337 (protocol + Bearer token + workspace mapping) with exact output
#   G4  cold container has no Chromium processes (browsers start on demand)
#   G5  box 用户可以在自己的缓存目录创建 Claude CLI MCP 日志
#
# Desktop profile additionally (GROKBOT_EVAL_DESKTOP=1 via the runner):
#   D1  the desktop plane is alive (xdpyinfo) at the pinned geometry 1280x800
#   D2  VNC 5900, noVNC 6080/6081, and the 1339 router are listening
#   D3  noVNC auth is dual-directional: the minted token completes the
#       WebSocket handshake (101), a wrong token is refused
#   D4  the Computer round-trip works: XTEST motion + a non-empty desktop
#       capture with the exact geometry
#   D5  the window router and session-sync daemons are alive (their death is
#       otherwise silent)
#   D6  desktop death leaves the container and gateway alive (the B1
#       unsupervised-desktop decision, asserted)
#
# Probes are three-valued (see scripts/lib/box-probe.sh): a gate fails when it
# could not measure, so a broken `docker exec` can never read as a clean result.
#
# CI note: GitHub runners are amd64; the self-built arm64 image runs under
# QEMU there, which keeps these gates functional but makes timing benchmarks
# meaningless — the cold-start sentinel is enforced on native arm64 only.
# Building the base image for amd64 needs the Archive Dockerfile's bun/uv
# pins parameterized first.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
NAME=grok-bot-exec-eval
IMAGE="${GROKBOT_EVAL_IMAGE:-grok-bot-exec-box:arm64}"
BOX_CONTAINER="$NAME"
. "$REPO/scripts/lib/box-probe.sh"
PROFILE="exec"
if [ "${1:-}" = "--profile" ]; then
  PROFILE="${2:?--profile needs exec|desktop}"
  shift 2
fi
WAIT="${1:-120}"
FAILURES=0
export GROKBOT_EVAL_DESKTOP="$([ "$PROFILE" = "desktop" ] && echo 1 || echo 0)"

in_box() { docker exec "$NAME" sh -c "$*"; }

pass() { echo "GATE PASS: $1"; }
fail() { echo "GATE FAIL: $1" >&2; FAILURES=$((FAILURES + 1)); }

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon unreachable (start Colima: colima start --profile ${GROKBOT_COLIMA_PROFILE:-grokbot}, or start OrbStack)" >&2
  exit 1
fi
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "$IMAGE not built; run docker/build-arm64-box.sh first" >&2
  exit 1
fi

# G0 — dependency pin: the image label must match the repository's canonical
# inputs (the same pin the app stamps at package time). A stale-but-present
# image is exactly the case presence checks cannot catch.
EXPECTED_PIN=$(node "$REPO/scripts/lib/deps-pin.mjs")
ACTUAL_PIN=$(docker image inspect "$IMAGE" --format '{{index .Config.Labels "com.grok-bot.local-vm.deps-pin"}}' 2>/dev/null || true)
if [ -n "$EXPECTED_PIN" ] && [ "$ACTUAL_PIN" = "$EXPECTED_PIN" ]; then
  pass "G0 image deps pin matches the repository (${EXPECTED_PIN:0:12}…)"
else
  fail "G0 image deps pin mismatch (image '${ACTUAL_PIN:-none}' != repo '${EXPECTED_PIN:-?}') — rebuild with docker/build-arm64-box.sh"
fi

# G1 — bounded gateway readiness (starts the container via the runner); on a
# native arm64 daemon the same measurement doubles as the cold-start sentinel.
COLD_START_STARTED_AT=$(date +%s)
if "$REPO/docker/run-arm64-box.sh" "$WAIT"; then
  COLD_START_ELAPSED=$(( $(date +%s) - COLD_START_STARTED_AT ))
  pass "G1 gateway ready within ${WAIT}s (authenticated /health, cold start ${COLD_START_ELAPSED}s)"
  SERVER_ARCH=$(docker info --format '{{.Architecture}}' 2>/dev/null || true)
  if [ "$(uname -m)" = "arm64" ] && [ "$SERVER_ARCH" = "aarch64" ]; then
    if [ "$COLD_START_ELAPSED" -le 15 ]; then
      pass "G1 cold start ${COLD_START_ELAPSED}s <= 15s (performance sentinel, native arm64)"
    else
      fail "G1 cold start ${COLD_START_ELAPSED}s exceeds the 15s performance sentinel (native arm64)"
    fi
  else
    echo "G1 NOTE: cold-start sentinel not enforced (host $(uname -m), docker server ${SERVER_ARCH:-unknown})"
  fi
else
  fail "G1 gateway not ready within ${WAIT}s"
  docker logs --tail 40 "$NAME" >&2 || true
  docker rm -f "$NAME" >/dev/null 2>&1
  exit 1
fi

LOGS=$(docker logs "$NAME" 2>&1)

# G2 — the daemon the host spawned reached ready.
if echo "$LOGS" | grep -q '"event":"box-exec-daemon-ready"'; then
  pass "G2 reconstructed exec-daemon ready (host-spawned)"
else
  fail "G2 exec-daemon ready line missing from logs"
fi

# G3 — a real exec through the daemon's ConnectRPC service on 1337: the same
# transport, Bearer credential, and shellArgs stream the host uses, asserted
# on exact marker output. A docker-exec shell proves nothing about the daemon
# protocol, the token, or the workspace mapping — this does.
MARKER="gate-exec-$(date +%s)-$RANDOM"
SMOKE_ERR_FILE="$(mktemp)"
SMOKE_OUT="$(node "$REPO/scripts/daemon-smoke.mjs" "$NAME" "echo $MARKER" 2>"$SMOKE_ERR_FILE")"
SMOKE_EXIT=$?
if [ "$SMOKE_EXIT" = "0" ] && [ "$SMOKE_OUT" = "$MARKER" ]; then
  pass "G3 daemon exec round-trip via 1337 with exact marker output"
else
  fail "G3 daemon exec round-trip failed (exit $SMOKE_EXIT, output '$SMOKE_OUT')"
  cat "$SMOKE_ERR_FILE" >&2
fi
rm -f "$SMOKE_ERR_FILE"

# G4 — cold exec container must not carry desktop processes. The count is the
# gate; a count that could not be read is a failure, because "docker exec never
# reached the box" and "the box is clean" are different facts that both used to
# produce an empty capture.
probe_box_process_count chromium
if [ "$PROBE_STATUS" != "$PROBE_OK" ]; then
  fail "G4 inconclusive — the container reported no process count: ${PROBE_OUTPUT:-empty output}"
elif [ "$PROBE_OUTPUT" = "0" ]; then
  pass "G4 no Chromium processes on the cold container (browsers on demand)"
else
  fail "G4 Chromium processes present: $PROBE_OUTPUT"
fi

if in_box 'mkdir -p /home/box/.cache/claude-cli-nodejs/gate && test -w /home/box/.cache/claude-cli-nodejs/gate'; then
  pass "G5 Claude CLI MCP log cache is writable by the box user"
else
  fail "G5 Claude CLI MCP log cache is not writable by the box user"
fi

if in_box 'test "$(readlink /home/box/chrome-profile)" = /home/box/sand-data/chrome-profile && mkdir -p /home/box/sand-data/chrome-profile/Default && test -w /home/box/chrome-profile/Default'; then
  pass "G6 browser profile uses the writable data volume"
else
  fail "G6 browser profile is not backed by the writable data volume"
fi




run_desktop_gates() {
  # D1 — the plane is alive and exactly the pinned geometry (box-common.sh
  # SCREEN_GEOM is the single source; the executor mirrors it in TS).
  if in_box 'DISPLAY=:1 xdpyinfo | grep -q "dimensions:"'; then
    DIMS=$(in_box 'DISPLAY=:1 xdpyinfo | grep -o "dimensions: *[0-9x]*" | head -1 | grep -o "[0-9]*x[0-9]*" | head -1')
    if [ "$DIMS" = "1280x800" ]; then
      pass "D1 desktop alive on :1 at ${DIMS} (geometry single-source holds)"
    else
      fail "D1 desktop geometry drifted: got '${DIMS:-none}', want 1280x800"
    fi
  else
    fail "D1 xdpyinfo failed on :1 — the desktop plane is not alive"
  fi

  # D2 — the plane's ports: VNC, both noVNC entries, the window router.
  PORTS_OK=1
  for port in 5900 6080 6081 1339; do
    if ! in_box "ss -tln | grep -q ':$port '"; then PORTS_OK=0; fail "D2 port $port is not listening"; fi
  done
  [ "$PORTS_OK" = "1" ] && pass "D2 VNC 5900, noVNC 6080/6081, router 1339 all listening"

  # D3 — noVNC auth, both directions, from inside the box.
  TOKEN=$(in_box 'head -1 /tmp/sand-novnc-tokens.d/1 2>/dev/null | cut -d: -f1')
  if [ -n "$TOKEN" ]; then
    GOOD=$(in_box "curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' 'http://127.0.0.1:6080/websockify?token=$TOKEN'")
    BAD=$(in_box "curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' 'http://127.0.0.1:6080/websockify?token=0000000000000000000000000000000000000000000000000000000000000000'")
    if [ "$GOOD" = "101" ] && [ "$BAD" != "101" ]; then
      pass "D3 noVNC auth dual-direction (minted token 101, wrong token refused)"
    else
      fail "D3 noVNC auth wrong (good='$GOOD' bad='$BAD')"
    fi
  else
    fail "D3 no minted token found in /tmp/sand-novnc-tokens.d/1"
  fi

  # D4 — the Computer round-trip: XTEST motion, then a desktop capture with
  # the exact geometry (the same primitives the executor drives).
  if in_box 'echo "{\"action\":\"move\",\"x\":640,\"y\":400}" | python3 /usr/local/bin/xtest-input-local.py :1'; then
    SHOT_BYTES=$(in_box 'bash -c "xwd -root -display :1 -silent | convert xwd:- png:-" | wc -c' | tr -d ' ')
    if [ "${SHOT_BYTES:-0}" -gt 1000 ]; then
      pass "D4 Computer round-trip: XTEST motion + desktop capture (${SHOT_BYTES} bytes)"
    else
      fail "D4 desktop capture too small (${SHOT_BYTES:-0} bytes)"
    fi
  else
    fail "D4 XTEST motion failed"
  fi

  # D5 — 每个桌面进程都只有一个持有者。表达式中的方括号避免计入探测 shell。
  probe_in_box "pgrep -fc '[s]and-window-router.mjs' 2>&1"
  ROUTER_STATUS="$PROBE_STATUS"; ROUTER_COUNT="$PROBE_OUTPUT"
  probe_in_box "pgrep -fc '[s]ession-sync.mjs' 2>&1"
  SYNC_STATUS="$PROBE_STATUS"; SYNC_COUNT="$PROBE_OUTPUT"
  if [ "$ROUTER_STATUS" != "$PROBE_OK" ] || [ "$SYNC_STATUS" != "$PROBE_OK" ] ||
     [[ ! "$ROUTER_COUNT" =~ ^[0-9]+$ ]] || [[ ! "$SYNC_COUNT" =~ ^[0-9]+$ ]]; then
    fail "D5 inconclusive — the container did not report its desktop daemons: ${PROBE_OUTPUT:-empty output}"
  elif [ "$ROUTER_COUNT" = "1" ] && [ "$SYNC_COUNT" = "1" ]; then
    pass "D5 desktop daemons have one owner each: window router and session-sync"
  else
    fail "D5 desktop daemon count differs from one (router=$ROUTER_COUNT session-sync=$SYNC_COUNT)"
  fi

  # D6 — the B1 decision asserted: killing the display leaves container and
  # gateway alive; the probe is what exposes the death. No auto-restart.
  XVFB_PID=$(in_box 'pgrep -f "Xvfb :1" | head -1')
  if [ -n "$XVFB_PID" ]; then
    in_box "kill $XVFB_PID" 2>/dev/null || true
    sleep 2
    STATE=$(docker inspect --format '{{.State.Status}}' "$NAME" 2>/dev/null || true)
    TOKEN_V=$(python3 -c "import json; print(json.load(open('$HOME/.grokbot-local/local-docker-vm.json'))['token'])" 2>/dev/null || true)
    GW=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 -H "authorization: Bearer $TOKEN_V" "http://127.0.0.1:${GROKBOT_EVAL_PORT:-1341}/health" 2>/dev/null || echo 000)
    DEAD=$(in_box 'DISPLAY=:1 xdpyinfo >/dev/null 2>&1 && echo alive || echo dead')
    if [ "$STATE" = "running" ] && [ "$GW" = "200" ] && [ "$DEAD" = "dead" ]; then
      pass "D6 desktop death: container running, gateway healthy, probe exposes the death (no auto-restart)"
    else
      fail "D6 desktop death semantics wrong (state='$STATE' gateway='$GW' display='$DEAD')"
    fi
  else
    fail "D6 could not find Xvfb to kill"
  fi
}

if [ "$PROFILE" = "desktop" ]; then
  run_desktop_gates
fi

docker rm -f "$NAME" >/dev/null 2>&1
docker volume rm grok-bot-exec-eval-data grok-bot-exec-eval-workspace >/dev/null 2>&1 || true

if [ "$FAILURES" -eq 0 ]; then
  echo "ALL CONTAINER GATES PASS"
  exit 0
fi
echo "$FAILURES gate(s) failed" >&2
exit 1
