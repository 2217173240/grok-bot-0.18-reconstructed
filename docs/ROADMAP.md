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

**C 后、S-9 前的结构修（S-4 review 定案）✅ 第二回合落地（2026-09-20）**：第一回合曾翻默认后回退——
路由轮次真正在容器内执行（现在推理/本地工具跑在 Mac coordinator，只有 computer 面在容器；
身份块的「我就是沙箱」要等这一步才是完整事实）。毕业 golden path 的「agent 写的文件人能
在 Mac 看到」只有在执行面与文件面都对齐后才成立。热修已先把 agent cwd 与两形态 daemon
的 workspaceRoot 收敛到 `<root>/box-workspace`（2026-09-16），执行面收敛由此项完成。
落地时连环修了三个真 bug（全部有账本/栈证据）：staging 只挂单文件 → 盒内 turn 死于
`agent-store-worker.cjs` 缺失（修：staging 整棵 host 树 + 目录挂载，layout v3 + schema 12）；
demo 插件 Mac 路径在盒内死（修：重定位到 /workspace）；盒无 settings.json → provider 默认
cursor、turn 撞封锁后端（修：创建时把 Mac 的 provider 强制合并进卷内 settings.json）。
活体验收：探针回复即 `Linux <容器hostname> ... aarch64`，盒内账本记录 claude-code provider
的真实 Bash 执行。**阻塞（已回退默认，host 转正挂起）**：全新对话在盒内硬失败
`TranscriptJournalCorruptionError: transcript checkpoint must recover before preparing`
（UI 报 Agent failed to respond）——新 agent 只建 `conversation-blobs.db` 从不建 `store.db`，
journal 的 recover/prepare 路由状态错配（bundle 内 `isJournalEnabled` 为注入依赖，真源未定位）。
修复路径：定位 journal 启用门槛与 store.db 的创建者（agent-isolation worker 侧），
或给 host plane 配实验开关把 transcript 走 legacy 路由。
**第二回合（2026-09-20，三路子代理深挖 + 容器内活体验证）**：根因闭环——journal 首 checkpoint
无 recover 播种是 stock 结构缺陷，Cursor 用 gate 默认 OFF 盖住，而数据卷里的 statsig bootstrap
（2897 个哈希 gate、每分钟自维护）把它拨成了 ON；桌面 settings 同步还会整表重写覆盖文件（文件级
override 不可靠）。修法=run plan env 三件套：`SAND_FEATURE_GATE_OVERRIDES` 钉 8 个危险 live gate
到代码默认（journal 为首，另含 notify_bus/action_audit/auto_review/browser_use_subagent 等）、
`SAND_LOCAL_ADMIN=1`（盒内权限层与 awaiting-human 强制复活）、`SAND_HOST_IN_BOX=1`（forever-box/
日志船运走对分叉）；schema 12→14（13 曾短暂部署于本机，无中间部署承诺）。**活体验收（全新对话）**：
journal 错误 0、permission-allowed + 真实执行（cwd=/workspace）、agent-transcripts 落 legacy jsonl
零 marker、assistant 回复带 Linux 指纹持久化。默认重翻。
**登记 watch items**：桌面 resync 的 account-scope null 推送会整批清空盒内
localToolPermission/computerUseModel/MCP 禁用表（同族于 flag 文件覆盖，面更宽——待守卫）；
探针首轮工具调用出现过一次瞬时 `Cannot read properties of undefined`（第二条命令即恢复，观察中）；
S-9 golden path 必须含「盒内全新会话全流程」门禁（本轮的教训固化）。已知限：插件 MCP 桥在 Mac 回环、盒内轮次不可达（登记待桥接）；
死轮次留下的 transcript journal 需恢复（清理 agents/ 即愈，登记为 watch item）。

**投递链贯通（2026-09-21）**：盒内轮次的 assistant 回复现在完整出现在 UI 里。两处修改共同完成：
宿主出口的条目字段名投影（`renderer-entry-shape.ts`，接入 `host-gateway-api.ts` 的五个转录命令与
`roster-projection.ts` 的事件发射）与打包阶段对 renderer 文字提取器的补丁
（`router-renderer-patch.mjs` 的 `patchOriginalEntryTextExtractor`）。完整调用链、根因实证与验证剧本见
`docs/HANDOFF-inbox-delivery.md`；产物分层与字段名约定见 `docs/ARCHITECTURE.md`。

