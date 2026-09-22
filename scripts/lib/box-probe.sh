#!/bin/bash
# 容器门禁使用的三值探测。
#
# `docker exec` 把三种互不相同的情况合并成同一种形状：容器已经停止、exec 被拒绝、盒内没有这个命令，
# 都表现为非零退出并且 stdout 为空。命令真的运行了、只是没有输出，形状完全相同。读代码的人无法从
# 这个形状判断门禁到底测到了什么，因此「把空输出当成条件不成立」的门禁，恰好在它知道得最少的时候
# 判为通过：G4 曾经在每一次 docker exec 都失败的时候报告「没有 Chromium 进程」。
#
# 这里的每个探测都把测量结果与测量动作本身分开：
#
#   PROBE_OK       命令在盒内运行了，PROBE_OUTPUT 是它的输出
#   PROBE_UNKNOWN  探测没有到达盒内，PROBE_OUTPUT 是诊断信息。门禁遇到这种情况必须判为失败。
#
# 分隔由一行只有盒内 shell 才会打印的哨兵承担，因此不需要相信退出码的约定：盒内的远程命令本身
# 完全可能以 125、126、127 退出，用退出码区分会误判。
#
# 盒子的名字由 BOX_CONTAINER 给出，所以同一组探测可以服务本仓库创建的每一个容器，而不是只服务
# 评测用的那一个。

PROBE_OK=0
PROBE_UNKNOWN=1
PROBE_STATUS=$PROBE_UNKNOWN
PROBE_OUTPUT=""
PROBE_SENTINEL="grokbot-probe-reached-the-box"

# 盒内命令的执行者。默认通过 docker exec 进入 BOX_CONTAINER；换用别的容器运行环境，或者在
# 测试里驱动探测的三值分支时，替换这一个函数即可，探测逻辑本身保持不变。
probe_runner() {
  docker exec "$BOX_CONTAINER" sh -c "$1" 2>&1
}

# probe_in_box <shell-command>
# 在 BOX_CONTAINER 内用 sh 运行 <shell-command>，设置 PROBE_STATUS 与 PROBE_OUTPUT。
# 始终返回 0：调用者根据 PROBE_STATUS 分支，因此一个自身以非零退出的命令仍然是一次成功的探测。
probe_in_box() {
  local raw
  raw="$(probe_runner "printf '%s\n' '$PROBE_SENTINEL'; $1")"
  case "$raw" in
    "$PROBE_SENTINEL"$'\n'*)
      PROBE_STATUS=$PROBE_OK
      PROBE_OUTPUT="${raw#"$PROBE_SENTINEL"$'\n'}"
      ;;
    # 盒内命令只输出了空行时，命令替换会去掉全部结尾换行，只剩下哨兵自己。这是一次成功的
    # 探测，测量结果是「空」，与探测失败不是同一件事。
    "$PROBE_SENTINEL")
      PROBE_STATUS=$PROBE_OK
      PROBE_OUTPUT=""
      ;;
    *)
      PROBE_STATUS=$PROBE_UNKNOWN
      PROBE_OUTPUT="${raw:-docker exec 没有任何输出}"
      ;;
  esac
}

# probe_box_process_count <pattern>
# 把 PROBE_OUTPUT 设成匹配 <pattern> 的进程数量，无法读取数量时设为 PROBE_UNKNOWN。
# pgrep -c 在没有匹配时打印 0 并以 1 退出，所以数量只从输出读取，退出码不参与判断。输出不是单个
# 数字（pgrep 不存在、sh 报错）一律判为未知，绝不当成 0。
probe_box_process_count() {
  probe_in_box "pgrep -c '$1' 2>&1 || true"
  [ "$PROBE_STATUS" = "$PROBE_OK" ] || return 0
  case "$PROBE_OUTPUT" in
    ""|*[!0-9]*) PROBE_STATUS=$PROBE_UNKNOWN ;;
  esac
}

# probe_box_pid <pattern>
# 把 PROBE_OUTPUT 设成匹配 <pattern> 的第一个进程号。没有匹配时 PROBE_OUTPUT 为空但状态仍为
# PROBE_OK：进程确实不在，这是测量结果，与探测失败不是同一件事。
probe_box_pid() {
  probe_in_box "pgrep -f '$1' | head -1"
}
