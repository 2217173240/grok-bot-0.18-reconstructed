export const SAND_INFERENCE_PROVIDERS = ["cursor", "claude-code", "codex", "openrouter"] as const;
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
  return { schemaVersion: 1, providers: { cursor: empty(), "claude-code": empty(), codex: empty(), openrouter: empty() } };
}

/** Coordinator-owned tool loop: the provider adapter executes Grok Bot plugins itself. */
export const ROUTED_PROVIDER_OWNED_TOOL_STEPS = 8;
/**
 * Host-owned tool loop: advertise tools, emit one model step of tool-call chunks,
 * and let SimplePromptToolExecutor execute them. An inner SDK loop with no
 * executeTool burns tokens without producing an assistant message.
 */
export const ROUTED_PROVIDER_HOST_TOOL_STEPS = 1;

export function routedProviderToolSteps(hasExecutor: boolean): 1 | 8 {
  return hasExecutor ? ROUTED_PROVIDER_OWNED_TOOL_STEPS : ROUTED_PROVIDER_HOST_TOOL_STEPS;
}
