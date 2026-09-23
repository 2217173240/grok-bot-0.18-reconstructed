import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import createIgnore from "ignore";

import { resolvePackagedAppArtifacts } from "../scripts/lib/packaged-app.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("packaged verification authority is the selected app bundle", () => {
  const appPath = path.join(repoRoot, "dist", "Example.app");
  const artifacts = resolvePackagedAppArtifacts(appPath);
  assert.equal(artifacts.appPath, appPath);
  assert.equal(artifacts.asarPath, path.join(appPath, "Contents", "Resources", "app.asar"));
  assert.equal(artifacts.unpackedPath, `${artifacts.asarPath}.unpacked`);
  assert.notEqual(artifacts.asarPath, path.join(repoRoot, ".build", "app.asar"));
  assert.throws(() => resolvePackagedAppArtifacts(path.join(repoRoot, ".build", "app.asar")), /\.app bundle/);
});

test("publication ignore rules retain reconstructed frontend source", async () => {
  const ignoreRules = await readFile(path.join(repoRoot, ".gitignore"), "utf8");
  assert.match(ignoreRules, /^\/recovered\/$/m);
  assert.doesNotMatch(ignoreRules, /^recovered\/$/m);
  const retained = "frontend/src/recovered/ui/sand-form-primitives.css";
  const matcher = createIgnore().add(ignoreRules);
  assert.equal(matcher.ignores(retained), false, `${retained} must remain addable in a fresh repository`);
  assert.equal(matcher.ignores("recovered/generated-output.txt"), true, "root recovery output must remain ignored");
});

