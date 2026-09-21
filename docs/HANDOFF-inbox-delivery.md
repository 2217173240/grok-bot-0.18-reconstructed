# HANDOFF：盒内轮次的"最后一公里"——assistant 回复投递到 UI

> 交接目的：让下一个执行者（GPT）能在不重新考古的前提下继续修。
> 所有路径均为仓库相对路径（仓库根 = 本文件所在目录的上一级）。
> 行号为写作时刻的近似值，以符号名 grep 为准。

---

## 0. 一句话现状

**这条投递链已经完整贯通**：推理与工具执行跑在 Docker 容器内（三方 Anthropic 兼容 API → Claude CLI，
账本/转录/权限全绿），assistant 回复经投递缝进入 stock 投递管线并出现在 UI 里。

贯通由两处修改共同完成，两处都必须保留：宿主出口的条目形状投影（§5.1）与打包阶段对
renderer 提取器的补丁（§5.2）。缺任何一处，普通消息文字都会在 renderer 里抛出
`TypeError: Cannot read properties of undefined (reading 'matchAll')`，错误边界随即把整个聊天
换成 "Something went wrong"。

---

## 1. 运行拓扑（当前部署事实）

```
┌─ Mac (darwin) ─────────────────────────────────────────────┐
│ Electron App（打包自 dist/，start-local.sh 启动）           │
│  ├─ renderer（聊天 UI）                                     │
│  ├─ node-agent-coordinator（协调器进程）                    │
│  │    └─ inference-router.ts：host-turn 模式下 sendPrompt   │
│  │       不再本地拦截，直接转发给 ↓                          │
│  └─ （Mac 平面 = 退出开关 GROKBOT_TURN=mac，可用已验证）     │
└──────────────┬──────────────────────────────────────────────┘
               │ gateway HTTP (127.0.0.1:1340, Bearer token
               │  = ~/.grokbot-local/local-docker-vm.json 的 token)
┌─ Docker 容器 grok-bot-local-vm（arm64 原生，Colima）────────┐
│ PID1 = node /home/box/sand-host/host-main.cjs（盒内 host）  │
│  ├─ gateway-server.ts（HTTP API + /events SSE）             │
│  ├─ transcript 扩展（会话/投递/事件，本问题的主战场）        │
│  ├─ turn 机器（turn-runtime/turn-run-shell/turn-settle）    │
│  ├─ inference 扩展 → provider-session.ts claudeExecutor     │
│  │     └─ spawn Claude CLI（CLAUDE_CODE_PATH 指向 SDK 自带  │
│  │        cli.js；ANTHROPIC_BASE_URL=bigmodel；token 只读   │
│  │        挂载于 /home/box/sand-data/anthropic-token）      │
│  └─ box-exec-daemon(1337)/桌面面(5900/6080/6081/1339)       │
└──────────────────────────────────────────────────────────────┘
```

关键 env（容器 PID1，由 run plan 注入，见 `source/electron-main/box/local-docker-host-connector.ts`）：
- `SAND_LOCAL_ADMIN=1`、`SAND_HOST_IN_BOX=1`、`CLAUDE_CODE_PATH`、`ANTHROPIC_BASE_URL`、`SAND_CLAUDE_MODEL`
- `SAND_FEATURE_GATE_OVERRIDES=sand_new_transcript_journal=0,sand_action_audit_logs=0,sand_auto_review=0,sand_agent_network=0`
  （journal 必须钉 0：stock 首 checkpoint 无 recover 播种、必崩，见 §6-G1；
   **notify_bus / send_message_delivery_owed 绝不能钉**：它们承载 UI 事件流，钉了 UI 全盲，实测教训）
- schema version = 18（drift 检测维度：schema/hostSha/depsPin/desktop/hostTurn label）

启动/运维：`start-local.sh`（start/stop/status/restart；默认盒内平面，`GROKBOT_TURN=mac` 退出；
`GROKBOT_DESKTOP=0` 无头）。容器创建时把 Mac 的 inferenceProvider 强制合并进卷内 settings.json。

---

## 2. 一轮对话的完整调用链（盒内平面）

