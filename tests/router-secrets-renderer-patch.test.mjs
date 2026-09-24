import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "acorn";
import { simple } from "acorn-walk";
import { patchOriginalSettingsPanel } from "../scripts/lib/router-renderer-patch.mjs";

// 使用生产 patch 的完整插入结果检查构建产物；交互由 native UI 验证。
const source = patchOriginalSettingsPanel('function Sa(s){}Q=x==="general"?a.jsx(Te,{children:a.jsx(Sa,{auth:t})}):null;Z=x==="usage"?a.jsx(Te,{children:a.jsx(Na,{})}):null');
const program = parse(source, { ecmaVersion: "latest", sourceType: "module" });
const functions = new Map(program.body.filter(node => node.type === "FunctionDeclaration").map(node => [node.id.name, node]));
const code = node => source.slice(node.start, node.end);

test("production secrets list has explicit loading, rejection, and refetch states", () => {
  const hook = code(functions.get("RRouterSecrets"));
  assert.match(hook, /loading:!0/);
  assert.match(hook, /keys:result\.keys,loading:!1,error:null/);
  assert.match(hook, /\.catch\(\(\)=>/);
  assert.match(hook, /keys:\[\],loading:!1,error:"Could not load API keys/);
  assert.match(hook, /return\(\)=>\{active=!1\}/);
  assert.match(hook, /setRevision\(value=>value\+1\)/);
});

test("production secrets mutations stop before clearing the key or refetching on unconfirmed sync", () => {
  const credential = functions.get("RRouterCredentialInput");
  const mutations = [];
  simple(credential, { AwaitExpression(node) { mutations.push(code(node.argument)); } });
  assert.deepEqual(mutations, ["window.desktop.secrets.upsert({[s.secret]:value.trim()})", "window.desktop.secrets.remove([s.secret])"]);
  const conditions = [];
  simple(credential, { IfStatement(node) { if (code(node.test) === "result?.synced!==!0") conditions.push(node); } });
  assert.equal(conditions.length, 1);
  assert.equal(conditions[0].consequent.body.at(-1).type, "ReturnStatement");
  assert.match(code(conditions[0].consequent), /setFailure/);
  assert.doesNotMatch(code(conditions[0].consequent), /setValue|n\(\)/);
  assert.match(code(credential), /setValue\(""\);n\(\)/);
  assert.match(code(credential), /finally\{setBusy\(null\)\}/);
  const catches = [];
  simple(credential, { CatchClause(node) { catches.push(node); } });
  assert.equal(catches.length, 1);
  assert.equal(catches[0].param, null);
  assert.match(code(catches[0]), /Could not save API key/);
  assert.match(code(catches[0]), /Could not remove API key/);
});

test("production credential controls provide retries and removal without claiming session keys are saved", () => {
  const credential = code(functions.get("RRouterCredentialInput"));
  assert.match(credential, /"Retry Save"/);
  assert.match(credential, /"Retry removal"/);
  assert.match(credential, /"Retry loading keys"/);
  assert.match(credential, /"Remove saved key"/);
  assert.match(credential, /role:"alert"/);
  assert.match(credential, /role:"status"/);
  assert.match(credential, /present\?"Replace key":"Paste API key"/);
  assert.doesNotMatch(credential, /Replace saved key|\.reveal\(|console\./);
  assert.match(code(functions.get("RRouterCredential")), /a\.jsx\(RRouterCredentialInput,props,props\.provider\.value\)/);
});
