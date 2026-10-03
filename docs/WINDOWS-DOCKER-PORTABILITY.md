# Windows Docker 适配与执行计划

更新日期：2026-10-03。用户要求 Mac 与 Windows 各自独立部署，agent、推理 CLI、文件工具和 Computer 都在本机 Linux Docker 容器运行。当前目标为 Windows 10 22H2（build 19045）/Windows 11 x64、Docker Desktop 的 WSL2/Linux containers 模式；Windows ARM64 需要独立构件及验收，不自动宣称支持。Docker 官方要求 WSL 至少 2.1.5，并将支持范围与 Microsoft 的系统维护期限关联；Win10 的实际 Docker 版本和系统维护状态需在用户机器记录。[Docker Windows 系统要求](https://docs.docker.com/desktop/setup/install/windows-install/)

进度入口为 [ROADMAP.md](ROADMAP.md)，运行架构依据 [LOCAL-SANDBOX-ARCHITECTURE.md](LOCAL-SANDBOX-ARCHITECTURE.md)，Mac 可移植性依据 [MAC-PORTABILITY-REVIEW.md](MAC-PORTABILITY-REVIEW.md)。每次实现、CI 或验收后更新下表的证据与剩余事项，保持代码版本和文档状态一致。

## 架构选择

Windows 使用原生 Electron 界面和本机 Docker CLI；Docker Desktop/WSL2 承载 Linux amd64 执行镜像。现有 host、box-exec、MCP、Xvfb、Chromium、noVNC、审批、转录及 Linux 进程管理继续复用。容器中的 Computer 操作容器桌面，不操作 Windows 宿主桌面。

平台差异集中在以下位置：

| 模块 | 共用部分 | 平台差异 |
| --- | --- | --- |
| 启动配置 | local admin、provider 配置、环境白名单、错误检查 | 默认数据目录、App 定位和打开方式 |
| Docker 连接 | Docker CLI、容器身份、依赖 pin、生命周期队列、健康检查 | Mac socket 与 Windows context/named pipe；宿主路径表达 |
| 执行镜像 | 一份 Dockerfile、同一 Linux 服务和工具协议 | arm64/amd64 二进制、官方校验和、基础镜像 digest、目标标签 |
| 桌面构建 | 源码运行模块、固定 renderer、ASAR 校验 | Mac `.app` 与 Windows Electron/原生依赖及发布目录 |
| 宿主生命周期 | 所属进程识别、幂等启动、受控关闭 | LaunchServices/POSIX 与 Windows 进程查询及进程树关闭 |

不需要给容器 host-lock 或 Claude Linux 进程组添加 Windows 实现。宿主 local-exec 的原生服务仍需核对 Windows 进程管理；不得把它变成 Windows agent 回合入口。官方远端、更新与遥测保护保持有效。

## 官方实践与项目应用

- Electron 支持共用 JavaScript 界面与业务模块，但原生 `.node`/DLL 需要匹配操作系统、CPU 和 Electron ABI。复用平台适配后的源码构建，分别验证 Windows 和 Mac 原生依赖加载。[Electron 原生模块](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules)
- Docker Desktop 的 WSL2 backend 提供本地 Linux containers。本项目选择这一成熟边界，继续使用 Docker CLI；不额外实现容器管理服务。[Docker WSL2](https://docs.docker.com/desktop/features/wsl/)
- 高频 Linux 数据保留在 Docker volume，宿主 workspace bind mount 用于用户文件交换。Windows/WSL 文件系统之间的访问成本需要真实测量；路径包含空格、中文、盘符和大小写差异都要覆盖。[Microsoft 文件系统建议](https://learn.microsoft.com/en-us/windows/wsl/filesystems)
- 分发包采用自身身份；Windows 签名和 SmartScreen 行为单独验证。原版 Windows 安装包存在于构件清单，只能作为经核对的输入，不能直接证明重建版可运行或可自由再分发。[Electron 分发签名](https://www.electronjs.org/docs/latest/tutorial/code-signing)

## 依赖顺序与进度

| 步骤 | 完成条件 | 当前状态与证据 |
| --- | --- | --- |
| 1. 架构与输入盘点 | 明确桌面/容器边界，核对现有 Windows 分支及原版构件身份 | 已完成源码评审；Windows 原版 EXE 的固定 SHA 已在镜像仓库 manifest 登记 |
| 2. 平台与配置接口 | Windows Docker endpoint、路径和镜像选择；Mac 现有行为保持 | 代码已实现，34 项本机规则/文件检查及源码类型检查通过；Windows Docker 实机部分尚未验证 |
| 3. 共用启动配置 | 两种入口共用环境/provider 校验；Windows 幂等启动和所属进程关闭 | Mac 与 PowerShell 已接入共享配置；Windows CI 的真实进程树关闭、创建时间核验和 SQLite 启动互斥已通过 |
| 4. Linux amd64 镜像 | 官方二进制校验、真实构建、实际 digest 与平台 pin；保留 arm64 | 镜像仓库 #7、#8、#9 已合入；151 项门禁、17 层扫描及 run 37135069283 的空存储导入通过。[固定 Release](https://github.com/2217173240/grok-bot-box-image/releases/tag/base-d7e8cc1-amd64) 已发布，旧 arm64 构件保留 |
| 5. Windows 构建 | 固定输入提取，源码覆盖，原生依赖和 ASAR 校验，可运行分发目录 | Windows x64 unsigned portable ZIP 已在 Windows runner 构建成功；完整原版文件清单、131 个 renderer 文件/补丁链、ASAR/unpacked 与 PE 身份通过。实际 Electron 42.1.0/ABI 146 的 SQLite、tree-sitter Bash 和进程扫描通过 |
| 6. Windows CI | Windows runner 实际编译、原生模块加载与 Electron 启动；Linux runner 验证镜像与工具 | 类型检查、平台/进程测试、包构建和真实 DOM/preload 已通过；产品的持续响应与 IPC 检查尚未通过。同环境最小 Electron 控制程序已通过（run 37142064569），正在缩小产品加载路径。Linux run 37142064571 已通过固定下载/导入、执行镜像构建、桌面门禁、生产 host/daemon 鉴权、Shell/Read 和重建数据保留 |
| 7. 安装与真实回合 | Windows Docker 连接、挂载、UI 文件/MCP/Computer、审批、取消、重启及升级 | 用户已明确：暂无 Windows 机器，本轮保留实机验收待办 |
| 8. 分发收尾 | 文档、匹配版本、未完成边界、秘密扫描、合并与资源清理 | 开发中随进度更新；未验证构件不标为正式可用发行版 |

代码检查、Windows 构建检查、Linux 容器检查和 Windows + WSL2 实机验收分别记录。普通托管 Windows CI 是否具备可用 Linux Docker backend 必须现场检查；不能把 runner 上的 Windows Docker 服务当成所需 Linux backend。

Windows native 构建使用固定 node-gyp 13.0.2，包含 Node 26/MSVC 的官方 LTO 修复；开发 Node 保持 26.5.0，Electron 保持 42.1.0/ABI 146。[node-gyp 修复说明](https://github.com/nodejs/node-gyp/pull/3331)

## Windows 独立部署

目标机器安装 Docker Desktop 并启用 WSL2、Linux containers，以及 General 中的 **Use containerd for pulling and storing images**。固定归档需要保留 OCI digest；新版本默认启用该镜像存储，已有安装应核对设置。[Docker 镜像存储说明](https://docs.docker.com/desktop/features/containerd/)

源码构建还需要 Git、Node 26.5.0、Python 与 Visual Studio C++ Build Tools。每台机器使用自己的数据和模型账号。

在 PowerShell 的仓库目录运行：

```powershell
npm ci
git clone https://github.com/2217173240/grok-bot-box-image.git .cache/box-image
node .cache/box-image/scripts/fetch-artifact.mjs base-amd64 --load
node docker/build-box.mjs --platform linux/amd64
npm run package:windows
```

分发目录为 `dist/Grok Bot 0.18 Reconstructed-win32-x64`，同级生成 ZIP。包内 `Grok Bot.exe` 与 `start-local.ps1` 配套使用；启动脚本直接使用随包 Electron 的 Node，源码和镜像构建按上述环境准备。构建输入或 lockfile 变化后，重新构建执行镜像，使其 deps pin 与包内 `resources/build-stamp.json` 一致。

默认数据目录为 `%LOCALAPPDATA%\GrokBotLocal`，可用 `-DataRoot` 指定其他目录。默认 provider 为 Claude Code；用本地编辑器将自己的 token 写入数据目录中的 `anthropic-token`，只授予当前账号读取权限。模型、API 地址和子模型映射沿用共享启动配置的显式环境变量；其他 provider 使用该数据目录已保存的设置和各自凭据。

在解压后的分发目录执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-local.ps1 start
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-local.ps1 status
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-local.ps1 stop -StopContainer
```

`stop` 关闭此启动器持有的应用进程；加上 `-StopContainer` 同时停止归属匹配的项目容器，保留镜像、工作文件和数据卷。`restart` 在停止前检查新配置。直接打开 EXE 也会读取相同本地配置，缺少必需配置时显示错误。

当前 ZIP 为未签名开发验证包。Windows 10/11 的 SmartScreen、Docker Desktop/WSL2、含中文和空格的实际挂载、UI 文件/MCP/Computer、审批、取消与升级由步骤 7 的真实机器验收覆盖。

## 主要困难和验证重点

1. **原生依赖与构件组成。** Mac 的 `.node`、Mach-O 与 `.app` 无法在 Windows 加载。核对 Electron ABI、tree-sitter、原生辅助程序及资源路径；只有平台实际加载成功才能证明完整。
2. **Docker endpoint。** 当前 Unix socket 搜索需要 Windows 分支；尊重 Docker context/DOCKER_HOST 的明确选择，确认 daemon 为 Linux、镜像为 amd64，保持容器所有权检查。
3. **路径和权限。** 正确处理 drive letter、反斜杠、空格、中文和 mount 字段转义。Mac Keychain 密文不能作为跨设备凭据配置；Windows 使用本机安全存储，运行密钥不进入构建层。
4. **生命周期。** Windows 宿主关闭不能直接假设 POSIX 进程组语义。仅终止身份匹配的本项目进程；停止容器不删除数据，不全局关闭其他项目的 WSL 或 Docker。
5. **首次运行。** Docker/WSL 未安装、未启动、模式错误、端口占用、路径权限不足、凭据缺失要给出具体错误；失败不改走宿主执行或官方远端。
6. **平台专用能力。** 1Password launcher、passkey 与其他原生辅助能力逐项核对；例如现有 `onepassword-cli-runtime.ts` 明确限制 macOS。不可把核心容器回合通过扩大成全部平台专用功能对等。
7. **发布与升级。** deps pin 随实际输入变化更新；Mac 和 Windows 分别匹配自己的执行镜像。保留旧版本配对和数据，升级失败不自动降级数据库或覆盖凭据。

## Skills 的用途

现有 `codebase-design` 用于定义集中平台接口，`review` 用于代码及需求审查，`diagnosing-bugs` 用于真实跨平台故障定位，`archify` 用于需要时更新架构图。无需为了 Windows 重做前端。

已检索 Microsoft 官方 [winapp-frameworks](https://github.com/microsoft/winappCli/blob/main/plugins/winapp/skills/winapp-frameworks/SKILL.md) 与 [winapp-package](https://github.com/microsoft/winappCli/blob/main/plugins/winapp/skills/winapp-package/SKILL.md)：前者提供 Electron/Windows 框架接入说明，后者用于 MSIX 打包、manifest 和签名。它们适合后续需要 MSIX/Windows package identity 时参考；当前不因为存在 skill 就引入 Windows App SDK 或重写界面。已完成来源与内容核对，未安装额外 skills。

## 保留的验收与发布边界

用户授权本轮完成 Windows 适配与 Windows CI，明确接受真实 Windows 机器验收待办，预期使用 Win10 测试。正式宣称 Windows 支持已验收前，需要在对应 Windows x64 + Docker Desktop/WSL2 上完成步骤 7。公开签名发行另需发布者证书，开发测试包必须明确标记签名状态。仅使用已有授权账号，Codex 凭据继续只限隔离容器只读；公开原版资源仍受 PROVENANCE.md 约束。
