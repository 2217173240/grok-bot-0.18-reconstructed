#!/bin/bash
# grokbot-local — launch the reconstructed Grok Bot in local-admin mode.
#
#   start-local.sh [start|stop|status|restart|logs]   (default: start)
#   GROKBOT_BOX=docker start-local.sh start           # computer = Docker VM
#                                                     # (default: host process on the Mac)
#
# Principles baked in:
#   idempotent    — safe to run repeatedly; seeds settings only when absent,
#                   reuses the staged host runtime, refuses double launches.
#   lifecycle     — stop goes through the Apple quit event so before-quit
#                   reaps the local host; status reports every moving part.
#   no blind retry — start waits a bounded time for the gateway, then fails
#                   with the host log tail instead of spinning.
set -euo pipefail

BIN="/Applications/Grok Bot 0.18 Reconstructed.app/Contents/MacOS/Grok Bot"
BUNDLE_ID="com.anysphere.sand.reconstructed"
REPO="/Users/xinheyun/Desktop/grok-bot-0.18-reconstructed"
DATA_ROOT="${GROKBOT_DATA_ROOT:-$HOME/.grokbot-local}"
PROFILE="$DATA_ROOT/profile"
TOKEN_FILE="$DATA_ROOT/anthropic-token"
APP_LOG="$DATA_ROOT/app.log"
PID_FILE="$DATA_ROOT/app.pid"
GATEWAY_HEALTH_URL="http://127.0.0.1:1340/health"
READY_TIMEOUT_S="${GROKBOT_READY_TIMEOUT_S:-45}"

say() { printf '%s\n' "$*"; }
die() { printf 'grokbot-local: %s\n' "$*" >&2; exit 1; }

app_pid() {
  # The host and exec-daemon also run under $BIN as Electron-as-node; the app
  # itself is the one carrying --user-data-dir.
  pgrep -f "^${BIN} --user-data-dir=" | head -1 || true
}

host_pid() {
  pgrep -f "sand-host/host-main\.cjs" | head -1 || true
}

gateway_token() {
  python3 - "$DATA_ROOT/local-docker-vm.json" <<'PY' 2>/dev/null || true
import json, sys
try:
    print(json.load(open(sys.argv[1]))["token"])
except Exception:
    pass
PY
}

