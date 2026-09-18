# ROADMAP：从"有手无眼"到完整盒子（2026-09-16）

> 本文取代 `ARCHIVE-ASSETS.md` §6/§7 的排队结构（那份保留作历史记录与资产索引）。
> 重新推导，不机械继承旧清单：原 P1-6/F1-F3/新鲜度等条目已按性质归并、重排或降级，见文末对照。

## 0. 现状定位

盒子现在**有手无眼**：

| 平面 | 状态 |
| --- | --- |
| 执行面（linux 里面） | **已通**：arm64 原生容器默认（PR #7），网关 ~3s，host 自拉重建版 daemon，QEMU/Mac-host 双向回退 |
| 界面面（linux 界面化） | **未接线**：桌面栈完整躺在镜像里，代码路径零调用（见 §1） |
| 人机面（登录/接管） | **空白**：request_box_help 合同已知（Archive 8 月观察），无任何实现 |

另：执行面自身有四处裂缝（§2），全部是同一类病。

## 1. 界面化整合状态：镜像有，代码无——断在四层

Archive 桌面栈的整合完成度可以精确描述为"二进制在、进程无、协议断、工具 stub"：

| 层 | 镜像里 | 代码路径 | 断点 |
| --- | --- | --- | --- |
| 进程层 | `box-init` 是默认 CMD，会起 Xvfb/xfwm4/x11vnc/noVNC/路由器/会话同步 | 连接器把 entrypoint 覆写成 `node` 跑 host——box-init 不执行 | 桌面栈零进程 |
| 网络层 | 6080/6081/1339/1337 在容器内可用 | 自建镜像分支只 publish 网关 1340（6080/6081/1339 只在 ECR 分支） | noVNC 对 Mac 不可见 |
| 服务层 | `sand-window-router.mjs`、`start-window`/`stop-window`、`box-chrome` 都在 `/usr/local/bin` | 无人启动路由器；`box-windows.ts` 自初始导入只改过注释 | 多窗口/token 通路断 |
| 工具层 | XTEST 输入、整屏截图的参考实现（Archive `desktop-input.mjs`/`xtest-input.py`） | Computer 工具仍是 `withNoMonitorComputerUse` 抛错 stub | agent 无"眼"无"鼠标" |

**且这是被有意锁死的**：门禁 G4 断言冷启动容器零 Chromium 进程。当前系统在契约上就是无头的——所以接通界面不是"补个开关"，而是要演进这份契约（见 §3 切片 B）。

## 2. review 发现的重归类：四处裂缝，一种病

不按 F1/F2/F3 排，按性质归——它们全是**"一个东西的两套表示静默漂移"**：

| 裂缝 | 漂移的两边 | 现状 |
| --- | --- | --- |
| 文件双轨 | daemon 的 `/workspace`（workspace 卷）vs Claude SDK cwd 的 sand-data 候选（data 卷） | 同一 agent 的两只手写两个卷 |
| 静默 QEMU 回退 | commit 宣称 "never silently fall back" vs 默认路径缺自建镜像时确实静默走 ECR/QEMU | 报错守卫只保护显式 env 的情形 |
| 门禁绕路 | 测试路径（`docker exec`）vs 产品路径（gateway→host→daemon 1337） | G3 防不了 daemon 协议/token/路径映射回归 |
| 镜像无新鲜度钉 | 仓库依赖（package-lock/补丁脚本）vs 镜像内 node_modules | 依赖升级后容器跑旧的，无人报错 |

这个仓库已经栽过两次同族病（artifact-fallback 吞改动、EACCES 吞错），两次的解法同构：**给每个二元对加一个对账机制**（build-stamp、诊断副本）。上面四条的对账机制分别是：统一挂载点、intercept 事件+状态标注、端到端门禁、镜像 label 钉。

## 3. 路线：三个切片，依赖推导而非优先级打分

**切片 A「运行契约 v2」**——把执行面的四处裂缝一次收拢（它们都改同一个工件：run plan / 镜像契约）：

