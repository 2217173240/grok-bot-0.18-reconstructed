# 扩展点核对（S-9）

本地用户通过 Settings 选择 provider、配置 MCP 插件并使用容器桌面，生产回合装配这些能力，将工具结果写入 transcript；外部操作的授权由用户决定。

引用的路径都以仓库根为起点。

## 加一个 provider

| 要做的事 | 位置 |
| --- | --- |
| 把 provider 名加入清单 | `source/shared/inference-router.ts` 的 `SAND_INFERENCE_PROVIDERS` |
| 新增执行器 | `source/host/extensions/inference/` 下新增一个文件，形态参照 `codex-direct-responses.ts` |
| 在执行分派里接上 | `source/host/extensions/inference/provider-session.ts` 的 `run()` 分派段与模型解析段 |
| 补模型映射 | `start-local.sh` 的 `ANTHROPIC_*` 环境变量组（仅本地默认路线需要） |
| 让设置面板列出它 | `scripts/lib/router-renderer-patch.mjs` 的 `RRouterProviders` |

`SAND_INFERENCE_PROVIDERS` 是单一数据源：`SandInferenceProvider` 类型、`isSandInferenceProvider` 校验、`SandInferenceRouterUsage.providers` 的键集合都由它推导，因此新增一个名字不需要改动这三处。

`sand-model-experiment.ts` 与用量记账按 provider 名查表，新增 provider 时也需要核对对应模型信息和用量字段。

判定：**边缘扩展**。改动集中在「清单 + 一个执行器文件 + 两处查表」。

## 加一个工具

| 工具来源 | 要做的事 | 位置 |
| --- | --- | --- |
| Grok host 工具 | 把工具加进生产工具集并提供依赖 | `source/host/runner/tools/turn-toolset.ts`、`source/host/runner-production-bridge.ts` |
| Grok host 工具 | 将定义与执行器交给 provider | `source/host/extensions/inference/provider-session.ts` 的 host tools 转换与 `createHostToolsMcpBridge` |
| Grok host 工具 | 核对分类、审批、取消与执行结果 | 对应工具 factory、`auto-review-gate.ts` 与 `tool-stream-executor.ts` |

本地生产 host、provider 和 CLI 均在 Docker 容器执行。Mac coordinator 负责连接和命令传递；preload 只在工具需要新的界面 IPC 时增加接口。Grok host 工具由生产工具集装配，Claude 通过每回合 MCP bridge 获得当前可见工具。工具执行统一使用 host 的权限、审批和结果记录。

新增工具时需要验证权限、子代理范围，以及 provider 调用后的 transcript 结果。文件修改与搜索使用 Shell，图片与文本读取使用 Read；本地网页操作使用 Shell 或 Computer/Browser。`WebFetch/WebSearch` 的官方 backend 实现仅对远程模式开放。

## 加一块屏

| 要做的事 | 位置 |
| --- | --- |
| 端口常量 | `source/packages/constants/sand-box.ts` 的 `SAND_BOX_PRIMARY_NOVNC_PORT` / `SAND_BOX_FORK_NOVNC_PORT` |
| 显示号、窗口归属与资源配额 | `source/host/box/box-windows.ts` 的 `sandBoxDisplayToken`、owner token、`SAND_BOX_MAX_WINDOWS` |
| 窗口启停原语 | 同文件的 `runStartWindow` / `runStopWindow`，调用镜像内的 `start-window` / `stop-window` |
| 屏内 web 入口 | `docker/bin/box-init-exec`（主屏 6080、副屏 6081、路由器 1339） |
| 每屏浏览器 | 镜像内的 `box-chrome`，按 `DISPLAY` 派生 profile 与 CDP 端口（9222+N） |
| 内存预算 | `source/electron-main/box/local-docker-host-connector.ts` 的内存上限（每只 Chromium 约 800MB，桌面档 4g） |

`sandBoxDisplayToken` 返回显示路由编号；noVNC 使用单独签发的随机访问凭证。`runStartWindow` 校验 owner token、串行处理窗口启停、撤销旧访问凭证，并在容器中生成 32 字节随机 TokenFile 条目。窗口停止时撤销访问，重复启动保持窗口归属检查。随机凭证、旧凭证撤销和正确/错误凭证的 WebSocket 握手均有真实容器验证。

