# 全套本地 Grok Bot 部署手册（另一台 Mac 从零跑起来）

> 基线：`origin/main@671541a`（PR #28 已含第二轮翻转：**轮次默认在盒内执行**、桌面默认开）。
> 撰写时 PR #29（盒内回合 text-delivery seam）open 未合并——若已合并则直接用 main 最新。
> 本手册按"构建链 → 打包链 → 数据面 → 启动链 → 验证链"完整展开，来源为源机逐项扫描，非记忆。

## 0. 你要在新 Mac 上复刻的是什么

```text
/Applications/Grok Bot 0.18 Reconstructed.app   ← 界面+协调器（Electron，本地打包）
~/.grokbot-local/                               ← 数据面（token/设置/工作区/账本）
Colima VM (aarch64) ── grok-bot-local-vm 容器    ← 计算机（Linux 桌面+浏览器+执行）
        box-init-exec（桌面后台） → node host-main.cjs（PID1）
        → host 拉起 box-exec-daemon(1337) → gateway(1340) → App 连接
推理：GLM 的 Anthropic 兼容端点（`open.bigmodel.cn`）——唯一运行期外部依赖，**只需要一个 GLM API key**，其余全部内置（见 §6）
```

三条链，缺一不可：

| 链 | 产物 | 一次性/常驻 |
| --- | --- | --- |
| 构建链 | `grok-box-base:arm64`（Archive Dockerfile，31 步）+ `grok-bot-exec-box:arm64`（薄层） | 一次性（deps-pin 变更才重建） |
| 打包链 | `dist/Grok Bot 0.18 Reconstructed.app` → 拷入 `/Applications` | 每次 app 代码变更 |
| 启动链 | `start-local.sh start` → App → 容器 → 网关健康 | 每次开机后 |

## 1. 前置条件（新 Mac 清单）