按调用顺序，符号@文件:行（行号近似）：

1. **UI 发送** → renderer → coordinator `dispatch("sendPrompt", args)`
   - 转发判定：`source/node-agent-coordinator/inference-router.ts` 的 `dispatch()`
     （`hostTurnModeEnabled()` → `{handled:false}` → 走远端）
2. **网关接收**：`source/host/gateway-server.ts` `routeCommand()`
   - 命令表：`source/host/gateway-protocol.ts` `SAND_GATEWAY_COMMANDS.sendPrompt`
   - API 形状：`source/host/host-gateway-api.ts:184` `sendPrompt(args)`
     （`args.agentId` 缺省取 active agent；`args.prompt`）
3. **转录扩展接手** → `source/host/extensions/transcript/send-turn-dispatch.ts:153`
   `tm.turnRuntime.runTurn(session, runner, prompt, {...})`
   - 用户消息入活会话：session append → roster emit（**这条路径工作正常**——SSE 能看到
     `"channel":"transcript","type":"appended","role":"user"`）
4. **turn 机器**：`source/host/extensions/transcript/turn-runtime.ts`
   - `runTurn()`（≈line 330）：调 `runner.run(prompt, …)`（line 427）
   - **runner 是谁**：`source/host/sand-host.ts:172` `buildRunner: options => new SandAgentRunner(options)`
     （**无包装**，直接实例）；`source/host/host-runner-composition.ts:2604` `deps.buildRunner(runnerOptions)`
   - **关键委托**：`source/host/runner/sand-agent-runner.ts:1214` 附近
     `if (this.#productionTurnRunShell !== undefined) return this.#productionTurnRunShell.run(...)`
     —— 生产形态下 SandAgentRunner 自身的 `#activeRun/emitUpdate/文本累积` **全部不执行**，
     真正的状态在 shell 适配器链里（这是 seam v1 失效的原因）
   - shell 适配器：`source/host/runner/production-turn-run-shell-adapter.ts:205`
     `createProductionTurnRunShellAdapter()`（update 中继、collectText 回调）
   - 真正的 turn 驱动与结算：`source/host/runner/turn-run-shell.ts` +
     `source/host/runner/turn-settle.ts:133` `createTurnSettle()`（collectors：collectText /
     collectSendMessage / collectReaction / collectAgentMessage；**TurnSettleResult 带 `text: string`**）
5. **推理执行**：turn 机器经 inference 扩展拿 executor
   - `source/host/extensions/inference/cursor-session.ts:115`
     `routedProvider !== "cursor"` → `createProviderPromptSession(routedProvider)`
   - `source/host/extensions/inference/provider-session.ts:427` `ProviderPromptExecutor`
     （**line 429-434：stream(_ctx, id, _definitions) 刻意丢弃 shell 传入的工具定义**，
     注释自称 "Host-owned sessions are text-only"——Mac 时代的事实，如今是断链点）
   - `provider-session.ts:345` `claudeExecutor()`：硬编码 `tools:[...CLAUDE_LOCAL_TOOLS]`
     （Bash/Read/Write/Edit/MultiEdit/Glob/Grep/LS/WebFetch/TodoWrite，line 246）
     + `canUseTool → claudeToolPermission`（line 265；SAND_LOCAL_ADMIN=1 时放行）
     + `cwd: resolveAgentWorkspace()`（= /workspace）+ `maxTurns: 24`
   - CLI 子进程跑模型与本地工具（**已验证工作**：账本 `local-intercept.jsonl` 记录
     request/permission-allowed/result，uname 等真实输出）
6. **turn 结算与投递判定**：回到 `turn-runtime.ts`
   - `runWithReplyNudges()`（≈line 536）：`isDeliveryOwed(result)`（line 177：
     `sentMessageCount===0 && !reacted`）为真则进入 nudge 循环
     （REPLY_NUDGE_PROMPT / CLOSING_SEND_NUDGE_PROMPT，line 47-49 的提示词明说
     **"Plain assistant text is NEVER shown to the user; only a real SendMessage tool
     invocation reaches them"**）
   - 空投递上报：`reportTurnEmptyDelivery`（line 458）

