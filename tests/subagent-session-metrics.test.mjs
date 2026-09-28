import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
await mkdir(path.join(root, ".cache"), { recursive: true });
const directory = await mkdtemp(path.join(root, ".cache/subagent-metrics-"));
const outfile = path.join(directory, "runtime.mjs");
await build({ stdin: { contents: `
  export { SandAgentRunner } from "./source/host/runner/sand-agent-runner.ts";
  export { createProductionSubagentSession } from "./source/host/runner/production-subagent-session.ts";
  export { createContext } from "./source/packages/context/core.ts";
  export { RegistryResourceAccessor } from "./source/packages/agent-exec/resource-provider.ts";
`, resolveDir: root }, outfile, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent" });
const api = await import(pathToFileURL(outfile).href);
test.after(() => rm(directory, { recursive: true, force: true }));

for (const cancelled of [false, true]) {
  test(`生产子会话${cancelled ? "取消" : "完成"}后保留 runner 的审计与单次用量`, async () => {
    const records = [];
    const resourceAccessor = new api.RegistryResourceAccessor();
    const ready = Promise.withResolvers();
    const usage = { inputTokens: 13, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 0 };
    const runner = new api.SandAgentRunner({
      conversationId: "metrics-child", isSubagent: true, subagentType: "computerUse", subagentModelId: "metrics-model",
      ctx: api.createContext(),
      box: { ensureReady: async () => ({ remoteAccessor: resourceAccessor, terminalsFolder: directory }) },
      actionAuditor: { record: record => records.push(record) },
      transport: { onUpdate: () => {} },
      runStep: async (_step, context) => {
        runner.computerUse.recordAuditIntent("click");
        runner.computerUse.recordAuditIntent("screenshot");
        context.emitUpdate({ type: "turn-ended", usage });
        ready.resolve();
        if (cancelled) await new Promise(resolve => context.signal.addEventListener("abort", resolve, { once: true }));
        return { done: true, value: { text: "completed actions retained", aborted: context.signal.aborted } };
      },
    });
    const session = api.createProductionSubagentSession(runner);
    const run = session.run("Collect session metrics");
    await ready.promise;
    if (cancelled) session.interrupt("user stopped");
    assert.equal((await run).aborted, cancelled);
    assert.deepEqual([...session.getComputerUseAuditActionCounts()], [["click", 1], ["screenshot", 1]]);
    assert.deepEqual(session.getComputerUseUsageSnapshot(), { modelId: "metrics-model", turnEndedCount: 1, usage });
    assert.deepEqual(session.getComputerUseUsageSnapshot(), runner.getComputerUseUsageSnapshot());
    assert.equal(session.getComputerUseAuditActionCounts(), runner.getComputerUseAuditActionCounts());
  });
}
