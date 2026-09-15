# Archive 资产同步简报（2026-09-15）

> 写给本仓库 local-admin 开发线。来源：`/Users/xinheyun/Desktop/grok-compare/Archive`（2026-08-14/15 的独立黑盒仿写，**早于本重建仓库出现**，作者靠三路 bot 交叉核对 + 容器内实测逆向了真机 box），完整对照分析见 `/Users/xinheyun/Desktop/grok-compare/分析-Archive-vs-bot-0.18.md`。
>
> 可信度背书：Archive 的《确定-计算环境-*》观察文档已被本仓库源码逐项交叉验证——CDP 9222+N（`BOX_CDP_PORT_BASE`）、VNC 5900+N、noVNC 6080/6081 + websockify TokenFile `/tmp/sand-novnc-tokens.d`（我们自己的会话 msg138 也见到此目录）、`x-sand-display`/`x-sand-window-owner` 请求头、1337/1339/1340 端口职责、box-chrome 启动器强制——全部命中。

> **状态注记（开发会话，2026-09-15）**：④③① 批次已提交并合并（PR #4，`57df4fa`，活体验证通过：daemon 用真实令牌、`"local"` 被拒 401）。"artifact-fallback 吞改动"的 blocker 已解——真因是 `.cache` 运行时缓存被误删导致打包**静默失败**、旧 dist 照常发货；已落地 `build-stamp.json` 盖戳 + 启动验戳防回归。§1 的 noVNC token 约束已写入 `box-windows.ts` 源码注释。

## 1. 对当前未提交批次（④③①）直接有用

### ④ 的邻接面：noVNC token 也是 fail-open

- 观察值：镜像里 `websockify 0.0.0.0:6081 --token-plugin=TokenFile --token-source=/tmp/sand-novnc-tokens.d`，**token 就是显示号**（文件内容形如 `2: localhost:5902`）。与刚删掉的 exec-daemon 默认令牌 `local` 是同一族问题。
- 现成参考实现：
  - `Archive/box-service/lib/novnc-auth.mjs` — 32 字节随机 token，每次接管重签、旧的即作废，文件 0600，URL 形状仍走 `path=websockify?token=…`（noVNC 1.6.0 静默忽略 `?token=` 参数，实测坑）。
  - `Archive/box-image/bin/sand-window-router.mjs` — `crypto.timingSafeEqual` 前先做**等长垫平**（长度不等时也跑一次恒时比较再返回 false，防长度旁路）；owner token 无文件/空文件一律 fail-closed；`x-sand-display` 缺省或非法当 :1 不报错（照抄观察值行为）。
- 何时需要：6080/6081 目前仅回环 publish，风险低；一旦暴露面扩大或 docker 模式常开，按此硬化。

### 打包 blocker（artifact-fallback 吞 host 改动）的验收原则

- 症结是"测试绿、活体旧"：测试测 `source/host`，活体跑 `dist/recovered-source` 的 artifact。
- Archive 的对应纪律（`Archive/cli/lib/up.js` 的 `runArgs()` + `Archive/tests/lib/run-args.mjs`）：**验收只从交付物派生的单一事实源出发，不手写第二份**——他们曾在 tests 里各自手写 `docker run` 参数，结果"从 Mac 侧复核端口隔离"实际在核对测试自己刚写的三行 `-p`，产品真正走的函数零断言。
- 落地建议：publication/packaging 测试加一条——断言 staged `v2-<sha>/sand-host/host-main.cjs` 包含本批次新引入的标记串（如 `SAND_BOX_EXEC_DAEMON_AUTH_TOKEN` resolver 的报错文本），或哈希等于 `source/host` 新编译产物；artifact-fallback 静默胜出时 CI 直接红，而不是靠事后三 proof 才发现。

## 2. 本会话完全未覆盖、Archive 独有的资产

### 人机交接（awaiting_human）行为规格