---

## 3. 投递管线（stock 设计，工作正常——只要有人调用 SendMessage）

`source/host/extensions/transcript/turn-runtime.ts:717` `case "send-message":`
→ `sendPipeline.validateAiReplyTarget` → `createSendMessageEntry` →
`this.tm.sendPipeline.appendSendMessageEntry(entry)`（line 765）→
`runSession.db.appendTranscriptEntry(entry)`（line 773）→ `roster.emitAgentUpdate` →
sand-host `wireEvents()`（`source/host/sand-host.ts:891`）→ SSE `"channel":"transcript"` →
Mac coordinator 中继 → renderer 渲染。

SendMessage 工具的定义在 `source/host/runner/tools/send-message-tool.ts`
（工具名常量 `source/host/runner/send-message-reminder-middleware.ts:1` `SAND_SEND_MESSAGE_TOOL_NAME="SendMessage"`）。
**这套工具属于 turn 机器的工具面（cursor 后端协议），从未到达 claudeExecutor 的 CLI 工具清单**——见 §4。

---

## 4. 根因（实证链）

**现象**：turn 完整执行（账本有工具调用与真实输出、镜像 jsonl 有 assistant 全文、
listAgents 健康、journal 错误 0），UI 卡"正在执行"后无任何回复。

**证据**：
1. 活会话库只有用户条目：`/home/box/sand-data/agents/<id>/store.db` 的
   `transcript_entries` 表 = 1 行（user）。assistant 全文只存在于
   `/home/box/sand-data/agent-transcripts/<id>/<id>.jsonl`（镜像文件，UI 不读它）。
2. SSE（`GET /events`）只推 user appended + agent-upserted（活动心跳）；零 assistant 事件。
3. stock 语义（§2 第 6 步的提示词原文）：普通文本永不展示，投递只认 SendMessage 工具调用。
4. claudeExecutor 的 CLI 工具清单没有 SendMessage（也从未收到 shell 的工具定义，
   `ProviderPromptExecutor.stream` 丢弃 `_definitions`）→ 模型**没有能力投递**。
5. nudge 循环于是永远失败（模型没有该工具，nudge 只是浪费轮次）。

**推论**：任何"让 turn 跑得更好"的修补都不解决显示；必须让 assistant 内容进入
`case "send-message"` 分支（§3），或者让模型真的拿到并调用 SendMessage。

---

## 5. 已实现的修复

### 5.1 宿主出口的条目形状投影

renderer 是固定不变的 0.18 产物，它读普通消息文字的位置是 `entry.text`，而宿主把同一份文字存成
`content`（`send-message-shaping.ts` 写入 `content`，`quotableEntryText` 也读 `content`）。
`source/host/extensions/transcript/renderer-entry-shape.ts` 在条目离开宿主时补上 renderer 需要的
拼写，同时保留 `content`，因此宿主内部的读取者和磁盘上已有的条目都不受影响。

接入的两个出口：

- 读取面：`source/host/host-gateway-api.ts` 的 `getAgentTranscript`、`getAgentTranscriptPage`、
  `getAgentTranscriptWindow`、`getAgentTranscriptTail`、`getAgentThread`，以及 `openAgent` 返回的
  `switchAgent` 结果。
- 实时面：`source/host/extensions/transcript/roster-projection.ts` 的 `emit()`，所有
  `{type:"appended", entry}` 与 `{type:"snapshot", entries}` 事件都经过它。

投递缝本身也要给出 renderer 认得的拼写：

- `source/host/extensions/transcript/turn-runtime.ts` 的 `deliverUndeliveredText(result)` 读
  `TurnSettleResult.text`，在 nudge 循环之前与之后各检查一次，合成
  `{type:"send-message", message:{type:"text", content}}` 交给 `handleAgentUpdate`。

### 5.2 打包阶段对 renderer 提取器的补丁

