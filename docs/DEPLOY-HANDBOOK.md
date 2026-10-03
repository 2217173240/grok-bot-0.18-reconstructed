# macOS arm64 本地部署手册

本手册描述当前 `main` 的部署路径：macOS Apple Silicon、Docker 计算机、local-admin、已配置的第三方推理 provider，以及固定的原版 renderer 构建输入。实际验收范围与版本记录见 [ROADMAP.md](ROADMAP.md)。

不同 Mac 各自部署时，使用各自的运行环境、数据根和凭据。当前可移植性缺口、分发方式与新机器验收顺序见 [多台 Mac 独立部署评审](MAC-PORTABILITY-REVIEW.md)。

## 运行条件

- macOS Apple Silicon（arm64）。
- Xcode Command Line Tools、Git、Node `26.5.0`（`.node-version`）、Docker CLI。
- Colima，默认 profile 为 `grokbot`；OrbStack 作为 Colima 候选不可用时的最后候选。
- 运行期需要 local-admin、Docker 和一个已配置的第三方 inference provider。当前生产启动脚本默认 `claude-code`，Codex 仅在隔离验收范围内验证，本手册不指导 Mac 回合使用 Codex。
- 构建需要访问仓库锁定的下载源、npm registry、GitHub 以及基础镜像独立仓库的固定构件。

不要把真实 key 写入 shell 命令、shell history、日志或 Git。使用本地文本编辑器保存 `${GROKBOT_DATA_ROOT:-$HOME/.grokbot-local}/anthropic-token`，并将文件权限设为 `0600`。启动脚本会检查该文件；provider 层读取它并只注入 Claude CLI 子进程。启动环境中的 `ANTHROPIC_API_KEY=local-file` 是非秘密登录标记。

先创建私有文件，再用编辑器输入 API key 本身，保存为纯文本：

```sh
grokbot_data_dir="${GROKBOT_DATA_ROOT:-$HOME/.grokbot-local}"
install -d -m 700 "$grokbot_data_dir"
touch "$grokbot_data_dir/anthropic-token"
chmod 600 "$grokbot_data_dir/anthropic-token"
nano "$grokbot_data_dir/anthropic-token"
```

## 获取代码与固定基础镜像

```sh
git clone https://github.com/2217173240/grok-bot-0.18-reconstructed.git
cd grok-bot-0.18-reconstructed
git clone https://github.com/2217173240/grok-bot-box-image.git .cache/box-image
```

基础镜像由 `docker/base-image.json` 选择。使用独立 `grok-bot-box-image` 仓库提供的固定 Release 构件和 fetch 工具，按其 manifest、镜像 digest、平台与 OCI source label 校验。导入基础镜像后构建本仓库执行镜像：

```sh
colima start --profile grokbot --cpu 4 --memory 6 --disk 30 --arch aarch64
export DOCKER_HOST="unix://$HOME/.colima/grokbot/docker.sock"
node .cache/box-image/scripts/fetch-artifact.mjs base-arm64 --load
docker/build-arm64-box.sh
```

发布包、执行镜像和容器门禁使用 `scripts/lib/deps-pin.mjs` 计算的同一个依赖 pin。其输入变化后，先重新构建执行镜像；启动会明确拒绝过期镜像。原数据卷和基础镜像继续保留。

`scripts/lib/docker-socket.sh` 与 `source/electron-main/box/local-docker-host-connector.ts` 维护同一候选顺序：显式 `DOCKER_HOST`、`GROKBOT_COLIMA_PROFILE` 指定的 profile（默认 `grokbot`）、系统 socket、无 profile/default Colima socket、按名称排序的其余 Colima profile、OrbStack socket。若需要指定 socket，可以在当前 shell 设置 `DOCKER_HOST=unix://<socket>`。

## 构建和安装 App

```sh
npm ci
npm run bootstrap
npm run package
npm run verify
./start-local.sh stop
ditto "dist/Grok Bot 0.18 Reconstructed.app" "/Applications/Grok Bot 0.18 Reconstructed.app"
```

`bootstrap` 获取并校验固定的官方 0.18 构建输入，固定 renderer 允许作为构建输入。安装前确认 `Contents/Resources/build-stamp.json` 的 `sourceRevision` 与仓库提交一致。

## 数据根和 MCP

