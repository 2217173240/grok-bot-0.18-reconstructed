import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
await mkdir(path.join(root, ".cache"), { recursive: true });
const directory = await mkdtemp(path.join(root, ".cache/prompt-assembly-"));
const bundle = path.join(directory, "runtime.mjs");
await build({ stdin: { contents: `
  export { createSystemPromptAssembly } from "./source/host/runner/system-prompt-assembly.ts";
  export { SAND_SYSTEM_PROMPT_CLOUD_AGENTS_DISABLED } from "./source/host/runner/system-prompt.ts";
  export { SandAgentDb } from "./source/host/extensions/session/agent-db.ts";
  export { readSandProfileFile, writeSandProfileFile } from "./source/host/agents/agent-profile.ts";
  export { spotlightPromptSection } from "./source/shared/sand-spotlight.ts";
`, resolveDir: root }, outfile: bundle, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent" });
const api = await import(pathToFileURL(bundle).href);
test.after(() => rm(directory, { recursive: true, force: true }));

async function setup(t, options = {}) {
  const agentDir = await mkdtemp(path.join(directory, "agent-"));
  const filePath = path.join(agentDir, "profile.json");
  const settingsFilePath = path.join(agentDir, "settings.json");
  const db = new api.SandAgentDb(path.join(agentDir, "agent.db"));
  t.after(() => db.close());
  const writeProfile = name => api.writeSandProfileFile(filePath, { name, description: "编程助手", title: name, avatarShape: "", avatarColor: "" });
  writeProfile("Alpha");
  let epoch = 0;
  const deps = {
    basePrompt: api.SAND_SYSTEM_PROMPT_CLOUD_AGENTS_DISABLED,
    isSubagentRunner: false, isSharedRoomRunner: false, isSystemPromptOverridden: false,
    agentProfileProvider: () => ({ ...api.readSandProfileFile(filePath), filePath, settingsFilePath }),
    agentStore: () => db, compactionEpoch: () => epoch,
    memoryStore: () => null, memorySnapshots: () => null, userMemory: () => null, projectMemory: () => null,
    isBoxScopedSubagent: () => false,
    requestContext: { resolve: () => ({ timeZone: "Asia/Singapore", userFullName: "Test User" }) },
    automationStore: () => null, workflowStore: () => null, channelStore: () => null,
    connectorManifests: [], mcpManagement: () => null,
    mcpCustomInstructionsSection: () => "Connector instructions: Ask the user before sending email.",
    mcpDiscoveryStatusSection: () => null, remoteBoxSection: () => "", computerSection: () => null,
    ...options,
  };
  return { assembly: api.createSystemPromptAssembly(deps), deps, db, writeProfile, nextEpoch: () => { epoch++; } };
}

function splitProfile(prompt) {
  const marker = "\n\nAgent profile:\n";
  const index = prompt.indexOf(marker);
  assert.ok(index > 0);
  assert.equal(prompt.indexOf(marker, index + marker.length), -1);
  return { prefix: prompt.slice(0, index), profile: prompt.slice(index + 2) };
}

for (const isSubagentRunner of [false, true]) {
  test(`${isSubagentRunner ? "subagent" : "普通 agent"} 将 profile 放在公共配置之后`, async t => {
    const first = await setup(t, { isSubagentRunner });
    const second = await setup(t, { isSubagentRunner });
    second.writeProfile("Beta");
    const a = splitProfile(first.assembly.getSystemPrompt());
    const b = splitProfile(second.assembly.getSystemPrompt());
    assert.equal(a.prefix, b.prefix);
    assert.ok(a.prefix.startsWith(first.deps.basePrompt));
    assert.ok(a.prefix.endsWith(first.deps.mcpCustomInstructionsSection()));
    assert.ok(a.prefix.includes(api.spotlightPromptSection({ canSendMessage: !isSubagentRunner })));
    assert.match(a.profile, /Title: Alpha/);
    assert.match(b.profile, /Title: Beta/);
    assert.ok(a.profile.endsWith('the default is visible. Pass only the fields you mean to change; the rest are preserved.'));
    if (isSubagentRunner) assert.equal(first.assembly.prepareAgentProfilePromptSnapshot(first.db), undefined);
  });
}

test("shared-room 保持 base、spotlight、profile 的顺序", async t => {
  const { assembly, deps, db } = await setup(t, { isSharedRoomRunner: true });
  const snapshot = assembly.prepareAgentProfilePromptSnapshot(db);
  assert.equal(assembly.getSystemPrompt(snapshot), [
    deps.basePrompt, api.spotlightPromptSection({ canSendMessage: true }),
    "Agent profile:\nTitle: Alpha\nDescription: 编程助手",
  ].join("\n\n"));
});

test("SQLite profile snapshot 在改名后保持末尾内容，summary 后更新身份", async t => {
  const { assembly, db, deps, writeProfile, nextEpoch } = await setup(t);
  const snapshot = assembly.prepareAgentProfilePromptSnapshot(db);
  const original = assembly.getSystemPrompt(snapshot);
  assert.equal(splitProfile(original).profile, snapshot.profileSection);
  writeProfile("Renamed");
  assert.deepEqual(assembly.prepareAgentProfilePromptSnapshot(db), snapshot);
  assert.equal(assembly.getSystemPrompt(snapshot), original);
  const update = assembly.getAgentProfileUpdateForTurn(snapshot);
  assert.match(update.text, /Current name: Renamed/);
  assembly.persistAnnouncedAgentProfile(db, snapshot, update.identity);
  const reopenedAssembly = api.createSystemPromptAssembly(deps);
  const persisted = reopenedAssembly.prepareAgentProfilePromptSnapshot(db);
  assert.equal(reopenedAssembly.getAgentProfileUpdateForTurn(persisted), null);
  assert.equal(reopenedAssembly.getSystemPrompt(persisted), original);
  nextEpoch();
  const refreshed = reopenedAssembly.prepareAgentProfilePromptSnapshot(db);
  assert.match(refreshed.profileSection, /Title: Renamed/);
  const current = splitProfile(reopenedAssembly.getSystemPrompt(refreshed));
  assert.equal(current.profile, refreshed.profileSection);
  assert.equal(current.prefix, splitProfile(original).prefix);
});