1. `/workspace` 从 named volume 换 bind mount（Colima 共享 `/Users`），`resolveAgentWorkspace()` 与 daemon `workspaceRoot` 收敛到同一目录，Mac 侧可见（Archive `MAC_BOT_WORKSPACE_HOST` 双径回报现成）✅ 2026-09-16 已落地：schema 7、`SAND_WORKSPACE_ROOT`/`SAND_AGENT_WORKSPACE`/`SAND_WORKSPACE_HOST` 三 env 钉同一目录、创建即记 `workspace-bind-mount` 事件 + 状态面双径行（当时限自建分支；官方分支残留随 A-3 的 PR 闭合，schema 8 起两分支同契约）；
2. 默认路径缺自建镜像时的 QEMU 回退：记 intercept 事件 + `start-local` 状态面一行标注（保留开箱即用，修复"说的和做的不一致"）✅ 2026-09-16 已落地：`decideDockerImage` 判别选择 + `official-image-qemu-fallback` 账本事件（每进程一次）+ 状态面告警，活体双向验证过；
3. 镜像新鲜度：package-lock + `apply-third-party-patches.mjs` hash 打进 image label，连接器/门禁比对，不符报"跑 `build-arm64-box.sh`" ✅ 2026-09-16 已落地：`scripts/lib/deps-pin.mjs` 单一实现三处消费（package stamp / build label / 门禁 G0）；**stale≠missing**——过期镜像给 actionable 拒绝不落 QEMU 回退（有顺序陷阱测试锚定）；容器 label 漂移即替换。官方 ECR 分支的 F2 残留（命名卷+无收敛）同 PR 闭合，schema 8；
4. G3 端到端化：容器内 node 直连 1337 走 ExecService 真 exec（顺带冷启动 <15s 阈值当性能哨兵）✅ 2026-09-16 已落地：`source/box-exec-daemon/smoke.ts`（同传输/Bearer/shellArgs 流）+ `scripts/daemon-smoke.mjs` 编排，G3 锚精确输出；冷启动哨兵原生 arm64 生效（实测 3s）；生产盒直打验证 `pwd=/workspace` 且 daemon 写入即时落到 Mac 侧。

**为什么 A 先于一切**：桌面模式会把文件面 ×4（工作区、截图、下载目录、浏览器 profile）、端口面 ×5 翻进来。先修契约再扩面，否则每条裂缝复制成多条；反过来，A 做完后 B 只是"在好契约上加面"。

### B1 拓扑决定（2026-09-16，S-1 落地版）

1. **PID1 = host**。入口是 box-init 的 exec 变体（镜像内 `/usr/local/bin/box-init-exec`）：
   起桌面面（start-desktop.sh 主屏 → 自带 6080 入口；6081 forks 入口与 1339 路由器后台）
   后 `exec /usr/local/bin/node host-main.cjs` 转前台。不造新 supervisor——Archive 的
   register-pid 监督表语义保留在 start-desktop.sh 内部，用于精确拆除；容器级收尸归 Docker。
   **不并入**：box-service(18765) 是 Q4 明确不做；session-sync 归 C3（S-7）。
2. **桌面组件不自动重启**。死由探测暴露（xdpyinfo / VNC·noVNC 端口，"探活必须打端口"），
   修复走 recreate——不做机械重试。host 侧 S-3 的 Computer 工具遇到死桌面诚实报错。
3. **`--restart unless-stopped` 交互**：host 崩 → 容器整体重启（桌面面随 PID1 一起回来）；
   桌面崩 → 容器活着、host 活着、门禁/探测抓（S-4 的 desktop profile 断言这一条）。
4. **opt-in 先行，S-4 已翻转默认**：双 profile 门禁全绿后（2026-09-16），desktop 成为
   自建镜像的**默认**（`resolveDesktopMode`：`SAND_LOCAL_ADMIN_DESKTOP=0` 退回无头 exec，
   start-local `GROKBOT_DESKTOP=0`）。官方镜像永不 desktop。run 契约 → schema 9→11
   （9=入口+label，10=seccomp，11=内存 cap 2g/4g）+ `com.grok-bot.local-vm.desktop` label
   （0/1 进漂移检测）。host 进程继承 `DISPLAY=:1`。
