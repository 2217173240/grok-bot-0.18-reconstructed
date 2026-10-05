# 多台 Mac 独立部署评审

初次评审日期：2026-10-03，基线 `ff8d986`；配置说明更新于 2026-10-05。用户在各自 Mac 安装同一版本、配置自己的第三方账号，应用在该机器的 Docker sandbox 内执行并保存结果；需要人工判断的动作仍由本机用户批准。

目标是普通项目的独立安装体验：新机器无需开发者的用户名、目录、缓存、凭据或旧容器。当前已验证范围为 macOS Apple Silicon；Intel Mac 尚未建立对应应用构件、基础镜像和实际验收。本页记录部署评审与共用启动配置；现有 Mac 安装、虚拟机和数据保留，未新增安装器。

Windows 已由用户确认为正式交付目标，实施状态与真实机器验收边界见 [Windows Docker 适配计划](WINDOWS-DOCKER-PORTABILITY.md)。该实现同时完成 Mac 的 `GROKBOT_APP_PATH` 路径配置、App/build stamp 统一定位、共享 provider 校验与 Docker context 传递；本页其余事项继续作为独立 Mac 部署的评审依据。

## 推荐部署方式

每台 Mac 保持一个独立实例：相同发布版本，各自的 Colima `grokbot`、数据卷、工作目录、凭据和审批状态。设备之间共享经过校验的程序构件，各自生成运行身份和访问 token。固定容器名和回环端口可以在不同机器重复使用。

应用、启动器、镜像构建与容器检查使用统一的 runtime profile。Docker 选择顺序为 `DOCKER_CONTEXT` → `DOCKER_HOST` → `GROKBOT_COLIMA_PROFILE` → 数据根中的 `runtime.json` → 平台默认值。Mac 默认使用专属 Colima `grokbot`；Windows/Linux 默认使用 Docker CLI 当前 context，客户端首次连接时固定该名称。所选 runtime 不可用时报告错误；OrbStack 等其他 runtime 仍可通过 context 或 host 显式选择。

`runtime.json` 必须包含 `"version": 1`，`docker` 和 `image` 均可省略。提供 `docker` 时，从 `context`、`host`、仅限 macOS 的 `colimaProfile` 中选择一个字段。镜像优先级为 `SAND_LOCAL_ADMIN_IMAGE` → `GROKBOT_IMAGE` → `runtime.json` 的 `image` → 平台默认镜像。完整操作见[部署手册](DEPLOY-HANDBOOK.md)。

目前可执行的路径是[源码构建部署手册](DEPLOY-HANDBOOK.md)。推荐的分发目标是维护者构建一次，用户下载匹配的 App、执行镜像和启动工具，在本机校验并初始化。执行镜像与基础镜像构件继续统一由 `grok-bot-box-image` 仓库管理；应用源码与运行代码版本由本仓库管理。

建议一次发布用同一份清单关联：App SHA-256、源码 revision、执行镜像 digest、基础镜像 digest、deps pin、平台、所需 macOS 范围和数据格式版本。用户安装时校验清单及发布者身份，再启动本机实例。该完整发布清单与预构建执行镜像分发流程属于待实施事项；现有基础镜像 manifest、fetch 工具、build stamp 和 deps pin 可以复用。

## 已具备的可移植能力

| 能力 | 当前证据 | 保证范围 |
| --- | --- | --- |
| 基础镜像获取 | 镜像仓库 `artifacts/manifest.json`、`scripts/fetch-artifact.mjs` | HTTPS 下载，文件 SHA、平台、RepoDigest 与源码 label 校验；无需复制开发者缓存 |
| 构建输入身份 | `scripts/bootstrap-runtime.mjs`、`PROVENANCE.md` | 原版构件有固定哈希；开发者本地路径是可选输入，另有归档和下载路径 |
| 用户目录发现 | connector 的 `homedir()`、启动脚本的 `$HOME` | 账号目录随当前用户解析；扫描的生产 source、docker、scripts 与启动脚本未发现 `xinheyun` 或 `finonelib` 依赖 |
| 容器环境 | `localDockerRunPlan`、`localDockerInferenceEnvironment` | 模型及诊断环境进入容器；配置身份变化触发容器更新，保留数据卷 |
| 版本不匹配检测 | `scripts/lib/deps-pin.mjs`、`decideDockerImage` | App 与依赖镜像不匹配时拒绝启动；deps pin 只覆盖规定输入，不代表整个发布包的身份 |
| 本地边界 | connector 回环端口、`local-admin.ts` | 每台机器本地运行；运行期无需 Cursor/xAI 官方返回 |

