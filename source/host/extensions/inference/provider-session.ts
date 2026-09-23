import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { query as queryClaude, type PermissionResult, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { createOpenAI } from "@ai-sdk/openai";
import { jsonSchema, zodSchema, streamText, tool, type CoreMessage, type LanguageModelV1, type ToolSet } from "ai";
import { z } from "zod";

import { BasePromptBuilder, BasePromptExecutor } from "../../../packages/chat-inference/base.js";
import type { Context } from "../../../packages/context/core.js";
import type { SandInferenceProvider } from "../../../shared/inference-router.js";
import { parseBoxSecretsSnapshot } from "../../../shared/node/box-secrets-store.js";
import { resolveClaudeCodeCliPath } from "../../../shared/node/inference-router-local.js";
import type { SandLocalToolPermission } from "../../../shared/local-tool-permission.js";
import { isLocalAdminEnabled } from "../../../shared/node/local-admin.js";
import { appendLocalIntercept, redactTypedDesktopInput } from "../../../shared/node/local-admin-intercept.js";
import { getSandRootDir } from "../../host-paths.js";
import { SandSettingsStore } from "../../../shared/node/settings/sand-settings-store.js";
import { getBoxSecretsStorePath } from "../secrets/secrets-service.js";
import { streamCodexDirectResponses, type CodexDirectTool } from "./codex-direct-responses.js";
import { createRoutedMcpBridge } from "../../../shared/node/mcp/routed-mcp-bridge.js";
import type { LabelMessage, PromptExecutor } from "./sand-labeling.js";

type Loose = Record<string, any>;
interface ProviderMessage extends LabelMessage { role: string; content: string | readonly unknown[] }
type RoutedProvider = Exclude<SandInferenceProvider, "cursor">;
type UsageRecord = { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };

const GROK_ROUTER_SYSTEM_PROMPT = [
  "You are Grok Bot, a warm, concise desktop assistant.",
  "You are running inside Grok Bot, not inside Codex CLI or Claude Code.",
  "The tools supplied with this request are Grok Bot's already-connected plugins and accounts. Use them whenever they are relevant instead of claiming that a plugin is unavailable or asking the user to reconnect it.",
  "Never ask for an API key for an already-connected plugin. Respond directly to the user in natural language after completing any necessary tool calls.",
].join("\n");

function recordRoutedUsage(provider: RoutedProvider, usage: UsageRecord): void {
  new SandSettingsStore(join(getSandRootDir(), "settings.json")).recordInferenceUsage(provider, usage);
}

function persistedSecrets(): Record<string, string> {
  try {
    return parseBoxSecretsSnapshot(JSON.parse(readFileSync(getBoxSecretsStorePath(), "utf8")) as unknown) ?? {};
  } catch { return {}; }
}

function openRouterCredential(): string {
  const value = process.env.OPENROUTER_API_KEY?.trim() || persistedSecrets().OPENROUTER_API_KEY?.trim();
  if (value == null || value.length === 0) throw new Error("OpenRouter needs OPENROUTER_API_KEY. Add it in Settings → Router.");
  return value;
}

function providerPrompt(messages: readonly ProviderMessage[], extraGuidance?: string): string {
  const rendered = messages.map(message => {
    const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    return `${message.role.toUpperCase()}: ${content}`;
  }).join("\n\n");
  return `${GROK_ROUTER_SYSTEM_PROMPT}${extraGuidance == null || extraGuidance.length === 0 ? "" : `\n\n${extraGuidance}`}\n\nContinue this Grok Bot conversation.\n\n${rendered}`;
}

function deferred<T>() { return Promise.withResolvers<T>(); }

// The inference token reaches the Claude CLI child only — the desktop app's
// own environment (readable via ps eww) carries at most a non-secret marker.
// Resolution order: existing env token (compat), then the 0600 token file in
// the sand root.
export function claudeChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...env };
  let token = env.ANTHROPIC_AUTH_TOKEN?.trim();
  if (token == null || token.length === 0) {
    // The host's sand root is <root>/box-data while the desktop's is <root>;
    // accept the token file at either level.
    const root = getSandRootDir();
    for (const candidate of [join(root, "anthropic-token"), join(dirname(root), "anthropic-token")]) {
      try {
        const fromFile = readFileSync(candidate, "utf8").trim();
        if (fromFile.length > 0) { token = fromFile; break; }
      } catch {}
    }
  }
  if (token != null && token.length > 0) {
    childEnv.ANTHROPIC_AUTH_TOKEN = token;
    childEnv.ANTHROPIC_API_KEY = token;
  }
  return childEnv;
}

function response(text: string, id: string, modelId: string, toolCalls: readonly Loose[] = [], messages?: Array<{ role: string; content: Loose[] }>) {
  return { id, modelId, timestamp: new Date(), headers: {}, messages: messages ?? [{ role: "assistant", content: [{ type: "text", text }, ...toolCalls] }] };
}