5. **知情债务登记（seccomp）**：desktop 默认 ⇒ 默认容器运行在 `seccomp=unconfined` 上。
   这是知情取舍而非疏忽：默认 profile 下 Chromium 自带沙箱无法启动（秒死成僵尸，实测），
   放开后浏览器沙箱**保留并生效**，恶意页面拿不到容器（也就拿不到全机 cookie 库）——
   补偿控制存在且被 D 门禁覆盖。`BOX_NO_SANDBOX=1`（丢弃浏览器沙箱）永不默认。
   exec 道维持默认 seccomp。

**切片 B「桌面模式」**——唤醒睡着的界面：

1. **先做拓扑决定**（其余三件事的地基）：推荐 box-init 出一个 exec 变体——起桌面+路由后台、`exec node host-main.cjs` 当前台（进程收尸归 Docker；避免再造 supervisor）；
2. 端口与 token：6080/6081/1339 publish 到回环；noVNC token 用 Archive `novnc-auth.mjs` 的随机签发（镜像里现成的 TokenFile 机制，**别用显示号**）；
3. Computer 去 stub：XTEST 输入 + 整屏截图（Archive 参考实现）；浏览器侧零改动（`driver-v2.mjs` 自包含）✅ 2026-09-16 已落地：`local-computer-use.ts` 执行器（仅 desktop opt-in 挂载）+ `docker/bin/xtest-input-local.py`（Archive ctypes 核心扩 move/down/up）；截图走 `xwd|convert` 整屏、落 /workspace 可 Mac 侧读取；几何镜像 1280x800 有单测；桌面容器 `seccomp=unconfined`（schema 10）否则 Chromium 自沙箱秒死成僵尸；活体：点击 dock 启动真浏览器 + 窗口截图确认；
4. 契约演进：G4 拆成 exec/desktop 两个门禁 profile（无头纪律保留给 exec 模式）；加资源上限（Archive 实测每只 Chromium ~800MB）✅ 2026-09-16 已落地：`--profile exec|desktop`（D1 几何单源/D2 端口/D3 双向鉴权/D4 Computer 往返/D5 桌面死语义），双 profile 活体全绿后默认翻转（独立 commit），内存 cap 2g/4g 进 run 契约（schema 11）；

**切片 C「人机面」**——让浏览器从"能打开"变"能登录"：