固定不变的 renderer 产物的文字提取器读 `content`，同一个产物自己的转录投影
（`frontend/src/production/model.ts` 的 `projectTranscriptEntry`）却写出 `text`。一份普通消息
因此让提取器把 `undefined` 交给 `String.prototype.matchAll`，错误边界替换整个聊天界面。

`scripts/lib/router-renderer-patch.mjs` 新增 `patchOriginalEntryTextExtractor`，沿用该文件已有的
`replaceExactlyOnce` 方式，在打包阶段改写 fidelity 展开目录里的提取器：

- `A_n`：普通消息读 `content??text??""`，`send-message` 读 `message.content??message.text??""`，
  `notice` 读 `text??""`。
- `Fpt`：扫描之前先确认接收到的值是字符串。

补丁点位于 `buildFidelityReconstructedAsar`（`scripts/clean-build.mjs`），与
`applyOriginalRendererRouterPatch` 同一阶段，因此修改 `frontend/src` 或
`src/app/dist/renderer` 都不会改变发货内容。

### 5.3 端到端判据

盒内会话库出现 `kind:"send-message"` 且 `message.content` 非空的条目，UI 同时渲染出该回复；
网关 `getAgentTranscriptTail` 返回的普通消息条目同时带 `text` 与 `content`。回退判据是 UI 出现
"Something went wrong"。验证步骤见 §7。

### 5.4 另一个已验证可用的形态（对照基准）

Mac 平面（`GROKBOT_TURN=mac`）：router 在 Mac 侧跑 claudeExecutor 并**自行 append 转录**
（`source/node-agent-coordinator/inference-router.ts` 的 append/emitTranscript），
UI 一切正常。盒内投递缝的目标就是复刻这个语义。

---

## 6. 雷区清单（每条都是实测踩过的，勿重复踩）

- **G1 journal**：`sand_new_transcript_journal` 打开时，全新对话首个 checkpoint 必崩
  （`TranscriptJournalCorruptionError: transcript checkpoint must recover before preparing`；
  `source/host/transcript-mirror/transcript-mirror.ts` prepareCheckpoint 首检 + recover 无调用者）。
  数据卷里的 statsig bootstrap（`/home/box/sand-data/sand-statsig-bootstrap.json`，2897 个哈希 gate，
  每分钟自刷新）把它拨成 ON。**必须用 env 钉 0**；override 文件会被桌面 settings 同步整表清空，不可靠。
- **G2 UI 事件 gate**：`sand_notify_bus` / `sand_send_message_delivery_owed` 承载 UI 事件流，
  钉 0 = renderer 全盲（turn 照跑）。**不要钉**。
- **G3 staging 整树**：host 运行时按 argv[1] 相对找兄弟工件
  （`agent-isolation/*.cjs`、`extensions/*/*.cjs`）。staging 必须整棵树 + 目录挂载
  （layout v3；`source/electron-main/box/local-docker-host-connector.ts` `stageCurrentHostBundle`）。
- **G4 provider 种子**：盒内无 settings.json 时 provider 默认 cursor → 撞封锁后端。
  创建容器时强制合并 Mac 的 provider 进卷（connector 的 seed 逻辑）。
- **G5 权限**：盒内必须有 `SAND_LOCAL_ADMIN=1`，否则 claudeToolPermission 拒一切非只读工具。
- **G6 合成 turn 陷阱**：直接 `POST /api/sendPrompt {"prompt":...}`（无完整 args）会**静默死在半路**
  （accepted 但无回复、无 settle）——不要用它做验证；另注意 active agent 若已被
  `.journal-mode` marker 毒化（agent-transcripts/<id>/ 下），行为会混入 journal 崩溃。
- **G7 drift**：纯 env 变更不触发容器重建，必须 bump `LOCAL_DOCKER_SCHEMA_VERSION` 或加 label。
  宿主 bundle 内容变化会改变 `hostSha256` label，连接器随即重建容器；只改 renderer 不改容器。
