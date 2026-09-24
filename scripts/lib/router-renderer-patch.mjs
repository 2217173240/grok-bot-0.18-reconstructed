import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const REGISTRY_BEFORE = 'const wDn=[{id:"general",label:"General",icon:"settings-gear"},{id:"usage",label:"Usage & Billing",icon:"chart-bars"},{id:"beta",label:"Updates",icon:"cloud-download"}]';
const REGISTRY_AFTER = 'const wDn=[{id:"general",label:"General",icon:"settings-gear"},{id:"router",label:"Router",icon:"git-branch"},{id:"usage",label:"Usage & Billing",icon:"chart-bars"},{id:"beta",label:"Updates",icon:"cloud-download"}]';
const GENERAL_BEFORE = 'Q=x==="general"?a.jsx(Te,{children:a.jsx(Sa,{auth:t})}):null';
const GENERAL_AFTER = 'Q=x==="general"?a.jsx(Te,{children:a.jsx(Sa,{auth:t})}):x==="router"?a.jsx(RRouterPanel,{}):null';
const USAGE_BEFORE = 'Z=x==="usage"?a.jsx(Te,{children:a.jsx(Na,{})}):null';
const USAGE_AFTER = 'Z=x==="usage"?a.jsx(Te,{children:a.jsx(RRouterUsage,{})}):null';
const COMPONENT_ANCHOR = 'function Sa(s){';
// The shipped renderer is its own worst enemy here: its transcript projection
// writes `text` on ordinary message entries, while this extractor reads
// `content` and feeds the result straight to `String.prototype.matchAll`. A
// single ordinary message therefore yields `undefined.matchAll`, and the error
// boundary replaces the whole chat with "Something went wrong". Accept both
// spellings and never hand a non-string to matchAll.
const ENTRY_TEXT_BEFORE = 'function A_n(n){switch(n.kind){case"message":return n.content;case"send-message":return n.message.type==="text"?n.message.content:"";case"notice":return n.text;default:return""}}';
const ENTRY_TEXT_AFTER = 'function A_n(n){switch(n.kind){case"message":return n.content??n.text??"";case"send-message":return n.message.type==="text"?n.message.content??n.message.text??"":"";case"notice":return n.text??"";default:return""}}';
const PR_SCAN_BEFORE = 'function Fpt(n){const e=[];for(const t of n.matchAll(I_n)){';
const PR_SCAN_AFTER = 'function Fpt(n){const e=[];const s0=typeof n==="string"?n:"";for(const t of s0.matchAll(I_n)){';
// Exported so the regression guard can exercise the transform without the
// pinned artifact: `src/app/dist` is a bootstrap output that a fresh checkout
// (and therefore CI) does not carry.
export const RENDERER_ENTRY_TEXT_ANCHORS = Object.freeze({
  entryTextBefore: ENTRY_TEXT_BEFORE,
  entryTextAfter: ENTRY_TEXT_AFTER,
  prScanBefore: PR_SCAN_BEFORE,
  prScanAfter: PR_SCAN_AFTER,
});

