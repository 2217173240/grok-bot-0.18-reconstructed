#!/bin/bash
# Zero-remote live scenario: boot → connect → one real tool call → stop,
# then prove the intercept ledger recorded zero cursor/xai egress for the
# whole window. Ends by bringing the app back up so the lab stays healthy.
#
# The "turn" at the Agent-API level is the one piece this scenario cannot
# yet drive (pr/14 local Agent API); the turn plane's cursor paths are
# covered structurally (routedProvider !== "cursor" guards) and the ledger's
# blocked-fetch lines prove live attempts get caught at the fetch layer.
# When the local turn API lands, extend this script to drive one through it.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LEDGER="${GROKBOT_DATA_ROOT:-$HOME/.grokbot-local}/local-intercept.jsonl"

fail() { echo "zero-remote-live: $*" >&2; exit 1; }

# Docker endpoint discovery is shared with start-local.sh, and it names no
# Colima profile borrowed from another project.
. "$REPO/scripts/lib/docker-socket.sh"
resolve_docker_host || fail "no Docker socket found ($(docker_unreachable_hint))"

echo "== scenario: restart (boot + connect)"
"$REPO/start-local.sh" restart >/dev/null 2>&1 || fail "app restart failed"
BEFORE=$(wc -l < "$LEDGER" | tr -d ' ')

echo "== scenario: one real tool call through the box (gateway→host→daemon)"
MARKER="zero-remote-$(date +%s)"
OUT=$(node "$REPO/scripts/daemon-smoke.mjs" grok-bot-local-vm "echo $MARKER" 2>/dev/null)
[ "$OUT" = "$MARKER" ] || fail "tool call round-trip failed (got '$OUT')"

echo "== scenario: stop"
"$REPO/start-local.sh" stop >/dev/null 2>&1 || fail "app stop failed"

echo "== proof: the scenario window (lines ${BEFORE}..end)"
node "$REPO/scripts/zero-remote-check.mjs" "$LEDGER" $((BEFORE + 1))
CHECK_EXIT=$?
if [ "$CHECK_EXIT" = "0" ] && [ "$(( $(wc -l < "$LEDGER" | tr -d ' ') - BEFORE ))" = "0" ]; then
  # An empty window is vacuously clean; the full-history scan below is the
  # real proof, so only note the quiet window instead of leaning on it.
  echo "zero-remote NOTE: the scenario window added no ledger lines (a healthy minute can be quiet); relying on the full-history proof"
fi

echo "== proof: full ledger history"
node "$REPO/scripts/zero-remote-check.mjs" "$LEDGER" 1
FULL_EXIT=$?
[ "$CHECK_EXIT" = "0" ] || FAILURES=$CHECK_EXIT
[ "$FULL_EXIT" = "0" ] || FAILURES=$FULL_EXIT

echo "== restore: bring the app back up"
"$REPO/start-local.sh" start >/dev/null 2>&1 || echo "zero-remote-live: WARNING app did not come back; run start-local.sh start" >&2
exit ${FAILURES:-0}