**登记 watch items（2026-09-21 追加）**：renderer 是打包阶段产物，修改 `frontend/src` 或
`src/app/dist/renderer` 都不会改变发货内容，renderer 行为只能靠 `router-renderer-patch.mjs` 的补丁修改，
且补丁锚点移动会让打包直接失败；`docker/arm64-exec-box.Dockerfile` 的注释计入 deps-pin，改注释必须重建薄层。

**三路审计与加固批次（2026-09-22）**：围绕「两个平面语义分叉 / 被吞掉的失败 / 状态面与真实状态不一致」
三类问题做了三路并行审计，逐条核实后修了六处（每处都带回归测试，且测试先确认在缺陷代码上失败）：

| 修复 | 问题 |
| --- | --- |
| 身份提示词按平面分流 | 盒内也被教用 `docker exec`，而盒内没有 docker CLI；账本里有 6 次 `command not found` 与一段 20 分钟探测循环 |
| 漂移检测纳入 daemon 哈希 + 清理保护在用目录 | 只重建 daemon 不触发容器重建，而 staged runtime 清理只保留最新 3 份，可能删掉活容器正在挂载的目录 |
| 本地计算机状态改为真实探测 | `runState` 返回常量 `"running"`，界面永远不会显示执行面不可用；`getStatus` 另外还会把 running 覆盖成 `absent` |
| 持久化队列区分「缺失」与「损坏」 | 读失败返回空集合，下一次读取-修改-写入在空基础上覆盖，静默毁掉待办与证据 |
| staging 完整性校验 | 树遍历的 `catch {}` 丢弃失败的子树，staging 阶段无报告，盒内轮次才以 MODULE_NOT_FOUND 失败 |

**同批登记的其余项，第二次清扫已修（2026-09-22）**：

| 修复 | 问题 |
| --- | --- |
| 门禁探测改为三值 | G4 把失败 `docker exec` 的空输出当成进程数为 0，于是恰好在探测坏掉时判为通过。探测改为「测到了」与「没测到」两类，后者判为失败；D5 使用同一套探测 |
| `stop` 结果按观测判定 | `docker stop` 退出码为 0 被当作容器已停止，调用方随后在同一个网关端口上启动 Mac host，且失败被 `.catch(() => undefined)` 吞掉 |
| Mac 平面路由器不再认领无法表示的发送 | 带附件、回复目标、fork 标记的发送被认领后只存文本，其余字段丢失；纯附件发送直接抛错。这类发送改为交给盒内平面处理 |
| 转录条目 id 两个平面共用生成器 | Mac 平面自算轮次号，错误条目使用 `t<毫秒>s0`，被自己的正则读成轮次号，之后每个 id 都跳到毫秒量级；远端尾部读不出来时又退回空集，重新发出盒内已有的 id |
| 截图读取失败如实报错 | 盒内 driver 吞掉自己的截图失败，宿主又把读不回来的载荷变成成功的文本结果，模型在没看到屏幕的情况下被告知截图成功 |
| Codex 凭据缺失指名平面 | 盒内读取 `auth.json` 的路径与挂载目标不一致，失败表现为裸的 ENOENT，既不说是哪条路径，也不说哪个平面需要它 |
| 桌面健康心跳说明无生产者 | 该文件由盒内 supervisor 写入，本形态没有 supervisor；转发器已经返回 `absent`，调用方却丢掉返回值，于是永不发出的心跳与停掉的轮询看起来一样 |
| 权限设置 `never` 覆盖盒内 CLI 工具 | 盒内工作区是用户机器的 bind mount，写入直接作用在用户机器上，而权限回调对盒内一律放行 |
| 持久化网关描述不再提供接管地址 | 接管地址由 pod 按盒子签发，描述文件的保存窗口长达七天，旧进程签发的地址会直接呈现给操作者 |

**盒内插件 MCP 工具（2026-09-22，第三次清扫已修）**。这个功能在盒内完全不可用，根因有四处，缺一处就不通：