- 真机合同（Archive 8/14 观察记录，`Archive/docs/grok_bot/确定-交叉核对-三Bot.md` §2）：工具 `request_box_help`，reason ∈ auth / captcha / payment / other，聊天里出现一条短 instruction + hand back to agent；bot 不该问密码。
- Archive 的服务端实现（`Archive/box-service/server.mjs` + `lib/screens.mjs`）语义值得照抄：
  - 屏级状态机 idle / driving_page / awaiting_human；
  - `ask_human` 幂等（已在接管中不重置计时器，防调用方反复 ask 把屏永久占住）；
  - **15 分钟服务端超时，不依赖 UI、不依赖调用方老实**；
  - awaiting 期间非交接接口一律 `WINDOW_BUSY`，闸门先于参数校验、**先于读请求体**（连"你的 JSON 写错了"都不回）；
  - 进锁后复核闸门：两个并发 act 同时通过入口闸门排进队列，前一个的快照可能已把屏翻转，后一个必须复核（"§7.1 说无条件就不能有这个窗口"）。
- 敏感字段闸门（`server.mjs` handleAct + `lib/snapshot.mjs` isSensitiveRef）：fill/select/press **按动作白名单**在执行前重检节点属性（不信任调用方传来的 ref 语义）；快照里密码/OTP/卡号一律抹值打 `[password]` 标。他们修过"只挡 fill、逐字符 press 敞开"的洞——白名单这条是教训。

### Computer use 参考实现（本地模式目前是 stub）

- 本仓库本地路径 Computer 被 `withNoMonitorComputerUse` 换成抛 `SandBoxNoMonitorAvailableError`（`source/host/ports/box.ts`、`source/host/box/production.ts`）；镜像自带 daemon 才有 fork desktops + 1339。
- Archive 全套容器内控制实现可直接读：`box-image/bin/box-chrome`（CDP 口 9222+N、flock 防并发起同一只、冷启动不自动开浏览器、profile 按屏派生）、`box-service/lib/browser.mjs`（playwright-core `connectOverCDP` + 连接缓存 + 断连清理、`autoStart` 只有 open_url 允许——"看"的操作不带隐藏副作用）、aria snapshot 剥离成 YAML、`lib/desktop-input.mjs` + `xtest-input.py`（XTEST 注入，坐标白名单 1280×800）、整屏截图、`lib/url-guard.mjs`（open_url 目的地闸门：调试口 9222+N / VNC / noVNC / 窗口服务 / 路由器全段拒绝，防调用方绕过 owner token 机制）。

### session-sync 守护

- `Archive/box-image/bin/session-sync.mjs`：整机一份守护，经 CDP Storage 域（cookie 走 browser 端点、localStorage 走页面 target）把登录态同步到各屏，**只补缺不覆盖**（覆盖会把刚轮换的短命登录 cookie 回滚成旧的，反而登出），带每 (display, origin) 重载断路器（RELOAD_CAP=2，防"页面一加载就清 localStorage → 补齐 → 判定从无到有 → 再重载"的 5 秒自激回路）。多窗口/多 bot 共享登录态时用得上，独立模块可原样搬。

## 3. arm64 原生镜像：修订后的定位（不要按旧结论行动）

- 旧结论（commit 0a925d4）"QEMU 起不来"已翻案：root cause 是 daemon 布局 bug，v2 修复后 QEMU 下 21s ready、exec 延迟 70–130ms。
- 换 arm64 自建镜像的真实成本：本地 Docker 模式依赖**镜像自带 daemon**（`/exec-daemon/node`：`sand-window-router.mjs 1339 1337 14000` + websockify noVNC，配合 `SAND_USE_EXISTING_BOX_EXEC_DAEMON=1` + v2 staged bind-mount，二者组合才是 21s 就绪的前提）——Archive 镜像里没有这个 daemon，换镜像 = 重建 daemon + 桌面治理。
- 若将来走自建镜像路线，Archive 的桌面治理脚本是现成起点：
  - `box-image/Dockerfile`：trixie/arm64 全栈，踩坑注释全保留（picom ARGB 黑屏砍合成器、壁纸必须 `_XROOTPMAP_ID` 否则整屏黑、每屏一条 D-Bus 会话总线、C.UTF-8 防 coreutils 八进制转义中文文件名、字体三件套 noto-cjk/liberation/color-emoji——"screenshot 是 agent 的眼睛，字认不出等于眼睛瞎一半"）；
  - `start-desktop.sh`：每屏监督表（组件真 pid 落 JSON，关屏按表精确杀，不信进程名）；
  - `start-window` / `stop-window`：owner token、幂等、token 不是自己时退出码 75 不改绑；
  - `box-chrome`：见上。
