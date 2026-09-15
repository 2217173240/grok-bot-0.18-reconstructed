# Grok Bot 0.18 —— 重建与扩展

**[English](README.md) | 简体中文**

![Grok Bot Router 设置页，已选中 Codex 并显示本地用量汇总](docs/assets/router-settings.png)

本仓库是对公开发布的 Grok Bot 0.18.0 macOS 应用进行的**非官方、面向源码**的重建。

项目起步于理解这款桌面应用如何组装的尝试，如今已包含其 Electron、host、coordinator、
本地执行、协议与 renderer 各边界的可读 TypeScript 实现，以及一套把这些源码重新
组装成可用 macOS 应用的确定性工具链。

项目还加入了若干实用实验：

- 支持 Cursor、Claude Code、Codex 与 OpenRouter 的推理路由器（Router）；
- 让 Grok Bot 的插件/MCP 工具跨路由供应商可用；
- 路由推理的本地用量统计；
- 以本地 Docker 沙箱替代远端 box 的可选方案；以及
- 融入官方打磨 UI 之中的重建设置界面。

这是一个 hacking 与研究项目，不是 Anysphere 的原始 monorepo，也不是官方
Grok Bot 发布。从编译产物推断出的命名与模块边界可能与原始源码不同。

## 完全本地运行（local admin 模式）

`SAND_LOCAL_ADMIN=1` 把每一层后端依赖改写为本地等价物，应用可以**无需
Cursor/xAI 账号、无需官方登录流程、不依赖任何远端返回**地端到端运行。
隔离在代码层强制执行（每个出口点都有守卫），而不是寄希望于网络不可达。

| 层 | 官方应用 | 本地模式 |
|---|---|---|
| 身份 | 经 `authenticator.cursor.sh` 的 Cursor OAuth | 本地 admin 会话；不弹浏览器、不刷新令牌，生产 RPC 一律 fail-closed |
| 电脑 | 租用云虚拟机（`EnsureSandBox`） | 本机 host 进程（`127.0.0.1:1340`），或经 `GROKBOT_BOX=docker` 使用本地 Docker 虚拟机 |
| 推理 | Cursor 后端 | 经本地 Claude Code 会话路由到任意 Anthropic 兼容端点（模型由环境变量决定） |
| 工具 | 路由会话只广播工具却没有执行器（模型只能编造输出） | 真实、受权限门控的本地工具（bash、文件、搜索），最多 8 轮工具往返 |
| 插件 | 经 dashboard OAuth 的市场/目录 | 数据根下的 `mcp-servers.json` —— 标准 `{ mcpServers: { name: { command, args, env } } }` 格式的 stdio/http 服务器，无需账号即可在 UI 中管理 |
| 遥测 / statsig / 凭证签发 | 官方后端 | 跳过或拦截；每次被拦截的尝试都会记录在案 |

实现遵循（并由测试强制）的工程规则：

- **幂等** —— 重复启动复用已落盘的运行时与令牌，settings 仅在缺失时播种，
  网关快路径从不重复拉起进程。
- **生命周期管理** —— host 子进程及其 exec-daemon 在退出时回收；崩溃遗留的
  孤儿 daemon 在下次拉起前自愈；三振出局的断路器阻止对确定性失败的自动重启。
- **不机械重试** —— 有界、感知事件 的等待并输出真实错误，取代静默轮询；
  必然失败的查询一次性 fail-closed。
- **审计优先于信任** —— 每次权限决策与工具请求/结果都追加到
  `local-intercept.jsonl`，因此真实工具输出与模型虚构的输出可区分
  （已用 md5 地面真值核验）。

### 快速开始（本地模式）

```bash
# 一次性：把推理令牌放进 0600 权限的文件
echo <token> > ~/.grokbot-local/anthropic-token && chmod 600 ~/.grokbot-local/anthropic-token

./start-local.sh start    # 另有：stop | status | restart | logs
GROKBOT_BOX=docker ./start-local.sh start   # 电脑 = 本地 Docker 虚拟机
GROKBOT_TURN=host  ./start-local.sh start   # 回合在 host 进程内执行（单一执行面，
                                            # host journal 即转写正本；实验性）
```