type CodexCredentials = { accessToken: string; refreshToken: string; idToken: string; accountId: string; path: string; document: Loose };

function codexCredentials(): CodexCredentials {
  const path = join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "auth.json");
  // The in-box turn reads the box filesystem only, and a bare ENOENT from
  // lstatSync says which file is missing but not where the search happened or
  // which plane needed it. Name both so the message is actionable.
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw new Error(
      `Codex is not signed in for this execution plane: no credentials at ${path}`
      + `${process.env.SAND_HOST_IN_BOX === "1" ? " (the turn runs inside the local computer, which reads only the box filesystem)" : ""}. `
      + "Run `codex login` for that plane, or set CODEX_HOME to a directory that holds auth.json.",
      { cause: error },
    );
  }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("Codex login credentials must be a private direct regular file.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Loose;
  const accessToken = parsed?.tokens?.access_token;
  const refreshToken = parsed?.tokens?.refresh_token;
  const idToken = parsed?.tokens?.id_token;
  const accountId = parsed?.tokens?.account_id;
  if (parsed?.auth_mode !== "chatgpt" || typeof accessToken !== "string" || accessToken.length === 0 || typeof refreshToken !== "string" || refreshToken.length === 0 || typeof idToken !== "string" || idToken.length === 0 || typeof accountId !== "string" || accountId.length === 0) {
    throw new Error("Codex is not signed in with ChatGPT. Run `codex login`, then reopen Grok Bot.");
  }
  return { accessToken, refreshToken, idToken, accountId, path, document: parsed };
}

function jwtAudience(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Loose;
    const audience = payload.aud;
    return typeof audience === "string" ? audience : Array.isArray(audience) ? audience.find((value): value is string => typeof value === "string") ?? null : null;
  } catch { return null; }
}

async function refreshCodexCredentials(current: CodexCredentials): Promise<CodexCredentials> {
  const clientId = jwtAudience(current.idToken);
  if (clientId == null) throw new Error("Codex login expired and its refresh identity is invalid. Run `codex login` again.");
  const refresh = await fetch("https://auth.openai.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: current.refreshToken, client_id: clientId }),
  });
  if (!refresh.ok) throw new Error("Codex login expired and could not be refreshed. Run `codex login` again.");
  const payload = await refresh.json() as Loose;
  if (typeof payload.access_token !== "string" || payload.access_token.length === 0) throw new Error("Codex returned an invalid refreshed login. Run `codex login` again.");
  const document = {
    ...current.document,
    tokens: {
      ...current.document.tokens,
      access_token: payload.access_token,
      refresh_token: typeof payload.refresh_token === "string" && payload.refresh_token.length > 0 ? payload.refresh_token : current.refreshToken,
      id_token: typeof payload.id_token === "string" && payload.id_token.length > 0 ? payload.id_token : current.idToken,
    },
    last_refresh: new Date().toISOString(),
  };
  const temporary = `${current.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporary, current.path);
  return codexCredentials();
}

function codexAuthenticatedFetch(initial: CodexCredentials): typeof fetch {
  let credentials = initial;
  return async (input, init) => {
    const perform = () => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${credentials.accessToken}`);
      headers.set("ChatGPT-Account-Id", credentials.accountId);
      return fetch(input, { ...init, headers });
    };
    let result = await perform();
    if (result.status !== 401) return result;
    credentials = await refreshCodexCredentials(credentials);
    result = await perform();
    return result;
  };
}

function configuredCodexModel(): string {
  const selected = process.env.SAND_CODEX_MODEL?.trim();
  if (selected) return selected;
  try {
    const config = readFileSync(join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "config.toml"), "utf8");
    return /^\s*model\s*=\s*["']([^"']+)["']/m.exec(config)?.[1]?.trim() || "gpt-5.4";
  } catch { return "gpt-5.4"; }
}

function configuredCodexReasoningEffort(): "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
  const selected = process.env.SAND_CODEX_REASONING_EFFORT?.trim();
  if (selected === "minimal" || selected === "low" || selected === "medium" || selected === "high" || selected === "xhigh") return selected;
  try {
    const config = readFileSync(join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "config.toml"), "utf8");
    const value = /^\s*model_reasoning_effort\s*=\s*["']([^"']+)["']/m.exec(config)?.[1]?.trim();
    return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" ? value : undefined;
  } catch { return undefined; }
}

export function routedToolSchema(definition: Loose) {
  const parameters = definition.inputSchema ?? definition.parameters;
  if (parameters instanceof z.ZodType) return zodSchema(parameters).jsonSchema;
  return parameters?.jsonSchema ?? parameters;
}