# Mirror the connector's Colima discovery so docker CLI works from this shell.
resolve_docker_host() {
  [ -n "${DOCKER_HOST:-}" ] && return 0
  for socket in /var/run/docker.sock "$HOME"/.colima/docker.sock "$HOME"/.colima/*/docker.sock; do
    if [ -S "$socket" ]; then export DOCKER_HOST="unix://$socket"; return 0; fi
  done
  return 1
}

health_ok() {
  local token
  token="$(gateway_token)"
  [ -n "$token" ] || return 1
  curl -s -o /dev/null --max-time 2 -H "authorization: Bearer $token" \
    "$GATEWAY_HEALTH_URL" 2>/dev/null || return 1
}

seed_settings() {
  local settings="$DATA_ROOT/settings.json"
  if [ -f "$settings" ]; then
    say "settings: kept existing $settings"
    return
  fi
  python3 - "$settings" <<'PY'
import json, sys
settings = {
    "version": 1, "mcpBoxServers": [], "autoUpdateWhenIdleOptIn": False,
    "egressTunnelEnabled": False, "webauthnProxyEnabled": True,
    "mcpCustomInstructions": {}, "mcpCustomInstructionsByServerId": {},
    "mcpDisabledToolsByServerId": {}, "conciergeConsent": "unset",
    "settingsMigrations": ["downgrade-persisted-max-fast"],
    "hasSeenOnboarding": True,
    "inferenceProvider": "claude-code", "boxRuntime": "local-docker",
}
open(sys.argv[1], "w").write(json.dumps(settings, indent=2) + "\n")
PY
  say "settings: seeded $settings (claude-code + local box)"
}

do_start() {
  [ -x "$BIN" ] || die "app binary not found: $BIN (run scripts/package-macos.mjs first)"
  [ -r "$TOKEN_FILE" ] || die "missing $TOKEN_FILE (echo <token> > $TOKEN_FILE; chmod 600)"

  if [ "$(app_pid)" ]; then
    say "already running: app pid $(app_pid)"
    health_ok && say "gateway: healthy" || say "gateway: not ready (host may still be starting)"
    exit 0
  fi
  # Reap our own orphaned host BEFORE classifying the 1340 holder — the
  # guard cannot tell an orphan host from a foreign process, but host_pid can;
  # with the guard first, our own leftover host killed the boot instead.
  if [ "$(host_pid)" ]; then
    say "note: leftover host pid $(host_pid); stopping it first"
    kill "$(host_pid)" 2>/dev/null || true
    sleep 1
  fi
  # 1340 held by a NON-app listener is fine when it is the Docker computer's
  # port forward (ssh/docker-proxy for grok-bot-local-vm) and that gateway is
  # healthy — the app connects to it. Anything else holding the port blocks.
  if lsof -nP -iTCP:1340 -sTCP:LISTEN >/dev/null 2>&1; then
    if [ "$(cat "$DATA_ROOT/box-mode" 2>/dev/null || echo auto)" != "mac-host" ]        && resolve_docker_host 2>/dev/null        && docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^grok-bot-local-vm$'        && health_ok; then
      say "port 1340: held by the Docker computer's forward (healthy) — the app will connect to it"
    else
      die "port 1340 is held by something that is not our app or computer; refusing to start"
    fi
  fi

  # One-time migration from the /tmp smoke root.
  if [ ! -d "$DATA_ROOT" ] || [ -z "$(ls -A "$DATA_ROOT" 2>/dev/null)" ]; then
    if [ -d /tmp/grok-bot-local ] && [ -f /tmp/grok-bot-local/settings.json ]; then
      mkdir -p "$DATA_ROOT"
      cp -R /tmp/grok-bot-local/. "$DATA_ROOT/" 2>/dev/null || true
      say "migrated smoke state from /tmp/grok-bot-local"
    fi
  fi
  mkdir -p "$DATA_ROOT" "$PROFILE"
  seed_settings

  # Stale package hint: repo dist newer than the installed bundle.
  if [ -d "$REPO/dist/Grok Bot 0.18 Reconstructed.app" ] && \
     [ "$REPO/dist/Grok Bot 0.18 Reconstructed.app/Contents/MacOS/Grok Bot" -nt "$BIN" ]; then
    say "note: repo dist is newer than /Applications copy — consider re-copying it"
  fi

  : > "$APP_LOG"

  export SAND_LOCAL_ADMIN=1
  export SAND_DISABLE_SENTRY=1
  export SAND_DISABLE_TELEMETRY=1
  export SAND_CLAUDE_MODEL=glm-5.2
  export ANTHROPIC_BASE_URL='https://open.bigmodel.cn/api/anthropic'
  # The real token stays in the 0600 file; the provider layer injects it into
  # the CLI child only. This marker just satisfies the logged-in check.
  export ANTHROPIC_API_KEY='local-file'
  export ANTHROPIC_DEFAULT_FABLE_MODEL='glm-5.3[1M]'
  export ANTHROPIC_DEFAULT_FABLE_MODEL_NAME='glm-5.3'
  export ANTHROPIC_DEFAULT_HAIKU_MODEL='glm-5.3-flash'
  export ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME='glm-5.3-flash'
  export ANTHROPIC_DEFAULT_OPUS_MODEL='glm-5.3[1M]'
  export ANTHROPIC_DEFAULT_OPUS_MODEL_NAME='glm-5.3'
  export ANTHROPIC_DEFAULT_SONNET_MODEL='glm-5.2[1M]'
  export ANTHROPIC_DEFAULT_SONNET_MODEL_NAME='glm-5.2'
  export ANTHROPIC_MODEL='glm-5.2'
  export CLAUDE_CODE_SUBAGENT_MODEL='glm-5.2[1M]'
  export ENABLE_TOOL_SEARCH='true'
  export DISABLE_AUTOUPDATER=1
  # Stale package guard: the app bundle carries a build stamp; warn loudly when
  # it does not match this repository's HEAD (a silently failed rebuild shipped
  # as a stale dist exactly once — never again).
  STAMP="$BIN/../Resources/build-stamp.json"  # resolved against MacOS dir
  STAMP="/Applications/Grok Bot 0.18 Reconstructed.app/Contents/Resources/build-stamp.json"
  if [ -f "$STAMP" ]; then
    STAMPED_REV=$(python3 -c "import json; print(json.load(open('$STAMP'))['sourceRevision'])" 2>/dev/null)
    HEAD_REV=$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unknown)
    if [ "$STAMPED_REV" != "$HEAD_REV" ]; then
      say "WARNING: installed app was built from ${STAMPED_REV:0:7} but the repo is at ${HEAD_REV:0:7} — repackage and re-copy before trusting runtime behavior"
    fi
  else
    say "WARNING: installed app has no build stamp (pre-stamp package); freshness cannot be verified"
  fi

  export SAND_DATA_ROOT="$DATA_ROOT"
  export SAND_USER_DATA_DIR="$PROFILE"
  # GROKBOT_BOX=docker runs the computer as the local Docker VM instead of a
  # Mac-side host process. Docker (Colima) must be running; the connector
  # discovers Colima sockets on its own.
  # Computer selection: GROKBOT_BOX=host forces the Mac-side host process;
  # GROKBOT_BOX=docker forces the container; unset lets the connector default
  # to Docker when its daemon is reachable (the isolated Linux lab) and fall
  # back to the Mac host otherwise. GROKBOT_IMAGE pins a specific image.
  if [ "${GROKBOT_BOX:-}" = "docker" ]; then
    resolve_docker_host || die "no Docker socket found (start Colima: colima start)"
    docker info >/dev/null 2>&1 || die "Docker daemon unreachable via $DOCKER_HOST (colima start?)"
    export SAND_LOCAL_ADMIN_BOX=docker
    echo docker > "$DATA_ROOT/box-mode"
    say "computer: Docker VM (forced)"
  elif [ "${GROKBOT_BOX:-}" = "host" ]; then
    export SAND_LOCAL_ADMIN_BOX=host
    echo mac-host > "$DATA_ROOT/box-mode"
    say "computer: Mac host process (forced)"
  else
    echo auto > "$DATA_ROOT/box-mode"
    say "computer: auto (Docker when reachable, else Mac host)"
  fi
  if [ -n "${GROKBOT_IMAGE:-}" ]; then
    export SAND_LOCAL_ADMIN_IMAGE="$GROKBOT_IMAGE"
    say "image: $GROKBOT_IMAGE (pinned)"
  fi
  # GROKBOT_TURN=host executes routed turns inside the local host process
  # (single execution plane; the host journal becomes the transcript of record).
  if [ "${GROKBOT_TURN:-}" = "host" ]; then
    export SAND_LOCAL_ADMIN_TURN=host
    say "turns: host execution plane (experimental)"
  fi
  # The desktop plane is the default computer (complete bot; both gate
  # profiles green). GROKBOT_DESKTOP=0 opts back to the headless exec plane.
  if [ "${GROKBOT_DESKTOP:-}" = "0" ]; then
    export SAND_LOCAL_ADMIN_DESKTOP=0
    say "desktop: off (headless exec plane, GROKBOT_DESKTOP=0)"
  else
    export SAND_LOCAL_ADMIN_DESKTOP=1
    say "desktop: on (default; GROKBOT_DESKTOP=0 for headless exec)"
  fi

  # Launch the binary directly — `open` would strip the environment.
  "$BIN" --user-data-dir="$PROFILE" >"$APP_LOG" 2>&1 &
  local pid=$!
  echo "$pid" > "$PID_FILE"
  say "launched: app pid $pid, log $APP_LOG"

  local waited=0
  while [ "$waited" -lt "$((READY_TIMEOUT_S * 2))" ]; do
    health_ok && { say "gateway: healthy on 127.0.0.1:1340 (after ${waited}x500ms)"; exit 0; }
    if ! ps -p "$pid" >/dev/null 2>&1; then
      say "app exited during startup; last log lines:"
      tail -20 "$APP_LOG" || true
      exit 1
    fi
    sleep 0.5
    waited=$((waited + 1))
  done
  say "gateway did not become healthy within ${READY_TIMEOUT_S}s; host log tail:"
  tail -30 "$DATA_ROOT/box-logs/sand-host.log" 2>/dev/null || \
    say "(no host log — the host may never have spawned; see $APP_LOG)"
  exit 1
}

do_stop() {
  local pid
  pid="$(app_pid)"
  if [ -z "$pid" ]; then
    say "not running"
  else
    osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || kill "$pid"
    local waited=0
    while ps -p "$pid" >/dev/null 2>&1 && [ "$waited" -lt 20 ]; do
      sleep 0.5
      waited=$((waited + 1))
    done
    ps -p "$pid" >/dev/null 2>&1 && { kill "$pid" 2>/dev/null || true; sleep 1; }
    say "app stopped (pid $pid)"
  fi
  local hpid
  hpid="$(host_pid)"
  if [ -n "$hpid" ]; then
    say "host still alive (pid $hpid); sending SIGTERM"
    kill "$hpid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  # The Docker computer outlives the app by design: desktop session, browser
  # state, and the handover URL all survive an app restart (the login profile
  # rides the data volume regardless). Removing it on every stop was a
  # Mac-host-era reflex — a host-mode start stops the computer itself when
  # actually switching (the connector's host branch owns that).
  if [ "$(cat "$DATA_ROOT/box-mode" 2>/dev/null || echo auto)" != "mac-host" ]; then
    resolve_docker_host || true
    if docker info >/dev/null 2>&1; then
      if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^grok-bot-local-vm$'; then
        say "computer:   left running by design (a GROKBOT_BOX=host start will stop it)"
      fi
    else
      say "computer:   docker unreachable — container state untouched"
    fi
  fi
  say "note: the detached local-exec-daemon is left running by design; it reattaches on next start"
}

do_status() {
  local pid hpid token
  pid="$(app_pid)"; hpid="$(host_pid)"
  say "data root:   $DATA_ROOT"
  say "box mode:    $(cat "$DATA_ROOT/box-mode" 2>/dev/null || echo mac-host) (GROKBOT_BOX=docker to switch)"
  # QEMU fallback honesty: with no pinned image and the self-built arm64 image
  # missing, the default path runs the emulated official image. The connector
  # records the same fact in the intercept ledger when it connects.
  if [ "$(cat "$DATA_ROOT/box-mode" 2>/dev/null || echo auto)" != "mac-host" ] && [ -z "${GROKBOT_IMAGE:-}" ]; then
    if resolve_docker_host && docker info >/dev/null 2>&1 && \
       ! docker image inspect grok-bot-exec-box:arm64 >/dev/null 2>&1; then
      say "image:       WARNING self-built arm64 image missing — default falls back to the emulated official image (QEMU); build with docker/build-arm64-box.sh"
    fi
  fi
  if [ "$(cat "$DATA_ROOT/box-mode" 2>/dev/null || echo auto)" != "mac-host" ] && [ -d "$DATA_ROOT/box-workspace" ]; then
    say "workspace:   $DATA_ROOT/box-workspace (Mac side of the container's /workspace)"
  fi
  if [ -f "$DATA_ROOT/mcp-servers.json" ]; then
    say "mcp plugins: $(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1])).get("mcpServers", {})))' "$DATA_ROOT/mcp-servers.json") defined in mcp-servers.json"
  fi
  if [ -n "$pid" ]; then say "app:         running (pid $pid)"; else say "app:         not running"; fi
  if ! resolve_docker_host 2>/dev/null || ! docker info >/dev/null 2>&1; then
    say "computer:    docker unreachable (colima start?) — cannot inspect the container"
  elif docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^grok-bot-local-vm$'; then
    if [ "$(docker inspect --format '{{index .Config.Labels "com.grok-bot.local-vm.desktop"}}' grok-bot-local-vm 2>/dev/null)" = "1" ]; then
      say "computer:    desktop plane (box-init-exec, opt-in)"
      if [ -f "$DATA_ROOT/box-workspace/.grokbot/novnc-url" ]; then
        say "handover:    $(cat "$DATA_ROOT/box-workspace/.grokbot/novnc-url")"
      fi
    else
      say "computer:    exec plane (headless)"
    fi
  fi
  if [ -n "$hpid" ]; then say "host:        running (pid $hpid)"; else say "host:        not running"; fi
  if pgrep -f "dist/local-exec-daemon/main\.cjs" >/dev/null 2>&1; then
    say "exec-daemon: running (pid $(pgrep -f "dist/local-exec-daemon/main\.cjs" | head -1))"
  else
    say "exec-daemon: not running"
  fi
  if health_ok; then say "gateway:     healthy"; else say "gateway:     down"; fi
  if [ -f "$DATA_ROOT/local-intercept.jsonl" ]; then
    say "intercept:   $(wc -l < "$DATA_ROOT/local-intercept.jsonl" | tr -d ' ') events"
  fi
  exit 0
}

do_logs() {
  say "tailing $DATA_ROOT/app.log and box-logs/sand-host.log (Ctrl-C to stop)"
  tail -n 40 -F "$APP_LOG" "$DATA_ROOT/box-logs/sand-host.log" 2>/dev/null
}

case "${1:-start}" in
  start)   do_start ;;
  stop)    do_stop ;;
  restart) do_stop; do_start ;;
  status)  do_status ;;
  logs)    do_logs ;;
  *)       die "usage: $0 [start|stop|status|restart|logs]" ;;
esac