- macOS **Apple Silicon**（arm64 原生是整个方案的前提；Intel Mac 会整体落 QEMU，性能失义）
- Xcode Command Line Tools：`xcode-select --install`（原生模块编译需要）
- **mise**（Node 版本管理；仓库钉 `.node-version`=26.5.0）：`brew install mise` 并启用 shims。打包环境实测要求：mise node 26.5.0、`CXX=clang++`、`CXXFLAGS=-std=c++20`（tree-sitter 原生编译，c++17 会撞 Node 24+ 的 V8 头）
- Docker CLI + **Colima**：`brew install docker colima`
- Git；Git LFS（`brew install git-lfs && git lfs install`——仅 research-archives 指针需要，无 LFS 也可走 URL 下载）
- 磁盘：≥25GB（Colima 磁盘 30GB + 镜像 ~5.4GB + 仓库/构建 ~5GB）
- 一个 **GLM API key**（[open.bigmodel.cn](https://open.bigmodel.cn) 的 Anthropic 兼容端点；这是运行期唯一推理依赖——不需要 Cursor/xAI/Claude/OpenRouter 的任何账号或 key。本项目通过 Anthropic 协议兼容层把 Claude Code 工具链整体路由到 GLM，模型位映射已内置）
- 网络可达（一次性构建期）：downloads.cursor.com（官方 0.18 DMG，SHA 钉死）、nodejs.org、github.com（bun/uv/node 资产）、registry.npmjs.org；运行期：`open.bigmodel.cn`（推理）+ 盒内浏览器的目标站点

## 2. 取代码（两个仓库）

```sh
# 主仓库（重建版 bot）
git clone https://github.com/2217173240/grok-bot-0.18-reconstructed.git
cd grok-bot-0.18-reconstructed && git checkout 671541a   # 或 main 最新

# Archive 仓库（base 镜像的 Dockerfile 来源——外部依赖，别漏）
# 拷贝源机的 /Users/xinheyun/Desktop/grok-compare/Archive 即可（它不在 GitHub 上）
# 注意：Archive 仓库路径任意，但必须在 /Users 下（见 §3 Colima 挂载限制）
```

> 若无源机 Archive 副本：base Dockerfile 依赖其中 `box-image/Dockerfile` + `box-image/bin/*` 全套脚本（桌面治理/box-chrome/路由/会话同步），缺一不可，务必完整拷贝。

## 3. 镜像链（二选一）

### 方式 A：从源机迁移镜像（快，推荐）

```sh
# 源机：
docker save grok-box-base:arm64 -o /tmp/base.tar
docker save grok-bot-exec-box:arm64 -o /tmp/exec-box.tar
# 传到新机后：
docker load -i base.tar && docker load -i exec-box.tar
docker image inspect grok-bot-exec-box:arm64 --format '{{index .Config.Labels "com.grok-bot.local-vm.deps-pin"}}'
# ^ 记下这个 pin；若与主仓库当前 deps-pin 不一致（见 §4 后的 pin 校验），走方式 B 重建薄层
```

### 方式 B：新机构建（约 30-60 分钟）

```sh
# 1) Colima VM（源机参数，照抄）：aarch64 / 4C / 6GiB / 30GiB
colima start --cpu 4 --memory 6 --disk 30 --arch aarch64
# ⚠ Colima 默认只共享 /Users —— 仓库和数据根必须在 /Users 下，/tmp 下的 bind mount 对容器不可见（实测坑）

# 2) base 镜像（Archive 仓库根为上下文；31 步全过为成功判据）
cd <archive-repo>
docker build --platform linux/arm64 -f box-image/Dockerfile -t grok-box-base:arm64 .

# 3) 薄层（自带临时小上下文，避免把仓库 node_modules 撑进去）
cd <grok-bot-repo>
docker/build-arm64-box.sh
# 成功判据：构建日志含 "tree-sitter loads natively" 和 "node:sqlite available"
```

**deps-pin 三处对账**（防"仓库依赖升了、镜像里还是旧的"）：pin = sha256(package-lock.json ‖ scripts/apply-third-party-patches.mjs ‖ docker/arm64-exec-box.Dockerfile)，同时存在于 App 的 build-stamp、镜像 label、门禁 G0。任一不符：`docker/build-arm64-box.sh` 重建薄层（base 不用动）。

## 4. 打包链（App 本体）

```sh
cd <grok-bot-repo>
npm ci                # postinstall 自动跑 native:patch（tree-sitter binding.gyp 的 c++20 补丁）
                      # ⚠ node_modules 重装会冲掉补丁——postinstall 会重打，但若手动 npm install 后构建报
                      #   "concept/requires" 编译错，先跑: npm run native:patch
npm run bootstrap     # 下载官方 0.18 DMG（downloads.cursor.com/sand/…，SHA-256 钉死校验）
                      #   缓存 Electron 运行时、hydrate src/app。
                      #   已有原版 App 可 GROKBOT_BOT_018_APP=<path> 跳过下载（重建版 App 会被拒）
npm run package       # check(typecheck×2+测试) → 编译 → asar → ad-hoc 签名 → dist/
# 产物：dist/Grok Bot 0.18 Reconstructed.app
ditto "dist/Grok Bot 0.18 Reconstructed.app" "/Applications/Grok Bot 0.18 Reconstructed.app"
```

排错要点：
- **打包静默失败**是这个仓库栽过的坑——装完后看 `Contents/Resources/build-stamp.json` 的 `sourceRevision` 是否等于 `git rev-parse HEAD`；不等 = 旧包，重跑 `npm run package`。
- `.cache/` 运行时缓存被删 → bootstrap 会重新下载 DMG，属正常路径，不要往缓存里塞重建版 App（校验会拒，且曾污染打包）。

## 5. 数据面（`~/.grokbot-local/`）

**手工必备（只有一项）**：

```sh
mkdir -p ~/.grokbot-local
echo '把你的 GLM API key 原样粘到这里' > ~/.grokbot-local/anthropic-token   # ← 全项目唯一要填的密钥
chmod 600 ~/.grokbot-local/anthropic-token
```

**为什么只需这一个 key**：推理走 GLM 的 Anthropic 兼容端点（`start-local.sh` 已写死 `ANTHROPIC_BASE_URL` 并把 Claude Code 的全部模型位映射到 GLM）；真 key 只住这个 0600 文件，由 provider 层在拉起 CLI 子进程时注入——环境变量里的 `ANTHROPIC_API_KEY` 只是过登录检查的非秘密标记。Cursor 认证被本地 JWT 短路、xAI 后端被钉死到 loopback 拒连，两者都不需要任何凭据。

**自动生成（勿手工造）**：`settings.json`（首启 seed：claude-code + local-docker）、`local-docker-vm.json`（容器 gateway token）、`local-docker-runtime/v3-*`（staged host 树，App 自动维护）、`box-workspace/`（容器 /workspace 的 Mac 侧）、`local-intercept.jsonl`（审计账本）、`box-mode`。

**可选迁移（从源机拷）**：`mcp-servers.json` + `demo-mcp-server.cjs`（本地 MCP 插件源，二者的 Mac 路径已适配共享工作区）、`box-secrets.json`（Saved keys 镜像）。不拷则插件面为空，不影响主线。

**可选挂载**：若要用 Codex/Claude 原生登录态，`~/.codex`、`~/.claude` 存在即被只读挂进容器（`/root/.codex`、`/root/.claude`）；默认推理路线不需要。

## 6. 启动链

```sh
cd <grok-bot-repo>
./start-local.sh start
```

脚本做的事（顺序即依赖序）：回收孤儿 host → 判定 1340 端口持有者（Docker 计算机的端口转发是合法持有者）→ seed settings → 导出环境（见下表）→ 校验 build-stamp ↔ HEAD → **直启 binary**（不走 `open`，否则环境被剥）→ 有界等待 45s 网关健康（`127.0.0.1:1340/health` + Bearer）。

**环境开关表**（`start-local.sh` 识别的）：

| 变量 | 默认 | 语义 |
| --- | --- | --- |
| `GROKBOT_BOX` | auto | `docker` 强制容器 / `host` 强制 Mac-host 进程 / auto=Docker 可达即容器 |
| `GROKBOT_TURN` | host（in-box） | `mac` 退回 Mac 协调器轮次面（结构回退，非默认） |
| `GROKBOT_DESKTOP` | 1 | `0` 退回无头 exec 面 |
| `GROKBOT_IMAGE` | 自建 arm64 | 钉任意镜像 tag；缺省时自建缺失→官方 ECR/QEMU 回退（**带账本标注**，状态面有黄字） |
| `GROKBOT_DATA_ROOT` | `~/.grokbot-local` | 数据根重定向 |

**推理配置（已内置，通常零配置）**：`start-local.sh` 导出 `ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic`、`SAND_CLAUDE_MODEL=glm-5.2`，并把 fable/haiku/opus/sonnet/主模型/子代理全部映射到 GLM 系列（glm-5.2 / glm-5.3 / glm-5.3-flash）。要换模型就改脚本这些行；key 见 §5 的 0600 文件，永远不进环境变量明文、不进 git。

其他子命令：`stop`（走 Apple quit 事件回收 host；容器**有意保留**——桌面会话/登录态/接管 URL 跨 App 重启存活）、`restart`、`status`（体检全量：计算机形态/镜像警告/工作区双径/插件数/host/gateway/接管 URL）、`logs`。

## 7. 验证链（按序，全绿才算部署成功）

```sh
./start-local.sh status
# 期望：app running；computer: desktop plane；gateway: healthy；
#       handover: http://127.0.0.1:6080/…（浏览器能打开 = noVNC 面通）

# 容器门禁（desktop profile，G0-G4 + D1-D5 十项，约 2-3 分钟）
docker/container-gates.sh --profile desktop
#   G0 镜像 pin / G1 网关有界就绪+冷启动哨兵 / G2 daemon ready / G3 1337 真执行链精确输出 / G4 无头纪律
#   D1 几何 / D2 端口 / D3 noVNC 双向鉴权（对 token 通、错 token 拒）/ D4 Computer 往返 / D5 桌面死语义

# 零远端证明（可选但推荐跑一次）
scripts/zero-remote-live.sh   # 断言账本零 cursor/xai 出网行

# UI 冒烟（最终判据）
# 问 bot："检查能否与云端的 sandbox 沟通"
# 期望：从本地现实作答（"我运行在 Linux 容器里，没有云端"），
#       它亮出的 uname/hostname 应是 Linux 指纹（in-box turn 生效的判据），
#       且不发任何对 grok.com/cursor.sh 的连通性验证。
```

## 8. 故障速查（按症状）

| 症状 | 首查 | 常因 |
| --- | --- | --- |
| `start` 报 missing token | `~/.grokbot-local/anthropic-token` | §5 手工项没做 |
| 网关 45s 不健康 | `./start-local.sh logs` + `box-logs/sand-host.log` 尾部 | 容器崩溃循环：看 `docker logs grok-bot-local-vm`（历史两案：数据卷 root 属主 EACCES、镜像 pin 过期） |
| `computer: docker unreachable` | `colima list` | Colima 没起；起后脚本自动发现 `~/.colima/*/docker.sock`（`/var/run/docker.sock` 不存在是常态，别手工造） |
| 镜像警告 self-built missing | `docker/build-arm64-box.sh` | 薄层没建（§3）；不建则默认走 QEMU 回退（能用但慢 8-16×，状态面有黄字标注） |
| G0 pin mismatch | 同上 | 仓库依赖变了：重建薄层即可，base 不用动 |
| tree-sitter 编译报 concept/requires | `npm run native:patch` 后重跑 package | node_modules 重装冲掉 c++20 补丁 |
| App 行为像旧代码 | `Contents/Resources/build-stamp.json` vs `git rev-parse HEAD` | 打包静默失败装了旧包（启动时也会大声警告） |
| 新会话在 UI 报 Agent failed | PR #29 是否合并；`docker logs` 查 TranscriptJournal | 盒内轮次的已知地雷区——门钉已防主要案，PR #29 在修 text-delivery；临时退避：`GROKBOT_TURN=mac` |
| noVNC 白屏/连不上 | `./start-local.sh status` 的 handover URL 是否本次启动签发 | token 随容器重启重签即作废——重新让 bot ask（这是设计，URL 不跨重启） |
| 容器替换循环 | `docker inspect grok-bot-local-vm` 的 labels（schema/pin/host-sha） | 契约漂移自动替换是正常自愈；若反复替换→对照 §3/§4 的 pin 与 staging |

## 9. 出网白名单（部署后网络审计用）

- **运行期必需**：`open.bigmodel.cn`（推理）；容器内浏览器访问的业务站点
- **一次性构建**：`downloads.cursor.com`（官方 DMG）、`nodejs.org`、`github.com`（bun/uv/node）、`registry.npmjs.org`
- **永不**：`api2/api3.cursor.sh`、`*.cursor.com`、`*.x.ai`（local-admin 拦截层设计性阻断；zero-remote 脚本可随时证明）
- 可选：`SAND_BOT_PROXY=<http代理>` 给盒内浏览器走代理（Clash 环境治 DNS 投毒；fake-IP 段已有部署级适配）

## 10. 源机特异性备忘（新机不需要复制，但要知道差异）

- Colima profile 名 `finonelib` 仅为源机命名，新机 `colima start` 默认 profile 即可——发现逻辑按 `~/.colima/*/docker.sock` 通配
- 源机 Clash fake-IP（198.18/15 段）触发了 egress 门的部署级适配；新机无 Clash 则走默认严格模式，行为更纯
- `docs/LEARNING-PYRAMID.*` 是未跟踪的旧资产，与本部署无关
- 源机工作区曾有未提交实验（已全部随 PR #28 合并）；新机从 git 干净起步，无此负担