test("default packaging keeps the checksum-pinned renderer and verifies the reconstructed app", async () => {
  const source = await readFile(path.join(repoRoot, "scripts", "package-macos.mjs"), "utf8");
  assert.match(source, /await buildFidelityReconstructedAsar\(\)/);
  assert.match(source, /await verifyOfficialMacReference\(\{ runtimeApp \}\)/);
  assert.match(source, /await verifyReconstructedMacPackage\(\{/);
});

test("Router settings use the trusted backend and display recorded inference usage", async () => {
  const rendererPatch = await readFile(path.join(repoRoot, "scripts", "lib", "router-renderer-patch.mjs"), "utf8");
  const preload = await readFile(path.join(repoRoot, "source", "electron-preload", "preload.ts"), "utf8");
  const mainEdge = await readFile(path.join(repoRoot, "source", "electron-main", "main-edge.ts"), "utf8");
  const inference = await readFile(path.join(repoRoot, "source", "host", "extensions", "inference", "inference-service.ts"), "utf8");
  const cursorSession = await readFile(path.join(repoRoot, "source", "host", "extensions", "inference", "cursor-session.ts"), "utf8");
  const cursorBackend = await readFile(path.join(repoRoot, "source", "shared", "node", "cursor-backend", "cursor-inference.ts"), "utf8");
  const providers = await readFile(path.join(repoRoot, "source", "host", "extensions", "inference", "provider-session.ts"), "utf8");
  const codexDirect = await readFile(path.join(repoRoot, "source", "host", "extensions", "inference", "codex-direct-responses.ts"), "utf8");
  const turnShell = await readFile(path.join(repoRoot, "source", "host", "runner", "turn-run-shell.ts"), "utf8");
  const coordinatorMain = await readFile(path.join(repoRoot, "source", "node-agent-coordinator", "main.ts"), "utf8");
  // Both planes reach plugin tools through the same loopback bridge, so it lives
  // in shared code rather than beside one of them.
  const mcpBridge = await readFile(path.join(repoRoot, "source", "shared", "node", "mcp", "routed-mcp-bridge.ts"), "utf8");
  const localDocker = await readFile(path.join(repoRoot, "source", "electron-main", "box", "local-docker-host-connector.ts"), "utf8");
  const secretsIpc = await readFile(path.join(repoRoot, "source", "electron-main", "secrets", "secrets-ipc.ts"), "utf8");
  assert.match(rendererPatch, /desktop\.agent\.getInferenceRouter\(\)/);
  assert.match(rendererPatch, /desktop\.agent\.setInferenceRouter\(n\)/);
  assert.match(rendererPatch, /desktop\.agent\.getBoxRuntime\(\)/);
  assert.match(rendererPatch, /desktop\.agent\.setBoxRuntime\(r\)/);
  assert.match(rendererPatch, /role:"switch"/);
  assert.match(rendererPatch, /Use local Docker VM/);
  assert.match(rendererPatch, /onValueChange:l=>\{if\(l!==null\)void e\(l\)\}/);
  assert.match(rendererPatch, /desktop\.secrets\.upsert/);
  assert.doesNotMatch(rendererPatch, /settings\.router-provider\.v1/);
  assert.match(rendererPatch, /Usage for /);
  assert.match(rendererPatch, /Requests/);
  assert.match(rendererPatch, /Input tokens/);
  assert.match(rendererPatch, /Last used/);
  assert.match(rendererPatch, /Tracked activity/);
  assert.match(rendererPatch, /RRouterProviders\.filter/);
  assert.match(preload, /getInferenceRouter: \(\) => edge\("getInferenceRouter"\)/);
  assert.match(preload, /getBoxRuntime: \(\) => edge\("getBoxRuntime"\)/);
  assert.match(preload, /setBoxRuntime: \(mode: string\) => edge\("setBoxRuntime", \{ mode \}\)/);
  assert.match(mainEdge, /syncHostSettingsToBox\(\{ inferenceProvider: provider \}\)/);
  assert.match(mainEdge, /invoke\(deps\.settingsStore, "setInferenceProvider", provider\)/);
  assert.match(mainEdge, /return \{ provider, usage:/);
  assert.match(mainEdge, /invoke\(deps\.boxRecovery, "restartCoordinator"\)/);
  assert.match(mainEdge, /mode === "local-docker"\) await startLocalDockerBox\(settingsPath\); else await stopLocalDockerBox\(\)/);
  assert.match(mainEdge, /setBoxRuntime", mode === "local-docker" \? "remote" : "local-docker"/);
  assert.match(localDocker, /public\.ecr\.aws\/k0i0n2g5\/cursorenvironments\/universal:sand-box-latest/);
  assert.match(localDocker, /"127\.0\.0\.1:1340:1340"/);
  assert.match(localDocker, /SAND_BOX_AUTO_UPDATE=0/);
  assert.match(localDocker, /dst=\/home\/box\/sand-host,readonly/);
  // The staged host tree carries its runtime siblings (agent-isolation and
  // extension workers) — an in-box turn died on a missing worker when the
  // mount was the single entry file.
  assert.match(localDocker, /LOCAL_HOST_RUNTIME_LAYOUT_VERSION = "3"/);
  // The staged directory is named after the host bundle AND the exec daemon, so
  // a daemon-only rebuild is drift too: without this the container keeps the old
  // daemon mounted while reporting itself current, and pruning can then delete
  // the directory it still reads.
  assert.match(localDocker, /const daemonDrifted = inspected\.boxExecDaemonSha256 !== hostBundle\.boxExecDaemonSha256/);
  assert.match(localDocker, /readMountedLocalHostRuntime/);
  assert.match(localDocker, /isLocalAdminEnabled\(\) \|\| settings\.getBoxRuntime\(\) === "local-docker"/);
  assert.match(inference, /recordInferenceUsage\(provider/);
  assert.match(inference, /routerSettings\.getInferenceProvider\(\)/);
  assert.match(inference, /typeof extendedUsage\.then === "function"/);
  assert.match(inference, /createProviderPromptSession\(provider\)/);
  assert.match(providers, /https:\/\/chatgpt\.com\/backend-api\/codex/);
  assert.match(providers, /headers\.set\("ChatGPT-Account-Id", credentials\.accountId\)/);
  assert.match(providers, /streamCodexDirectResponses/);
  assert.doesNotMatch(providers, /provider\.responses\(configuredCodexModel\(\)\)/);
  assert.match(codexDirect, /store: false/);
  assert.match(codexDirect, /response\.output_text\.delta/);
  assert.match(codexDirect, /type: "function_call_output"/);
  assert.match(providers, /parameters: jsonSchema\(parameters\)/);
  assert.match(providers, /You are Grok Bot, a warm, concise desktop assistant/);
  assert.match(providers, /mcpServers: \{ grok_bot_plugins:/);
  assert.match(providers, /recordRoutedUsage\(provider, usage\)/);
  assert.match(providers, /queryClaude/);
  // Routed Claude Code turns must carry real, audited local tools — never the
  // stock empty tool list that made the model fabricate command output.
  assert.match(providers, /tools: \[\.\.\.CLAUDE_LOCAL_TOOLS,/);
  assert.match(providers, /canUseTool: async \(toolName, input\)/);
  assert.match(providers, /claudeToolPermission\(toolName, input, options\?\.localToolPermission\)/);
  assert.match(providers, /mac-permission-denied/);
  // Local tool access set to "Never" must reach the in-box CLI child: the box
  // workspace is bind-mounted from the user's machine, so those tools act there.
  assert.match(providers, /localToolPermission === "never" && !CLAUDE_BOX_READ_TOOLS\.has\(toolName\)/);
  // The in-box CLI child reaches plugin tools through a loopback bridge, so
  // the tools must be advertised and the bridge closed with the stream.
  assert.match(providers, /createRoutedMcpBridge\(\{ listTools: \(\) => mcp\.listTools\(\), callTool: tool => mcp\.callTool\(tool\) \}\)/);
  assert.match(providers, /mcpServers: \{ grok_bot_plugins: \{ type: "http" as const, url: mcpServerUrl \} \}/);
  assert.match(providers, /maxTurns: 24/);
  assert.match(providers, /xtest-input-local\.py/);
  assert.match(providers, /do not fall back to curl/);
  // Sensitive-input discipline (C2): typed desktop input is redacted in the
  // ledger copy, the ledger is 0600, and the agent never handles credentials.
  assert.match(providers, /Never handle credentials yourself/);
  assert.match(providers, /display notification/);
  assert.match(await readFile(path.join(repoRoot, "source/shared/node/local-admin-intercept.ts"), "utf8"), /redactTypedDesktopInput/);
  // Session persistence (C3, S-7): the browser profile rides the data volume
  // so a handoff login survives container replacement; the Archive
  // session-sync daemon mirrors login state across screens (no-op single).
  const dockerfile = await readFile(path.join(repoRoot, "docker", "arm64-exec-box.Dockerfile"), "utf8");
  assert.match(dockerfile, /ln -s \/home\/box\/sand-data\/chrome-profile \/home\/box\/chrome-profile/);
  assert.match(await readFile(path.join(repoRoot, "docker", "bin", "box-init-exec"), "utf8"), /session-sync\.mjs/);
  // Egress gate (C4, S-8): navigation passes a private/reserved destination
  // check with a ledger line; the browser proxy rides MAC_BOT_PROXY.
  const navigate = await readFile(path.join(repoRoot, "docker", "bin", "box-navigate"), "utf8");
  assert.match(navigate, /isBlockedV4/);
  assert.match(navigate, /kind: "egress-gate"/);
  assert.match(navigate, /Page\.navigate/);
  assert.match(localDocker, /MAC_BOT_PROXY=\$\{process\.env\.SAND_BOT_PROXY\.trim\(\)\}/);
  assert.match(providers, /box-navigate/);
  assert.match(providers, /cwd: resolveAgentWorkspace\(\)/);
  assert.match(providers, /Never simulate, guess, or invent command output/);
  // Local-admin turns carry the local identity: the assistant must know it IS
  // the sandbox and never present cursor/xai remotes as its backend.
  assert.match(providers, /there is no cloud sandbox behind you/i);
  // The identity block is gated on local admin, and the desktop primitives are
  // composed per execution plane: the box has no docker CLI, so in-box prompts
  // must name the wrappers directly. tests/local-admin-desktop-primitives.test.mjs
  // asserts the composed prompt for both planes.
  assert.match(providers, /localAdminDesktopPrimitiveLines/);
  assert.match(providers, /SAND_HOST_IN_BOX/);
  // The human-handoff contract (C1): the identity teaches the ask protocol
  // with the staleness note; the box gate wraps shell/stream/computer use.
  assert.match(providers, /ask-human\.json/);
  assert.match(providers, /it dies with a container restart/);
  const awaiting = await readFile(path.join(repoRoot, "source", "host", "box", "awaiting-human.ts"), "utf8");
  assert.match(awaiting, /AWAITING_HUMAN_DEFAULT_TIMEOUT_MS = 15 \* 60 \* 1000/);
  assert.match(awaiting, /REPEATED ask while awaiting must NOT/);
  assert.match(await readFile(path.join(repoRoot, "source", "host", "box", "production.ts"), "utf8"), /withAwaitingHuman\(withNoMonitorComputerUse\(primary\.remoteAccessor\)\)/);
  assert.match(await readFile(path.join(repoRoot, "source", "host", "box", "production.ts"), "utf8"), /resourceEntry\(shellExecutorResource/);
  assert.doesNotMatch(providers, /tools: mcpServerUrl == null \? \[\]/);
  assert.match(providers, /https:\/\/openrouter\.ai\/api\/v1/);
  assert.match(providers, /OpenRouter needs OPENROUTER_API_KEY/);
  assert.match(cursorSession, /routedProvider !== "cursor"/);
  assert.match(cursorSession, /createProviderPromptSession\(routedProvider\)/);
  assert.match(cursorBackend, /routedProvider !== "cursor"/);
  assert.match(cursorBackend, /createProviderPromptSession\(routedProvider\)/);
  assert.doesNotMatch(rendererPatch, /ANTHROPIC_API_KEY|OPENAI_API_KEY/);
  assert.match(turnShell, /inferenceProvider === "cursor"/);
  assert.match(turnShell, /createProviderPromptSession\(inferenceProvider\)/);
  assert.match(coordinatorMain, /return await gatewayDispatch\(method, args, signal\)/);
  assert.doesNotMatch(mcpBridge, /openWorldHint: !readOnly/);
  assert.match(mcpBridge, /server\.listen\(0, "127\.0\.0\.1"/);
  assert.doesNotMatch(mcpBridge, /readOnlyHint: readOnly/);
  assert.match(mcpBridge, /request\.url !== `\/mcp\/\$\{secret\}`/);
  assert.doesNotMatch(coordinatorMain, /createCoordinatorInferenceRouter|routed\.handled/);
  assert.match(codexDirect, /type: "tool-call"/);
  assert.match(codexDirect, /SimplePromptToolExecutor/);
  assert.match(secretsIpc, /persistBoxSecretsSnapshot/);
  assert.match(secretsIpc, /macSecretsPath/);
  assert.match(secretsIpc, /await persistBoxSecretsSnapshot\([\s\S]*?await deps\.setBoxSecrets/);
  assert.match(secretsIpc, /errorClass: "box_unreachable"/);
  assert.match(await readFile(path.join(repoRoot, "source/shared/node/local-admin.ts"), "utf8"), /SAND_LOCAL_ADMIN_ENV = "SAND_LOCAL_ADMIN"/);
  assert.match(await readFile(path.join(repoRoot, "source/electron-main/account/cursor-auth.ts"), "utf8"), /if \(this\.localAdminEnabled\)/);
  assert.match(localDocker, /isLocalAdminEnabled\(\) \|\| settings\.getBoxRuntime\(\) === "local-docker"/);
  assert.match(localDocker, /if \(isLocalAdminEnabled\(\)\) \{/);
  assert.match(localDocker, /export function resolveDockerHost/);
  // Local admin selects Docker before connecting, then returns the container
  // gateway. A failed Docker connection must propagate instead of switching
  // to a Mac host process.
  assert.match(localDocker, /resolveLocalAdminBox\(process\.env, await probeDockerAvailable\(\)\)/);
  assert.match(localDocker, /const connection = await ensureLocalDockerBox\(settings\.settingsPath, undefined\)/);
  assert.doesNotMatch(localDocker, /ensureLocalAdminHost\(/);
  assert.match(localDocker, /resolveLocalAdminBox/);
  assert.match(localDocker, /if \(!dockerAvailable\) throw new Error\("Docker sandbox is unavailable/);
  assert.match(localDocker, /refusing to silently fall back to the emulated official image/);
  assert.match(localDocker, /SELF_BUILT_EXEC_BOX_IMAGE/);
  // The default-path fallback (self-built image missing, no explicit pin) is
  // annotated, never silent: the choice maps to an intercept record and the
  // status surface carries the same warning.
  assert.match(localDocker, /official-image-qemu-fallback/);
  assert.match(localDocker, /officialImageQemuFallbackRecord\(imageChoice\)/);
  assert.match(await readFile(path.join(repoRoot, "start-local.sh"), "utf8"), /self-built arm64 image missing/);
  // One workspace, one owner: the container's /workspace is a bind mount of
  // the Mac-side directory, and the daemon root, agent cwd, and Mac alias all
  // converge on it (F2).
  assert.match(localDocker, /SAND_AGENT_WORKSPACE=\/workspace/);
  assert.match(localDocker, /SAND_WORKSPACE_ROOT=\/workspace/);
  assert.match(localDocker, /workspace-bind-mount/);
  assert.match(await readFile(path.join(repoRoot, "source", "host", "main.ts"), "utf8"), /SAND_WORKSPACE_ROOT\?\.trim\(\) \|\| path\.join\(getSandRootDir\(\), "box-workspace"\)/);
  // The container gate must exercise the daemon's real wire (ConnectRPC on
  // 1337, Bearer credential, workspace cwd) — not a docker-exec shell that
  // bypasses protocol, token, and path mapping (F3).
  const smoke = await readFile(path.join(repoRoot, "source", "box-exec-daemon", "smoke.ts"), "utf8");
  assert.match(smoke, /SAND_BOX_EXEC_DAEMON_AUTH_TOKEN/);
  assert.match(smoke, /message\.case !== "shellResult"/);
  assert.match(smoke, /workingDirectory: "\/workspace"/);
  const gates = await readFile(path.join(repoRoot, "docker", "container-gates.sh"), "utf8");
  assert.match(gates, /scripts\/daemon-smoke\.mjs/);
  assert.doesNotMatch(gates, /bash -c "echo \$MARKER"/);
  assert.match(gates, /15s performance sentinel/);
  assert.match(await readFile(path.join(repoRoot, "docker", "run-arm64-box.sh"), "utf8"), /SAND_WORKSPACE_ROOT=\/workspace/);
  // Image freshness pin (A-3): one canonical implementation feeds the package
  // stamp, the image label, and the gate; a present-but-stale image is
  // refused with the rebuild action and must never reach the QEMU fallback.
  assert.match(localDocker, /SELF_BUILT_DEPS_PIN_LABEL = "com\.grok-bot\.local-vm\.deps-pin"/);
  assert.match(localDocker, /stale-image-refused/);
  assert.match(localDocker, /refusing to run outdated dependencies or to silently fall back/);
  assert.match(await readFile(path.join(repoRoot, "scripts", "package-macos.mjs"), "utf8"), /depsPin/);
  assert.match(await readFile(path.join(repoRoot, "docker", "build-arm64-box.sh"), "utf8"), /com\.grok-bot\.local-vm\.deps-pin=/);
  assert.match(gates, /G0 image deps pin/);
  // Desktop opt-in (B1): box-init-exec topology, mode label, opt-in env.
  assert.match(localDocker, /SAND_LOCAL_ADMIN_DESKTOP_ENV = "SAND_LOCAL_ADMIN_DESKTOP"/);
  assert.match(localDocker, /box-init-exec/);
  assert.match(localDocker, /inspected\.desktop !== desktop/);
  assert.match(await readFile(path.join(repoRoot, "docker", "bin", "box-init-exec"), "utf8"), /exec \/usr\/local\/bin\/node/);
  // noVNC auth (S-2): randomly minted token, never the display number; the
  // takeover URL rides the path=websockify?token= form (noVNC 1.6.0 silently
  // ignores a top-level ?token=) and lands Mac-side via the workspace mount.
  const boxInitExec = await readFile(path.join(repoRoot, "docker", "bin", "box-init-exec"), "utf8");
  assert.match(boxInitExec, /head -c 32 \/dev\/urandom/);
  assert.match(boxInitExec, /websockify\?token=%s/);
  assert.match(boxInitExec, /novnc-url/);
  assert.match(localDocker, /127\.0\.0\.1:6080:6080/);
  // The real Computer tool (B3): XTEST input via the in-image helper plus
  // desktop-level screenshots, mounted only under the desktop opt-in.
  const localComputerUse = await readFile(path.join(repoRoot, "source", "host", "box", "local-computer-use.ts"), "utf8");
  assert.match(localComputerUse, /xtest-input-local\.py/);
  assert.match(localComputerUse, /LOCAL_DESKTOP_GEOMETRY = \{ width: 1280, height: 800 \}/);
  assert.match(localComputerUse, /xwd -root/);
  assert.match(localComputerUse, /cursor position query is not available/);
  assert.match(await readFile(path.join(repoRoot, "source", "host", "box", "production.ts"), "utf8"), /localDesktopComputerUseEnabled\(\)\s*\?\s*\(accessor => generated\.withLocalDesktopComputerUse\(accessor\)\)/);
  assert.match(await readFile(path.join(repoRoot, "source", "host", "box", "generated-production.ts"), "utf8"), /resourceEntry\(computerUseExecutorResource, localComputerUseExecutor\)/);
  assert.match(await readFile(path.join(repoRoot, "docker", "arm64-exec-box.Dockerfile"), "utf8"), /xtest-input-local\.py/);
  // Dual gate profiles (S-4): exec keeps every current assertion; desktop
  // adds the plane's own contract (geometry, ports, dual auth, computer
  // round-trip, death semantics); memory caps ride both plans.
  assert.match(gates, /--profile exec\|desktop/);
  assert.match(gates, /run_desktop_gates/);
  assert.match(gates, /D3 noVNC auth dual-direction/);
  assert.match(localDocker, /"--memory", options\.desktop === true \? "4g" : "2g"/);
  assert.match(await readFile(path.join(repoRoot, "start-local.sh"), "utf8"), /GROKBOT_DESKTOP=0 for headless exec/);
  assert.match(await readFile(path.join(repoRoot, "docker", "arm64-exec-box.Dockerfile"), "utf8"), /box-init-exec/);
  assert.match(await readFile(path.join(repoRoot, "start-local.sh"), "utf8"), /GROKBOT_DESKTOP/);
  assert.match(localDocker, /stopLocalAdminHost\(\);/);
  // Local admin never mints official credentials.
  assert.match(await readFile(path.join(repoRoot, "source/electron-main/box/box-host-connector.ts"), "utf8"), /if \(isLocalAdminEnabled\(\)\) return undefined;/);
  // Plugins without OAuth: mcp-servers.json feeds BOTH MCP managers via one
  // shared source swap, and the desktop marketplace surface stays local.
  assert.match(await readFile(path.join(repoRoot, "source/shared/node/mcp/local-mcp-servers.ts"), "utf8"), /applyLocalAdminMcpSources/);
  assert.match(await readFile(path.join(repoRoot, "source/host/extensions/mcp/mcp-service.ts"), "utf8"), /applyLocalAdminMcpSources\(\{/);
  assert.match(await readFile(path.join(repoRoot, "source/electron-main/mcp/desktop-mcp-manager.ts"), "utf8"), /createLocalMcpServersFileWriter\(getSandRootDir\(\)\)/);
  assert.match(await readFile(path.join(repoRoot, "source/electron-main/mcp/mcp-desktop.ts"), "utf8"), /marketplaceUnavailable \? \[\]/);
  assert.match(await readFile(path.join(repoRoot, "source/shared/node/cursor-backend/cursor-inference.ts"), "utf8"), /Cursor inference is unavailable in local admin mode/);
  assert.match(await readFile(path.join(repoRoot, "source/shared/node/local-admin-intercept.ts"), "utf8"), /blocked-fetch/);
  assert.match(await readFile(path.join(repoRoot, "source/electron-main/main.ts"), "utf8"), /password-store", "basic"/);
  assert.match(await readFile(path.join(repoRoot, "source/electron-main/secrets/secret-store.ts"), "utf8"), /if \(isLocalAdminEnabled\(\)\) return false;/);
  assert.match(await readFile(path.join(repoRoot, "source/electron-main/box/box-host-connector.ts"), "utf8"), /SAND_LOCAL_ADMIN forbids EnsureSandBox/);
});