- 收益上限：省掉 QEMU 每调用 70–130ms 翻译开销；1.8GB amd64 镜像换更小 arm64 栈。定位：**路线图 backlog，非当前优先**。

## 4. 不建议同步的

- Archive 的 `:18765` 窗口服务 HTTP API：自有重设计，与 Connect RPC（1337/1339）线不兼容，接进来等于养第二套协议。
- Archive 砍掉 exec/shell 的决定（其规格 §7.3）：本仓库的执行面就是主体，不适用。
- Archive 的 MCP server（`Archive/mcp-server/`）：面向"Claude Code 当 client"的独立场景，与本仓库 host 内 MCP 体系平行；其**工具描述文案**（ask_human/awaiting_human 语义教学、TOO_MANY_SCREENS 与 BAD_REQUEST 的错误分类——"参数没错、先腾地方"vs"参数错了、改参数"）值得参考，代码不必搬。

## 5. 观察对齐表（精简版）

| 项 | Archive 观察/实现 | 本仓库源码锚点 |
| --- | --- | --- |
| CDP 口 | 9222+N，仅容器内回环，不 publish | `source/host/runner/tools/sand-browser-tools.ts:22` |
| VNC | 5900+N，一律不 publish，仅容器内探活 | x11vnc 每显示一路（镜像自带） |
| noVNC | 6080 主 / 6081 fork + TokenFile `/tmp/sand-novnc-tokens.d` | `source/packages/constants/sand-box.ts:4-5` |
| 窗口 token | `/tmp/sand-window-tokens.d/N`，start-window 幂等、退出码 75 | `source/host/box/box-windows.ts:23-25`、`/home/box/.sand-window-assignments.json` |
| fork 路由 | 1339，`x-sand-display` + `x-sand-window-owner` | `source/host/box/box-windows.ts:12-14` |
| 执行/网关 | 1337 daemon / 1340 `SAND_HOST_PORT` | `source/box-exec-daemon/server.ts`、gateway 配置 |
| 浏览器启动 | 必须 box-chrome 启动器，class=box-chrome | 系统提示明令 + `box-chrome --sand-prepare` 预热 |

完整对齐表、时间线与逐项分析：`/Users/xinheyun/Desktop/grok-compare/分析-Archive-vs-bot-0.18.md`。

## 6. 必要优化清单（最终版，按必要度排序；已按 PR #4 后状态校准）

前提判断：Archive 有 Linux+桌面+浏览器控制、无 exec；本仓库有 exec（daemon）和自包含的浏览器 driver（`driver-v2.mjs` 上传后经 Shell 工具跑，不依赖常驻服务）；但本地**默认**模式 exec 落在 macOS 本机。"Linux 里面"的价值 = 隔离 + 真 Linux 语义 + 试验场（编译/工具链），目前只有 docker 分支具备——这与 0.18 序列里分量最重的"由假转真"（`77c8a9d` 真实本地工具）是同一条价值线：exec 层就是主体。

**P0 —— 不做则"Linux 试验场"落不了地**