export function codexInput(messages: readonly ProviderMessage[]): Loose[] {
  return messages.flatMap(message => {
    if (!Array.isArray(message.content)) return [{ role: message.role, content: message.content }];
    const output: Loose[] = [];
    for (const part of message.content) {
      if (part.type === "tool-call") output.push({ type: "function_call", call_id: part.toolCallId, name: part.toolName, arguments: JSON.stringify(part.args) });
      else if (part.type === "tool-result") output.push({ type: "function_call_output", call_id: part.toolCallId, output: typeof part.result === "string" ? part.result : JSON.stringify(part.result) });
      else if (part.type === "text") output.push({ role: message.role, content: part.text });
      else throw new Error(`Unsupported Codex message content: ${part.type}`);
    }
    return output;
  });
}

function codexTools(definitions: readonly Loose[] | undefined): CodexDirectTool[] | undefined {
  if (definitions == null) return undefined;
  const tools = definitions.flatMap((source): CodexDirectTool[] => {
    const parameters = routedToolSchema(source);
    return typeof source.name === "string" && source.name.length > 0 && parameters != null ? [{
      name: source.name,
      ...(typeof source.description === "string" ? { description: source.description } : {}),
      parameters,
      source,
    }] : [];
  });
  return tools.length === 0 ? undefined : tools;
}

function codexExecutor(messages: readonly ProviderMessage[], invocationId: string, definitions?: readonly Loose[], onUsage?: (usage: UsageRecord) => void, signal?: AbortSignal) {
  const credentials = codexCredentials();
  const usage = deferred<{ promptTokens: number; completionTokens: number; totalTokens: number }>();
  const extendedUsage = deferred<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; maxTokens: number }>();
  const resultResponse = deferred<ReturnType<typeof response>>();
  const metadata = deferred<Record<string, unknown>>();
  const model = configuredCodexModel();
  const tools = codexTools(definitions);
  const fullStream = (async function* () {
    let text = "";
    const toolCalls: Loose[] = [];
    try {
      for await (const event of streamCodexDirectResponses({
        fetch: codexAuthenticatedFetch(credentials),
        endpoint: "https://chatgpt.com/backend-api/codex/responses",
        model,
        ...(configuredCodexReasoningEffort() == null ? {} : { reasoningEffort: configuredCodexReasoningEffort()! }),
        instructions: GROK_ROUTER_SYSTEM_PROMPT,
        input: codexInput(messages),
        ...(tools == null ? {} : { tools }),
        maxSteps: 1,
        ...(signal === undefined ? {} : { signal }),
      })) {
        if (event.type === "text-delta") { text += event.delta; yield { type: "text-delta" as const, textDelta: event.delta }; continue; }
        if (event.type === "tool-call") {
          const call = { type: "tool-call" as const, toolCallId: event.toolCallId, toolName: event.toolName, args: event.args };
          toolCalls.push(call);
          yield call;
          continue;
        }
        const basic = { promptTokens: event.usage.inputTokens, completionTokens: event.usage.outputTokens, totalTokens: event.usage.inputTokens + event.usage.outputTokens };
        const extended = { ...event.usage, maxTokens: 0 };
        onUsage?.(event.usage);
        usage.resolve(basic);
        extendedUsage.resolve(extended);
        metadata.resolve({ openai: { responseId: event.responseId, direct: true } });
        resultResponse.resolve(response(text, invocationId, model, toolCalls));
      }
    } catch (error) {
      // Reject the deferreds for any late awaiter, then mark each rejection
      // handled: the error already propagates through fullStream, and an
      // unawaited rejected promise here crashes the coordinator as an
      // unhandledRejection (observed live when the CLI died mid-turn).
      for (const settled of [usage, extendedUsage, metadata, resultResponse]) {
        settled.reject(error);
        settled.promise.catch(() => undefined);
      }
      throw error;
    } finally {
      for (const settled of [usage, extendedUsage, metadata, resultResponse]) {
        settled.reject(new Error("Codex stream ended before its result was consumed."));
        settled.promise.catch(() => undefined);
      }
    }
  })();
  return { fullStream, response: resultResponse.promise, usage: usage.promise, extendedUsage: extendedUsage.promise, providerMetadata: metadata.promise, invocationId: Promise.resolve(invocationId) };
}

// --- Local tool execution for routed Claude Code turns ---------------------
// The stock options (tools: [], maxTurns: 1, no permission callback) left the
// model with zero real tools, which it papered over by fabricating command
// output. These paths give it real, audited tools on this machine instead.

const CLAUDE_LOCAL_TOOLS = ["Bash", "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "LS", "WebFetch", "TodoWrite"] as const;
const CLAUDE_READ_ONLY_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "WebFetch"]);
// Tools that cannot change anything the user owns. They stay available while the
// box waits for a human, and while local tool access is set to "Never".
const CLAUDE_BOX_READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "WebFetch", "TodoWrite"]);

// The plugin tools of this computer, as the CLI child needs them: a way to list
// the definitions it may call and a way to perform each call. The daemon owns
// the MCP servers; these two functions are the host's half of that path.
export interface HostMcpTools {
  listTools(): Promise<unknown>;
  callTool(tool: { readonly name: string; readonly providerIdentifier: string; readonly toolName: string; readonly args: unknown; readonly toolCallId: string }): Promise<unknown>;
}