| 修复 | 问题 |
| --- | --- |
| 权限回调不再清空工具参数 | `claudeToolPermission` 的 allow 一律返回 `updatedInput: {}`。Claude CLI 用 `updatedInput` **替换**工具参数，于是模型给出的每个参数都被抹掉。内置工具的参数由 CLI 自己重新读取，所以这个缺陷长期不可见；插件工具的参数的唯一载体就是这次调用，全部丢失。实测：CLI 的账本记录 `{"text":"plugin-ok"}`，而它发到桥上的请求体是 `arguments: {}` |
| 盒内 daemon 成为 MCP 宿主 | 此前 `ExecService` 只处理 read、shell、writeShellStdin，`mcpArgs` 与 `mcpStateExecArgs` 走 `BOX_EXEC_UNSUPPORTED`，`LoadMcpServers` 返回空成功。现在 `source/box-exec-daemon/mcp-host.ts` 用官方 SDK 启动每个配置的 stdio 服务器、维护每服务器一个客户端，并应答列举与调用；启动失败的服务器按服务器报状态与原因，不影响其他服务器 |
| 盒内轮次把工具交给 CLI 子进程 | `turn-run-shell` 从 mcp 扩展取到工具面，`provider-session` 为每个流开一个回环 MCP 桥，把桥地址放进 CLI 的 `mcpServers`，并随流关闭。桥移到 `source/shared/node/mcp/routed-mcp-bridge.ts`，两个平面共用同一实现 |
| 插件清单进入盒内 | `mcp-servers.json` 以只读 bind mount 挂到 `/home/box/sand-data/mcp-servers.json`，即盒内定义源读取的位置。用绑定而不是拷贝，操作者改动后盒子立即读到当前文件 |

引入的依赖：`@modelcontextprotocol/sdk`（含其传递依赖）。它进入 `package-lock.json`，因此依赖 pin 变化，必须用
`docker/build-arm64-box.sh` 重建盒子镜像；自建镜像里也装上了 SDK，宿主包本身不需要它。

`McpArgs` 的字段约定在这里记一次：到达 daemon 时 `name` 是服务器自己的工具名，`toolName` 是调用方使用的标签，
`providerIdentifier` 是配置里的服务器名；网关的 `executeRoutedMcpTool` 会做这个交换，盒内路径按同样约定映射。
参数以 protobuf `Value` 传递，宿主侧在 `box-mcp-exec` 一处归一化（与 backend 端口一致）。

复现与验证剧本：`docker logs grok-bot-local-vm | grep "box-exec-daemon: mcp"` 显示每个插件的启动、工具列举与
每次调用的工具名与参数键名；盒内账本的 `tool-use` 事件记录 CLI 看到的完整参数。

**盒内推理出网曾间歇性卡住（2026-09-22，环境侧，未复现）**：Mac 用 Clash 的 TUN 接口（`utun4`，MTU 1380）
接管 fake-IP 网段 198.18.0.0/15。卡住期间从盒内测同一个推理端点，两次结果差三个数量级：

| 位置 | connect | total |
| --- | --- | --- |
| Mac | 0.002-0.004 s | 0.11 s |
| 盒内（卡住期间） | 7.18 s | 7.29 s |
| 盒内（同一容器，稍后） | 0.002 s | 0.10 s |

当时盒内累积约 90 条 `SYN-SENT` 到 `198.18.0.57`/`.59`。模型请求是流式长连接，握手反复失败时会持续重试，
那一轮就此停滞：转录里没有 assistant 条目、没有浏览器进程、`claude` 子进程持续增加，UI 只显示「正在运行」。
临时处置是重建容器终止该轮次。

随后在**同一个容器**（eth0 仍为 MTU 1500）连续测 11 次握手，全部 2-4 ms，`SYN-SENT` 为 0，故障不再出现。
因此当时推断的「Docker 网桥 MTU 1500 与 TUN MTU 1380 不匹配」缺少支持：如果那是原因，低 MTU 不会自己消失。
现在没有充分证据支持改动 MTU，改动反而可能引入新的分片问题。该现象按「代理 TUN 的瞬时故障」记录，
再次出现时先在盒内连续测握手并把 `ss -tn` 的 `SYN-SENT` 计数记下来，再决定是否调整。