1. **把容器变成默认执行目标**。当前默认 local-admin 模式 host+daemon 跑在 Mac：shell 以用户权限直接打 macOS（无隔离、非 GNU 语义），workspace 落 `box-data/box-workspace`。只有 `SAND_LOCAL_ADMIN_BOX=docker` 分支同时有隔离+桌面。方向：docker 分支转正，Mac-host 降级为无 Docker 环境的 fallback。
2. **arm64 原生自建镜像**（零件三方凑齐：trixie 基础 + Archive 桌面治理脚本 + 本仓库 v2 staged daemon/host）。做法：关掉 `SAND_USE_EXISTING_BOX_EXEC_DAEMON`，让 host 拉起 staged 重建版 daemon（`exec-daemon-process.ts` 已支持该路径）。理由从"延迟优化"升格为**可行性**：QEMU 下 21s ready 只证明服务栈能跑；试验场的核心负载是编译（cargo/go build），模拟下原生代码常见 5–10 倍减速。Archive Dockerfile 第二层的工具链清单（Go/Rust/Python/bun/uv/gh + pkg-config/libssl-dev，照"观察值那台"配的）就是试验场规格，直接可用。
3. **真容器集成测试**：build-stamp 已解决"测试绿、打包旧"（§1 原则的落地）；剩余缺口是"起真容器"这一层——起 arm64 容器跑 exec/浏览器冒烟（Archive `tests/run-gates.sh` + `e2e.mjs` 是骨架参考，含冷启动 G1"此时不应有 Chromium 进程"这类行为门禁）。

> **执行结果（2026-09-15，P0-2 已落地）**：arm64 原生自建镜像已建成并验证——`docker/arm64-exec-box.Dockerfile`（Archive base + 官方 Node 22 arm64 钉版本钉校验和 + linux/arm64 运行时依赖层）。实测：host 在容器内**自拉起**重建版 daemon（无 `SAND_USE_EXISTING_BOX_EXEC_DAEMON`），网关 **3 秒**就绪（QEMU 下 21–25s）。编译基准（hello 级）：

| 负载 | arm64 原生 | QEMU amd64 | 差距 |
|---|---|---|---|
| cargo build | 0.40s | 6.36s | **16×** |
| go build | 1.53s | 5.19s | **3.4×** |
| 网关冷启动 | 3s | 21–25s | **~8×** |

"试验场可行性"论断由预估升格为实测。构建/运行入口：`docker/build-arm64-box.sh`、`docker/run-arm64-box.sh`。遗留：P0-1（docker 转正为默认执行目标）与 P0-3（真容器门禁进 CI）待做；QEMU 对照组因官方镜像工具链版本可能略有差异，倍数量级可信。

**P1 —— 把盒子从"能用"变"可信、完整"**

4. **Computer use 补齐**：自建镜像里 1339 路由 + `start-window`/`stop-window` 用 Archive 现成实现（头语义 `x-sand-display`/`x-sand-window-owner` 与 `box-windows.ts` 一致，timingSafeEqual 等长垫平都写好了）；GUI 级输入参考 `desktop-input.mjs` + `xtest-input.py`（XTEST）。浏览器侧不用动：`driver-v2.mjs` 路线自包含。
5. **人机交接**：`request_box_help` 合同 + awaiting_human 语义（§2 已详）+ noVNC 随机 token（`box-windows.ts` 注释已登记约束，实现时抄 `novnc-auth.mjs`）。登录态进容器后这是必需品，不是加分项。
6. **本地模式出网策略**：远程线有 egress tunnel + 私网目标拒绝；本地 docker 容器目前直连出网、无等价治理。最小做法：私网/保留段拒绝 + `MAC_BOT_PROXY` 代理模式（Archive `up.js` 已解过 DNS 投毒场景，含 NO_PROXY 必须排除回环否则页面驱动连不上自己浏览器的坑）。

**P2 —— 明确不做**

- 不并入 Archive 的 `:18765` 窗口服务和 mcp-server：本仓库 driver 模式自包含，最小合并集 = `box-image`（Dockerfile + bin/ 脚本）+ 行为规格。
- 多屏配额、>4 屏支持等留给运行时调参，不做结构性工作。

