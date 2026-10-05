#!/bin/bash
# Shell 只导入统一解析器返回的 Docker 环境，不自行扫描其他项目。
resolve_docker_host() {
  local key value bridge
  bridge="$(node "$(dirname "${BASH_SOURCE[0]}")/local-runtime-cli.mjs")" || return $?
  while IFS='=' read -r key value; do
    case "$key" in
      DOCKER_HOST) if [ -n "$value" ]; then export DOCKER_HOST="$value"; else unset DOCKER_HOST; fi ;;
      DOCKER_CONTEXT) if [ -n "$value" ]; then export DOCKER_CONTEXT="$value"; else unset DOCKER_CONTEXT; fi ;;
      *) printf '%s\n' "Unexpected runtime resolver key: $key" >&2; return 1 ;;
    esac
  done <<< "$bridge"
}

docker_unreachable_hint() {
  printf '%s' 'start the selected Docker runtime; use DOCKER_CONTEXT, DOCKER_HOST or runtime.json to select another runtime'
}
