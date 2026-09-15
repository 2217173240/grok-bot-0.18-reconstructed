#!/bin/bash
# Build the arm64-native exec lab image.
#   docker/build-arm64-box.sh
# Prerequisite: grok-box-base:arm64 built from the Archive repository:
#   docker build -f box-image/Dockerfile -t grok-box-base:arm64 <archive-repo>
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
export DOCKER_HOST="${DOCKER_HOST:-}"

if ! docker image inspect grok-box-base:arm64 >/dev/null 2>&1; then
  echo "grok-box-base:arm64 not found. Build it from the Archive repository first:" >&2
  echo "  docker build -f box-image/Dockerfile -t grok-box-base:arm64 <archive-repo>" >&2
  exit 1
fi

# Small context: the repo root carries node_modules; only manifests are needed.
CONTEXT=$(mktemp -d)
trap 'rm -rf "$CONTEXT"' EXIT
cp "$REPO/docker/arm64-exec-box.Dockerfile" "$CONTEXT/Dockerfile"
cp "$REPO/package.json" "$REPO/package-lock.json" "$CONTEXT/"
mkdir -p "$CONTEXT/scripts"
cp "$REPO/scripts/apply-third-party-patches.mjs" "$CONTEXT/scripts/"

docker build -t grok-bot-exec-box:arm64 "$CONTEXT"
docker image inspect grok-bot-exec-box:arm64 --format 'built: {{join .RepoTags ","}}'