1. `request_box_help` 合同 + awaiting_human 状态机（15 分钟服务端超时、闸门先于读请求体、`ask_human` 幂等——Archive 语义照抄）✅ 2026-09-16 已落地（S-5）：状态机在容器内 host（`awaiting-human.ts`），ask/交回用文件契约（`.grokbot/ask-human.json`，与 novnc-url 同形；agent 的 Mac 侧工具能删它解禁——无死锁），门禁挂 shell/shellStream/computerUse 三个执行器，服务端 15 分钟期限（`SAND_AWAITING_HUMAN_TIMEOUT_MS` 可覆写），重复 ask 不重置计时，坏 ask 进 reason-less 门禁不静默放行；账本记 ask/hand-back/timeout/ask-malformed；URL staleness 文案进交接报错与身份提示词。活体：ask→hand-back（waitedMs 实测）与短期限→诚实收回+文件清除均在容器账本落证；**接管 URL 生命周期显性化**：token 随容器启动重签即作废，交接文案与错误信息必须说清「链接已随重启失效，请重新 ask」，不许人对白屏猜（S-4 review watch item）；
2. 敏感字段闸门（fill/select/press 白名单、快照抹值）+ noVNC 接管 URL ✅ 2026-09-17 已落地（S-6，拓扑适配版）：本拓扑的"快照"是像素级桌面截图——密码框自掩码，明文不进像素（DoD 的截图侧天然满足）；真正的暴露面在审计账本记录的工具输入——xtest 载荷的 text/key（含逐字符 key 路径，Archive 的 press 敞口）在**记录副本**抹值（执行不受影响，非 xtest 命令保真）；账本 0600 并对已松的旧账本收紧；提示词钉死凭据纪律——agent 永不自持凭据、secret 只走 noVNC 人工交接、不在聊天里复述；ask 时 osascript 弹系统通知；接管 URL autoconnect 已随 S-2 落；
3. session-sync（cookie/localStorage 只补缺 + 重载断路器，多窗口共享登录态）✅ 2026-09-17 已落地（S-7，拓扑适配版）：**登录态持久化**先行——profile 符号链接进 data 卷（活体证明：cookie 种入→容器替换→存活，前提是干净退出刷盘；SIGKILL 前未刷的丢失是浏览器惰性落盘的诚实行为）；box-init-exec 启动即清陈旧 Singleton 锁（新容器里按构造陈旧，不清 chromium 认死锁起不来——实测抓到）+ 现建卷内 profile 目标（卷挂载遮蔽镜像层）；Archive session-sync 守护原样接入（单屏 no-op、多窗口即工作，只补缺两道冗余+RELOAD_CAP 断路器语义全在脚本内）；CDP 口=9222+N（display 1 → 9223）。内存预算：单窗口 ~800MB/Chromium 对 4g cap 安全，多窗口落地时复核；**内存预算复核**：每只 Chromium ~800MB，多窗口会顶 4g cap——届时提 cap 或限窗数，OOM-kill 要诚实报错不许容器内静默死（S-4 review watch item）；
4. egress 治理 ✅ 2026-09-17 已落地（S-8，拓扑适配版）：**导航门** `docker/bin/box-navigate`——被教的唯一导航原语（CDP Page.navigate），目的地先过闸：字面私网/保留段/回环/CGNAT/组播拒 + **DNS 解析后判**（防 rebind 到内网）；fake-IP 段（198.18/15，本部署 Clash 合成）按部署现实处理——域名全落 fake-IP → 放行并记 `proxy-fronted` 账本行（真实目的地由代理在远端解析），字面 fake-IP 直连仍拒，`SAND_EGRESS_STRICT=1` 恢复全严格；**代理模式**：`SAND_BOT_PROXY` → 容器 `MAC_BOT_PROXY` → box-chrome `--proxy-server`（Archive 语义：CONNECT 在远端解析、治 DNS 投毒），Chromium 默认绕过回环（CDP/noVNC 不受影响，有回归验证）；活体：三类拒绝带账本行、真导航到 example.com、代理透传 + 9223 回环可达；

**完成定义**：A = 同一 agent 的所有工具写同一目录、所有回退都有标注、门禁走真执行链；B = Computer 工具在容器里点得动真浏览器、人能在浏览器里看到那块屏；C = agent 遇到登录页会停下来把屏交给人、15 分钟后诚实收回。

**C 后、S-9 前的结构修（S-4 review 定案）✅ 2026-09-18 已落地**：`SAND_LOCAL_ADMIN_TURN=host` 转正为默认——
路由轮次真正在容器内执行（现在推理/本地工具跑在 Mac coordinator，只有 computer 面在容器；
身份块的「我就是沙箱」要等这一步才是完整事实）。毕业 golden path 的「agent 写的文件人能
在 Mac 看到」只有在执行面与文件面都对齐后才成立。热修已先把 agent cwd 与两形态 daemon
的 workspaceRoot 收敛到 `<root>/box-workspace`（2026-09-16），执行面收敛由此项完成。
落地时连环修了三个真 bug（全部有账本/栈证据）：staging 只挂单文件 → 盒内 turn 死于
`agent-store-worker.cjs` 缺失（修：staging 整棵 host 树 + 目录挂载，layout v3 + schema 12）；
demo 插件 Mac 路径在盒内死（修：重定位到 /workspace）；盒无 settings.json → provider 默认
cursor、turn 撞封锁后端（修：创建时把 Mac 的 provider 强制合并进卷内 settings.json）。
活体验收：探针回复即 `Linux <容器hostname> ... aarch64`，盒内账本记录 claude-code provider
的真实 Bash 执行。已知限：插件 MCP 桥在 Mac 回环、盒内轮次不可达（登记待桥接）；
死轮次留下的 transcript journal 需恢复（清理 agents/ 即愈，登记为 watch item）。