这是源码与既有验收支持的能力清单。当前证据来自一台开发 Mac 和隔离测试，尚无第二台全新 Mac 的独立安装记录。

## 部署能力与剩余验收

| 优先级 | 发现与代码位置 | 对其他 Mac 的影响 | 推荐修改与完成条件 |
| --- | --- | --- | --- |
| P1 | `GROKBOT_APP_PATH` 与 App/build stamp 统一定位已实现 | 支持标准目录之外的安装位置 | 独立新 Mac 继续验收含空格目录、不同安装位置 |
| P1 | 共享 `local-launch-config.mjs` 按 provider 校验凭据 | Claude Code 使用 token 文件；其他 provider 使用各自配置 | 账号范围按授权分别验收 |
| P1 | 启动入口共用配置解析与 runtime profile | 配置错误明确报告，Docker 目标明确选择 | 独立新 Mac 验收首次启动、重启与升级 |
| P1 | 已有 macOS 与 Windows 构建检查，以及 Linux 容器检查 | 平台 CI 验证对应构建和运行路径 | 第二台全新 Mac 的安装记录仍待补充 |
| P2 | 容器门禁共用 runtime profile 与数据根解析 | 自定义数据根和 daemon 与应用使用相同选择规则 | 用对应数据根检查实际鉴权 |
| P2 | `start-local.sh` 的 stop 保留容器和 local-exec；VM 继续运行 | 用户退出窗口后仍可能占用内存 | 提供明确的“退出应用”和“停止本项目全部运行资源”；验证只停止本项目进程、容器及专用 VM，保留镜像、数据与其他项目 |

现有 `GROKBOT_DATA_ROOT` 不能证明同一 Docker daemon 上支持多个并行实例：connector 固定容器名、数据卷名和端口。本目标是每台 Mac 一个实例，保持这些默认常量即可，无需引入实例注册中心。`/workspace`、`/home/box` 属于镜像内约定，digest、版本和平台约束属于可复核构建输入，均应保留并验证。

## 分发质量与发布条件