- **G8 管道吞错**：shell 里 `cmd | tail` 会吃退出码；打包失败曾被管道掩盖。用独立变量存 `$?`。
- **G9 renderer 产物分层**：发货的 renderer 是 `buildFidelityReconstructedAsar` 在 fidelity 展开目录里
  构造并打补丁的结果（`scripts/clean-build.mjs`）。修改 `frontend/src`（从产物反推的可读副本）或
  `src/app/dist/renderer`（固定不变的基线产物）都不会改变发货内容，renderer 行为只能靠打包阶段补丁修改，
  补丁写在 `scripts/lib/router-renderer-patch.mjs`。
- **G10 条目文字拼写两套并存**：宿主持有 `content`，renderer 的转录投影持有 `text`。任何新增的
  renderer 读取路径都要两种拼写都接受，任何新增的宿主出口都要经过 `renderer-entry-shape.ts` 的投影。
- **G11 `ELECTRON_RUN_AS_NODE=1`**：该变量泄漏进启动 shell 时，`start-local.sh` 会让 Electron 以纯
  Node 模式启动，二进制拒绝 `--user-data-dir` 并立即退出（日志为
  `bad option: --user-data-dir=...`）。同一个变量还会让 `node` 指向 Electron，使
  `npm test` 里的 asar 相关用例假失败（`ENOTEMPTY`）。启动与测试都要在剔除该变量的环境里执行。
- **G12 Colima profile 名称**：本机 profile 是 `finonelib`，`colima status` 不带参数时报告
  "not running"。socket 为 `unix://$HOME/.colima/finonelib/docker.sock`，`start-local.sh` 的 1340
  守卫需要该 socket 可达才会把端口持有者认成电脑的端口转发；否则拒绝启动。

---

## 7. 验证剧本（下一个执行者照此跑）

前置：在剔除 `ELECTRON_RUN_AS_NODE` 的环境里执行 `./start-local.sh restart`
（`env -u ELECTRON_RUN_AS_NODE ./start-local.sh restart`）；
`export DOCKER_HOST="unix:///Users/xinheyun/.colima/finonelib/docker.sock"`（默认 socket 不存在，见 G12）。

1. **发货产物里的补丁**：确认打包后的 renderer 携带提取器补丁——
   `n.status` 无关，直接查 asar：
   `node -e 'const a=require("@electron/asar");const s=a.extractFile("dist/Grok Bot 0.18 Reconstructed.app/Contents/Resources/app.asar","dist/renderer/assets/index-UbX-y3il.js").toString();console.log(s.includes(`content??n.text??""`))'`
   输出 `true` 才继续。
2. **staged 宿主 bundle 是否含投递缝**：
   `HM=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/home/box/sand-host"}}{{.Source}}{{end}}{{end}}' grok-bot-local-vm)`
   然后 `grep -c deliverUndeliveredText "$HM/host-main.cjs"` 与
   `grep -c projectTranscriptPayloadForRenderer "$HM/host-main.cjs"`（各自 >0；否则重打包+ditto+重建容器）。
3. **发一条真实探针**（需要人在 UI 里发；合成 RPC 不可用，见 G6）：
   "运行 uname -a 并贴出真实输出 探针X"。
4. **四处对账**：
   - UI：是否出现完整回复（最终判据），并且不出现 "Something went wrong"；
   - 会话库：`docker exec grok-bot-local-vm sh -c 'A=$(ls -t /home/box/sand-data/agents|grep -v active-agent|head -1); sqlite3 /home/box/sand-data/agents/$A/store.db "SELECT COUNT(*),substr(entry,1,80) FROM transcript_entries"'`
     ——期望 ≥2 行且出现 `"kind":"send-message"`；
   - 网关返回的普通消息条目同时带 `text` 与 `content`：
     `curl -s -X POST http://127.0.0.1:1340/api/getAgentTranscriptTail -H "authorization: Bearer <token>" -H "content-type: application/json" -d '{"id":"<agentId>","limit":20}'`；
   - 盒日志：`docker logs --since 300s grok-bot-local-vm 2>&1 | grep -v privacy | grep -iE "error|failed"` 为空。
5. **SSE 侧证**（可选）：发探针前起 `curl -sN --max-time 120 http://127.0.0.1:1340/events -H "authorization: Bearer <token>"`，
   期望出现 `"channel":"transcript"` 且 entry 含 assistant 内容。