## 3.5 跨拓扑加固清扫（2026-09-18，三路审计 + 第二跳核实）

bug 族：为单一拓扑/时代写的守卫与假设在另一形态或异常序列下失真。已修（活体验证）：
host 分支先停容器（曾静默把容器当 Mac host 用）、forceRecreate 丢弃陈旧 in-flight +
探测绕过缓存、非 admin recreate 容器缺失容忍、QEMU 回退账本后置到全部拒绝守卫之后、
配置类错误（stale/镜像错配）不烧自动断路器、host-turn 挂载面进 drift（label）、
孤儿 host 清理先于端口分类、stop 不再销毁电脑（桌面会话存活；host 切换由连接器负责）、
status 对 docker 不可达如实报告、桌面启动失败不再崩溃循环（host 带死桌面继续、探测暴露）、
box-navigate 读 $DISPLAY（CDP=9222+N 单源）、xtest 注入前整段预扫（部分注入前就报字符位）、
awaiting 门禁补上 Mac 权限层强制（Bash 仅放行交回命令；docker exec 旁路关闭）。
**登记未修**（低频/未来形态）：1339 路由器与 session-sync 死亡无生产探测（多窗口落地时修）；
SAND_LOCAL_ADMIN_DESKTOP 读进程 env，两个启动环境交替会乒乓重建容器（落 settings 时修）；
box-mode 三态文件仍是"上次 start 的快照"（A6，现为纯展示层，风险已降）；
awaiting 的 hand-back 无法认证"人真的来过"（拓扑边界，文档已载）。

## 4. 边界（不变）

- 不并入 Archive 的 `:18765` 窗口服务与 mcp-server（driver 自包含，最小合并集 = box-image + 行为规格）。
- 多屏配额等运行时调参，不做结构性工作。

## 4.5 横切：零远端证明 gate ✅（2026-09-16，S-0）

切片 B 开线前落地。出口清单以已 patch 的调用点为准（connect-node 绕过 fetch 拦截的教训）：
fetch 全局拦截（`blocked-fetch` 记账+抛错）、cursor-inference / cursor-marketplace 两处
connect-node 传输（上游 fail-closed），清单由 `tests/zero-remote.test.mjs` 钉死——新出口
文件出现即测试失败，强迫有意识的清单决策。matcher 覆盖 cursor+xai 两族。
`scripts/zero-remote-live.sh` = 活体剧本（重启→真工具调用→关停→窗口+全量账本断言）；
分类器只认 URL 形状字段（`url`/`baseUrl`/`backendUrl`/`endpoint`），文本提及不算出网声明
（agent 命令串/日志尾里的域名是审计文本，网络层独立性由毕业验收封锁证明）。
活体基线：1905 行账本、470 次 blocked-fetch、0 出网观测；伪造违规行必被抓（exit 1）。
已知边界：turn 级 API 驱动待 pr/14 落地后扩展剧本。

## 5. 与旧清单的对照（重排了什么）

| 旧条目 | 去向 |
| --- | --- |
| F2 / F1 / F3 / 镜像新鲜度 | 归并为切片 A |
| P1-4 Computer use | 切片 B（新增显性前提：拓扑决定 + G4 profile 化） |
| P1-5 人机交接 | 切片 C（吸收 session-sync） |
| P1-6 egress 独立项 | 拆解：私网拒绝提前进 A，代理模式归 C |
| nightly CI 接线 | 降为 B 的附属（desktop 模式才需要 CI 容器变体） |
| 资源上限 | 归 B（桌面内存预算） |