**账号作用域同步（2026-09-21 加固）**：`reconcileMcp` 在没有账号作用域时不推送
`mcpCustomInstructionsAccountScope: null`，因此常规同步不会触发宿主的 `clearAccountScope()`；该函数会删除
`localToolPermission`、`computerUseModel`、`agentDefaultModel`、`autoReviewInstructions` 并清空三张 MCP 表。
`coordinator-resync.ts` 的 `pushCurrent` 在该轮次内作用域变为空时同样不再推送，堵住原来会清空盒内设置的竞态窗口；
真正的账号离开仍由 `prepareAccountTransition` 与 `account-transition-cleanup.ts` 的显式清空负责。
实测盒内 `localToolPermission=ask`、`computerUseModel` 与账号作用域均完好。
账号切换时删除 `localToolPermission` 是有意行为：切换后权限回到默认值，而 `never` 现在同时对盒内 CLI 工具生效，
因此这个重置只会放宽而不会遗留一个已失效的收紧设置。

**S-9 毕业验收（2026-09-21，三条自办项完成）**：

1. **门禁**：`docker/container-gates.sh --profile desktop` 与 `--profile exec` 两个档位全部通过。
   desktop 档 G0-G4 加 D1-D6 共十一项（含本批次新增的 D5 桌面守护进程探针）；exec 档 G0-G4 五项全过。
2. **零远端证明**：`scripts/zero-remote-live.sh` 全绿——重启后经网关到宿主再到 daemon 的真实工具调用往返成功，
   场景窗口与全量历史两次扫描均为 **3535 行账本、0 次出网观测**（其中 1625 行为被拦截的 cursor/xai 域名尝试）。
3. **基准数字**（原生 arm64 容器，与 Mac 宿主同程序对照）：

   | 项目 | 容器 | Mac 宿主 |
   | --- | --- | --- |
   | 网关冷启动（exec 档） | 2-3 s | — |
   | 网关冷启动（desktop 档） | 4-6 s | — |
   | cargo 首次构建（release，斐波那契样例，rustc 1.85.1） | 927 ms | 854 ms（rustc 1.97.1） |
   | cargo 重建（保留工具链缓存） | 133 ms | 151 ms |
   | go 首次构建（空缓存，go 1.24） | 5323 ms | 2035 ms |
   | go 重建（缓存已填充） | 47 ms | 67 ms |

   冷启动哨兵在门禁里强制为不超过 15 s。原生 arm64 与 QEMU 的差距沿用早前记录（QEMU 下网关约 21-25 s）。

4. **扩展点核对**：见 `docs/EXTENSIBILITY.md`。三处扩展（provider、工具、屏）都位于已有的注册点或数据源上，
   没有出现必须改动核心逻辑的情况；两条缺口已登记。

剩余一项是封锁 golden path，需要真人在 noVNC 窗口里登录一次（凭据不进 agent 之手是这条链路的验证目标）。

## 3.5 跨拓扑加固清扫（2026-09-18，三路审计 + 第二跳核实）

bug 族：为单一拓扑/时代写的守卫与假设在另一形态或异常序列下失真。已修（活体验证）：
host 分支先停容器（曾静默把容器当 Mac host 用）、forceRecreate 丢弃陈旧 in-flight +
探测绕过缓存、非 admin recreate 容器缺失容忍、QEMU 回退账本后置到全部拒绝守卫之后、
配置类错误（stale/镜像错配）不烧自动断路器、host-turn 挂载面进 drift（label）、
孤儿 host 清理先于端口分类、stop 不再销毁电脑（桌面会话存活；host 切换由连接器负责）、
status 对 docker 不可达如实报告、桌面启动失败不再崩溃循环（host 带死桌面继续、探测暴露）、
box-navigate 读 $DISPLAY（CDP=9222+N 单源）、xtest 注入前整段预扫（部分注入前就报字符位）、
awaiting 门禁补上 Mac 权限层强制（Bash 仅放行交回命令；docker exec 旁路关闭）。
**登记未修**（低频/未来形态）：1339 路由器与 session-sync 死亡无生产探测——桌面 profile 门禁的 D5 已加
两者存活性探针（`docker/container-gates.sh`），但两个守护进程都由 `docker/bin/box-init-exec` 以普通后台
进程启动，没有监督者，停止后需要重建容器（多窗口实现时决定是否加监督）；
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