脚本幂等，对网关做有界等待，失败时输出 host 日志尾部而不是空转。插件配置放在
`~/.grokbot-local/mcp-servers.json`；工具产物落在共享的 box 工作区
（`box-data/box-workspace`）。验证记录与完整的提交叙事见分支历史
（`dir-0-1-musk`）。

## 仓库里有什么？

入库的树包含经过审阅的重建代码、测试、清单、构建脚本，以及以 Git LFS 保存的
原始 macOS arm64 与 Windows x64 安装包副本。它**刻意不**提交解包的上游应用、
构建产物、本地凭据，以及庞大的取证恢复工作区。

公开的 Grok Bot 0.18.0 应用被当作钉死的构建输入。bootstrap 阶段，工具链会
下载它、校验 SHA-256 身份，并抽取重建所需的部件。

产出的应用在设计上就是混合体：

- 应用运行时从 `source/` 下的可读源码编译；
- 官方打磨过的 renderer 保持为 UI 基线；
- 一段窄而确定的变换加入重建的 Router 设置 UI；
- 原始与补丁后的 renderer chunk 哈希都会记录并校验；且
- 成品使用独立的 bundle 标识与 ad-hoc 签名。

机器上已安装的上游应用永远不会被覆盖。

### 为什么保留官方 renderer？

分发出来的应用不含原始前端源码或 source map，只有优化压缩后的生产版
JavaScript 与 CSS chunk：足以检视行为、恢复契约，但拿不到原始 React 组件、
命名、注释、文件结构或设计系统源码。

以同等打磨度重造完整前端是另一个大得多的逆向工程课题，不是周末工程能实现的
目标。务实的选择因此是：重建运行时与控制面代码，保留哈希钉死的官方 renderer，
只对新的 Router 设置做最小、可审计的 UI 补丁。

`frontend/` 是可读的部分重建与设计工作区，适合理解 UI 契约、试验干净的组件，
但不应被误认为 Anysphere 缺失的原始前端源码，也不是打包 renderer 的
像素级替代品。

## 保存的原始安装包

精确的 0.18.0 安装包研究副本位于 `research-archives/original/0.18.0/`，
以 Git LFS 存储：

| 平台 | 文件 | SHA-256 |
| --- | --- | --- |
| macOS arm64 | `macos-arm64/Grok_Bot_0.18.0.dmg` | `a253ccd8aab01e083f9812a0264354c5034d8ba7f0610bbb557e82ae77d203eb` |
| Windows x64 | `windows-x64/Grok_Bot_0.18.0_Setup.exe` | `464079a15ef5fa8b61ccea8fffcc78f63cfcf6df65fb0ad5e725d8b95f7e437e` |

来源 URL、体积、校验命令与机器可读的制品清单见
[research-archives/README.md](research-archives/README.md)。

## 当前功能

### 推理路由器（Inference Router）

打开 **Settings → Router** 选择新回合使用的后端：

| 供应商 | 认证方式 | 工具支持 |
| --- | --- | --- |
| Cursor | 现有 Grok Bot/Cursor 会话 | 原生 Grok Bot 工具与插件 |
| Claude Code | 现有 Claude Code 登录 | 路由的 Grok Bot MCP 工具 |
| Codex | 现有本地 ChatGPT/Codex 登录 | Direct Responses 传输 + Grok Bot 工具 |
| OpenRouter | 经桌面密钥桥保存的 API key | Grok Bot 工具执行循环 |

默认为 Cursor。Claude Code 与 Codex 在本地客户端已登录时无需单独的 API key。
应用在路由对话中保持流式响应、思考状态、表情回应、富插件提及与 MCP 工具执行。

**Usage & Billing** 面板展示本地记录的请求与 token 汇总（仅限返回用量数据的
供应商）。这些数字是活动记录，不是供应商的权威账单。

### 本地 Docker 沙箱

Router 页还有 **Use local Docker VM** 开关。启用后，Grok Bot 把 box host 与
执行 daemon 跑在一个自有的本地容器里，而不是连接远端沙箱。

该容器：

