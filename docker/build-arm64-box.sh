#!/bin/bash
# Build the arm64-native exec lab image.
#   docker/build-arm64-box.sh
# 前置条件：导入 docker/base-image.json 指定 digest 的基础镜像。
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
export DOCKER_HOST="${DOCKER_HOST:-}"

BASE_IMAGE=$(node "$REPO/scripts/lib/deps-pin.mjs" --base-image)
if ! docker image inspect "$BASE_IMAGE" >/dev/null 2>&1; then
  echo "Locked base image $BASE_IMAGE is missing. Import that image or explicitly review and update docker/base-image.json." >&2
  exit 1
fi
BASE_PLATFORM=$(docker image inspect "$BASE_IMAGE" --format '{{.Os}}/{{.Architecture}}')
[ "$BASE_PLATFORM" = linux/arm64 ] || { echo "Base image has unexpected platform: $BASE_PLATFORM" >&2; exit 1; }

# Small context: the repo root carries node_modules; only manifests are needed.
mkdir -p "$REPO/.cache"
CONTEXT=$(mktemp -d "$REPO/.cache/box-build.XXXXXX")
trap 'rm -rf "$CONTEXT"' EXIT
cp "$REPO/docker/arm64-exec-box.Dockerfile" "$CONTEXT/Dockerfile"
cp "$REPO/package.json" "$REPO/package-lock.json" "$CONTEXT/"
mkdir -p "$CONTEXT/scripts" "$CONTEXT/docker/bin"
cp "$REPO/scripts/apply-third-party-patches.mjs" "$CONTEXT/scripts/"
cp "$REPO/docker/bin/box-init-exec" "$CONTEXT/docker/bin/box-init-exec"
cp "$REPO/docker/bin/xtest-input-local.py" "$CONTEXT/docker/bin/xtest-input-local.py"
cp "$REPO/docker/bin/box-navigate" "$CONTEXT/docker/bin/box-navigate"

# Dependency pin: baked as an image label from the same canonical inputs the
# app stamps at package time (scripts/lib/deps-pin.mjs is the one
# implementation). The connector compares it and refuses a present-but-stale
# image instead of quietly running outdated dependencies.
DEPS_PIN=$(node "$REPO/scripts/lib/deps-pin.mjs")

OUTPUT_IMAGE="${GROKBOT_BUILD_IMAGE:-grok-bot-exec-box:arm64}"
docker build --platform linux/arm64 --build-arg "BASE_IMAGE=$BASE_IMAGE" --label "com.grok-bot.local-vm.deps-pin=$DEPS_PIN" -t "$OUTPUT_IMAGE" "$CONTEXT"
docker image inspect "$OUTPUT_IMAGE" --format 'built: {{join .RepoTags ","}} deps-pin: {{index .Config.Labels "com.grok-bot.local-vm.deps-pin"}} base: {{index .Config.Labels "org.opencontainers.image.base.name"}}'
