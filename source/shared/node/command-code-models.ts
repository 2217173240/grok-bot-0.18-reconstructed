import { COMMAND_CODE_MODELS_URL, parseCommandCodeModels, type CommandCodeModel } from "../inference-router.js";

const COMMAND_CODE_MODELS_TIMEOUT_MS = 10_000;

// The catalog is public and changes daily, so every Settings visit reads it
// fresh instead of caching a list that would hide new models.
export async function fetchCommandCodeModels(fetchImpl: typeof fetch = fetch): Promise<CommandCodeModel[]> {
  const response = await fetchImpl(COMMAND_CODE_MODELS_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(COMMAND_CODE_MODELS_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Command Code model list failed with HTTP ${response.status}.`);
  return parseCommandCodeModels(await response.json());
}
