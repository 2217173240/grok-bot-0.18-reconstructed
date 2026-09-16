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

1. `/workspace` 从 named volume 换 bind mount（Colima 共享 `/Users`），`resolveAgentWorkspace()` 与 daemon `workspaceRoot` 收敛到同一目录，Mac 侧可见（Archive `MAC_BOT_WORKSPACE_HOST` 双径回报现成）✅ 2026-09-16 已落地：schema 7、`SAND_WORKSPACE_ROOT`/`SAND_AGENT_WORKSPACE`/`SAND_WORKSPACE_HOST` 三 env 钉同一目录、创建即记 `workspace-bind-mount` 事件 + 状态面双径行；
2. 默认路径缺自建镜像时的 QEMU 回退：记 intercept 事件 + `start-local` 状态面一行标注（保留开箱即用，修复"说的和做的不一致"）✅ 2026-09-16 已落地：`decideDockerImage` 判别选择 + `official-image-qemu-fallback` 账本事件（每进程一次）+ 状态面告警，活体双向验证过；
3. 镜像新鲜度：package-lock + `apply-third-party-patches.mjs` hash 打进 image label，连接器/门禁比对，不符报"跑 `build-arm64-box.sh`"；
4. G3 端到端化：容器内 node 直连 1337 走 ExecService 真 exec（顺带冷启动 <15s 阈值当性能哨兵）✅ 2026-09-16 已落地：`source/box-exec-daemon/smoke.ts`（同传输/Bearer/shellArgs 流）+ `scripts/daemon-smoke.mjs` 编排，G3 锚精确输出；冷启动哨兵原生 arm64 生效（实测 3s）；生产盒直打验证 `pwd=/workspace` 且 daemon 写入即时落到 Mac 侧。

**为什么 A 先于一切**：桌面模式会把文件面 ×4（工作区、截图、下载目录、浏览器 profile）、端口面 ×5 翻进来。先修契约再扩面，否则每条裂缝复制成多条；反过来，A 做完后 B 只是"在好契约上加面"。

**切片 B「桌面模式」**——唤醒睡着的界面：

1. **先做拓扑决定**（其余三件事的地基）：推荐 box-init 出一个 exec 变体——起桌面+路由后台、`exec node host-main.cjs` 当前台（进程收尸归 Docker；避免再造 supervisor）；
2. 端口与 token：6080/6081/1339 publish 到回环；noVNC token 用 Archive `novnc-auth.mjs` 的随机签发（镜像里现成的 TokenFile 机制，**别用显示号**）；
3. Computer 去 stub：XTEST 输入 + 整屏截图（Archive 参考实现）；浏览器侧零改动（`driver-v2.mjs` 自包含）；
4. 契约演进：G4 拆成 exec/desktop 两个门禁 profile（无头纪律保留给 exec 模式）；加资源上限（Archive 实测每只 Chromium ~800MB）。

**切片 C「人机面」**——让浏览器从"能打开"变"能登录"：

1. `request_box_help` 合同 + awaiting_human 状态机（15 分钟服务端超时、闸门先于读请求体、`ask_human` 幂等——Archive 语义照抄）；
2. 敏感字段闸门（fill/select/press 白名单、快照抹值）+ noVNC 接管 URL；
3. session-sync（cookie/localStorage 只补缺 + 重载断路器，多窗口共享登录态）；
4. egress 治理在此刻兑现：凭据进盒、noVNC 暴露后，私网拒绝 + 代理模式才有完整意义（私网拒绝本身便宜，可提前进 A）。

**完成定义**：A = 同一 agent 的所有工具写同一目录、所有回退都有标注、门禁走真执行链；B = Computer 工具在容器里点得动真浏览器、人能在浏览器里看到那块屏；C = agent 遇到登录页会停下来把屏交给人、15 分钟后诚实收回。

## 4. 边界（不变）

- 不并入 Archive 的 `:18765` 窗口服务与 mcp-server（driver 自包含，最小合并集 = box-image + 行为规格）。
- 多屏配额等运行时调参，不做结构性工作。

## 5. 与旧清单的对照（重排了什么）

| 旧条目 | 去向 |
| --- | --- |
| F2 / F1 / F3 / 镜像新鲜度 | 归并为切片 A |
| P1-4 Computer use | 切片 B（新增显性前提：拓扑决定 + G4 profile 化） |
| P1-5 人机交接 | 切片 C（吸收 session-sync） |
| P1-6 egress 独立项 | 拆解：私网拒绝提前进 A，代理模式归 C |
| nightly CI 接线 | 降为 B 的附属（desktop 模式才需要 CI 容器变体） |
| 资源上限 | 归 B（桌面内存预算） |
