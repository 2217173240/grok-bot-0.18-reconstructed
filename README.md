# Grok Bot 0.18 Reconstructed

[![repository checks](https://github.com/2217173240/grok-bot-0.18-reconstructed/actions/workflows/check.yml/badge.svg)](https://github.com/2217173240/grok-bot-0.18-reconstructed/actions/workflows/check.yml)
**English · [简体中文](README.zh-CN.md)**

An unofficial reconstruction of the publicly released Grok Bot 0.18.0 macOS app, extended with a local Docker computer, configurable inference providers, and local MCP tools. The project lets you inspect and build the desktop runtime from readable source, then run an agent in a container with a third-party model API.

![Router settings in the reconstructed desktop app](docs/assets/router-settings.png)

## What this repository does

- **Runs the agent on your computer.** Local admin mode starts the host, execution daemon, desktop, browser, and agent turns in a Docker container by default. Docker or the required image being unavailable produces an error. Files live in a bind-mounted workspace; settings and transcripts remain local.
- **Routes inference.** Settings → Router offers Cursor, Claude Code, Codex, and OpenRouter. The local startup script selects Claude Code with an Anthropic-compatible API by default; its model and endpoint can be configured through environment variables. Provider tools differ, so availability in the Router does not imply identical tool support.
- **Connects local tools and plugins.** The container runs file and shell tools and hosts MCP servers configured in `mcp-servers.json`, including stdio processes and Streamable HTTP endpoints. Tool discovery, pagination, cancellation, and process shutdown have dedicated checks.
- **Rebuilds the desktop runtime.** Readable TypeScript under `source/` supplies Electron main, coordinator, host, execution, and protocol behavior. Packaging retains the checksum-pinned 0.18.0 renderer and applies a narrowly checked settings patch. `frontend/` is a readable partial reconstruction for development.
- **Keeps the build traceable.** Bootstrap verifies the original release input; native patches and renderer edits check their expected hashes. The resulting macOS app has its own bundle identity and an ad-hoc signature.

The tested local path uses a third-party model service. It does not require a Cursor or xAI response for the verified conversation, file, and MCP flow; it still needs that model service and any websites or remote MCP servers a task uses. The original 0.18.0 app is also required as a **build input**. See [Provenance](PROVENANCE.md) for the origin and limits of the reconstruction.

## Build the macOS app

Requirements: an Apple Silicon Mac, Node.js **26.5.0**, Xcode Command Line Tools, Git, and network access to install dependencies and obtain the pinned 0.18.0 release input. Git LFS can supply the preserved installer; if only its pointer is present, bootstrap downloads and verifies the original release.

```sh
git clone https://github.com/2217173240/grok-bot-0.18-reconstructed.git
cd grok-bot-0.18-reconstructed
npm ci
npm run bootstrap
npm run check
npm run package
```

The package is written to `dist/Grok Bot 0.18 Reconstructed.app`. `npm run bootstrap` accepts `GROK_BOT_018_APP` when you already have the matching original app. The original app installed on your Mac is left intact.

## Run the local container mode

This path also requires a running Docker-compatible daemon and the `linux/arm64` base image identified by [docker/base-image.json](docker/base-image.json). The base image is a separate, reviewed input; `docker/build-arm64-box.sh` checks its immutable digest before building `grok-bot-exec-box:arm64`. The [architecture and deployment notes](docs/LOCAL-SANDBOX-ARCHITECTURE.md) explain the image boundary and data paths.

```sh
docker/build-arm64-box.sh
ditto "dist/Grok Bot 0.18 Reconstructed.app" "/Applications/Grok Bot 0.18 Reconstructed.app"
install -d -m 700 "$HOME/.grokbot-local"
${EDITOR:-vi} "$HOME/.grokbot-local/anthropic-token"
chmod 600 "$HOME/.grokbot-local/anthropic-token"
./start-local.sh start
./start-local.sh status
```

Put your model provider's token in `anthropic-token` as a single line. The launcher defaults to `https://open.bigmodel.cn/api/anthropic` and model `glm-5.2`; set `ANTHROPIC_BASE_URL` and `SAND_CLAUDE_MODEL` when using another compatible service. The token file stays in the local data directory and is supplied to the container's provider process. The agent's shared files are under `~/.grokbot-local/box-workspace`.

`./start-local.sh` also supports `stop`, `restart`, and `logs`. The explicit `GROKBOT_BOX=host` and `GROKBOT_TURN=mac` settings select diagnostic execution on the Mac. The default uses Docker and executes turns inside the container. A working Docker image and an installed reconstructed app are required before `start` can succeed.

To add a local MCP server, create `~/.grokbot-local/mcp-servers.json` with the standard `mcpServers` object. The configured command runs inside the container with access to its mounted workspace; review plugin commands before using them. The [extension guide](docs/EXTENSIBILITY.md) identifies the provider, tool, and plugin integration points.

## What has been verified

The repository CI runs TypeScript checks, regression tests, an editable frontend build, and a clean Git archive check on pull requests and `main`. Local validation also exercised a real Linux Electron UI connected to an isolated container: a GLM-backed Claude SDK turn wrote and read a file, calculated its SHA-256, called a stdio MCP echo tool, and returned the result to the conversation. In that test network, Cursor and xAI destinations were blocked while the configured model endpoint remained available.

These results cover the tested Claude SDK path. Full tool equivalence across providers, a packaged macOS end-to-end run for every feature, and a build independent of the pinned upstream renderer remain open work. The [local architecture report](docs/LOCAL-SANDBOX-ARCHITECTURE.md) records the tested boundaries and remaining priorities.

## Repository guide

| Path | Purpose |
| --- | --- |
| [`source/`](source/) | Electron main, coordinator, host, box daemon, shared runtime, and protocols |
| [`frontend/`](frontend/) | Readable partial renderer reconstruction and design workspace |
| [`docker/`](docker/) | Local execution image, desktop scripts, and base-image identity |
| [`scripts/`](scripts/) | Bootstrap, deterministic patches, build, package, and verification |
| [`tests/`](tests/) | Runtime, provider, MCP, packaging, and publication checks |
| [`research-archives/original/0.18.0/`](research-archives/original/0.18.0/) | Preserved original installer identities and Git LFS pointers |

For development, run `npm run check`, `npm run frontend:build`, and `npm run publication:check`. macOS packaging uses `npm run package` followed by `npm run verify`. Contribution and CI rules are in [CONTRIBUTING.md](CONTRIBUTING.md); the code layout is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Report problems through [Issues](https://github.com/2217173240/grok-bot-0.18-reconstructed/issues).

This is an experimental, unofficial reconstruction of one pinned release. It does not include Anysphere's original source or a grant to redistribute it as an official build. Read [PROVENANCE.md](PROVENANCE.md) and [NOTICE.md](NOTICE.md) before reusing or distributing artifacts.