默认数据根是 `~/.grokbot-local`，可通过 `GROKBOT_DATA_ROOT` 指定。首次启动会创建 settings、profile、Docker runtime 状态、workspace、gateway token 和本地诊断账本。不要手工创建 gateway token、runtime staging 目录或生产容器数据卷。

可选 MCP 配置放在数据根的 `mcp-config/shared/mcp-servers.json`。其服务器 `command`、`args`、`env`、`cwd` 由容器内 box 用户执行，服务器可以访问配置授予的工作目录和凭据；只配置信任的服务器。配置变化由应用重新加载连接。MCP 参数通过现有 protobuf/JSON 边界传递，服务器的 HTTP 配置使用当前支持的 Streamable HTTP 路径。

## 启动、停止和状态

准备好 token、Docker 和已配置 provider 后：

```sh
./start-local.sh start
./start-local.sh status
```

需要时使用 `./start-local.sh logs` 跟随日志，按 Ctrl-C 结束；`stop` 退出 App 并保留容器，`restart` 重新加载完整启动环境。容器数据卷保持保留，重建动作由应用的计算机恢复入口执行。

`start-local.sh` 只接受 Docker 计算机路径：它设置 `SAND_LOCAL_ADMIN=1`、`SAND_LOCAL_ADMIN_BOX=docker`、`SAND_LOCAL_ADMIN_TURN=host`，默认启用 desktop plane；设置 `GROKBOT_DESKTOP=0` 才使用 headless exec plane。脚本通过 macOS LaunchServices 显式传递非敏感 `--env`。

默认模型为 `glm-5.3-flash`，兼容地址为 `https://open.bigmodel.cn/api/anthropic`。显式设置 `SAND_CLAUDE_MODEL`、`ANTHROPIC_BASE_URL` 或各 `ANTHROPIC_DEFAULT_*_MODEL` 可以覆盖默认值；模型映射变化后容器重新建立，继续使用原数据卷。

脚本默认使用 `/Applications/Grok Bot 0.18 Reconstructed.app`，健康地址为 `http://127.0.0.1:1340/health`，就绪等待默认 45 秒。可使用 `GROKBOT_READY_TIMEOUT_S` 调整等待时间，使用 `GROKBOT_IMAGE` 指定已经校验的执行镜像标签。启动时若发现非本应用或健康 Docker computer 占用 1340 端口会终止启动。

`status` 可能显示 handover URL。该 URL 含访问 token，分享日志、截图或诊断文本前必须隐藏整行。

## 验收

```sh
./start-local.sh status
docker/container-gates.sh --profile desktop
```

确认 status 显示 app、Docker computer、gateway healthy；桌面验收确认 noVNC handover 能打开。对已配置 provider 执行一次真实文本回合、一次本地文件回合、一次 host MCP 回合，再检查 transcript 和目标工作目录。不要在没有对应账号或 key 时声称其他 provider 已验收。

可选地运行本地零远端检查：

```sh
scripts/zero-remote-live.sh
```

该检查用于当前 local-admin 网络边界和本地诊断账本。它不能替代容器出口防火墙，也不能证明所有第三方网站均可访问。

## 故障边界

- `missing .../anthropic-token`：使用文本编辑器保存 token 文件并设置 `chmod 600`，不要把 token 写进命令行。
- `no Docker socket found`：启动 Colima `grokbot` profile，启动 OrbStack，或设置正确的 `DOCKER_HOST`。
- gateway 超时：查看 `./start-local.sh logs`、Docker container logs 和 host 日志，确认镜像 pin、数据卷权限、runtime staging 与 1340 端口状态。
- installed app 行为与源码不同：比较 build stamp 的 `sourceRevision` 和当前仓库提交，重新执行 `npm run package`、`npm run verify` 后重新 `ditto`。
- handover URL 失效：重新执行 `status` 获取当前 URL，并在任何外部分享前隐藏完整 URL 行。
- MCP 服务器失败：确认 `mcp-servers.json` 的结构、command/cwd/args、服务器权限和 HTTP endpoint；应用会报告连接、工具发现或工具调用失败，不会自动重放有外部副作用的调用。

容器写入 bind-mounted workspace 会影响宿主机对应目录。外部工具已经发生的副作用不会因取消、网络中断或应用退出自动撤销。
