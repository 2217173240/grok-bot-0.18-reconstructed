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
| 6. Windows CI | Windows runner 实际编译、原生模块加载与 Electron 启动；Linux runner 验证镜像与工具 | [Windows run 37149058466](https://github.com/2217173240/grok-bot-0.18-reconstructed/actions/runs/37149058466) 全部通过：21 项平台/真实进程测试、包构建、原生依赖、完整产品 DOM/preload/IPC 及所属进程清理。进程身份查询使用异步 PowerShell，真实测试验证查询期间事件循环继续运行、取消隔离与退出后重新读取。[Linux run 37149058470](https://github.com/2217173240/grok-bot-0.18-reconstructed/actions/runs/37149058470) 通过固定下载/导入、执行镜像构建、桌面工具、生产 host/daemon 鉴权、Shell/Read 和重建数据保留 |
| 7. 安装与真实回合 | Windows Docker 连接、挂载、UI 文件/MCP/Computer、审批、取消、重启及升级 | 2026-10-05 在 Windows 10 22H2 实机完成：启动与幂等、真实文本回合、中文空格挂载的文件读写、图片读取、Computer 桌面与容器浏览器、MCP 连接与调用、重启与容器替换后的数据保留均通过。审批与取消两项在本配置下无法触发，升级缺少第二个版本，详见下文实机验收证据 |
| 8. 分发收尾 | 文档、匹配版本、未完成边界、秘密扫描、合并与资源清理 | 文档与未签名 portable ZIP 已具备；源码和秘密扫描通过。Mac 全量检查 333 项：319 通过、14 项环境/平台跳过、零失败。已移除临时 renderer 隔离实验并清理本地实验副本；Windows 实机验收继续保留为步骤 7 |

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
3. **路径和权限。** 正确处理 drive letter、反斜杠、空格、中文和 mount 字段转义。Mac Keychain 密文不跨设备复制；每台机器重新配置自己的凭据。本地 admin 的推理 token 使用数据目录中的受限权限文件，运行密钥不进入构建层。
4. **生命周期。** Windows 宿主关闭不能直接假设 POSIX 进程组语义。仅终止身份匹配的本项目进程；停止容器不删除数据，不全局关闭其他项目的 WSL 或 Docker。
5. **首次运行。** Docker/WSL 未安装、未启动、模式错误、端口占用、路径权限不足、凭据缺失要给出具体错误；失败不改走宿主执行或官方远端。
6. **平台专用能力。** 1Password launcher、passkey 与其他原生辅助能力逐项核对；例如现有 `onepassword-cli-runtime.ts` 明确限制 macOS。不可把核心容器回合通过扩大成全部平台专用功能对等。
7. **发布与升级。** deps pin 随实际输入变化更新；Mac 和 Windows 分别匹配自己的执行镜像。保留旧版本配对和数据，升级失败不自动降级数据库或覆盖凭据。

## Skills 的用途

现有 `codebase-design` 用于定义集中平台接口，`review` 用于代码及需求审查，`diagnosing-bugs` 用于真实跨平台故障定位，`archify` 用于需要时更新架构图。无需为了 Windows 重做前端。

已检索 Microsoft 官方 [winapp-frameworks](https://github.com/microsoft/winappCli/blob/main/plugins/winapp/skills/winapp-frameworks/SKILL.md) 与 [winapp-package](https://github.com/microsoft/winappCli/blob/main/plugins/winapp/skills/winapp-package/SKILL.md)：前者提供 Electron/Windows 框架接入说明，后者用于 MSIX 打包、manifest 和签名。它们适合后续需要 MSIX/Windows package identity 时参考；当前不因为存在 skill 就引入 Windows App SDK 或重写界面。已完成来源与内容核对，未安装额外 skills。

## Windows 实机验收证据（2026-10-05）

在一台 Windows x64 实机、本机 Docker Desktop 的 Linux 容器中执行。验收数据目录、工作目录和绑定挂载路径均包含中文与空格。

### 机器与运行身份

| 项目 | 实际值 |
| --- | --- |
| 操作系统 | Windows 10 Pro for Workstations 22H2，内部版本 19045.6332，x64 |
| 处理器与内存 | Intel Core i7-11800H（8 核 16 线程），31.5 GB |
| WSL | 2.5.9.0，内核 6.6.87.2-1；Ubuntu 与 docker-desktop 两个发行版均在运行 |
| Docker | Docker Desktop 4.93.0，Engine 29.8.1，context `desktop-linux`，引擎为 linux/amd64 |
| 容器镜像存储 | `UseContainerdSnapshotter=true`；固定归档导入后 RepoDigest 保留 |
| 固定基础镜像 | `grok-box-base@sha256:e53fd2e73fa9257c6c197df32ef793f145545a063682c722cf7cb7e8ef53ade5`，归档大小与 SHA-256 与镜像仓库 manifest 登记一致，`sourceRevision` 为 `d7e8cc18` |
| 执行镜像 | `grok-bot-exec-box:amd64`，镜像标识 `sha256:954024ef…`，平台 linux/amd64，deps pin 与应用 build stamp 同为 `69f36880e7b794eed55467eadc663ab2ac5a6705d4c669fbb63d1b7bdb4bd589` |
| 构建环境 | 便携 Node 26.5.0 与 npm 11.17.0；系统 Node 22.14.0；Git 2.52.0.windows.1；Python 3.11.7 |
| 模型账号 | provider `claude-code`，地址 `https://api.deepseek.com/anthropic`，主模型与各子模型均为 `deepseek-v4-flash`；凭据只以数据目录中的 `anthropic-token` 提供，限制为当前 Windows 账号可读 |

系统和硬件条件与 Docker 官方 Windows 要求一致：WSL 2.1.5 以上、Windows 10 22H2 build 19045、LanmanServer 已启动并设为自动。本轮只覆盖 Windows 10 22H2，不据此声明 Windows 11 或 Windows ARM64 已验收。

### 逐项结果

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| 构建与镜像身份 | 通过 | 本机 `npm ci` 与 `npm run package:windows` 成功，产出 175 774 193 字节 ZIP；`verifyWindowsPackage` 在同一命令内通过；包内 build stamp 的 `depsPin` 与执行镜像标签一致，`upstreamAsarSha256` 与基线包相同 |
| 启动、界面与幂等 | 通过 | `start-local.ps1 start` 后 `status` 报告「应用：运行中」「Docker gateway：运行正常」；再次执行 `start` 只输出「应用已经运行」，进程数与容器数不变 |
| 容器身份与实际挂载 | 通过 | 容器 `grok-bot-local-vm` 标签含 owner、deps pin、schema version 与基础镜像 digest；`/workspace` 的来源为含中文与空格的宿主目录，另有只读的推理凭据、host、daemon 与 MCP 配置挂载 |
| 真实文本回合 | 通过 | 界面输入提示词后，模型经容器返回标记 `WINACCEPT-A1`；容器性能账本记录 `turn` 成功、耗时 11.5 秒、首次可见文字 8.3 秒、输入 34 983 与输出 102 个 token |
| 会话记录与重新打开 | 通过 | 数据卷 `agent-transcripts` 中的记录含用户消息、`SendMessage` 工具调用与最终文本；应用重启后界面完整回到此前的全部往返 |
| 文件与路径 | 通过 | agent 在 `/workspace` 创建并在其后追加内容；同一文件的 SHA-256 在 Windows 侧与容器侧一致（`5c0adff2…` 与 `2cda2821…`），内容含中文并由界面回读核对 |
| 图片读取 | 通过 | 以剪贴板粘贴附件后提问，模型只回答图内标记 `ORBIT 7319`；转录中该用户消息带 `[Image]` 前缀 |
| Computer 与容器桌面 | 通过 | 容器账本记录 `Computer` 的 `screenshot`、`click` 与 `wait` 动作并各自产生截图；容器浏览器打开 example.com 后页面标题为 `Example Domain`；容器截图为 1280x800，与容器 X 显示尺寸一致，宿主桌面为 1707x960，操作未涉及宿主桌面 |
| MCP | 通过 | 服务器 `acceptance-echo` 状态为 `ready`，工具 `echo` 被列出；调用返回 `echo: WINDOWS-MCP-C4` |
| 重启与数据保留 | 通过 | 连续两次 `restart` 后容器标识不变（`451e161d…`），会话、设置与工作文件均保留；推理配置变化引起容器更换时，数据卷继续沿用，转录与工作文件同样保留 |
| 容器替换 | 通过 | 容器被替换为新容器（标识由 `d6d41d92…` 变为 `451e161d…`），未删除数据卷，替换后转录 12 条记录与工作文件内容完整 |
| 审批 | 阻塞 | 本配置把 `sand_auto_review` 置为 0，且 local admin 下宿主工具统一放行：多次 Shell 写入、Computer 动作与 MCP 调用都记为 `permission-allowed`，界面全程未出现审批卡，无法执行拒绝与单次允许 |
| 取消 | 阻塞 | 回合进行中界面出现 `Working` 状态，此时界面的全部按钮只有「Attach file」与「Start voice input」，没有停止或取消控件；在流式输出进行中点击发送按钮位置与按下 Esc 都未中断输出；IPC 入口只提供 `cancelTrial`、`cancelLogin` 等，没有取消回合的入口。agent 启动的 Shell 命令在回合结束后仍在容器中继续运行，因此也没有属于该回合的进程可供终止 |
| 升级 | 未验证 | 两个可识别版本都存在（基线 `90db1aa` 与修复后 `2307264`，deps pin 相同），但基线版本在本机无法运行：它创建容器时命中上文第 1 个缺陷，`start` 报 gateway 超时，容器始终没有建立。旧版本无法进入运行状态，升级无法从它开始；按预定边界不做数据库降级，也不用同版本重新解压充当升级 |
| 另一个盘符 | 通过 | 以 `D:\GrokBot 验收 第二盘符` 作为数据目录（含中文与空格），容器被替换为新容器后，实际挂载为 `D:\GrokBot 验收 第二盘符\box-workspace -> /workspace`；agent 在其中创建 `second-drive.txt`，内容为 `SECONDDISK-D5 第二盘符 验证。`，两侧 SHA-256 同为 `58600569…`。数据卷未删除 |

### 本轮修复的产品缺陷

实机暴露出两个位于同一处、都会让容器无法创建的缺陷，均已修复并各自带一条测试：

1. `source/electron-main/box/local-docker-host-connector.ts` 把设置写入程序交给 `node -e` 时，模板字面量里的 `\n` 被解释为真实换行，生成的程序无法解析，容器创建以 `SyntaxError` 失败。改为 `\\n`。同一缺陷自 `11f0208`（2026-09-18）起存在。既有测试没有覆盖该程序：`scripts/linux-package-smoke.mjs` 使用自己的一行写入程序。
2. 同一处的种子步骤把数据卷挂到镜像中并不存在的 `/data`。Docker 会把这个挂载点建为 root 所有，以 `box` 运行的容器无法写入，报 `EACCES`；同一个卷再挂给生产容器时目录同样不可写。改为挂到生产使用的 `SAND_BOX_DATA_ROOT`，使新卷继承镜像中该目录的属主，并在种子步骤中以 root 身份把数据目录与设置文件交还 `box` 用户，让已经存在且属主不对的卷也能恢复。

两项改动位于分支 `fix/local-docker-seed-script`，提交为 `620e2b9` 与 `2307264`。本轮实机验收使用的是以此重建的包；`depsPin` 不包含该文件，因此执行镜像无需重建。

基线包在这台机器上无法启动：用 `90db1aa` 的包配合同一个数据目录执行 `start`，它命中第 1 个缺陷，`start` 报 gateway 启动超时，容器始终没有建立。因此在修复合入之前，未做过任何改动的用户在这台机器上无法完成首次启动。

### 环境条件与所需用户操作

宿主 Windows 把 TCP 1324 至 1423 保留给 Hyper-V 与 WSL 动态使用，1340 位于其中，容器端口发布以 `WSAEACCES` 失败，`docker start` 报 `ports are not available`。这一项属于宿主配置：绑定的端口在应用内固定，无法通过配置绕开。本轮由用户在提升权限的 PowerShell 中停止 Windows NAT 服务，端口可用后应用自行恢复并建成容器。

同一台机器再次出现该错误时，依次执行 `net stop winnat`、启动应用、`net start winnat` 即可；若保留区间再次覆盖 1340，需要重启机器让区间重新分配。这一类错误的原因是宿主端口保留，与镜像和挂载无关。

重启 Windows NAT 服务后，动态保留区间重新分配，1340 不再属于任何保留区间且可以绑定。在这种正常环境下重新执行 `start`，应用报「应用已经启动，Docker gateway 运行正常」，容器正常建立并发布 1340，说明该失败只来自宿主当时的保留区间。

### 尚需用户决定的事项

以下三项无法由本机操作单独解决，都需要产品侧的决定或改动：

1. **审批**：local admin 下宿主工具统一放行，自动审查被启动脚本固定关闭，界面因此不会出现审批卡。要在本机验收审批，需要先决定本地模式是否提供审批策略（例如恢复自动审查，或为本地模式增加人工确认）。
2. **取消**：打包的界面没有提供停止或取消回合的控件，进程间入口也没有对应方法，因此即使宿主内部实现了取消，用户也无法触发。需要先决定是否在本地模式暴露取消入口。
3. **升级**：需要两个都能运行的版本。当前唯一的旧版本正是被本轮修复的缺陷所阻断，无法启动。修复合入并发布之后，后续版本之间才能做真正的升级验证。

### 其他观察

- 容器桌面持续报告磁盘空间不足，界面顶部显示 `Computer is low on disk space`；本轮未执行清理，也未影响已执行的项目。
- 输入框中的草稿（文字与图片附件）在应用重启后仍然保留。
- 直接打开 EXE 时读取的是同一套本地配置；缺少必需凭据时按部署文档给出明确错误。

## 保留的验收与发布边界

用户授权本轮完成 Windows 适配与 Windows CI，明确接受真实 Windows 机器验收待办，预期使用 Win10 测试。正式宣称 Windows 支持已验收前，需要在对应 Windows x64 + Docker Desktop/WSL2 上完成步骤 7。公开签名发行另需发布者证书，开发测试包必须明确标记签名状态。仅使用已有授权账号，Codex 凭据继续只限隔离容器只读；公开原版资源仍受 PROVENANCE.md 约束。