自动化回归：`tests/renderer-entry-text-patch.test.mjs` 验证 renderer 补丁，
`tests/renderer-entry-shape.test.mjs` 验证宿主投影，两者都用真实条目形状断言。

---

## 8. 未采用的修复路线

若日后要让盒内模型真正持有并调用 SendMessage 工具，需要让 claudeExecutor 说 turn 机器的流式工具调用协议——
executor 的 fullStream 产出 tool-call parts，runner 经 shell 工具注册表执行（含 SendMessage），
结果回灌继续。改动面：`provider-session.ts`（接收 `_definitions` 并以 SDK 的 MCP 机制
（`mcpServers` + `mcp__server__tool` 模式，参考 `source/node-agent-coordinator/routed-mcp-bridge.ts`
的桥实现）把工具暴露给 CLI）、工具名映射（nudge 逻辑按裸名 "SendMessage" 计数，
MCP 化名字 `mcp__x__SendMessage` 不被 `hasSendMessageCall` 识别，需要一并调整判定）。
这条路线成功后，§5.1 的投递缝可以只作为兜底保留。

---

## 9. 相关文件速查（全相对路径）

- 启动/运维：`start-local.sh`；镜像 `docker/arm64-exec-box.Dockerfile`；
  盒内脚本 `docker/bin/box-init-exec`、`docker/bin/box-navigate`、`docker/bin/xtest-input-local.py`；
  构建 `docker/build-arm64-box.sh`；门禁 `docker/container-gates.sh`
- 连接器/run plan/staging/种子：`source/electron-main/box/local-docker-host-connector.ts`
- Mac 侧轮次路由（对照基准）：`source/node-agent-coordinator/inference-router.ts`
- 网关：`source/host/gateway-server.ts`、`source/host/gateway-protocol.ts`、`source/host/host-gateway-api.ts`
- turn 机器：`source/host/extensions/transcript/{send-turn-dispatch,turn-runtime,send-pipeline,session-runtime,send-message-shaping}.ts`；
  `source/host/runner/{sand-agent-runner,production-turn-run-shell-adapter,turn-run-shell,turn-settle,send-message-reminder-middleware}.ts`
- 推理执行：`source/host/extensions/inference/{cursor-session,provider-session}.ts`
- 工具：`source/host/runner/tools/send-message-tool.ts`（SendMessage 定义）
- 转录镜像（journal/legacy）：`source/host/transcript-mirror/*.ts`
- 实验开关：`source/shared/node/experiments/{cursor-experiments,experiment-config.gen,feature-flag-overrides}.ts`
- 权限/身份：`source/shared/node/local-admin.ts`、`provider-session.ts` 的 claudeToolPermission/身份提示词
- 条目形状投影：`source/host/extensions/transcript/renderer-entry-shape.ts`
- renderer 打包补丁：`scripts/lib/router-renderer-patch.mjs`、`scripts/clean-build.mjs` 的 `buildFidelityReconstructedAsar`
- 前端转录投影（发货产物的对应源码）：`frontend/src/production/model.ts` 的 `projectTranscriptEntry`
- 测试：`tests/local-admin.test.mjs`、`tests/publication-packaging.test.mjs`（改行为请同步锚定）、
  `tests/renderer-entry-text-patch.test.mjs`、`tests/renderer-entry-shape.test.mjs`

## 10. 未决清单（非本问题，排队中）

- 桌面 resync 的账号作用域推送不再触发宿主的 `clearAccountScope()`（该函数会删除 `localToolPermission`、
  `computerUseModel` 等设置并清空三张 MCP 表）；真正的账号离开仍走显式清空路径
- `1339` 路由器与 session-sync 已有桌面 profile 门禁的 D5 存活性探针；两者没有监督者，死亡后需重建容器
- `docs/LEARNING-PYRAMID.*`、`docs/DEPLOY-HANDBOOK.md` 未跟踪文件归档决定
- S-9 毕业验收（封锁 golden path，含"盒内全新会话全流程"门禁）、S-10 收尾