export function resolveAgentWorkspace(): string {
  const override = process.env.SAND_AGENT_WORKSPACE?.trim();
  if (override != null && override.length > 0) return override;
  const root = getSandRootDir();
  // The shared workspace first: since the container binds /workspace to
  // <root>/box-workspace, preferring it here converges the routed tools' cwd
  // with the computer's file plane in BOTH forms (Mac-host daemon and Docker
  // container) — the tool artifacts land where the computer's files live and
  // where the Mac user can see them. The legacy box-data layout stays as a
  // fallback for pre-convergence deployments.
  for (const candidate of [join(root, "box-workspace"), join(root, "box-data", "box-workspace")]) {
    try { if (lstatSync(candidate).isDirectory()) return candidate; } catch {}
  }
  return root;
}

// The awaiting-human gate, enforced at the Mac permission layer. The box-side
// gate covers the box executors, but the taught desktop primitives run from
// THIS Mac via docker exec — without this seam the agent could keep driving
// the box (typing into the very screen the human is taking over) during a
// handoff. While the ask file exists, only the hand-back itself (removing the
// ask file) and reads pass; everything else gets the waiting message.
export function awaitingHumanAskFilePath(env: NodeJS.ProcessEnv = process.env): string | null {
  const root = env.SAND_WORKSPACE_ROOT?.trim() || resolveAgentWorkspace();
  if (root.length === 0) return null;
  return join(root, ".grokbot", "ask-human.json");
}

// An allow carries the tool input back unchanged. The permission result's
// `updatedInput` REPLACES the input the tool executes with, so an empty object
// here silently erased every argument the model supplied — invisible for the
// built-in tools whose arguments the CLI re-reads from its own state, and fatal
// for MCP tools, whose arguments exist nowhere else.
function allowUnchanged(input?: unknown): PermissionResult {
  return { behavior: "allow", updatedInput: typeof input === "object" && input != null && !Array.isArray(input) ? input as Record<string, unknown> : {} };
}

export function claudeToolPermission(toolName: string, input?: unknown, localToolPermission?: SandLocalToolPermission): PermissionResult {
  if (isLocalAdminEnabled()) {
    const askPath = awaitingHumanAskFilePath();
    if (askPath != null && existsSync(askPath)) {
      const command = typeof (input as { command?: unknown } | undefined)?.command === "string" ? (input as { command: string }).command : "";
      const isHandBack = toolName === "Bash" && [
        `rm ${askPath}`,
        `unlink ${askPath}`,
        "rm .grokbot/ask-human.json",
        "unlink .grokbot/ask-human.json",
      ].includes(command.trim());
      if (isHandBack) {
        appendLocalIntercept({ kind: "awaiting-human", event: "mac-permission-handback-allowed", tool: toolName });
        return allowUnchanged(input);
      }
      if (CLAUDE_BOX_READ_TOOLS.has(toolName)) {
        return allowUnchanged(input);
      }
      appendLocalIntercept({ kind: "awaiting-human", event: "mac-permission-denied", tool: toolName });
      return {
        behavior: "deny",
        message: "The box is awaiting a human handoff (ask-human.json present): box-driving tools are paused so the human has the screen. Pass the takeover URL from .grokbot/novnc-url to the user, then wait. Resume by removing the ask file (rm .grokbot/ask-human.json) once the human confirms, or let the deadline reclaim the box.",
      };
    }
    // The box workspace is bind-mounted from the user's machine, so a command or
    // a write inside the box acts on the user's computer. "Never" therefore
    // applies here, exactly as it does to the Mac-side tools. Reading stays open
    // because it cannot change anything the user owns.
    if (localToolPermission === "never" && !CLAUDE_BOX_READ_TOOLS.has(toolName)) {
      appendLocalIntercept({ kind: "tool-use", provider: "claude-code", phase: "permission-denied", tool: toolName });
      return {
        behavior: "deny",
        message: "Local tool access is set to \"Never\", and this computer's workspace is shared with the user's machine, so "
          + `${toolName} cannot run here. Change the setting in Settings → Agent → Execution on Local Computer, or answer without changing anything.`,
      };
    }
    return allowUnchanged(input);
  }
  if (CLAUDE_READ_ONLY_TOOLS.has(toolName)) return allowUnchanged(input);
  appendLocalIntercept({ kind: "tool-use", provider: "claude-code", phase: "permission-denied", tool: toolName });
  return {
    behavior: "deny",
    message: "Grok Bot local tools are read-only outside local admin mode. Start the app with SAND_LOCAL_ADMIN=1 to allow file and command tools on this machine.",
  };
}