const COMPONENT_SOURCE = String.raw`
const RRouterProviders=[
  {value:"cursor",label:"Cursor",description:"Use your signed-in Cursor account.",kind:"account"},
  {value:"claude-code",label:"Claude Code",description:"Use your existing Claude Code sign-in and Grok Bot's connected plugins.",kind:"local",localKey:"claude-code"},
  {value:"codex",label:"Codex",description:"Use your existing ChatGPT sign-in from Codex with Grok Bot's connected plugins.",kind:"local",localKey:"codex"},
  {value:"openrouter",label:"OpenRouter",description:"Route through your OpenRouter account and selected model.",kind:"key",secret:"OPENROUTER_API_KEY"},
  {value:"command-code",label:"Command Code",description:"Route through your Command Code plan and the model you pick below.",kind:"key",secret:"COMMAND_CODE_API_KEY",models:!0}
],RRouterOptions=RRouterProviders.map(s=>({value:s.value,label:s.label})),RRouterEmptyUsage={requests:0,inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,lastUsedAt:null},RRouterInputClass="sand-9f619 sand-h8yej3 sand-5f5z56 sand-u97haq sand-lrnmfh sand-uve7l6 sand-16b7oty sand-1rgtt3y sand-o7x2bt sand-mkeg23 sand-1y0btm7 sand-qz0629 sand-1043rbw sand-13l7odt sand-1wd3ewq sand-jb2p0i sand-4z9k3i sand-frs9s4 sand-tt52l0 sand-1odjw0f sand-1t137rt sand-ltfok3";
function RRouterState(){
  const[s,e]=de.useState({provider:"cursor",usage:null,local:null,error:null});
  de.useEffect(()=>{let t=!0;const n=r=>{t&&e(r.detail)};window.addEventListener("sand-router-provider-changed",n);window.desktop.agent.getInferenceRouter().then(r=>{t&&e({...r,error:null})}).catch(r=>{t&&e(i=>({...i,error:String(r?.message??r)}))});return()=>{t=!1;window.removeEventListener("sand-router-provider-changed",n)}},[]);
  const t=async n=>{const r=s;e(i=>({...i,provider:n,error:null}));try{const i=await window.desktop.agent.setInferenceRouter(n),o={...i,error:null};e(o);window.dispatchEvent(new CustomEvent("sand-router-provider-changed",{detail:o}))}catch(i){e({...r,error:String(i?.message??i)})}};
  return[s,t]
}
function RRouterSecrets(){
  const[state,setState]=de.useState({keys:[],loading:!0,error:null}),[revision,setRevision]=de.useState(0);
  de.useEffect(()=>{let active=!0;setState({keys:[],loading:!0,error:null});
    window.desktop.secrets.list().then(result=>{if(!Array.isArray(result?.keys))throw new Error("Invalid secrets list");if(active)setState({keys:result.keys,loading:!1,error:null})}).catch(()=>{if(active)setState({keys:[],loading:!1,error:"Could not load API keys. Retry to check saved keys."})});
    return()=>{active=!1}
  },[revision]);
  return[state,()=>setRevision(value=>value+1)]
}
function RRouterNumber(s){return new Intl.NumberFormat().format(s)}
function RRouterCredential(props){return a.jsx(RRouterCredentialInput,props,props.provider.value)}
function RRouterCredentialInput({provider:s,state:e,keys:t,onSaved:n}){
  const[value,setValue]=de.useState(""),[busy,setBusy]=de.useState(null),[failure,setFailure]=de.useState(null);
  if(s.kind==="account")return a.jsx(se,{as:"span",color:"secondary",size:"sm",children:"Signed in"});
  if(s.kind==="local"){const c=e.local?.[s.localKey],d=c?.installed&&c?.authenticated;return a.jsx(se,{as:"span",color:d?"primary":"secondary",size:"sm",children:d?"Ready":c?.installed?"Sign in with "+(s.value==="codex"?"codex login":"claude"):"Not installed"})}
  const present=t.keys.includes(s.secret),disabled=busy!==null||t.loading||t.error!==null;
  const mutate=async operation=>{
    if(busy!==null||(operation==="save"&&value.trim().length===0))return;
    setBusy(operation);setFailure(null);
    try{
      const result=operation==="save"?await window.desktop.secrets.upsert({[s.secret]:value.trim()}):await window.desktop.secrets.remove([s.secret]);
      if(result?.synced!==!0){setFailure({operation,message:operation==="save"?"API key sync failed. Retry Save to finish syncing.":"API key removal sync failed. Retry removal to finish syncing."});return}
      setValue("");n()
    }catch{setFailure({operation,message:operation==="save"?"Could not save API key. Retry Save.":"Could not remove API key. Retry removal."})}
    finally{setBusy(null)}
  };
  return a.jsxs("div",{style:{width:360},children:[
    a.jsxs("div",{className:"sand-9f619 sand-78zum5 sand-6s0dn4 sand-h8yej3",children:[a.jsx("input",{"aria-label":s.secret,className:RRouterInputClass,disabled,onChange:event=>setValue(event.currentTarget.value),placeholder:t.loading?"Loading API keys…":t.error?"API key status unavailable":present?"Replace key":"Paste API key",style:{fontSize:13,height:34,minWidth:0,padding:"0 10px",width:270},type:"password",value}),a.jsx(oe,{disabled:disabled||value.trim().length===0,onClick:()=>mutate("save"),shape:"rectangular",size:"sm",variant:"secondary",children:busy==="save"?"Saving…":failure?.operation==="save"?"Retry Save":"Save"})]}),
    present||failure!==null?a.jsx(oe,{disabled:busy!==null||t.loading,onClick:()=>mutate("remove"),shape:"rectangular",size:"sm",variant:"secondary",children:busy==="remove"?"Removing…":failure?.operation==="remove"?"Retry removal":failure?"Remove key":"Remove saved key"}):null,
    t.loading?a.jsx(se,{as:"p",role:"status",color:"secondary",size:"sm",children:"Loading API keys…"}):null,
    t.error?a.jsxs("div",{children:[a.jsx(se,{as:"p",role:"alert",color:"red",size:"sm",children:t.error}),a.jsx(oe,{disabled:busy!==null,onClick:n,shape:"rectangular",size:"sm",variant:"secondary",children:"Retry loading keys"})]}):null,
    failure?a.jsx(se,{as:"p",role:"alert",color:"red",size:"sm",children:failure.message}):null
  ]})
}
function RRouterUsageRows({usage:s}){return a.jsxs("div",{children:[a.jsx(ie,{label:"Requests",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:RRouterNumber(s.requests)})}),a.jsx(ie,{divided:!0,label:"Input tokens",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:RRouterNumber(s.inputTokens)})}),a.jsx(ie,{divided:!0,label:"Output tokens",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:RRouterNumber(s.outputTokens)})}),a.jsx(ie,{divided:!0,label:"Cache tokens",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:RRouterNumber(s.cacheReadTokens+s.cacheWriteTokens)})}),a.jsx(ie,{divided:!0,label:"Last used",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:s.lastUsedAt?new Date(s.lastUsedAt).toLocaleString():"Not used yet"})})]})}
function RBoxRuntime(){const[s,e]=de.useState({mode:"remote",status:null,error:null,busy:!0});de.useEffect(()=>{let t=!0;window.desktop.agent.getBoxRuntime().then(n=>{t&&e({...n,error:null,busy:!1})}).catch(n=>{t&&e(r=>({...r,error:String(n?.message??n),busy:!1}))});return()=>{t=!1}},[]);const t=s.mode==="local-docker",n=async()=>{const r=t?"remote":"local-docker";e(i=>({...i,mode:r,busy:!0,error:null}));try{const i=await window.desktop.agent.setBoxRuntime(r);e({...i,error:null,busy:!1})}catch(i){e(o=>({...o,mode:t?"local-docker":"remote",error:String(i?.message??i),busy:!1}))}};return a.jsxs("div",{children:[a.jsx(ie,{description:t?(s.status?.detail??"Shell, files and computer use run in a Docker container on this Mac."):"Shell, files and computer use run on Grok Bot's remote computer.",label:"Use local Docker VM",variant:"card",children:a.jsx("button",{"aria-checked":t,"aria-label":"Use local Docker VM",disabled:s.busy,onClick:n,role:"switch",style:{appearance:"none",background:t?"var(--color-accent-primary, #4f8cff)":"rgba(255,255,255,.14)",border:0,borderRadius:999,cursor:s.busy?"wait":"pointer",height:22,opacity:s.busy?0.65:1,padding:2,position:"relative",transition:"background .15s ease",width:38},type:"button",children:a.jsx("span",{style:{background:"white",borderRadius:"50%",boxShadow:"0 1px 3px rgba(0,0,0,.35)",display:"block",height:18,transform:"translateX("+(t?16:0)+"px)",transition:"transform .15s ease",width:18}})})}),s.error?a.jsx(se,{as:"p",color:"red",size:"sm",children:s.error}):null]})}
function RCommandCodeModel(){const[s,e]=de.useState({models:[],selected:null,error:null,busy:!0});de.useEffect(()=>{let t=!0;window.desktop.agent.getCommandCodeModels().then(n=>{t&&e({...n,busy:!1})}).catch(n=>{t&&e(r=>({...r,error:String(n?.message??n),busy:!1}))});return()=>{t=!1}},[]);const t=async n=>{const r=s.selected;e(i=>({...i,selected:n,error:null}));try{await window.desktop.agent.setCommandCodeModel(n)}catch(i){e(o=>({...o,selected:r,error:String(i?.message??i)}))}},n=s.models.map(r=>({value:r.id,label:r.name})),r=s.selected!=null&&!n.some(i=>i.value===s.selected)?[{value:s.selected,label:s.selected},...n]:n,i=s.busy?"Loading models from Command Code…":s.error?s.error:RRouterNumber(s.models.length)+" models available. New models show up here as Command Code adds them.";return a.jsx(ie,{description:i,label:"Model",variant:"card",children:r.length===0?a.jsx(se,{as:"span",color:"secondary",size:"sm",children:s.busy?"Loading…":"Unavailable"}):a.jsx(ye,{"aria-label":"Command Code model",onValueChange:o=>{if(o!==null&&o!==s.selected)void t(o)},options:r,placement:"bottom-end",size:"lg",value:s.selected,variant:"filled"})})}
function RRouterPanel(){const[s,e]=RRouterState(),[t,n]=RRouterSecrets(),r=RRouterProviders.find(i=>i.value===s.provider)??RRouterProviders[0],i=s.usage?.providers?.[s.provider]??RRouterEmptyUsage,o=r.value==="codex"?"Uses the private ChatGPT login already stored by Codex on this Mac. Requests are made by Grok Bot directly.":r.kind==="local"?"Uses Claude Code's existing login on this Mac.":r.kind==="key"?"Manage the API key used for this provider.":"Uses the account already connected to Grok Bot.";return a.jsx(Te,{children:a.jsxs("div",{className:k("sand-settings-general","sand-9f619 sand-78zum5 sand-dt5ytf sand-3qzy4x"),children:[a.jsx(re,{title:"Routing",children:a.jsx(ie,{description:r.description,label:"Provider",variant:"card",children:a.jsx(ye,{"aria-label":"Routing provider",onValueChange:l=>{if(l!==null)void e(l)},options:RRouterOptions,placement:"bottom-end",size:"lg",value:s.provider,variant:"filled"})})}),a.jsx(re,{title:"Computer",children:a.jsx(RBoxRuntime,{})}),r.models?a.jsx(re,{title:"Model",children:a.jsx(RCommandCodeModel,{})}):null,a.jsx(re,{title:r.kind==="key"?r.label+" account":"Account",children:a.jsx(ie,{description:o,label:r.kind==="key"?"API key":"Status",variant:"card",children:a.jsx(RRouterCredential,{provider:r,state:s,keys:t,onSaved:n})})}),s.error?a.jsx(se,{as:"p",color:"red",size:"sm",children:s.error}):null,a.jsx(re,{title:"Usage for "+r.label,children:a.jsx(RRouterUsageRows,{usage:i})})]})})}
function RRouterUsageSummary({provider:s,usage:e,current:t,divided:n}){const r=[RRouterNumber(e.requests)+" requests",RRouterNumber(e.inputTokens)+" input",RRouterNumber(e.outputTokens)+" output",RRouterNumber(e.cacheReadTokens+e.cacheWriteTokens)+" cached"].join(" · "),i=t?"Current route":e.lastUsedAt?new Date(e.lastUsedAt).toLocaleString():"Not used yet";return a.jsx(ie,{divided:n,description:r,label:s.label,variant:"card",children:a.jsx(se,{as:"span",color:t?"primary":"secondary",size:"sm",children:i})})}
function RRouterUsage(){const[s]=RRouterState(),e=RRouterProviders.find(t=>t.value===s.provider)??RRouterProviders[0],t=RRouterProviders.filter(n=>n.value===s.provider||(s.usage?.providers?.[n.value]?.requests??0)>0);return a.jsxs("div",{className:k("sand-usage-section","sand-9f619 sand-78zum5 sand-dt5ytf sand-ou54vl"),children:[a.jsx(re,{title:"Current provider",children:a.jsx(ie,{description:e.description,label:e.label,variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:"Selected"})})}),a.jsx(re,{title:"Tracked activity",children:a.jsx("div",{children:t.map((n,r)=>a.jsx(RRouterUsageSummary,{provider:n,usage:s.usage?.providers?.[n.value]??RRouterEmptyUsage,current:n.value===s.provider,divided:r>0},n.value))})}),s.provider==="cursor"?a.jsx(Na,{}):null]})}
`;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + 1) >= 0) throw new Error(`Original renderer ${label} anchor is missing or ambiguous.`);
  return source.slice(0, first) + after + source.slice(first + before.length);
}

