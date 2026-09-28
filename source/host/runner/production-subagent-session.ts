import type { SubagentRunOptions, SubagentSession } from "./subagent-runtime.js";

export interface ProductionSubagentRunner extends Omit<Required<SubagentSession>, "run" | "interrupt"> {
  run(prompt: string, options?: SubagentRunOptions): Promise<unknown>;
  interrupt(reason: string): unknown;
}

export function createProductionSubagentSession(child: ProductionSubagentRunner): SubagentSession {
  return {
    run: async (prompt, options) => {
      const result = await child.run(prompt, options);
      if (typeof result !== "object" || result == null) {
        throw new TypeError("production subagent result is not bound");
      }
      const text = Reflect.get(result, "text");
      const aborted = Reflect.get(result, "aborted");
      if (typeof text !== "string" || typeof aborted !== "boolean") {
        throw new TypeError("production subagent result is not bound");
      }
      return { text, aborted };
    },
    interrupt: reason => { child.interrupt(reason); },
    getResolvedOutline: () => child.getResolvedOutline(),
    getObservedToolCallCount: () => child.getObservedToolCallCount(),
    getActivitySnapshot: () => child.getActivitySnapshot(),
    getTranscriptPath: () => child.getTranscriptPath(),
    getComputerUseUsageSnapshot: () => child.getComputerUseUsageSnapshot(),
    getComputerUseAuditActionCounts: () => child.getComputerUseAuditActionCounts(),
  };
}
