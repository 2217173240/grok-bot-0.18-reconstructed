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
| Claude CLI 原生工具 | 把工具名加入 CLI 工具清单 | `source/host/extensions/inference/provider-session.ts` 的 `CLAUDE_LOCAL_TOOLS` |
| Claude CLI 原生工具 | 为只读分类与权限判断增加相应规则 | 同文件的 `CLAUDE_READ_ONLY_TOOLS`、`claudeToolPermission` |

本地生产 host、provider 和 CLI 均在 Docker 容器执行。Mac coordinator 负责连接和命令传递；preload 只在工具需要新的界面 IPC 时增加接口。Grok host 工具由生产工具集装配，Claude 通过每回合 MCP bridge 获得这些工具；CLI 原生工具仍由单独的工具名与权限集合控制。

新增工具时需要验证其所属工具来源、权限与子代理范围，以及 provider 调用后的 transcript 结果。增加 Grok host 工具通常使用现有装配入口；增加 Claude CLI 原生工具还需要同步其名称和权限规则。

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

当前最多四个活动窗口，环境变量只能降低配额。增加容量需要同时修改 `SAND_BOX_MAX_WINDOWS`、容器 4 GiB 内存预算和镜像窗口服务，并验证资源释放与访问凭证生命周期。

## 插件 MCP 工具

stdio 插件服务器由容器 daemon 托管：`source/box-exec-daemon/mcp-host.ts` 用官方 SDK 启动配置里的每个服务器，盒内
轮次通过 `source/shared/node/mcp/routed-mcp-bridge.ts` 的回环桥把工具交给 CLI 子进程，插件清单位于
`/home/box/sand-data/mcp-config/shared/mcp-servers.json`（Mac 数据根 `mcp-config/shared/` 目录的只读绑定）。local-admin 下 HTTP 服务器也由容器内的官方 MCP SDK 直接连接；远程账号模式保留 backend 路由。

| 要做的事 | 位置 |
| --- | --- |
| 改动插件服务器的托管方式 | `source/box-exec-daemon/mcp-host.ts` 的 `BoxMcpHost` |
| 改动工具面与 CLI 之间的桥 | `source/shared/node/mcp/routed-mcp-bridge.ts` |
| 改动工具面的来源 | `source/host/host-runner-composition.ts` 注入的 `listTools` 与 `executeTool` |
| 改动生产回合如何接入 | `source/host/runner/turn-run-shell.ts` 的 `mcpTools`、`source/host/runner-production-bridge.ts` 的 MCP 资源投影与 `provider-session.ts` |
| 改动通用 provider 的工具发现和调用 | `source/host/runner/tools/turn-toolset.ts` 的 `createTurnMcpMetaToolFactory`，提供 `GetMcpTools`、`CallMcpTool` |

`McpArgs` 的字段约定：到达 daemon 时 `name` 是服务器自己的工具名，`toolName` 是调用方使用的标签。新增一个平面时
必须遵守它，否则工具会被判为不存在。

PR #75 的目录只读挂载支持配置原子替换和首次添加插件，可写缓存独立保存。PR #78 将 MCP 发现、执行、状态与审批资源接入通用 provider 生产工具集；PR #81 保留 host MCP 错误的完整文本。

隔离 Codex `gpt-6-astra` 已经通过生产工具装配调用官方 SDK MCP fixture，`GetMcpTools` 与 `CallMcpTool` 各执行一次，transcript 包含两次调用与两次结果，最终回答返回成功 nonce。该验证使用只读 auth 挂载，完整 Codex UI 与 host 初始化仍未覆盖。
