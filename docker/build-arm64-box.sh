#!/bin/bash
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$REPO/docker/build-box.mjs" --platform linux/arm64 "$@"
