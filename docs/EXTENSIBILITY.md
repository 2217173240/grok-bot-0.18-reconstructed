# 扩展点核对（S-9）

新增一个 provider、一个工具、一块屏各自需要改哪些文件。判断标准是改动是否位于已有的注册点或数据源上；若某处需要改动核心逻辑，说明该扩展点还没有收敛。

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

需要留意的是 `D1 取舍` 里记录的 `sand-model-experiment.ts` 与用量记账：它们按 provider 名查表，新增 provider 会得到空用量记录而不是报错。

判定：**边缘扩展**。改动集中在「清单 + 一个执行器文件 + 两处查表」。

## 加一个工具

| 平面 | 要做的事 | 位置 |
| --- | --- | --- |
| Mac 协调器轮次 | 把工具加进工具集 | `source/host/runner/tools/turn-toolset.ts` 的工具装配 |
| Mac 协调器轮次 | 让 preload 与 shell 都暴露它 | `source/electron-preload/preload.ts` 的注入清单 |
| 盒内轮次 | 把工具名加进本地工具清单 | `source/host/extensions/inference/provider-session.ts` 的 `CLAUDE_LOCAL_TOOLS` |
| 盒内轮次 | 只读工具需要加进只读集合 | 同文件的 `CLAUDE_READ_ONLY_TOOLS` |
| 盒内轮次 | 权限判定需要认识它 | 同文件的 `claudeToolPermission` |

盒内轮次这条路径有两个必须同步的清单：`CLAUDE_LOCAL_TOOLS` 是硬编码的工具名数组，权限层按名字判定。SendMessage 投递曾经失效正是因为这条清单与 turn 机器的工具面没有共享数据源，模型拿不到投递工具；`docs/HANDOFF-inbox-delivery.md` 记录了完整证据链。

判定：**边缘扩展，但有两个必须同步的清单**。把一个工具同时暴露给两个平面需要改两处；这与投递缺陷同源，属于已登记的架构缺口（`SAND_LOCAL_ADMIN_TURN` 两平面共用工具面尚未收敛）。

## 加一块屏

| 要做的事 | 位置 |
| --- | --- |
| 端口常量 | `source/packages/constants/sand-box.ts` 的 `SAND_BOX_PRIMARY_NOVNC_PORT` / `SAND_BOX_FORK_NOVNC_PORT` |
| 显示号与 owner token 协议 | `source/host/box/box-windows.ts` 的 `sandBoxDisplayToken`、`SAND_BOX_DISPLAY_HEADER`、`SAND_BOX_WINDOW_OWNER_HEADER` |
| 窗口启停原语 | 同文件的 `runStartWindow` / `runStopWindow`，调用镜像内的 `start-window` / `stop-window` |
| 屏内 web 入口 | `docker/bin/box-init-exec`（主屏 6080、副屏 6081、路由器 1339） |
| 每屏浏览器 | 镜像内的 `box-chrome`，按 `DISPLAY` 派生 profile 与 CDP 端口（9222+N） |
| 内存预算 | `source/electron-main/box/local-docker-host-connector.ts` 的内存上限（每只 Chromium 约 800MB，桌面档 4g） |

`box-windows.ts` 里明确记载了一条协议约束：镜像内的 fork 路由器与 websockify TokenFile 按显示号取键，因此显示凭证必须保持 `String(windowIndex)`。任何盒内进程都能按号码访问任意显示，这与已退役的 exec-daemon 默认令牌属于同一类问题；每窗口的 owner token 是当前可控的强凭证。真正的修法需要自建镜像，参考 `docs/ARCHIVE-ASSETS.md` 的 noVNC 鉴权条目。

判定：**边缘扩展**。三个屏以上需要在镜像内增加 fork 与端口，并复核 4g 上限；宿主侧没有核心改动。

## 插件 MCP 工具

stdio 插件服务器由本地计算机托管：`source/box-exec-daemon/mcp-host.ts` 用官方 SDK 启动配置里的每个服务器，盒内
轮次通过 `source/shared/node/mcp/routed-mcp-bridge.ts` 的回环桥把工具交给 CLI 子进程，插件清单位于
`/home/box/sand-data/plugins/mcp-servers.json`（Mac 数据根 `plugins/` 目录的只读绑定）。local-admin 下 HTTP 服务器也由容器内的官方 MCP SDK 直接连接；远程账号模式保留 backend 路由。

| 要做的事 | 位置 |
| --- | --- |
| 改动插件服务器的托管方式 | `source/box-exec-daemon/mcp-host.ts` 的 `BoxMcpHost` |
| 改动工具面与 CLI 之间的桥 | `source/shared/node/mcp/routed-mcp-bridge.ts` |
| 改动工具面的来源 | `source/host/host-runner-composition.ts` 注入的 `listTools` 与 `executeTool` |
| 改动盒内轮次如何接入 | `source/host/runner/turn-run-shell.ts` 的 `mcpTools` 与 `provider-session.ts` 的 `claudeExecutor` |

`McpArgs` 的字段约定：到达 daemon 时 `name` 是服务器自己的工具名，`toolName` 是调用方使用的标签。新增一个平面时
必须遵守它，否则工具会被判为不存在。

## 结论

三处扩展位于已有的注册点或数据源上，没有出现必须改动核心逻辑的情况。需要留意的缺口已经登记：盒内轮次的工具清单
与 turn 机器的工具面没有共享数据源；多屏的显示凭证按显示号取键，强度不足；插件 MCP 工具的面较宽，改动它需要同时
触碰 daemon、宿主与桥三处。