当前重建 App 使用独立 bundle ID 和 ad-hoc 签名。面向普通 Mac 用户的下载分发，应采用发布者自己的 Developer ID 签名、公证和可验证的发布来源；沿用已有打包流程即可逐项接入。签名工具运行成功不能替代另一台 Mac 上的 Gatekeeper 安装检查。Electron 官方也将签名一致性与 Keychain 行为关联起来。[Electron 签名说明](https://www.electronjs.org/docs/latest/tutorial/code-signing)

原版 renderer、图片与原生文件的公开再分发条件继续依据 [PROVENANCE.md](../PROVENANCE.md) 和 [NOTICE.md](../NOTICE.md)。当前无上游源码许可，不能仅凭仓库公开就宣称可自由再分发。权利审查与发布签名是公开二进制分发前的待办；本次没有添加许可证、上传二进制或使用签名凭据。

已有 SHA 和 OCI label 用于核对内容及声明。若增加发布流水线，复用 BuildKit 的 provenance/SBOM 支持，并在消费端校验可信发布来源与期望 digest；仅生成证明文件不足以完成验证。构建参数和构建上下文不得携带运行凭据。[Docker 构建证明](https://docs.docker.com/build/metadata/attestations/)

## 多目标取舍与优化顺序

这里把“凸包优化”用于筛选部署方案的有效取舍。方案涉及离散平台、不同分发方式和未测量成本，当前只能建立候选的 Pareto 取舍，不能计算数值凸包或声称某个方案数学上最优。

先约束正确性：Docker 内执行、每机数据独立、凭据私有、失败明确、审批和取消语义保留。再比较首次可用时间、常驻内存、升级成本及维护负担；这些指标需要在相同任务、设备和版本下记录。

| 方案 | 安装与更新成本 | 运行资源 | 维护代价 | 选择依据 |
| --- | --- | --- | --- | --- |
| 每台 Mac 源码构建 | 每台需要 Node、编译工具和构建下载 | 使用同一运行架构 | 用户承担构建环境问题 | 当前支持，适合开发与验证 |
| 一次构建，分发 App 与匹配执行镜像 | 目标机器只完成运行环境和账号配置；流水线建成后收益随设备数量增加 | 与源码构建的相同版本相近，仍需测量 | 维护者承担版本清单、签名、发布与更新 | 推荐的普通用户分发目标 |
| 每机 headless 模式 | 仍需相同版本及账号配置 | 省去桌面组件的收益待测量 | 少一类桌面能力，但需单独标明验收范围 | 仅适用于不需要 Computer 的任务，现有开关可复用 |

发布优化应优先消除每台机器重复构建和人工环境排错。预构建包不会自动缩短第三方模型响应时间；已有 MCP 队列与目录缓存优化继续复用。一次热构建 0.62 秒、一次取消清理 446ms 等历史数据只代表对应设备与场景，不能当作其他 Mac 的性能承诺。

内存测量记录 App、辅助进程、Colima 和容器的空闲/工作峰值，区分 VM 配置上限与实际占用。原 6GiB Colima 配置不是实测常驻内存。运行完毕可停止专用 VM 释放运行资源；不要用增加后台服务解决尚无测量证据的问题。

## 新机器安装与升级的验收路径

1. 在第二台 Apple Silicon Mac 或独立干净 macOS 环境下载固定版本，记录硬件、macOS、Docker/Colima 版本；不给它开发者 HOME、缓存或凭据目录。
2. 使用自己的路径与账号完成初始化。检查 App/镜像身份、deps pin、目录权限、端口冲突和错误提示；错误发生后不自动切换到别的项目环境。
3. 运行 local admin 文本、文件、MCP、Computer 图片、审批拒绝/单次允许、取消和下一条回复，核对副作用与实际进程退出。
4. 退出、完全停止环境并重新启动，确认数据保留；升级到新版本后验证原会话、设置和工作文件。升级前取得一致性备份，不能假设旧代码可读取升级后的数据格式。
5. 回收本次临时文件和运行资源，确认用户数据及其他项目未改变，再把该机器加入支持记录。

默认各机从空数据根初始化。需要迁移旧数据时，必须暂停相关写入，分别处理容器数据卷、Mac 设置、workspace 和机密状态；目标机重新建立 token、路径和本机凭据。不要把运行中的数据库目录放进网盘同步后让两台机器同时写入。项目部分数据库使用 WAL；SQLite 明确要求 WAL 的数据库使用者处于同一主机。[SQLite WAL 限制](https://www.sqlite.org/wal.html)

`DOCKER_HOST` 只选择 Docker daemon。远端 daemon 的 bind mount 路径属于远端机器，不能凭该变量自动获得客户端文件；当前每台 Mac 应使用自己的本地 runtime。[Docker bind mount 边界](https://docs.docker.com/engine/storage/bind-mounts/)

## 本次结论与下一步

路径、provider 与 Docker 配置已集中实现。第二台全新 Mac 的独立安装、升级和版本化构件发布仍保留各自验收范围；公开二进制发布同时需要权利审查与发布者签名条件。Intel Mac 需要自己的构件与验收记录，当前 Mac 支持范围继续明确为 Apple Silicon。Windows 当前分支的物理机器端到端验收见 [Windows 部署文档](WINDOWS-DOCKER-PORTABILITY.md)。
