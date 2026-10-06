#!/usr/bin/env -S node --import tsx
/**
 * AWS desktop UI acceptance. Run with verify-tauri-headless.sh and isolated DB +
 * ready seed. Uses the real frozen SPA, native pointer input, and existing REST
 * transport. Cloud discovery and mutation responses are explicitly fixtures;
 * this proves UI requests and dialog behavior, never AWS resource completion.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Script } from "node:vm";
import { defaultEvidenceRoot, parseSelectionArgs, runHarness } from "@papercusp/verification-harness";

// Fail before an expensive native boot if the public lifecycle labels drift.
const lifecycleLabels = { start: "Start machine", stop: "Stop machine" };
function checkLifecycleLabels() {
  const modelSource = readFileSync("apps/operator/app/cloud-workspaces/workspace-view-model.ts", "utf8");
  for (const [action, label] of Object.entries(lifecycleLabels)) {
    if (!modelSource.includes(`${action}: ${JSON.stringify(label)}`)) {
      throw new Error(`Native selector contract changed: ${action} must use ${label}`);
    }
  }
  console.log("CW_AWS_NATIVE_PREFLIGHT passed: lifecycle label contract");
}

async function runNativeAssertions(ctx) {
const required = (name) => {
  if (!process.env[name]) throw new Error(`Missing ${name}; use verify-tauri-headless.sh`);
  return process.env[name];
};
const pid = required("VERIFY_TAURI_PID");
const display = required("VERIFY_TAURI_DISPLAY");
if (required("PAPERCUSP_VERIFY_TAURI_ISOLATED") !== "1" || !/^:\d+$/.test(display) || Number(display.slice(1)) < 90) {
  throw new Error("Refusing a shared database or desktop display");
}
const out = resolve(process.env.CW_AWS_EVIDENCE_DIR || ctx.evidenceDir);
mkdirSync(out, { recursive: true });
const tool = required("VERIFY_TAURI_AGENT_TOOLS_BIN");
const evidence = {
  status: "running", syntheticCloudResponses: true, realAwsLifecycleProven: false,
  bridgePid: Number(pid), ownerSid: required("VERIFY_TAURI_OWNER_SID"),
  launchProvenance: required("VERIFY_TAURI_LAUNCH_PROVENANCE"),
  spaDist: required("VERIFY_TAURI_SPA_DIST"), display, steps: [], sourceHashes: {},
};
for (const path of ["apps/operator/app/cloud-workspaces/ConnectStage.tsx", "apps/operator/app/cloud-workspaces/cloud-workspaces.module.css", "apps/operator/app/cloud-workspaces/page.tsx", "apps/operator/app/cloud-workspaces/workspace-host-actions.ts", "apps/operator/app/cloud-workspaces/workspace-view-model.ts", "scripts/verify-cloud-workspaces-aws.mjs"]) {
  evidence.sourceHashes[path] = createHash("sha256").update(readFileSync(path)).digest("hex");
}
const command = (bin, args, opts = {}) => execFileSync(bin, args, { encoding: "utf8", timeout: 120000, ...opts });
const ev = (js) => {
  new Script(js); // Validate generated JS before touching the native bridge.
  return command(tool, ["eval", "--pid", pid, js]).trim();
};
const poll = (selector, js, label) => {
  ctx.markStep(label);
  const result = command("bash", [required("VERIFY_TAURI_POLL"), "--require", selector, "--eval", js]);
  evidence.steps.push({ label, result });
  console.log(`PASS ${label}`);
};
const click = (selector) => {
  ctx.markStep(`click:${selector}`);
  command("bash", [required("VERIFY_TAURI_LIVENESS_CHECK")]);
  ev(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e || e.disabled)throw new Error('Missing/disabled target'); e.scrollIntoView({block:'center',behavior:'instant'}); return true; })()`);
  evidence.pointerTargets ??= [];
  evidence.pointerTargets.push(JSON.parse(ev(`(() => { const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2),grid=e.closest('[class*=configureColumns],[class*=connectLayout]'); return {selector:${JSON.stringify(selector)},rect:{x:r.x,y:r.y,width:r.width,height:r.height},hit:hit?.outerHTML.slice(0,600),gridColumns:grid?getComputedStyle(grid).gridTemplateColumns:null,gridWidth:grid?.getBoundingClientRect().width}; })()`)));
  poll(selector, `(() => { const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2); return r.width>0 && r.height>0 && !!hit && (hit===e || e.contains(hit)); })()`, `pointer target:${selector}`);
  const rect = JSON.parse(ev(`(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()`));
  const env = { ...process.env, DISPLAY: display };
  const wid = command("xdotool", ["search", "--pid", pid], { env }).trim().split(/\s+/).at(-1);
  const geometry = command("xwininfo", ["-id", wid], { env });
  const x = Number(/Absolute upper-left X:\s*(-?\d+)/.exec(geometry)?.[1]);
  const y = Number(/Absolute upper-left Y:\s*(-?\d+)/.exec(geometry)?.[1]);
  if (![x,y,rect.x,rect.y].every(Number.isFinite)) throw new Error("Invalid client coordinates");
  command("xdotool", ["mousemove", "--sync", String(x+rect.x), String(y+rect.y)], { env });
  command("xdotool", ["click", "1"], { env });
};
const type = (label, value) => {
  const selector = `input[aria-label=${JSON.stringify(label)}]`;
  click(selector);
  poll(selector, `document.activeElement===document.querySelector(${JSON.stringify(selector)})`, `focus:${label}`);
  const env = { ...process.env, DISPLAY: display };
  command("xdotool", ["key", "--clearmodifiers", "ctrl+a"], { env });
  command("xdotool", ["type", "--clearmodifiers", "--delay", "0", value], { env });
  poll(selector, `document.querySelector(${JSON.stringify(selector)}).value===${JSON.stringify(value)}`, `input:${label}`);
};
const markButton = (text, scope = "document") => {
  evidence.buttonLookups ??= [];
  evidence.buttonLookups.push(JSON.parse(ev(`(() => { const root=${scope}; return {text:${JSON.stringify(text)},scope:${JSON.stringify(scope)},candidates:[...(root?.querySelectorAll('button,[role=menuitem]')||[])].map(e=>({text:e.textContent.trim(),label:e.getAttribute('aria-label'),disabled:!!e.disabled}))}; })()`)));
  poll("body", `(() => { const root=${scope}; return [...(root?.querySelectorAll('button,[role=menuitem]')||[])].some(e=>e.textContent.trim()===${JSON.stringify(text)} && !e.disabled); })()`, `enabled button:${text}`);
  const selector = `#cw-native-${evidence.steps.length}`;
  ev(`(() => { const b=[...${scope}.querySelectorAll('button,[role=menuitem]')].find(e=>e.textContent.trim()===${JSON.stringify(text)}); if(!b)throw new Error('Missing '+${JSON.stringify(text)}); b.id=${JSON.stringify(selector.slice(1))}; return true; })()`);
  return selector;
};
const navigate = (step) => ev(`window.__TSR_ROUTER__.navigate({to:'/cloud-workspaces',search:{step:${JSON.stringify(step)}}}); true`);
const connectForm = 'form[aria-labelledby="connect-panel-heading"]';
const connectSubmit = `${connectForm} button[type="submit"]`;

try {
  ev(`(() => {
    const original=window.fetch;
    window.__cwNative={original,rows:[],calls:[],queries:0};
    const connection={kind:'connection',id:'aws-native',target:'aws',label:'AWS native fixture',status:'connected',credentialRef:'resolver://aws/native',provider:{vpcId:'vpc-native',securityGroupIds:['sg-native'],launchTemplateId:'lt-native'},scopes:[{id:'123456789012',label:'AWS account 123456789012'}],regions:[{id:'us-east-1',label:'Virginia',zones:['us-east-1a']}],sizes:[{id:'m6i.xlarge',label:'m6i.xlarge',vcpu:4,memoryGiB:16,hourlyUsd:0.19}],images:[{id:'ami-native',label:'Ubuntu 24.04'}],networks:[{id:'subnet-native',label:'Private subnet'}]};
    window.fetch=async function(input,init){
      const url=new URL(typeof input==='string'?input:input.url,location.href);
      const state=window.__cwNative;
      if(url.pathname.endsWith('/rest-query') && url.searchParams.get('name')==='workspaceHosts.control'){
        state.queries++; return new Response(JSON.stringify({rows:state.rows,version:String(state.queries)}),{status:200,headers:{'content-type':'application/json'}});
      }
      if(['/api/workspace-hosts/connection','/api/workspace-hosts/provision','/api/workspace-hosts/action'].includes(url.pathname) && init?.method==='POST'){
        const payload=JSON.parse(init.body); state.calls.push({path:url.pathname,payload});
        if(payload.action==='connect')state.rows=[connection];
        if(url.pathname.endsWith('/provision'))state.rows=[connection,{kind:'workspace',id:payload.desired.hostId,name:payload.name,connectionId:connection.id,target:'aws',scopeLabel:'123456789012',region:'us-east-1',size:'m6i.xlarge',image:'ami-native',diskGiB:100,network:'subnet-native',desiredState:'running',observedState:'running',recoverability:{kind:'snapshot',label:'snap-native'},capabilities:{start:false,stop:true,repair:true,snapshot:true,restore:true,destroy:true},resources:[{logicalKey:'snapshot',kind:'snapshot',state:'applied',providerId:'snap-native',attempts:1}]}];
        if(payload.action==='stop'){state.rows[1].desiredState='stopped';state.rows[1].observedState='stopped';state.rows[1].capabilities.start=true;state.rows[1].capabilities.stop=false;}
        return new Response(JSON.stringify({ok:true}),{status:200,headers:{'content-type':'application/json'}});
      }
      return original.call(this,input,init);
    }; return true;
  })()`);
  navigate("connect");
  poll('[data-stage="connect"]', "!!document.querySelector('button[aria-label=\"Connect Amazon Web Services\"]:not([disabled])')", "AWS admission available");
  click('button[aria-label="Connect Amazon Web Services"]');
  poll(connectForm, `!document.querySelector('input[aria-label="Google Cloud project ID"]') && document.querySelector(${JSON.stringify(connectSubmit)}).disabled`, "AWS fields and incomplete admission guard");
  for (const [label,value] of [["Connection label","AWS native fixture"],["Injected credential reference","resolver://aws/native"],["AWS account ID","123456789012"],["VPC ID","vpc-native"],["Private subnet ID","subnet-native"],["Security group IDs","sg-native"],["Launch template ID","lt-native"],["AMI ID","ami-native"],["Instance profile ARN","arn:aws:iam::123456789012:instance-profile/native"],["KMS key ARN","arn:aws:kms:us-east-1:123456789012:key/native"]]) type(label,value);
  poll('a[download]', "document.querySelector('a[download]').getAttribute('href')==='/api/workspace-hosts/aws-setup-template?accountId=123456789012&region=us-east-1'", "AWS setup-template download link");
  evidence.submitCandidates = JSON.parse(ev("JSON.stringify([...document.querySelectorAll('button[type=submit]')].map(e=>({label:e.textContent.trim(),disabled:e.disabled,form:e.closest('form')?.getAttribute('aria-labelledby')})))"));
  poll(connectForm, `!document.querySelector(${JSON.stringify(connectSubmit)}).disabled`, "AWS complete admission guard");
  click(connectSubmit);
  poll('nav[aria-label="Cloud workspace setup"]', "window.__cwNative.calls.some(c=>c.payload.action==='connect' && c.payload.target==='aws' && c.payload.vpcId==='vpc-native' && c.payload.securityGroupIds[0]==='sg-native' && c.payload.credentialSource.method==='default-chain')", "AWS connection request captured");
  navigate("configure");
  poll('[data-stage="configure"]', "document.body.textContent.includes('m6i.xlarge')", "AWS catalog renders");
  type("Workspace name","native-aws");
  poll('#provision-readiness', "[...document.querySelectorAll('#provision-readiness li[data-ok]')].every(e=>e.dataset.ok==='true')", "AWS provision readiness settled");
  click(markButton("Provision workspace"));
  poll('[data-stage]', "window.__cwNative.calls.some(c=>c.path.endsWith('/provision') && c.payload.desired.target==='aws' && c.payload.desired.scope.kind==='account' && c.payload.desired.provider.subnetId==='subnet-native')", "AWS account provision request captured");
  navigate("operate");
  poll('ul[aria-label="Managed workspace hosts"]', "!!document.querySelector('[aria-label=\"More actions for native-aws\"]')", "AWS host renders in Operate");
  click(markButton(lifecycleLabels.stop));
  poll('ul[aria-label="Managed workspace hosts"]', "window.__cwNative.calls.some(c=>c.payload.action==='stop') && document.body.textContent.includes('Start machine')", "AWS stop request and observed fixture state");
  click(markButton(lifecycleLabels.start));
  poll('ul[aria-label="Managed workspace hosts"]', "window.__cwNative.calls.some(c=>c.payload.action==='start')", "AWS start request captured");
  click('[aria-label="More actions for native-aws"]');
  poll('[role="menu"]', "document.querySelector('[role=menu]').textContent.includes('Snapshot')", "AWS shared lifecycle menu");
  click(markButton("Snapshot"));
  poll('ul[aria-label="Managed workspace hosts"]', "window.__cwNative.calls.some(c=>c.payload.action==='snapshot')", "AWS snapshot request captured");
  click('[aria-label="More actions for native-aws"]');
  poll('[role="menu"]', "document.querySelector('[role=menu]').textContent.includes('Restore snapshot')", "AWS durable restore action available");
  click(markButton("Restore snapshot"));
  poll('[role="dialog"]', "document.querySelector('[role=dialog]').textContent.includes('Restore native-aws')", "Real restore Modal opens");
  command("xdotool", ["key","--clearmodifiers","Escape"], {env:{...process.env,DISPLAY:display}});
  poll('ul[aria-label="Managed workspace hosts"]', "!document.querySelector('[role=dialog]')", "Real Modal onOpenChange closes on Escape");
  click('[aria-label="More actions for native-aws"]');
  poll('[role="menu"]', "document.querySelector('[role=menu]').textContent.includes('Restore snapshot')", "Restore menu reopens");
  click(markButton("Restore snapshot"));
  poll('[role="dialog"]', "document.querySelector('[role=dialog]').textContent.includes('snap-native')", "Durable snapshot selected");
  type("Restored workspace name","native-aws-restored");
  click(markButton("Restore workspace", "document.querySelector('[role=dialog]')"));
  poll('ul[aria-label="Managed workspace hosts"]', "!document.querySelector('[role=dialog]') && window.__cwNative.calls.some(c=>c.payload.action==='restore' && c.payload.snapshot.target==='aws' && c.payload.snapshot.providerId==='snap-native' && c.payload.desired.hostId==='host-native-aws-restored')", "AWS restore request and successful Modal dismissal");
  evidence.requests = JSON.parse(ev("JSON.stringify(window.__cwNative.calls)"));
  command(tool, ["screenshot","--pid",pid,"--output",resolve(out,"aws-operate.png")]);
  evidence.status = "passed";
} catch (error) {
  evidence.status = "failed";
  evidence.error = String(error.stderr || error.message || error);
} finally {
  try { evidence.finalDom = ev("JSON.stringify({href:location.href,text:document.body.innerText.slice(-16000),calls:window.__cwNative?.calls,focus:document.activeElement?.outerHTML,inputs:[...document.querySelectorAll('input')].map(e=>({label:e.getAttribute('aria-label'),value:e.value}))})"); } catch {}
  try { command(tool, ["screenshot","--pid",pid,"--output",resolve(out,"final.png")]); } catch {}
  try { ev("if(window.__cwNative){window.fetch=window.__cwNative.original;delete window.__cwNative;} true"); } catch {}
  writeFileSync(resolve(out,"result.json"), JSON.stringify(evidence,null,2));
  console.log(`CW_AWS_NATIVE_RESULT status=${evidence.status} syntheticCloudResponses=true realAwsLifecycleProven=false evidence=${out}`);
}
return evidence.status === "passed"
  ? { ok: true }
  : { ok: false, reasonCode: "native-ui-assertion-failed", detail: evidence.error };
}

const preflightOnly = process.argv.includes("--preflight");
const selection = parseSelectionArgs(process.argv.slice(2));
const result = await runHarness({
  contract: {
    name: "cloud-workspaces-aws",
    phases: [
      { id: "selectors" },
      { id: "native", dependsOn: ["selectors"] },
    ],
  },
  evidenceRoot: defaultEvidenceRoot("cloud-workspaces-aws"),
  selection: preflightOnly ? { only: ["selectors"], from: null } : selection,
  reuseFrom: selection.reuse,
  async runPhase(ctx) {
    if (ctx.phase === "selectors") {
      ctx.markStep("lifecycle-label-contract");
      checkLifecycleLabels();
      return { ok: true };
    }
    ctx.markStep("isolated-runtime-preconditions");
    return runNativeAssertions(ctx);
  },
});
process.exitCode = result.verdict === "pass" ? 0 : 1;
