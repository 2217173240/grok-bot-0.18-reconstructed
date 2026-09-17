import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { query as queryClaude, type PermissionResult, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { createOpenAI } from "@ai-sdk/openai";
import { jsonSchema, streamText, tool, type CoreMessage, type LanguageModelV1, type ToolSet } from "ai";

import { BasePromptBuilder, BasePromptExecutor } from "../../../packages/chat-inference/base.js";
import { routedProviderToolSteps, type SandInferenceProvider } from "../../../shared/inference-router.js";
import { parseBoxSecretsSnapshot } from "../../../shared/node/box-secrets-store.js";
import { resolveClaudeCodeCliPath } from "../../../shared/node/inference-router-local.js";
import { isLocalAdminEnabled } from "../../../shared/node/local-admin.js";
import { appendLocalIntercept, redactTypedDesktopInput } from "../../../shared/node/local-admin-intercept.js";
import { getSandRootDir } from "../../host-paths.js";
import { SandSettingsStore } from "../../../shared/node/settings/sand-settings-store.js";
import { getBoxSecretsStorePath } from "../secrets/secrets-service.js";
import { streamCodexDirectResponses, type CodexDirectTool } from "./codex-direct-responses.js";
import type { LabelMessage, PromptExecutor } from "./sand-labeling.js";

type Loose = Record<string, any>;
interface ProviderMessage extends LabelMessage { role: string; content: string | readonly unknown[] }
type RoutedProvider = Exclude<SandInferenceProvider, "cursor">;
type UsageRecord = { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
type RoutedToolExecutor = (tool: Loose, args: unknown, toolCallId: string) => Promise<unknown>;

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

function response(text: string, id: string, modelId: string) {
  return { id, modelId, timestamp: new Date(), headers: {}, messages: [{ role: "assistant", content: [{ type: "text", text }] }] };
}

type CodexCredentials = { accessToken: string; refreshToken: string; idToken: string; accountId: string; path: string; document: Loose };

function codexCredentials(): CodexCredentials {
  const path = join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "auth.json");
  const stat = lstatSync(path);
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

function codexTools(definitions: readonly Loose[] | undefined): CodexDirectTool[] | undefined {
  if (definitions == null) return undefined;
  const tools = definitions.flatMap((source): CodexDirectTool[] => {
    const parameters = source.inputSchema ?? source.parameters;
    return typeof source.name === "string" && source.name.length > 0 && parameters != null ? [{
      name: source.name,
      ...(typeof source.description === "string" ? { description: source.description } : {}),
      parameters,
      source,
    }] : [];
  });
  return tools.length === 0 ? undefined : tools;
}

function codexExecutor(messages: readonly ProviderMessage[], invocationId: string, definitions?: readonly Loose[], executeTool?: RoutedToolExecutor, onUsage?: (usage: UsageRecord) => void) {
  const credentials = codexCredentials();
  const usage = deferred<{ promptTokens: number; completionTokens: number; totalTokens: number }>();
  const extendedUsage = deferred<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; maxTokens: number }>();
  const resultResponse = deferred<ReturnType<typeof response>>();
  const metadata = deferred<Record<string, unknown>>();
  const model = configuredCodexModel();
  const tools = codexTools(definitions);
  const fullStream = (async function* () {
    let text = "";
    try {
      for await (const event of streamCodexDirectResponses({
        fetch: codexAuthenticatedFetch(credentials),
        endpoint: "https://chatgpt.com/backend-api/codex/responses",
        model,
        ...(configuredCodexReasoningEffort() == null ? {} : { reasoningEffort: configuredCodexReasoningEffort()! }),
        instructions: GROK_ROUTER_SYSTEM_PROMPT,
        input: messages.map(message => ({ role: message.role === "assistant" ? "assistant" : "user", content: typeof message.content === "string" ? message.content : JSON.stringify(message.content) })),
        ...(tools == null ? {} : { tools }),
        ...(executeTool == null ? {} : { executeTool: async (selected, args, toolCallId) => await executeTool(selected.source, args, toolCallId) }),
        maxSteps: tools == null ? 1 : routedProviderToolSteps(executeTool != null),
      })) {
        if (event.type === "text-delta") { text += event.delta; yield { type: "text-delta" as const, textDelta: event.delta }; continue; }
        if (event.type === "tool-call") {
          yield { type: "tool-call" as const, toolCallId: event.toolCallId, toolName: event.toolName, args: event.args };
          continue;
        }
        const basic = { promptTokens: event.usage.inputTokens, completionTokens: event.usage.outputTokens, totalTokens: event.usage.inputTokens + event.usage.outputTokens };
        const extended = { ...event.usage, maxTokens: 0 };
        onUsage?.(event.usage);
        usage.resolve(basic);
        extendedUsage.resolve(extended);
        metadata.resolve({ openai: { responseId: event.responseId, direct: true } });
        resultResponse.resolve(response(text, invocationId, model));
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

export function claudeToolPermission(toolName: string): PermissionResult {
  if (isLocalAdminEnabled()) return { behavior: "allow", updatedInput: {} };
  if (CLAUDE_READ_ONLY_TOOLS.has(toolName)) return { behavior: "allow", updatedInput: {} };
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
const CLAUDE_LOCAL_ADMIN_IDENTITY_LINES = [
  "This deployment is fully local: your computer IS the sandbox — an isolated Linux box running on this Mac, with its workspace at your current working directory. There is no cloud sandbox behind you.",
  "Remote cursor / x.ai endpoints are not your backend and are blocked by design. Never describe cloud connectivity as your dependency, never suggest signing in or reconnecting to them, and never present them as your infrastructure.",
  "When asked about your environment, the sandbox, or where you run, answer from this local reality — you are the sandbox.",
  "When you hit a login, captcha, or payment wall you cannot pass yourself: STOP driving the box, write .grokbot/ask-human.json in the workspace with {\"reason\":\"auth|captcha|payment|other\",\"instruction\":\"what the human should do\"}, give the user the takeover URL from .grokbot/novnc-url (it dies with a container restart — if it does not open, ask again for a fresh one), then wait. Box actions stay blocked until the file is removed (hand-back) or the deadline reclaims the box; your local file tools keep working so you can finish the hand-back.",
  "Never handle credentials yourself: a password, OTP, or card number is exactly the handoff case — the human types it in the noVNC takeover. Never ask the user to paste secrets into chat; if they do, tell them to use the takeover instead and never repeat the secret back. When you write ask-human.json, also fire a Mac notification so the user notices: osascript -e 'display notification \"需要人工接管盒子\" with title \"Grok Bot\"'.",
  "For web UI tasks, drive the box's DESKTOP browser so your actions are visible on the screen the user can watch — do not fall back to curl. From this Mac the desktop primitives are: launch the browser with `docker exec -d grok-bot-local-vm /usr/local/bin/box-chrome` (on demand; DISPLAY is :1); input via `docker exec -i grok-bot-local-vm python3 /usr/local/bin/xtest-input-local.py :1` with JSON on stdin ({\"action\":\"click\"|\"move\"|\"type\"|\"key\"|\"scroll\", \"x\",\"y\",\"text\",\"key\",\"dir\"}; coordinates 0..1279 x 0..799); screenshot with `docker exec grok-bot-local-vm bash -c 'xwd -root -display :1 -silent | convert xwd:- png:-' > shot.png` then Read it. There is no xdotool — do not look for it. Navigate the browser ONLY with `docker --context colima-finonelib exec grok-bot-local-vm /usr/local/bin/box-navigate <url>` — it refuses private/reserved destinations (with an audit ledger line) before the page ever loads; typing a URL into the address bar yourself bypasses the egress gate and is forbidden.",
];

function claudeLocalToolsPrompt(): string {
  return [...CLAUDE_LOCAL_TOOLS_PROMPT_LINES, ...(isLocalAdminEnabled() ? CLAUDE_LOCAL_ADMIN_IDENTITY_LINES : [])].join("\n");
}

function claudeExecutor(messages: readonly ProviderMessage[], invocationId: string, onUsage?: (usage: UsageRecord) => void, mcpServerUrl?: string) {
  const executable = resolveClaudeCodeCliPath();
  if (executable == null) throw new Error("Claude Code is not installed. Install and sign in to Claude Code, then reopen Grok Bot.");
  const usage = deferred<{ promptTokens: number; completionTokens: number; totalTokens: number }>();
  const extendedUsage = deferred<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; maxTokens: number }>();
  const resultResponse = deferred<ReturnType<typeof response>>();
  const metadata = deferred<Record<string, unknown>>();
  const fullStream = (async function* () {
    try {
      let final: SDKResultMessage | undefined;
      const selectedModel = process.env.SAND_CLAUDE_MODEL?.trim();
      for await (const message of queryClaude({ prompt: providerPrompt(messages, claudeLocalToolsPrompt()), options: {
        pathToClaudeCodeExecutable: executable,
        cwd: resolveAgentWorkspace(),
        tools: [...CLAUDE_LOCAL_TOOLS, ...(mcpServerUrl == null ? [] : ["mcp__grok_bot_plugins__*"])],
        ...(mcpServerUrl == null ? {} : { mcpServers: { grok_bot_plugins: { type: "http" as const, url: mcpServerUrl } }, strictMcpConfig: true }),
        permissionMode: "default",
        canUseTool: async (toolName, input) => {
          const decision = claudeToolPermission(toolName);
          if (decision.behavior === "allow") appendLocalIntercept({ kind: "tool-use", provider: "claude-code", phase: "permission-allowed", tool: toolName, input: redactTypedDesktopInput(JSON.stringify(input ?? {}).slice(0, 200)) });
          return decision;
        },
        maxTurns: 24,
        persistSession: false,
        env: claudeChildEnv(),
        ...(selectedModel == null || selectedModel.length === 0 ? {} : { model: selectedModel }),
      } })) {
        if (message.type === "result") { final = message; continue; }
        recordClaudeToolTraffic(message);
      }
      if (final == null) throw new Error("Claude Code ended without a result.");
      if (final.subtype !== "success") throw new Error(final.errors.join("\n") || `Claude Code failed (${final.subtype}).`);
      const text = final.result;
      if (text.length > 0) yield { type: "text-delta" as const, textDelta: text };
      const input = final.usage.input_tokens, output = final.usage.output_tokens, cacheRead = final.usage.cache_read_input_tokens ?? 0, cacheWrite = final.usage.cache_creation_input_tokens ?? 0;
      onUsage?.({ inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite });
      usage.resolve({ promptTokens: input, completionTokens: output, totalTokens: input + output });
      extendedUsage.resolve({ inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, maxTokens: 0 });
      metadata.resolve({ anthropic: { sessionId: final.session_id, totalCostUsd: final.total_cost_usd } });
      resultResponse.resolve(response(text, invocationId, "claude-code"));
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
    }
  })();
  return { fullStream, response: resultResponse.promise, usage: usage.promise, extendedUsage: extendedUsage.promise, providerMetadata: metadata.promise, invocationId: Promise.resolve(invocationId) };
}

function toToolSet(definitions: readonly Loose[] | undefined, executeTool?: RoutedToolExecutor): ToolSet | undefined {
  if (definitions == null || definitions.length === 0) return undefined;
  const tools: ToolSet = {};
  for (const definition of definitions) {
    if (typeof definition.name !== "string" || definition.name.length === 0) continue;
    const parameters = definition.inputSchema ?? definition.parameters;
    if (parameters == null) continue;
    const routedTool: any = {
      ...(typeof definition.description === "string" ? { description: definition.description } : {}),
      parameters: jsonSchema(parameters),
    };
    if (executeTool != null) routedTool.execute = async (args: unknown, options: { toolCallId: string }) => await executeTool(definition, args, options.toolCallId);
    tools[definition.name] = tool(routedTool);
  }
  return Object.keys(tools).length === 0 ? undefined : tools;
}

function openRouterExecutor(messages: readonly ProviderMessage[], invocationId: string, definitions?: readonly Loose[], executeTool?: RoutedToolExecutor, onUsage?: (usage: UsageRecord) => void) {
  const id = process.env.SAND_OPENROUTER_MODEL?.trim() || "openai/gpt-5.2";
  const model: LanguageModelV1 = createOpenAI({ apiKey: openRouterCredential(), baseURL: "https://openrouter.ai/api/v1", compatibility: "compatible", name: "openrouter", headers: { "HTTP-Referer": "https://github.com/grok-bot-reconstructed", "X-Title": "Grok Bot Reconstructed" } }).chat(id as any);
  const tools = toToolSet(definitions, executeTool);
  const result = streamText({ model, system: GROK_ROUTER_SYSTEM_PROMPT, messages: messages as CoreMessage[], ...(tools === undefined ? {} : { tools }), toolCallStreaming: true, maxSteps: tools === undefined ? 1 : routedProviderToolSteps(executeTool != null) });
  const extendedUsage = result.usage.then(value => ({ inputTokens: value.promptTokens, outputTokens: value.completionTokens, cacheReadTokens: 0, cacheWriteTokens: 0, maxTokens: 0 }));
  if (onUsage != null) void extendedUsage.then(onUsage);
  return { fullStream: result.fullStream, response: result.response, usage: result.usage, extendedUsage, providerMetadata: result.providerMetadata, invocationId: Promise.resolve(invocationId) };
}

class ProviderPromptExecutor extends BasePromptExecutor<ProviderMessage> {
  constructor(readonly provider: RoutedProvider, initialMessages?: readonly ProviderMessage[], readonly onUsage?: (usage: UsageRecord) => void) { super(new BasePromptBuilder(initialMessages)); }
  stream(_ctx: unknown, invocationId = crypto.randomUUID(), _definitions?: readonly Loose[]) {
    // Host-owned sessions are text-only. Claude CLI, Codex auth, and MCP tools
    // live on the Mac coordinator; advertising tools here with no executor is a lie.
    if (this.provider === "codex") return codexExecutor(this.getMessages(), invocationId, undefined, undefined, this.onUsage);
    if (this.provider === "claude-code") return claudeExecutor(this.getMessages(), invocationId, this.onUsage);
    return openRouterExecutor(this.getMessages(), invocationId, undefined, undefined, this.onUsage);
  }
}

export function createProviderPromptSession(provider: RoutedProvider): { getModelId(): string; getExecutor(state?: unknown): PromptExecutor } {
  const modelId = provider === "codex" ? configuredCodexModel() : provider === "claude-code" ? "claude-code" : process.env.SAND_OPENROUTER_MODEL?.trim() || "openai/gpt-5.2";
  return { getModelId: () => modelId, getExecutor: state => new ProviderPromptExecutor(provider, Array.isArray(state) ? state as ProviderMessage[] : undefined, usage => recordRoutedUsage(provider, usage)) };
}

export async function runRoutedProviderText(provider: RoutedProvider, messages: readonly ProviderMessage[], options?: {
  readonly mcpServerUrl?: string;
  readonly tools?: readonly Loose[];
  readonly executeTool?: RoutedToolExecutor;
  readonly onTextDelta?: (delta: string, accumulated: string) => void;
}): Promise<string> {
  const invocationId = crypto.randomUUID();
  const onUsage = (usage: UsageRecord) => recordRoutedUsage(provider, usage);
  const result = provider === "codex"
    ? codexExecutor(messages, invocationId, options?.tools, options?.executeTool, onUsage)
    : provider === "claude-code"
      ? claudeExecutor(messages, invocationId, onUsage, options?.mcpServerUrl)
      : openRouterExecutor(messages, invocationId, options?.tools, options?.executeTool, onUsage);
  let text = "";
  for await (const event of result.fullStream) {
    if (event.type === "text-delta" && typeof event.textDelta === "string") {
      text += event.textDelta;
      options?.onTextDelta?.(event.textDelta, text);
    }
  }
  await result.response;
  return text;
}
