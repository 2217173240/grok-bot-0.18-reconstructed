import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";

export type CodexReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
const efforts = new Set<string>(["minimal", "low", "medium", "high", "xhigh"]);

export function readCodexConfiguration(env: NodeJS.ProcessEnv = process.env): { model: string; reasoningEffort?: CodexReasoningEffort } {
  const file = join(env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "config.toml");
  let raw: string;
  try { raw = readFileSync(file, "utf8"); }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Cannot read Codex configuration: ${file}`, { cause });
    raw = "";
  }
  let config: Record<string, unknown>;
  try { config = parse(raw); }
  catch { throw new Error(`Invalid TOML in Codex configuration: ${file}`); }
  // 配置错误只报告字段与路径，不把可能含有凭据的原文放入错误信息。
  if (config.model !== undefined && (typeof config.model !== "string" || config.model.trim().length === 0)) throw new Error(`Invalid model in Codex configuration: ${file}`);
  if (config.model_reasoning_effort !== undefined && (typeof config.model_reasoning_effort !== "string" || !efforts.has(config.model_reasoning_effort))) throw new Error(`Invalid model_reasoning_effort in Codex configuration: ${file}`);
  const model = env.SAND_CODEX_MODEL?.trim() || (config.model as string | undefined)?.trim() || "gpt-5.4";
  const reasoning = env.SAND_CODEX_REASONING_EFFORT?.trim() || config.model_reasoning_effort;
  if (reasoning !== undefined && (typeof reasoning !== "string" || !efforts.has(reasoning))) throw new Error("Invalid SAND_CODEX_REASONING_EFFORT");
  return { model, ...(reasoning === undefined ? {} : { reasoningEffort: reasoning as CodexReasoningEffort }) };
}
