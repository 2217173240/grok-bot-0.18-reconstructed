# Grok Bot 0.18 重建版

[![仓库检查](https://github.com/2217173240/grok-bot-0.18-reconstructed/actions/workflows/check.yml/badge.svg)](https://github.com/2217173240/grok-bot-0.18-reconstructed/actions/workflows/check.yml)
**[English](README.md) · 简体中文**

本仓库基于公开发布的 Grok Bot 0.18.0 macOS 应用进行非官方重建，加入本地 Docker 计算机、可配置的模型服务和本地 MCP 工具。你可以阅读、构建桌面运行时代码，并让容器内的 agent 调用指定的第三方模型 API。

![重建版桌面应用的 Router 设置页面](docs/assets/router-settings.png)

## 本仓库的主要能力

- **在自己的计算机上运行 agent。** 本地管理员模式默认通过 Docker 容器运行 host、执行 daemon、桌面、浏览器和回合。Docker 或所需镜像不可用时会明确报错。任务文件位于绑定的工作目录，设置与会话保存在本地。
- **选择模型服务。** Settings → Router 提供 Cursor、Claude Code、Codex 和 OpenRouter。默认本地启动脚本选择 Claude Code 和 Anthropic 兼容 API；可以通过环境变量配置模型及地址。各 provider 的工具能力尚有差异，出现在 Router 中不代表具有相同的工具支持。
- **连接本地工具与插件。** 容器可执行文件及 shell 工具，并托管 `mcp-servers.json` 配置的 MCP 服务，包括 stdio 进程和 Streamable HTTP 地址。工具发现、分页、取消与进程关闭均有对应检查。
- **从可读源码构建桌面运行时。** `source/` 包含 Electron 主进程、coordinator、host、执行与协议代码。打包时保留通过校验的 0.18.0 renderer，并加入范围明确的设置页面补丁。`frontend/` 是供开发使用的部分可读重建。
- **核对构建输入与产物。** bootstrap 校验原始发布构件；原生补丁和 renderer 修改核对预期哈希。生成的 macOS 应用使用独立的 bundle 标识和临时签名。

经过验证的本地路线使用第三方模型服务：对话、文件和 MCP 调用无需 Cursor 或 xAI 返回结果。模型服务、任务访问的网站以及用户配置的远程 MCP 服务仍可能需要网络。原版 0.18.0 应用也是**构建输入**。来源与重建范围详见[来源说明](PROVENANCE.md)。

## 构建 macOS 应用

需要 Apple Silicon Mac、Node.js **26.5.0**、Xcode Command Line Tools、Git，以及安装依赖和获取原版 0.18.0 构件所需的网络。Git LFS 可以提供保存的安装包；若仓库只有 LFS 指针，bootstrap 会下载并校验原版发布构件。

```sh
git clone https://github.com/2217173240/grok-bot-0.18-reconstructed.git
cd grok-bot-0.18-reconstructed
npm ci
npm run bootstrap
npm run check
npm run package
```

应用输出位于 `dist/Grok Bot 0.18 Reconstructed.app`。已有匹配原版应用时，可通过 `GROK_BOT_018_APP` 提供给 `npm run bootstrap`。机器上原有的官方应用保持原状。

## 运行本地容器模式

还需要运行中的 Docker 兼容服务，以及 [docker/base-image.json](docker/base-image.json) 指定的 `linux/arm64` 基础镜像。基础镜像是单独审查的构建输入；`docker/build-arm64-box.sh` 会先核对不可变 digest，再构建 `grok-bot-exec-box:arm64`。[架构与部署说明](docs/LOCAL-SANDBOX-ARCHITECTURE.md)记录了镜像边界和数据目录。

```sh
docker/build-arm64-box.sh
ditto "dist/Grok Bot 0.18 Reconstructed.app" "/Applications/Grok Bot 0.18 Reconstructed.app"
install -d -m 700 "$HOME/.grokbot-local"
${EDITOR:-vi} "$HOME/.grokbot-local/anthropic-token"
chmod 600 "$HOME/.grokbot-local/anthropic-token"
./start-local.sh start
./start-local.sh status
```

将模型服务的 token 写入 `anthropic-token`，只占一行。启动脚本默认使用 `https://open.bigmodel.cn/api/anthropic` 和 `glm-5.2`；其他兼容服务可设置 `ANTHROPIC_BASE_URL` 与 `SAND_CLAUDE_MODEL`。token 文件保存在本地数据目录，并提供给容器内的模型进程。agent 的共享文件位于 `~/.grokbot-local/box-workspace`。

`./start-local.sh` 还提供 `stop`、`restart` 与 `logs`。显式设置 `GROKBOT_BOX=host` 或 `GROKBOT_TURN=mac` 可以选择 Mac 上的诊断执行路径。默认使用 Docker 并在容器内执行回合。启动前需要准备好镜像与已安装的重建应用。

添加本地 MCP 服务时，在 `~/.grokbot-local/mcp-servers.json` 中写入标准的 `mcpServers` 对象。配置的命令会在容器中运行，并可访问绑定的工作目录；使用前请核对插件命令。[扩展说明](docs/EXTENSIBILITY.md)列出 provider、工具和插件的接入位置。

## 已完成的验证

仓库 CI 对 PR 和 `main` 执行 TypeScript 检查、回归测试、可读前端构建及 Git 归档检查。本地还使用真实的 Linux Electron 界面连接隔离容器：经 GLM 提供模型响应的 Claude SDK 回合写入并读取文件、计算 SHA-256、调用 stdio MCP echo 工具，最终把结果返回到会话。在该测试网络中，Cursor 和 xAI 地址被封锁，配置的模型地址仍可访问。

验证结果覆盖所测试的 Claude SDK 路线。所有 provider 的完整工具能力、macOS 安装包的各项端到端功能，以及不依赖固定原版 renderer 的构建仍需完成。[本地架构报告](docs/LOCAL-SANDBOX-ARCHITECTURE.md)记录了验证范围和后续事项。

## 仓库导航

| 路径 | 用途 |
| --- | --- |
| [`source/`](source/) | Electron 主进程、coordinator、host、容器 daemon、共享运行时与协议 |
| [`frontend/`](frontend/) | 部分可读 renderer 重建和设计工作区 |
| [`docker/`](docker/) | 本地执行镜像、桌面脚本与基础镜像身份 |
| [`scripts/`](scripts/) | bootstrap、确定性补丁、构建、打包与校验 |
| [`tests/`](tests/) | 运行时、provider、MCP、打包与发布检查 |
| [`research-archives/original/0.18.0/`](research-archives/original/0.18.0/) | 原始安装包身份记录与 Git LFS 指针 |

开发时运行 `npm run check`、`npm run frontend:build` 和 `npm run publication:check`。macOS 打包使用 `npm run package`，随后运行 `npm run verify`。贡献与 CI 规则见 [CONTRIBUTING.md](CONTRIBUTING.md)，代码结构见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。问题可提交到 [Issues](https://github.com/2217173240/grok-bot-0.18-reconstructed/issues)。

本项目是针对一个固定发布版本的实验性非官方重建。仓库不包含 Anysphere 的原始源码，也未获得将重建产物作为官方构件发布的授权。复用或发布前请阅读 [PROVENANCE.md](PROVENANCE.md) 与 [NOTICE.md](NOTICE.md)。
