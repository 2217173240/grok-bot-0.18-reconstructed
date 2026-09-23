import { createHash, randomUUID } from "node:crypto";
import WebSocket from "ws";

if (process.platform !== "darwin") throw new Error("Run this smoke against the isolated macOS package");
const cdp = process.env.MAC_UI_CDP_URL ?? "http://127.0.0.1:9223";
const pages = await (await fetch(`${cdp}/json/list`, { signal: AbortSignal.timeout(10_000) })).json();
const target = pages.find(page => page.type === "page" && page.title === "Grok Bot" && page.url.includes(".app/Contents/Resources/app.asar/dist/renderer/index.html"));
if (!target) throw new Error("No packaged Grok Bot renderer CDP page");
const ws = new WebSocket(target.webSocketDebuggerUrl, { handshakeTimeout: 10_000 });
await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
let nextId = 0;
const pending = new Map();
const fail = error => { for (const call of pending.values()) { clearTimeout(call.timer); call.reject(error); } pending.clear(); };
ws.on("error", fail);
ws.on("close", () => fail(new Error("CDP connection closed")));
ws.on("message", bytes => {
  const message = JSON.parse(bytes.toString());
  const call = pending.get(message.id);
  if (!call) return;
  pending.delete(message.id);
  clearTimeout(call.timer);
  if (message.error) call.reject(new Error(JSON.stringify(message.error)));
  else call.resolve(message.result);
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10_000);
  pending.set(id, { resolve, reject, timer });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result?.value;
};

try {
  if (process.argv.includes("--inspect")) {
    console.log(JSON.stringify(await evaluate("({text:document.body.innerText,controls:[...document.querySelectorAll('input,textarea,[contenteditable],button')].map(e=>({tag:e.tagName,label:e.getAttribute('aria-label'),disabled:e.disabled,html:e.outerHTML.slice(0,500)}))})")));
  } else {
    if (await evaluate("Boolean(document.querySelector('#sand-onboarding-create-name'))")) {
      await evaluate("document.querySelector('#sand-onboarding-create-name').focus()");
      await send("Input.insertText", { text: "Mac Source Audit" });
      await evaluate("(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Get started');if(!e||e.disabled)throw Error('Onboarding unavailable');e.click()})()");
    }
    const workspace = process.env.MAC_UI_WORKSPACE;
    if (!workspace?.startsWith("/repo/.cache/provider-live/workspace")) throw new Error("MAC_UI_WORKSPACE must target the isolated provider workspace");
    const nonce = `mac-ui-${randomUUID()}`;
    const digest = createHash("sha256").update(nonce).digest("hex");
    const file = `${workspace}/mac-ui-smoke-${nonce}.txt`;
    const prompt = `Use Bash to run uname -s, write the exact text ${nonce} without a trailing newline to ${file}, read it back and compute its SHA256. Also call the echo__echo MCP tool with text ${nonce}. In your final reply report the SHA256, operating system and MCP result.`;
    await evaluate("(()=>{const e=document.querySelector('[aria-label=\"Prompt\"]');if(!e)throw Error('Prompt missing');e.focus();const r=document.createRange();r.selectNodeContents(e);const s=getSelection();s.removeAllRanges();s.addRange(r);return true})()");
    await send("Input.insertText", { text: prompt });
    await evaluate("(()=>{const e=document.querySelector('[aria-label=\"Send message\"]');if(!e||e.disabled)throw Error('Send unavailable');e.click();return true})()");
    console.log(JSON.stringify({ nonce, file, digest, submitted: true }));
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      const text = await evaluate("document.body.innerText");
      if (text.includes(digest) && text.includes("Linux") && text.includes(`echo:${nonce}`)) {
        console.log(JSON.stringify({ nonce, rendererResult: true, text }));
        process.exitCode = 0;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    if (process.exitCode !== 0) throw new Error("Mac renderer did not display the file SHA256, Linux and MCP echo within 240 seconds");
  }
} finally {
  fail(new Error("CDP session finished"));
  ws.terminate();
}