function recordClaudeToolTraffic(message: SDKMessage): void {
  const blocks = (message as { type: string; message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(blocks)) return;
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const record = block as { type?: string; name?: string; input?: unknown; content?: unknown; is_error?: boolean };
    if (record.type === "tool_use") {
      appendLocalIntercept({ kind: "tool-use", provider: "claude-code", phase: "request", tool: record.name ?? "unknown", input: redactTypedDesktopInput(JSON.stringify(record.input ?? {}).slice(0, 400)) });
    } else if (record.type === "tool_result") {
      const body = typeof record.content === "string" ? record.content : JSON.stringify(record.content ?? "");
      appendLocalIntercept({ kind: "tool-use", provider: "claude-code", phase: "result", tool: "result", output: body.slice(0, 400), isError: record.is_error === true });
    }
  }
}

const CLAUDE_LOCAL_TOOLS_PROMPT_LINES = [
  "You have real local tools (Bash, file read/write/edit, search) for this machine's workspace — your current working directory.",
  "When asked to run a command, inspect files, or check this machine, actually call the tools and report their real output.",
  "Never simulate, guess, or invent command output or file contents. If a tool call is denied or fails, say so plainly and show the real error.",
];

// Local admin runs with no cloud behind it. Without this block the assistant
// inherits the stock cloud-centric self-image and answers sandbox questions
// by probing remote endpoints as if they were its backend (observed live:
// asked to "check the cloud sandbox", it verified connectivity to the very
// endpoints this deployment is independent of).
//
// The desktop primitives differ per execution plane, so the block is split.
// SAND_HOST_IN_BOX=1 means this process runs inside the box: the primitives at
// /usr/local/bin are directly executable there, and the box has no docker CLI
// at all (a prompt that said `docker exec` from inside it made the model loop
// on `docker: command not found` for twenty minutes, observed live). The
// Mac-side plane reaches the same primitives through `docker exec`.
const CLAUDE_LOCAL_ADMIN_IDENTITY_LINES = [
  "This deployment is fully local: your computer IS the sandbox — an isolated Linux box running on this Mac, with its workspace at your current working directory. There is no cloud sandbox behind you.",
  "Remote cursor / x.ai endpoints are not your backend and are blocked by design. Never describe cloud connectivity as your dependency, never suggest signing in or reconnecting to them, and never present them as your infrastructure.",
  "When asked about your environment, the sandbox, or where you run, answer from this local reality — you are the sandbox.",
  "When you hit a login, captcha, or payment wall you cannot pass yourself: STOP driving the box, write .grokbot/ask-human.json in the workspace with {\"reason\":\"auth|captcha|payment|other\",\"instruction\":\"what the human should do\"}, give the user the takeover URL from .grokbot/novnc-url (it dies with a container restart — if it does not open, ask again for a fresh one), then wait. Box actions stay blocked until the file is removed (hand-back) or the deadline reclaims the box; your local file tools keep working so you can finish the hand-back.",
  "Never handle credentials yourself: a password, OTP, or card number is exactly the handoff case — the human types it in the noVNC takeover. Never ask the user to paste secrets into chat; if they do, tell them to use the takeover instead and never repeat the secret back. When you write ask-human.json, also fire a Mac notification so the user notices: osascript -e 'display notification \"需要人工接管盒子\" with title \"Grok Bot\"'.",
  "For web UI tasks, drive the box's DESKTOP browser so your actions are visible on the screen the user can watch — do not fall back to curl.",
];

// The box is the computer here, so the primitives are local commands. DISPLAY
// is passed explicitly because tool children start without the host's exported
// environment; the wrappers derive their profile and CDP port from it.
const CLAUDE_LOCAL_ADMIN_DESKTOP_LINES_IN_BOX = [
  "  launch the browser with `env DISPLAY=:1 /usr/local/bin/box-chrome` (on demand; the wrapper derives its profile and CDP port from DISPLAY, so pass it explicitly)",
  "  input via `python3 /usr/local/bin/xtest-input-local.py :1` with JSON on stdin ({\"action\":\"click\"|\"move\"|\"type\"|\"key\"|\"scroll\", \"x\",\"y\",\"text\",\"key\",\"dir\"}; coordinates 0..1279 x 0..799)",
  "  screenshot with `bash -c 'xwd -root -display :1 -silent | convert xwd:- png:-' > shot.png` then Read it",
  "There is no xdotool — do not look for it. Navigate the browser ONLY with `/usr/local/bin/box-navigate <url>` — it refuses private/reserved destinations (with an audit ledger line) before the page ever loads; typing a URL into the address bar yourself bypasses the egress gate and is forbidden.",
];