镜像窗口服务最多允许四个活动窗口，环境变量只能降低配额。当前本地 standalone host 使用主屏，`createStandaloneProductionBoxInner` 返回 `maxWindows: 1`；启用多屏还需要接入 host 的窗口分配与释放。增加镜像容量需要同时修改 `SAND_BOX_MAX_WINDOWS`、容器 4 GiB 内存预算和镜像窗口服务，并验证资源释放与访问凭证生命周期。

## 插件 MCP 工具

stdio 插件服务器由容器 daemon 托管：`source/box-exec-daemon/mcp-host.ts` 用官方 SDK 启动配置里的每个服务器。生产回合通过 `GetMcpTools/CallMcpTool` 和现有 MCP executor 调用服务；Claude 使用每回合的 host tools bridge。插件清单位于
`/home/box/sand-data/mcp-config/shared/mcp-servers.json`（Mac 数据根 `mcp-config/shared/` 目录的只读绑定）。local-admin 下 HTTP 服务器也由容器内的官方 MCP SDK 直接连接；远程账号模式保留 backend 路由。

| 要做的事 | 位置 |
| --- | --- |
| 改动插件服务器的托管方式 | `source/box-exec-daemon/mcp-host.ts` 的 `BoxMcpHost` |
| 改动工具面与 Claude CLI 之间的桥 | `source/host/extensions/inference/host-tools-mcp-bridge.ts` |
| 改动工具与执行资源的来源 | `source/host/host-runner-composition.ts` 的 `createProductionMcpToolInputs` 和 `createProductionMcpForTurn` |
| 改动生产回合如何接入 | `source/host/runner/turn-run-shell.ts` 的 `mcpTools`、`source/host/runner-production-bridge.ts` 的 MCP 资源投影与 `provider-session.ts` |
| 改动通用 provider 的工具发现和调用 | `source/host/runner/tools/turn-toolset.ts` 的 `createTurnMcpMetaToolFactory`，提供 `GetMcpTools`、`CallMcpTool` |

`McpArgs.name` 到达 daemon 时必须是服务器工具名。通用生产工具的 `toolName` 同样保留服务器工具名，供禁用工具规则检查；原始组合名称保存在 ToolCall 记录。CLI 桥在自己的调用边界完成名称转换。新增调用入口需要同时验证执行名称、禁用规则与转录标签。

PR #75 的目录只读挂载支持配置原子替换和首次添加插件，可写缓存独立保存。PR #78 将 MCP 发现、执行、状态与审批资源接入通用 provider 生产工具集；PR #81 保留 host MCP 错误的完整文本。

隔离 Codex `gpt-6-astra` 已经通过生产工具装配调用官方 SDK MCP fixture，`GetMcpTools` 与 `CallMcpTool` 各执行一次，transcript 包含两次调用与两次结果，最终回答返回成功 nonce。该验证使用只读 auth 挂载，完整 Codex UI 与 host 初始化仍未覆盖。

## 本地动作审查

Settings 开启 Auto-review 时，本地模式使用 enforce。`local-provider-classifier.ts` 将动作、用户请求和权限规则交给当前 Router provider；每次分类创建独立的无工具文本会话。有效 `BLOCK` 结果进入现有审批卡；分类失败、未知结果、超限输出与取消均阻止动作。Computer/Browser 在允许或人工批准后仍复核页面状态。

本地 executor 的执行策略为单次请求、最长 120 秒；超时取消底层请求。历史文字按现有 32k 上限处理，当前动作、参数与权限规则完整保留。用户拒绝、取消、失效及设置变化分别返回对应结果，等待新的用户指示。文字、图片和工具结果统一通过 host 回合处理；用户可见回复通过 SendMessage 交付。

新增审查对象时复用 `SmartModeRiskTarget`、现有 controller 和对应工具的执行前检查。自然语言规则由模型解释，分类器提示规定 block 优先；严格 JSON 校验负责拒绝不符合格式的结果。真实模型验证与工具执行验证分别记录在维护计划中。
