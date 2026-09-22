export const SAND_INFERENCE_PROVIDERS = ["cursor", "claude-code", "codex", "openrouter", "command-code"] as const;
export type SandInferenceProvider = (typeof SAND_INFERENCE_PROVIDERS)[number];

export interface SandInferenceRouterUsageProvider {
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly lastUsedAt: string | null;
}

export interface SandInferenceRouterUsage {
  readonly schemaVersion: 1;
  readonly providers: Record<SandInferenceProvider, SandInferenceRouterUsageProvider>;
}

export function isSandInferenceProvider(value: unknown): value is SandInferenceProvider {
  return typeof value === "string" && (SAND_INFERENCE_PROVIDERS as readonly string[]).includes(value);
}

export function emptySandInferenceRouterUsage(): SandInferenceRouterUsage {
  const empty = (): SandInferenceRouterUsageProvider => ({ requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, lastUsedAt: null });
  return { schemaVersion: 1, providers: { cursor: empty(), "claude-code": empty(), codex: empty(), openrouter: empty(), "command-code": empty() } };
}

// Command Code serves open and closed models behind one OpenAI-compatible
// endpoint. Its catalog changes often, so the model list is read live from
// /models rather than pinned here; only chat-completions models are usable.
export const COMMAND_CODE_BASE_URL = "https://api.commandcode.ai/provider/v1";
export const COMMAND_CODE_MODELS_URL = `${COMMAND_CODE_BASE_URL}/models`;
export const COMMAND_CODE_DEFAULT_MODEL = "deepseek/deepseek-v4-flash";

export interface CommandCodeModel {
  readonly id: string;
  readonly name: string;
  readonly contextLength: number | null;
}

export function isCommandCodeModelId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && /^[\w.:/-]+$/.test(value);
}

export function parseCommandCodeModels(value: unknown): CommandCodeModel[] {
  const data = typeof value === "object" && value != null ? (value as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) throw new Error("Command Code returned an unexpected model list.");
  const models: CommandCodeModel[] = [];
  const seen = new Set<string>();
  for (const raw of data) {
    if (typeof raw !== "object" || raw == null) continue;
    const row = raw as { id?: unknown; name?: unknown; context_length?: unknown; supported_endpoints?: unknown };
    if (!isCommandCodeModelId(row.id) || seen.has(row.id)) continue;
    if (!Array.isArray(row.supported_endpoints) || !row.supported_endpoints.includes("/chat/completions")) continue;
    seen.add(row.id);
    models.push({
      id: row.id,
      name: typeof row.name === "string" && row.name.trim().length > 0 ? row.name.trim() : row.id,
      contextLength: Number.isSafeInteger(row.context_length) && (row.context_length as number) > 0 ? row.context_length as number : null,
    });
  }
  return models;
}