// This plane runs on the Mac and reaches the box's primitives through docker.
const CLAUDE_LOCAL_ADMIN_DESKTOP_LINES_FROM_MAC = [
  "  launch the browser with `docker exec -d grok-bot-local-vm env DISPLAY=:1 /usr/local/bin/box-chrome` (on demand; the wrapper derives its profile and CDP port from DISPLAY, and `docker exec` starts with an empty environment, so pass it explicitly)",
  "  input via `docker exec -i grok-bot-local-vm python3 /usr/local/bin/xtest-input-local.py :1` with JSON on stdin ({\"action\":\"click\"|\"move\"|\"type\"|\"key\"|\"scroll\", \"x\",\"y\",\"text\",\"key\",\"dir\"}; coordinates 0..1279 x 0..799)",
  "  screenshot with `docker exec grok-bot-local-vm bash -c 'xwd -root -display :1 -silent | convert xwd:- png:-' > shot.png` then Read it",
  "There is no xdotool — do not look for it. Navigate the browser ONLY with `docker --context colima-finonelib exec grok-bot-local-vm /usr/local/bin/box-navigate <url>` — it refuses private/reserved destinations (with an audit ledger line) before the page ever loads; typing a URL into the address bar yourself bypasses the egress gate and is forbidden.",
];

export function localAdminDesktopPrimitiveLines(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  return env.SAND_HOST_IN_BOX?.trim() === "1"
    ? CLAUDE_LOCAL_ADMIN_DESKTOP_LINES_IN_BOX
    : CLAUDE_LOCAL_ADMIN_DESKTOP_LINES_FROM_MAC;
}

// Exported for the regression guard, which asserts on the composed prompt
// rather than only on the plane split: the text the model receives must name
// primitives the invoking plane can execute.
export function claudeLocalToolsPrompt(env: NodeJS.ProcessEnv = process.env): string {
  if (!isLocalAdminEnabled(env)) return CLAUDE_LOCAL_TOOLS_PROMPT_LINES.join("\n");
  return [...CLAUDE_LOCAL_TOOLS_PROMPT_LINES, ...CLAUDE_LOCAL_ADMIN_IDENTITY_LINES, ...localAdminDesktopPrimitiveLines(env)].join("\n");
}

interface ClaudeExecutorOptions {
  readonly onUsage?: (usage: UsageRecord) => void;
  /** Plugin tools this executor exposes through its own bridge, closed with the stream. */
  readonly mcp?: HostMcpTools;
  readonly localToolPermission?: SandLocalToolPermission;
  readonly signal?: AbortSignal;
  readonly onToolEvent?: (event: ProviderToolEvent) => void;
}

export interface ProviderToolEvent {
  readonly id: string;
  readonly name: string;
  readonly status: "pending" | "done" | "failed";
  readonly args?: string;
}

function claudeRecordedMessage(
  message: SDKMessage,
  pendingTools: Map<string, string>,
  onToolEvent?: ClaudeExecutorOptions["onToolEvent"],
): { role: string; content: Loose[]; providerOptions: { claudeCode: { toolsExecuted: true } } } | undefined {
  if (message.type === "assistant") {
    const content: Loose[] = [];
    for (const block of message.message.content) {
      if (block.type === "text") content.push({ type: "text", text: block.text });
      if (block.type === "tool_use") {
        pendingTools.set(block.id, block.name);
        content.push({ type: "tool-call", toolCallId: block.id, toolName: block.name, args: block.input });
        onToolEvent?.({ id: block.id, name: block.name, status: "pending", args: redactTypedDesktopInput(JSON.stringify(block.input ?? {})) });
      }
    }
    return content.length === 0 ? undefined : { role: "assistant", content, providerOptions: { claudeCode: { toolsExecuted: true } } };
  }
  if (message.type !== "user" || ("isReplay" in message && message.isReplay === true) || !Array.isArray(message.message.content)) return undefined;
  const content: Loose[] = [];
  for (const block of message.message.content) {
    if (block.type !== "tool_result") continue;
    const name = pendingTools.get(block.tool_use_id);
    if (name == null) throw new Error(`Claude returned a result for unknown tool call ${block.tool_use_id}.`);
    pendingTools.delete(block.tool_use_id);
    const result = { type: "tool-result", toolCallId: block.tool_use_id, toolName: name, result: block.content ?? "", ...(block.is_error === true ? { isError: true } : {}) };
    content.push(result);
    onToolEvent?.({ id: block.tool_use_id, name, status: block.is_error === true ? "failed" : "done" });
  }
  return content.length === 0 ? undefined : { role: "tool", content, providerOptions: { claudeCode: { toolsExecuted: true } } };
}