export function patchOriginalSettingsRegistry(source) {
  return replaceExactlyOnce(source, REGISTRY_BEFORE, REGISTRY_AFTER, "settings registry");
}

export function patchOriginalEntryTextExtractor(source) {
  let patched = replaceExactlyOnce(source, ENTRY_TEXT_BEFORE, ENTRY_TEXT_AFTER, "entry text extractor");
  patched = replaceExactlyOnce(patched, PR_SCAN_BEFORE, PR_SCAN_AFTER, "PR scan receiver");
  return patched;
}

export function patchOriginalSettingsPanel(source) {
  let patched = replaceExactlyOnce(source, COMPONENT_ANCHOR, `${COMPONENT_SOURCE}${COMPONENT_ANCHOR}`, "component insertion");
  patched = replaceExactlyOnce(patched, GENERAL_BEFORE, GENERAL_AFTER, "Router panel switch");
  patched = replaceExactlyOnce(patched, USAGE_BEFORE, USAGE_AFTER, "Usage panel switch");
  return patched;
}

export async function applyOriginalRendererRouterPatch({ stageRoot }) {
  const assetsRoot = path.join(stageRoot, "dist", "renderer", "assets");
  const registryCandidates = [];
  const panelCandidates = [];
  for (const name of await readdir(assetsRoot)) {
    if (!name.endsWith(".js")) continue;
    const target = path.join(assetsRoot, name);
    const source = await readFile(target, "utf8");
    if (source.includes(REGISTRY_BEFORE)) registryCandidates.push({ name, target, source });
    if (source.includes(COMPONENT_ANCHOR) && source.includes(GENERAL_BEFORE) && source.includes(USAGE_BEFORE)) panelCandidates.push({ name, target, source });
  }
  if (registryCandidates.length !== 1 || panelCandidates.length !== 1) {
    throw new Error(`Expected one original Settings registry and panel chunk, found ${registryCandidates.length}/${panelCandidates.length}.`);
  }
  const changes = [];
  for (const [role, candidate, transform] of [
    ["registry", registryCandidates[0], patchOriginalSettingsRegistry],
    ["panel", panelCandidates[0], patchOriginalSettingsPanel],
  ]) {
    const patched = transform(candidate.source);
    await writeFile(candidate.target, patched);
    changes.push({
      role,
      path: `dist/renderer/assets/${candidate.name}`,
      original: { bytes: Buffer.byteLength(candidate.source), sha256: sha256(candidate.source) },
      patched: { bytes: Buffer.byteLength(patched), sha256: sha256(patched) },
    });
  }
  // The entry-text extractor lives in the renderer entry chunk, not the
  // Settings chunks above, so patch it wherever it is found.
  const entryTextCandidates = [];
  for (const name of await readdir(assetsRoot)) {
    if (!name.endsWith(".js")) continue;
    const target = path.join(assetsRoot, name);
    const source = await readFile(target, "utf8");
    if (source.includes(ENTRY_TEXT_BEFORE)) entryTextCandidates.push({ name, target, source });
  }
  if (entryTextCandidates.length !== 1) {
    throw new Error(`Expected one renderer chunk carrying the entry text extractor, found ${entryTextCandidates.length}.`);
  }
  for (const candidate of entryTextCandidates) {
    const patched = patchOriginalEntryTextExtractor(candidate.source);
    await writeFile(candidate.target, patched);
    changes.push({
      role: "entry-text-extractor",
      path: `dist/renderer/assets/${candidate.name}`,
      original: { bytes: Buffer.byteLength(candidate.source), sha256: sha256(candidate.source) },
      patched: { bytes: Buffer.byteLength(patched), sha256: sha256(patched) },
    });
  }
  const record = {
    schemaVersion: 1,
    mode: "original-renderer-settings-extension",
    chunks: changes,
    features: ["settings-router-provider", "settings-command-code-model", "settings-local-docker-vm", "usage-current-provider", "transcript-entry-text-shape"],
    transformations: ["settings-registry", "router-panel", "usage-panel", "entry-text-extractor"],
  };
  const provenancePath = path.join(stageRoot, "dist", "renderer-router-extension.json");
  await writeFile(provenancePath, `${JSON.stringify(record, null, 2)}\n`);
  return { ...record, provenancePath, provenanceBytes: (await stat(provenancePath)).size };
}
