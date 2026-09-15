#!/bin/bash
# Container gates: the "real container" acceptance layer (P0-3 lite).
# Wraps run-arm64-box.sh and asserts behavior, not just exit codes.
#
#   docker/container-gates.sh [ready-wait-seconds]
#
# Gates:
#   G1  gateway answers authenticated /health within the bounded wait
#   G2  the reconstructed exec-daemon reached ready on 1337 (host spawned it)
#   G3  a shell command round-trips inside the container with exact output
#   G4  cold exec container has no Chromium processes (the desktop discipline)
#
# CI note: GitHub runners are amd64; the self-built arm64 image runs under
# QEMU there, which keeps these gates functional but makes timing benchmarks
# meaningless — run benchmarks on an arm64 host. Building the base image for
# amd64 needs the Archive Dockerfile's bun/uv pins parameterized first.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
NAME=grok-bot-exec-eval
WAIT="${1:-120}"
FAILURES=0

pass() { echo "GATE PASS: $1"; }
fail() { echo "GATE FAIL: $1" >&2; FAILURES=$((FAILURES + 1)); }

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon unreachable (start Colima: colima start)" >&2
  exit 1
fi
if ! docker image inspect grok-bot-exec-box:arm64 >/dev/null 2>&1; then
  echo "grok-bot-exec-box:arm64 not built; run docker/build-arm64-box.sh first" >&2
  exit 1
fi

# G1 — bounded gateway readiness (starts the container via the runner).
if "$REPO/docker/run-arm64-box.sh" "$WAIT"; then
  pass "G1 gateway ready within ${WAIT}s (authenticated /health)"
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

# G3 — a command round-trips with exact output (marker defeats fake success).
MARKER="gate-exec-$(date +%s)-$RANDOM"
OUT=$(docker exec "$NAME" /bin/bash -c "echo $MARKER" 2>/dev/null || true)
if [ "$OUT" = "$MARKER" ]; then
  pass "G3 shell round-trip with exact marker output"
else
  fail "G3 shell round-trip returned '$OUT'"
fi

# G4 — cold exec container must not carry desktop processes.
CHROME=$(docker exec "$NAME" /bin/bash -c 'pgrep -c chromium' 2>/dev/null)
# pgrep -c prints 0 and exits 1 when nothing matches; treat any non-numeric
# capture (exec failure) as 0 rather than concatenating fallback output.
[[ "$CHROME" =~ ^[0-9]+$ ]] || CHROME=0
if [ "${CHROME:-0}" = "0" ]; then
  pass "G4 no Chromium processes on the cold exec container"
else
  fail "G4 Chromium processes present: $CHROME"
fi

docker rm -f "$NAME" >/dev/null 2>&1
docker volume rm grok-bot-exec-eval-data grok-bot-exec-eval-workspace >/dev/null 2>&1 || true

if [ "$FAILURES" -eq 0 ]; then
  echo "ALL CONTAINER GATES PASS"
  exit 0
fi
echo "$FAILURES gate(s) failed" >&2
exit 1
