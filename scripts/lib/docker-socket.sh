#!/bin/bash
# 本项目的 Docker 端点发现，shell 侧的唯一实现（start-local.sh 与
# scripts/zero-remote-live.sh 都 source 这个文件；TS 侧对应
# source/electron-main/box/local-docker-host-connector.ts 的 resolveDockerHost）。
#
# 选择顺序是显式的，不依赖“碰巧先找到哪个 socket”：
#   1. 已经设置的 DOCKER_HOST
#   2. 本项目自己的 Colima profile（GROKBOT_COLIMA_PROFILE，默认 grokbot）
#   3. 通用的 /var/run/docker.sock（Docker Desktop 等）
#   4. 无 profile 的 ~/.colima/docker.sock 与 default profile
#   5. 其余 Colima profile 按名称排序
# 第 5 步排序是为了让结果与 readdir 顺序无关；这里不写任何从别的项目借来的
# profile 名，运行环境由上面两步显式指定。

GROKBOT_DEFAULT_DOCKER_PROFILE="${GROKBOT_DEFAULT_DOCKER_PROFILE:-grokbot}"

# 当前选择的 Colima profile 名（只用于提示信息与候选顺序）。
grokbot_colima_profile() {
  printf '%s' "${GROKBOT_COLIMA_PROFILE:-$GROKBOT_DEFAULT_DOCKER_PROFILE}"
}

# 找到可用的 Docker socket 后导出 DOCKER_HOST；找不到返回 1。
resolve_docker_host() {
  [ -n "${DOCKER_HOST:-}" ] && return 0
  local candidate entry
  for candidate in \
    "$HOME/.colima/$(grokbot_colima_profile)/docker.sock" \
    /var/run/docker.sock \
    "$HOME/.colima/docker.sock" \
    "$HOME/.colima/default/docker.sock"
  do
    if [ -S "$candidate" ]; then export DOCKER_HOST="unix://$candidate"; return 0; fi
  done
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    candidate="$HOME/.colima/$entry/docker.sock"
    if [ -S "$candidate" ]; then export DOCKER_HOST="unix://$candidate"; return 0; fi
  done <<EOF
$(ls -1 "$HOME/.colima" 2>/dev/null | LC_ALL=C sort)
EOF
  return 1
}

# 找不到运行时的统一提示：说清显式选项，而不是让人猜该起哪个 profile。
docker_unreachable_hint() {
  printf '%s' "start a Docker runtime: colima start --profile $(grokbot_colima_profile), or export DOCKER_HOST=unix://<socket>"
}