function claudeExecutor(messages: readonly ProviderMessage[], invocationId: string, options?: ClaudeExecutorOptions) {
  const executable = resolveClaudeCodeCliPath();
  if (executable == null) throw new Error("Claude Code is not installed. Install and sign in to Claude Code, then reopen Grok Bot.");
  const usage = deferred<{ promptTokens: number; completionTokens: number; totalTokens: number }>();
  const extendedUsage = deferred<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; maxTokens: number }>();
  const resultResponse = deferred<ReturnType<typeof response>>();
  const metadata = deferred<Record<string, unknown>>();
  const fullStream = (async function* () {
    // The CLI child speaks MCP over HTTP itself, so the plugin tools reach it
    // through a loopback bridge that exists for exactly this stream. The bridge
    // is closed with the stream, which keeps a crashed turn from leaving a
    // listener behind or holding a tool call open.
    let bridge: { url: string; close(): Promise<void> } | undefined;
    const pendingTools = new Map<string, string>();
    const recordedMessages: Array<{ role: string; content: Loose[] }> = [];
    try {
      const mcp = options?.mcp;
      if (mcp != null) bridge = await createRoutedMcpBridge({ listTools: () => mcp.listTools(), callTool: tool => mcp.callTool(tool) });
      const mcpServerUrl = bridge?.url;
      const abortController = new AbortController();
      const abort = () => abortController.abort(options?.signal?.reason);
      if (options?.signal?.aborted === true) abort();
      else options?.signal?.addEventListener("abort", abort, { once: true });
      let final: SDKResultMessage | undefined;
      let streamedText = "";
      const selectedModel = process.env.SAND_CLAUDE_MODEL?.trim();
      try { for await (const message of queryClaude({ prompt: providerPrompt(messages, claudeLocalToolsPrompt()), options: {
        pathToClaudeCodeExecutable: executable,
        cwd: resolveAgentWorkspace(),
        tools: [...CLAUDE_LOCAL_TOOLS, ...(mcpServerUrl == null ? [] : ["mcp__grok_bot_plugins__*"])],
        ...(mcpServerUrl == null ? {} : { mcpServers: { grok_bot_plugins: { type: "http" as const, url: mcpServerUrl } }, strictMcpConfig: true }),
        permissionMode: "default",
        canUseTool: async (toolName, input) => {
          const decision = claudeToolPermission(toolName, input, options?.localToolPermission);
          if (decision.behavior === "allow") appendLocalIntercept({ kind: "tool-use", provider: "claude-code", phase: "permission-allowed", tool: toolName, input: redactTypedDesktopInput(JSON.stringify(input ?? {}).slice(0, 200)) });
          return decision;
        },
        maxTurns: 24,
        includePartialMessages: true,
        persistSession: false,
        abortController,
        env: claudeChildEnv(),
        ...(selectedModel == null || selectedModel.length === 0 ? {} : { model: selectedModel }),
      } })) {
        if (message.type === "result") { final = message; continue; }
        if (message.type === "stream_event" && message.event.type === "content_block_delta" && message.event.delta.type === "text_delta") {
          const delta = message.event.delta.text;
          streamedText += delta;
          yield { type: "text-delta" as const, textDelta: delta };
          continue;
        }
        recordClaudeToolTraffic(message);
        const recorded = claudeRecordedMessage(message, pendingTools, options?.onToolEvent);
        if (recorded != null) recordedMessages.push(recorded);
      } } finally { options?.signal?.removeEventListener("abort", abort); }
      if (final == null) throw new Error("Claude Code ended without a result.");
      if (final.subtype !== "success") throw new Error(final.errors.join("\n") || `Claude Code failed (${final.subtype}).`);
      if (pendingTools.size > 0) throw new Error("Claude Code ended before returning its tool results.");
      const text = streamedText || final.result;
      const input = final.usage.input_tokens, output = final.usage.output_tokens, cacheRead = final.usage.cache_read_input_tokens ?? 0, cacheWrite = final.usage.cache_creation_input_tokens ?? 0;
      options?.onUsage?.({ inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite });
      usage.resolve({ promptTokens: input, completionTokens: output, totalTokens: input + output });
      extendedUsage.resolve({ inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, maxTokens: 0 });
      metadata.resolve({ anthropic: { sessionId: final.session_id, totalCostUsd: final.total_cost_usd } });
      if (recordedMessages.length === 0 || !recordedMessages.some(message => message.role === "assistant" && message.content.some((part: Loose) => part.type === "text"))) {
        recordedMessages.push({ role: "assistant", content: [{ type: "text", text }] });
      }
      resultResponse.resolve(response(text, invocationId, "claude-code", [], recordedMessages));
      if (streamedText.length === 0 && text.length > 0) yield { type: "text-delta" as const, textDelta: text };
    } catch (error) {
      for (const [id, name] of pendingTools) options?.onToolEvent?.({ id, name, status: "failed" });
      // Reject the deferreds for any late awaiter, then mark each rejection
      // handled: the error already propagates through fullStream, and an
      // unawaited rejected promise here crashes the coordinator as an
      // unhandledRejection (observed live when the CLI died mid-turn).
      for (const settled of [usage, extendedUsage, metadata, resultResponse]) {
        settled.reject(error);
        settled.promise.catch(() => undefined);
      }
      throw error;
    } finally {
      // Closed with the stream: a crashed turn must not leave the loopback
      // listener behind or hold a tool call open.
      await bridge?.close().catch((error: unknown) => appendLocalIntercept({ kind: "tool-use", provider: "claude-code", phase: "mcp-bridge-close-failed", error: error instanceof Error ? error.message : String(error) }));
    }
  })();
  return { fullStream, response: resultResponse.promise, usage: usage.promise, extendedUsage: extendedUsage.promise, providerMetadata: metadata.promise, invocationId: Promise.resolve(invocationId) };
}