- 只绑定 loopback 端口；
- 以只读方式挂载内容寻址的 host 与 daemon 产物；
- 需要时复用用户已有的供应商认证；
- 在 coordinator 连接前先做校验；且
- 通过同一设置生命周期停止或替换。

需要 Docker Desktop 或其他兼容的本地 Docker daemon 在运行。远端模式仍为默认。

## 环境要求

- Apple Silicon 的 macOS
- Node.js 26.5.x
- Xcode Command Line Tools
- Git LFS
- Docker Desktop（可选，仅本地沙箱需要）
- 选择 Claude Code 或 Codex 路由时需要对应的本地登录

## 快速开始

```sh
git clone <your-repository-url>
cd grok-bot-0.18-reconstructed
git lfs install
git lfs pull
npm ci
npm run bootstrap
npm run check
npm run package
open "dist/Grok Bot 0.18 Reconstructed.app"
```

`npm run bootstrap` 优先使用 Git LFS 保存的钉死 0.18.0 DMG 副本；若该归档
缺失则回退到原始公开 URL；`GROK_BOT_018_APP` 也可指向已有的应用副本。
bootstrap 会校验 DMG 与 `app.asar`，缓存匹配的 Electron 运行时，并补齐被
ignore 的 `src/app/dist` 构建输入。

`npm run package` 编译重建的运行时，应用窄 renderer/设置变换，创建应用
bundle，赋予重建的 bundle 身份，ad-hoc 签名并校验结果。输出写入：

```text
dist/Grok Bot 0.18 Reconstructed.app
```

重建包在打包边界禁用上游更新器，默认关闭上游 Sentry 与遥测发送。显式提供的
环境配置仍然被尊重。

## 架构

```text
官方打磨 renderer
          │
          │ 桌面 preload / RPC
          ▼
     Electron 主进程
          │
          ├── 设置、密钥、认证与插件生命周期
          ├── 远端 box 连接器
          └── 自有的本地 Docker 连接器
                       │
                       ▼
              coordinator + host
                       │
                推理路由器
           ┌───────────┼───────────┐
        Cursor      Claude       Codex / OpenRouter
                       │
                Grok Bot MCP 工具
```

主要源码区域：

- `source/electron-main/` —— 桌面生命周期、设置、认证、box 连接器、
  coordinator 归属与 RPC 处理器；
- `source/electron-preload/` —— 暴露给 UI 的窄受信桥；
- `source/host/` —— 推理、工具、MCP、设置与回合执行；
- `source/node-agent-coordinator/` —— 转写路由、流式活动、表情回应与路由
  MCP 桥；
- `source/shared/` —— 共享契约、设置、协议与供应商辅助；
- `frontend/` —— 可读的 React/TypeScript renderer 重建与设计工作区；
- `scripts/` —— bootstrap、编译、renderer 补丁、打包、签名与校验；以及
- `tests/` —— 发布与路由回归测试。

更多细节见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 开发命令

```sh
npm test                  # 聚焦回归测试
npm run typecheck         # renderer TypeScript
npm run source:typecheck  # 运行时 TypeScript
npm run frontend:build    # 构建可读 renderer 重建
npm run package           # 构建、签名并校验 macOS 应用
npm run verify            # 校验已打包应用
npm run smoke             # 有界原生冒烟检查
npm run publication:check # 证明全新历史导出无损
```

`.cache`、`.build`、`dist`、`src/app/dist`、`recovered`、`recovery` 等
生成目录与本地探测根目录均被 ignore。

## 项目状态

应用可以启动，核心重建流程可用，包括路由推理、已连接插件与本地 Docker 沙箱。
这仍是一个实验性重建：只针对一个钉死的 macOS/arm64 发布版本，依赖外部供应商
会话，不承诺兼容未来的 Grok Bot 版本。

参与贡献请读 [CONTRIBUTING.md](CONTRIBUTING.md)。干净历史导出流程见
[docs/PUBLISHING.md](docs/PUBLISHING.md)。技术出处与保留的上游边界见
[PROVENANCE.md](PROVENANCE.md) 与 [NOTICE.md](NOTICE.md)。