function toToolSet(definitions: readonly Loose[] | undefined): ToolSet | undefined {
  if (definitions == null || definitions.length === 0) return undefined;
  const tools: ToolSet = {};
  for (const definition of definitions) {
    if (typeof definition.name !== "string" || definition.name.length === 0) continue;
    const parameters = routedToolSchema(definition);
    if (parameters == null) continue;
    const routedTool: any = {
      ...(typeof definition.description === "string" ? { description: definition.description } : {}),
      parameters: jsonSchema(parameters),
    };
    tools[definition.name] = tool(routedTool);
  }
  return Object.keys(tools).length === 0 ? undefined : tools;
}

function openRouterExecutor(messages: readonly ProviderMessage[], invocationId: string, definitions?: readonly Loose[], onUsage?: (usage: UsageRecord) => void, signal?: AbortSignal) {
  const id = process.env.SAND_OPENROUTER_MODEL?.trim() || "openai/gpt-5.2";
  const model: LanguageModelV1 = createOpenAI({ apiKey: openRouterCredential(), baseURL: "https://openrouter.ai/api/v1", compatibility: "compatible", name: "openrouter", headers: { "HTTP-Referer": "https://github.com/grok-bot-reconstructed", "X-Title": "Grok Bot Reconstructed" } }).chat(id as any);
  const tools = toToolSet(definitions);
  const result = streamText({ model, system: GROK_ROUTER_SYSTEM_PROMPT, messages: messages as CoreMessage[], ...(tools === undefined ? {} : { tools }), toolCallStreaming: true, maxSteps: 1, ...(signal === undefined ? {} : { abortSignal: signal }) });
  const extendedUsage = result.usage.then(value => ({ inputTokens: value.promptTokens, outputTokens: value.completionTokens, cacheReadTokens: 0, cacheWriteTokens: 0, maxTokens: 0 }));
  if (onUsage != null) void extendedUsage.then(onUsage).catch(error => appendLocalIntercept({ kind: "inference-usage", provider: "openrouter", error: error instanceof Error ? error.message : String(error) }));
  return { fullStream: result.fullStream, response: result.response, usage: result.usage, extendedUsage, providerMetadata: result.providerMetadata, invocationId: Promise.resolve(invocationId) };
}

class ProviderPromptExecutor extends BasePromptExecutor<ProviderMessage> {
  constructor(readonly provider: RoutedProvider, initialMessages?: readonly ProviderMessage[], readonly onUsage?: (usage: UsageRecord) => void, readonly localToolPermission?: SandLocalToolPermission, readonly mcp?: HostMcpTools, readonly onToolEvent?: (event: ProviderToolEvent) => void) { super(new BasePromptBuilder(initialMessages)); }
  stream(ctx: unknown, invocationId = crypto.randomUUID(), definitions?: readonly Loose[]) {
    const signal = (ctx as Context).signal;
    // host 统一执行已发现的工具；provider 只返回调用，权限与释放由外层管理。
    if (this.provider === "codex") return codexExecutor(this.getMessages(), invocationId, definitions, this.onUsage, signal);
    if (this.provider === "claude-code") return claudeExecutor(this.getMessages(), invocationId, {
      ...(this.onUsage === undefined ? {} : { onUsage: this.onUsage }),
      ...(this.localToolPermission === undefined ? {} : { localToolPermission: this.localToolPermission }),
      ...(this.mcp === undefined ? {} : { mcp: this.mcp }),
      ...(this.onToolEvent === undefined ? {} : { onToolEvent: this.onToolEvent }),
      signal,
    });
    return openRouterExecutor(this.getMessages(), invocationId, definitions, this.onUsage, signal);
  }
}

export function createProviderPromptSession(provider: RoutedProvider, options?: { readonly localToolPermission?: SandLocalToolPermission; readonly mcp?: HostMcpTools; readonly onToolEvent?: (event: ProviderToolEvent) => void }): { getModelId(): string; getExecutor(state?: unknown): PromptExecutor } {
  const modelId = provider === "codex" ? configuredCodexModel() : provider === "claude-code" ? "claude-code" : process.env.SAND_OPENROUTER_MODEL?.trim() || "openai/gpt-5.2";
  return { getModelId: () => modelId, getExecutor: state => new ProviderPromptExecutor(provider, Array.isArray(state) ? state as ProviderMessage[] : undefined, usage => recordRoutedUsage(provider, usage), options?.localToolPermission, options?.mcp, options?.onToolEvent) };
}
