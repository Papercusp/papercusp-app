#!/usr/bin/env node

/**
 * P-015 R-4: isolated, pointer-driven identity review journey.
 *
 * This driver owns a disposable coord_presence/adv_sessions fixture in the
 * verifier's isolated database, then drives the real Tauri webview. Mutation
 * responses are deliberately synthetic: this proves the UI's review,
 * failure, retry, and rollback rendering without pretending to prove a real
 * host activation. The artifact records that boundary explicitly.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import postgres from "postgres";
import { execFileSync } from "node:child_process";
import { isCliEntry } from "@papercusp/operator-core/lib/util/cli-entry";
import { redactIdentityLeaks } from "./lib/identity-leak-patterns.mjs";
import { openDeliveryLedger } from "../apps/operator/scripts/hooks/inject/delivery-ledger.mjs";

/**
 * Serialize the evidence artifact with every identity-leak class scrubbed.
 *
 * The artifact records spawned command lines and error stacks, and those carry the
 * absolute tauri-agent-tools path under the developer's home directory. git-sync's
 * content guard quarantines such a file on every sweep, so an unscrubbed artifact
 * copied into docs/evidence never commits and cannot back testing:record-run
 * (measured 2026-09-22: both R-4 artifacts sat quarantined for 141 consecutive
 * ticks). Scrubbing here, with the same module the guard uses, makes every
 * regeneration commit-safe instead of relying on the author to redact by hand.
 *
 * @param {unknown} evidence
 * @returns {string}
 */
export function serializeEvidence(evidence) {
  return `${redactIdentityLeaks(JSON.stringify(evidence, null, 2))}\n`;
}

/**
 * @param {string|number} pid
 * @param {readonly string[]} args
 * @returns {string[]}
 */
export function toolArgs(pid, args) {
  return [args[0], "--pid", pid, ...args.slice(1), ...(args[0] === "eval" ? [] : ["--json"])];
}

/**
 * @param {string} command
 * @param {readonly string[]} args
 * @param {Record<string, any>} [options]
 * @returns {string}
 */
export function checkedCommand(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", timeout: 45_000, ...options });
}

/**
 * Find an identity through the catalog's paginated pointer controls.
 * The injected page reader and pointer actions keep the live bridge in charge
 * while allowing the same traversal to run in the maintained test suite.
 */
export function selectIdentityInCatalog(id, label, { readPage, click, settle, maxPages = 100 }) {
  const selector = `[aria-label="Inspect identity ${id}"]`;
  let previousPage = null;
  for (let scanned = 1; scanned <= maxPages; scanned++) {
    const page = readPage(selector, scanned);
    if (page.marker === previousPage) {
      throw new Error(`identity catalog did not advance while looking for ${id}: ${page.marker}`);
    }
    if (page.found) {
      click(selector, label);
      return scanned;
    }
    if (!page.canAdvance) {
      throw new Error(`identity ${id} is absent after ${scanned} catalog page(s)`);
    }
    previousPage = page.marker;
    click('[aria-label="Identity catalog pages"] button:last-child', `${label}-next-page-${scanned}`);
    settle();
  }
  throw new Error(`identity ${id} was not found within ${maxPages} catalog pages`);
}

/** Require the rollback's own accepted response before inspecting activation. */
export function requireRollbackResponse({ poll, readResponse }) {
  poll();
  const response = readResponse();
  let body;
  try {
    body = JSON.parse(response?.body ?? "null");
  } catch {
    body = null;
  }
  if (response?.request?.action !== "rollback" || response?.status !== 200 || body?.ok !== true || body?.action !== "rollback") {
    throw new Error(`real rollback route refused the mutation: ${JSON.stringify(response)}`);
  }
  return response;
}

/** Exercise the real hook's ACK-on-emission protocol for the isolated fixture. */
export async function confirmFixtureDelivery({ request, emit, ledger }) {
  if (!ledger) throw new Error("fixture delivery ledger is unavailable");
  const rendered = await request(ledger.confirmed());
  if (rendered?.ok !== true || typeof rendered.text !== "string" || !rendered.text.trim()) {
    throw new Error("fixture host received no rendered control context");
  }
  // A fresh-context transition may have no confirmable candidate yet. Preserve
  // that pending state; the caller's activation assertions decide what it proves.
  if (!rendered.deliveryToken) return rendered;
  ledger.offer(rendered.deliveryToken);
  await emit(rendered.text);
  if (!ledger.commit()) throw new Error("fixture delivery emission was not recorded");
  const acknowledged = await request(ledger.confirmed());
  if (acknowledged?.ok !== true) throw new Error("fixture delivery confirmation failed");
  return acknowledged;
}

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name} (run through verify-tauri-headless.sh)`);
  return value;
};

export async function main() {
const pid = required("VERIFY_TAURI_PID");
const dsn = required("HARNESS_ADMIN_DATABASE_URL");
if (process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED !== "1") {
  throw new Error("PAPERCUSP_VERIFY_TAURI_ISOLATED=1 required; refusing shared database");
}
const isolatedHome = required("PAPERCUSP_HOME");
const parsedDsn = new URL(dsn);
if (!["127.0.0.1", "localhost"].includes(parsedDsn.hostname)
    || parsedDsn.port !== required("PAPERCUSP_PG_PORT")) {
  throw new Error("database address does not match the isolated verifier port");
}
required("VERIFY_TAURI_OWNER_SID");
required("VERIFY_TAURI_LAUNCH_PROVENANCE");
required("VERIFY_TAURI_SPA_DIST");
if (process.argv.includes("--preflight")) process.exit(0);
const tool = process.env.VERIFY_TAURI_AGENT_TOOLS_BIN || "tauri-agent-tools";
const workspace = process.env.PAPERCUSP_WORKSPACE_ID || process.env.PAPERCUSP_WORKSPACE || "default";
const realBackend = process.env.P015_R4_REAL_BACKEND === "1";
// Real-backend recovery leg (R-4 grade EI-24105995228250975): nuqs round-trip,
// provider-picker boundary, one FORCED apply failure refused by the real
// identity-management compare-and-swap, retry, and SSE sync invalidation.
const realRecovery = realBackend && process.env.P015_R4_REAL_RECOVERY === "1";
const owner = `p015-r4-owned-${process.pid}-${Date.now()}`;
const label = `P-015 R-4 disposable owner ${owner.slice(-12)}`;
const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
const outDir = process.env.TAURI_SURFACE_VERIFY_P015_R4_OUT || `/tmp/p015-r4-identities-${stamp}`;
mkdirSync(outDir, { recursive: true });

const evidence = {
  schemaVersion: "p015-r4-identities-ui-v1",
  status: "running",
  realBackend,
  realRecovery,
  syntheticMutationResponses: !realBackend,
  hostActivationProven: false,
  forcedRealFailureProven: false,
  workspace,
  owner,
  ownerLabel: label,
  treeHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  bridgePid: Number(pid),
  bridgeOwnerSid: process.env.VERIFY_TAURI_OWNER_SID || null,
  launchProvenance: process.env.VERIFY_TAURI_LAUNCH_PROVENANCE || null,
  frozenSpaDist: process.env.VERIFY_TAURI_SPA_DIST || null,
  steps: [],
};

const sql = postgres(dsn, { max: 1, connect_timeout: 10, idle_timeout: 2, onnotice: () => {} });
let sessionId = null;
let isolationVerified = false;

const run = (args, label) => {
  const result = checkedCommand(tool, toolArgs(pid, args), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 45_000,
  });
  evidence.steps.push({ label, command: [tool, "--pid", pid, ...args].join(" "), result: result.trim() });
  return result;
};

const settle = () => {
  const settlePath = process.env.VERIFY_TAURI_SETTLE;
  if (!settlePath) throw new Error("VERIFY_TAURI_SETTLE is required");
  execFileSync("bash", [settlePath], { stdio: "inherit", timeout: 45_000 });
};

const check = (args, label) => {
  try {
    // A sync invalidation may finish after DOM quiet; poll the actual predicate,
    // then record the exit-coded check against the settled page.
    const pollArgs = args.includes("--eval") && !args.includes("--require")
      ? ["--require", "body", ...args]
      : args;
    checkedCommand("bash", [required("VERIFY_TAURI_POLL"), ...pollArgs]);
    run(["check", ...args], label);
  } catch (error) {
    throw new Error(`${label} failed: ${error?.stderr || error?.message || error}`);
  }
};

const click = (selector, label) => {
  const display = required("VERIFY_TAURI_DISPLAY");
  if (!/^:[0-9]+$/.test(display) || Number(display.slice(1)) < 90) {
    throw new Error("pointer input requires a verifier-owned isolated display");
  }
  checkedCommand("bash", [required("VERIFY_TAURI_LIVENESS_CHECK")]);
  const rect = JSON.parse(evalFile(`(() => {
    const e = document.querySelector(${JSON.stringify(selector)});
    if (!e || e.disabled) throw new Error('missing or disabled pointer target');
    e.scrollIntoView({block:'center', inline:'center'});
    let r = e.getBoundingClientRect();
    if (r.left < 0 || r.right > window.innerWidth) {
      let node = e.parentElement;
      while (node) {
        if (node.scrollWidth > node.clientWidth) {
          node.scrollLeft += r.left - (window.innerWidth - r.width) / 2;
          r = e.getBoundingClientRect();
        }
        node = node.parentElement;
      }
      const scroller = document.scrollingElement;
      if (scroller) scroller.scrollLeft += r.left - (window.innerWidth - r.width) / 2;
      r = e.getBoundingClientRect();
    }
    if (r.left < 0 || r.right > window.innerWidth || r.top < 0 || r.bottom > window.innerHeight) {
      throw new Error('pointer target outside viewport: ' + JSON.stringify({left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:window.innerWidth,height:window.innerHeight}));
    }
    return {x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2), viewport:{width:window.innerWidth,height:window.innerHeight}};
  })()`, `pointer-${label}`));
  const env = { ...process.env, DISPLAY: display };
  const windows = checkedCommand("xdotool", ["search", "--pid", pid], { env }).trim().split(/\s+/);
  const window = windows.at(-1);
  const geometry = checkedCommand("xwininfo", ["-id", window], { env });
  const x = Number(/Absolute upper-left X:\s*(-?\d+)/.exec(geometry)?.[1]);
  const y = Number(/Absolute upper-left Y:\s*(-?\d+)/.exec(geometry)?.[1]);
  if (![x,y,rect.x,rect.y].every(Number.isFinite)) throw new Error("invalid X11 client origin");
  checkedCommand("xdotool", ["mousemove", "--sync", String(x+rect.x), String(y+rect.y)], { env });
  checkedCommand("xdotool", ["click", "1"], { env });
  evidence.steps.push({ label, input: "X11 pointer", selector, window, display, client: rect });
};

const selectIdentity = (id, label) => {
  const pagesScanned = selectIdentityInCatalog(id, label, {
    readPage: (selector, scanned) => JSON.parse(evalFile(`JSON.stringify((() => {
      const pages = document.querySelector('[aria-label="Identity catalog pages"]');
      const next = pages?.querySelector('button:last-child');
      return {
        marker: pages?.querySelector('span')?.textContent ?? null,
        found: !!document.querySelector(${JSON.stringify(selector)}),
        canAdvance: !!next && !next.disabled && next.textContent.trim() === 'Load more',
      };
    })())`, `${label}-catalog-page-${scanned}`)),
    click,
    settle,
  });
  evidence.steps.push({ label: `${label}-catalog-search`, id, pagesScanned });
};

const evalFile = (source, name) => {
  const file = resolve(outDir, `${name}.js`);
  writeFileSync(file, source);
  return run(["eval", "--file", file], `eval:${name}`);
};

// R-4: an installed identity may wear the Applied badge only when one of its
// refs is in the APPLIED stack. The reviewed/requested alternative
// (research-steward) must never borrow it before the host applies it.
// The applied stack renders on the "Current agent" tab and the installed-identity
// badges on the paginated "Library" tab, so the check reads the stack where it is,
// visits Library (paging with "Load more" until both identities are listed), then
// returns to the starting tab. Review/selection state is page-level, so the round
// trip does not discard it; callers re-check what they depend on.
const IDENTITY_TABS = { library: 1, agent: 2, bindings: 3 };
const identityTab = (name) => `[aria-label="Identity management sections"] [role="tab"]:nth-child(${IDENTITY_TABS[name]})`;
const readLibraryRows = (label, scanned) => JSON.parse(evalFile(`JSON.stringify((() => {
  const next = document.querySelector('[aria-label="Identity catalog pages"] button:last-child');
  return {
    rows: [...document.querySelectorAll('.pc-identities__identity')].map((row) => ({
      id: row.querySelector('strong')?.textContent?.trim() ?? '',
      applied: !!row.querySelector('.pc-identities__pill--applied'),
    })),
    canAdvance: !!next && !next.disabled && next.textContent.trim() === 'Load more',
  };
})())`, `${label}-library-page-${scanned}`));

const assertAlternativesNotApplied = (label) => {
  const startTab = JSON.parse(evalFile("JSON.stringify(new URLSearchParams(location.search).get('identityTab') ?? 'library')", `${label}-start-tab`));
  const stack = JSON.parse(evalFile("JSON.stringify(document.querySelector('.pc-identities__stack-card')?.textContent ?? '')", `${label}-stack`));
  if (!stack.includes("Applied stack")) throw new Error(`${label}: applied stack card not readable on tab ${startTab}: ${JSON.stringify(stack)}`);
  if (startTab !== "library") {
    click(identityTab("library"), `${label}-library-tab`);
    settle();
    check(["--selector", ".pc-identities__identity"], `${label}-library-visible`);
  }
  const listed = new Map();
  for (let scanned = 1; ; scanned += 1) {
    const page = readLibraryRows(label, scanned);
    for (const row of page.rows) listed.set(row.id, row);
    if ((listed.has("research-steward") && listed.has("papercusp-engineer")) || !page.canAdvance || scanned >= 10) break;
    click('[aria-label="Identity catalog pages"] button:last-child', `${label}-library-next-${scanned}`);
    settle();
  }
  const state = { startTab, stack, rows: [...listed.values()] };
  if (startTab !== "library") {
    click(identityTab(startTab), `${label}-return-tab`);
    settle();
    check(["--eval", `new URLSearchParams(location.search).get('identityTab') === ${JSON.stringify(startTab)}`], `${label}-tab-restored`);
  }
  evidence.appliedBadges = { ...(evidence.appliedBadges ?? {}), [label]: state };
  const alternative = state.rows.find((row) => row.id === "research-steward");
  const current = state.rows.find((row) => row.id === "papercusp-engineer");
  if (!alternative || !current) {
    throw new Error(`${label}: library does not list both research-steward and papercusp-engineer: ${JSON.stringify(state.rows)}`);
  }
  if (alternative.applied || state.stack.includes("domain:research-steward")) {
    throw new Error(`${label}: installed alternative research-steward renders Applied before the host applied it: ${JSON.stringify(state)}`);
  }
  if (!current.applied) throw new Error(`${label}: applied identity papercusp-engineer lost its Applied badge: ${JSON.stringify(state)}`);
  const borrowed = state.rows.filter((row) => row.applied && !state.stack.includes(`:${row.id}`));
  if (borrowed.length > 0) {
    throw new Error(`${label}: identities outside the applied stack render Applied: ${JSON.stringify(borrowed)}`);
  }
  evidence.observedChecks = [...(evidence.observedChecks ?? []), label];
};

const observeActivation = async (label) => {
  const [row] = await sql`
    SELECT control_generation, control_delivered_generation,
           control_state->'activation' AS activation
      FROM harness_shared.session_briefs
     WHERE workspace_id = ${workspace} AND owner_id = ${owner}
  `;
  const activation = row?.activation ?? null;
  evidence.steps.push({
    label,
    controlGeneration: row ? Number(row.control_generation) : null,
    controlDeliveredGeneration: row ? Number(row.control_delivered_generation) : null,
    activation,
  });
  return activation;
};

const acknowledgeRealHost = async (label) => {
  const ledger = openDeliveryLedger(owner);
  let attempt = 0;
  return confirmFixtureDelivery({
    ledger,
    emit: (text) => {
      // This is the disposable R-4 host fixture, never the real R-7 subject.
      // Persist the emitted context before the canonical ledger can confirm it.
      const path = resolve(outDir, `${label}-emitted.txt`);
      writeFileSync(path, text);
      evidence.steps.push({ label: `${label}-emitted`, path, host: "isolated fixture" });
    },
    request: async (confirmedDelivery) => {
      const requestLabel = attempt++ === 0 ? label : `${label}-confirm-delivery`;
      const responseText = evalFile(`
    fetch('/api/agent-mcp/turn-start-memory', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        owner: ${JSON.stringify(owner)},
        workspace: ${JSON.stringify(workspace)},
        prompt: 'identity activation acknowledgement',
        client: 'codex',
        confirmedDelivery: ${JSON.stringify(confirmedDelivery)},
      }),
    }).then(async (response) => JSON.stringify({status: response.status, body: await response.text()}))
      `, requestLabel);
      let response;
      try {
        response = JSON.parse(responseText);
      } catch {
        throw new Error(`${label} returned non-JSON response: ${responseText}`);
      }
      evidence.steps.push({ label: requestLabel, response });
      if (response.status !== 200) throw new Error(`${label} failed: ${responseText}`);
      return JSON.parse(response.body);
    },
  });
};

const syncInvalidations = (label) => {
  const value = JSON.parse(evalFile(
    "JSON.stringify(window.__sync_metrics__?.snapshot()?.invalidations ?? null)",
    label,
  ));
  evidence.steps.push({ label, invalidations: value });
  if (!value) throw new Error(`${label}: window.__sync_metrics__ is absent`);
  return value;
};

// Pointer selection must WRITE the nuqs params, and a fresh navigation to that
// URL must RESTORE the same selection. The provider-bindings tab must stay a
// read-only boundary: it names M3 and exposes no enabled control, so no
// provider can be silently selected.
const recoveryUrlStateAndBindings = () => {
  run(["navigate", `/settings/identities?identityAgent=${encodeURIComponent(owner)}`], "recovery-navigate-bare");
  settle();
  selectIdentity("research-steward", "recovery-select-identity");
  settle();
  check(["--eval", "new URLSearchParams(location.search).get('identityId') === 'research-steward'"], "nuqs-selection-written");
  click('[aria-label="Identity management sections"] [role="tab"]:nth-child(3)', "recovery-bindings-tab");
  settle();
  check(["--eval", "new URLSearchParams(location.search).get('identityTab') === 'bindings'"], "nuqs-tab-written");
  const bindings = JSON.parse(evalFile(`JSON.stringify((() => {
    const s = document.querySelector('section[aria-label="Provider bindings"]');
    if (!s) return null;
    const controls = [...s.querySelectorAll('input,select,textarea,button,a[href],[role="combobox"],[role="listbox"],[role="option"],[contenteditable="true"]')];
    return { text: s.innerText, controls: controls.length, enabled: controls.filter((c) => !c.disabled).length };
  })())`, "provider-bindings-boundary"));
  evidence.steps.push({ label: "provider-bindings-boundary", bindings });
  if (!bindings || !bindings.text.includes("Available in M3") || bindings.enabled !== 0) {
    throw new Error(`provider-bindings boundary exposes a selectable control: ${JSON.stringify(bindings)}`);
  }
  const url = JSON.parse(evalFile("JSON.stringify(location.pathname + location.search)", "nuqs-url-captured"));
  run(["navigate", url], "nuqs-restore-navigate");
  settle();
  check(["--eval", "document.querySelector('[aria-label=\"Identity management sections\"] [role=\"tab\"][aria-selected=\"true\"]')?.textContent.trim() === 'Provider bindings' && !!document.querySelector('section[aria-label=\"Provider bindings\"]') && new URLSearchParams(location.search).get('identityId') === 'research-steward'"], "nuqs-state-restored-from-url");
  click('[aria-label="Identity management sections"] [role="tab"]:nth-child(1)', "recovery-library-tab");
  settle();
  check(["--eval", "new URLSearchParams(location.search).get('identityTab') !== 'bindings' && document.querySelector('[aria-label=\"Identity management sections\"] [role=\"tab\"][aria-selected=\"true\"]')?.textContent.trim() === 'Library'"], "nuqs-tab-rewritten");
  // Everything after this point must happen WITHOUT a reload: the marker dies with the document.
  evalFile("(window.__p015R4NoReload = 'p015-r4-no-reload', 'marked')", "no-reload-marker");
};

const controlStates = (label) => {
  const value = JSON.parse(evalFile(`JSON.stringify(['Apply identity', 'Roll back identity'].map((name) => {
    const b = document.querySelector('button[aria-label="' + name + '"]');
    return { name, present: !!b, disabled: b ? b.disabled : null };
  }))`, label));
  evidence.steps.push({ label, controls: value });
  return value;
};

// One FORCED apply failure on the REAL backend. A second writer rewrites the
// session row (launchedBy only) in an open transaction, holding its row lock. The
// pointer-clicked switch reads the committed row, rebuilds, and its compare-and-swap
// UPDATE blocks on that lock; only once it is observed blocked does the writer
// commit, so the UPDATE re-evaluates against the changed row and matches nothing.
// A free-running writer raced the rebuild and lost (the switch returned 200). The
// fixture row is then restored byte-for-byte and the prior applied identity must
// be unchanged.
const forcedRealApplyFailure = async () => {
  const [before] = await sql`
    SELECT id, launch_spec FROM harness_shared.adv_sessions
     WHERE workspace_id = ${workspace} AND coord_owner_id = ${owner}`;
  if (!before) throw new Error("forced failure: fixture adv_sessions row is missing");
  const [eventsBefore] = await sql`
    SELECT count(*)::int AS n FROM harness_shared.session_identity_activation_events
     WHERE workspace_id = ${workspace} AND owner_id = ${owner}`;
  const activationBefore = await observeActivation("forced-failure-activation-before");
  const callsBefore = JSON.parse(evalFile("JSON.stringify(window.__p015R4RealCalls.length)", "forced-failure-calls-before"));
  const lockSql = postgres(dsn, { max: 1, connect_timeout: 10, onnotice: () => {} });
  let releaseWriter;
  const writerMayCommit = new Promise((resolveRelease) => { releaseWriter = resolveRelease; });
  let writerHolding;
  const writerHoldsLock = new Promise((resolveHeld) => { writerHolding = resolveHeld; });
  const writer = lockSql.begin(async (tx) => {
    const [{ pid }] = await tx`SELECT pg_backend_pid() AS pid`;
    await tx`
      UPDATE harness_shared.adv_sessions
         SET launch_spec = jsonb_set(launch_spec, '{launchedBy}', to_jsonb('p015-r4-concurrent-writer'::text))
       WHERE id = ${before.id}`;
    writerHolding(pid);
    await writerMayCommit;
  });
  writer.catch(() => {});
  let blockedSwitch = null;
  try {
    const writerPid = await Promise.race([writerHoldsLock, writer.then(() => { throw new Error("forced failure: writer committed before holding the lock"); })]);
    click('button[aria-label="Apply identity"]', "forced-failure-apply");
    // The switch's compare-and-swap is the only statement carrying `AND launch_spec =`;
    // the writer's own backend is idle in its transaction, not waiting on a lock.
    const deadline = Date.now() + 30_000;
    while (!blockedSwitch && Date.now() < deadline) {
      [blockedSwitch = null] = await sql`
        SELECT pid, wait_event_type, wait_event, left(query, 160) AS query
          FROM pg_stat_activity
         WHERE pid <> pg_backend_pid() AND pid <> ${writerPid}
           AND datname = current_database()
           AND wait_event_type = 'Lock'
           AND query ILIKE ${"%UPDATE harness_shared.adv_sessions%AND launch_spec =%"}`;
      if (!blockedSwitch) await new Promise((resolveTick) => setTimeout(resolveTick, 50));
    }
  } finally {
    releaseWriter();
    await writer.catch((error) => { throw new Error(`forced failure: concurrent writer failed: ${error}`); });
    await lockSql.end({ timeout: 5 });
  }
  if (!blockedSwitch) throw new Error("forced failure: the switch never blocked on the concurrent writer's row lock");
  checkedCommand("bash", [required("VERIFY_TAURI_POLL"), "--require", "body", "--eval", `window.__p015R4RealCalls.length > ${Number(callsBefore)}`]);
  await sql`UPDATE harness_shared.adv_sessions SET launch_spec = ${sql.json(before.launch_spec)} WHERE id = ${before.id}`;
  const response = JSON.parse(evalFile("JSON.stringify(window.__p015R4RealCalls.at(-1))", "forced-failure-response"));
  evidence.steps.push({ label: "forced-failure-response", response, blockedSwitch: { waitEventType: blockedSwitch.wait_event_type, waitEvent: blockedSwitch.wait_event, query: blockedSwitch.query } });
  if (response?.request?.action !== "switch" || response?.status === 200 || !String(response?.body).includes("changed concurrently")) {
    throw new Error(`forced failure was not refused by the real compare-and-swap: ${JSON.stringify(response)}`);
  }
  const [after] = await sql`SELECT launch_spec FROM harness_shared.adv_sessions WHERE id = ${before.id}`;
  const [eventsAfter] = await sql`
    SELECT count(*)::int AS n FROM harness_shared.session_identity_activation_events
     WHERE workspace_id = ${workspace} AND owner_id = ${owner}`;
  const activationAfter = await observeActivation("forced-failure-activation-after");
  const retained = {
    launchSpecUnchanged: JSON.stringify(after.launch_spec) === JSON.stringify(before.launch_spec),
    stack: after.launch_spec?.stack ?? null,
    activationEventsBefore: eventsBefore.n,
    activationEventsAfter: eventsAfter.n,
    activationUnchanged: JSON.stringify(activationAfter) === JSON.stringify(activationBefore),
  };
  evidence.steps.push({ label: "forced-failure-prior-state", retained });
  if (!retained.launchSpecUnchanged || retained.activationEventsAfter !== retained.activationEventsBefore || !retained.activationUnchanged) {
    throw new Error(`forced failure mutated prior state: ${JSON.stringify(retained)}`);
  }
  check(["--eval", "document.body.innerText.includes('Identity change failed: The session identity changed concurrently') && !document.body.innerText.includes('Change requested') && document.querySelector('.pc-identities__stack-card')?.textContent.includes('domain:papercusp-engineer') && !document.querySelector('.pc-identities__stack-card')?.textContent.includes('domain:research-steward')"], "forced-failure-banner-prior-identity-kept");
  const controls = controlStates("forced-failure-controls");
  if (!controls.find((c) => c.name === "Apply identity")?.present || controls.find((c) => c.name === "Apply identity")?.disabled) {
    throw new Error(`retry is not reachable after the forced failure: ${JSON.stringify(controls)}`);
  }
  evidence.forcedRealFailureProven = true;
};

const captureRealFetch = `
(() => {
  window.__p015R4RealCalls = [];
  const original = window.fetch;
  window.fetch = async (input, init) => {
    const response = await original(input, init);
    if (String(input).includes('/api/agent-mcp/identity-management')) {
      const body = await response.clone().text();
      window.__p015R4RealCalls.push({
        request: JSON.parse(init?.body || '{}'),
        status: response.status,
        body,
      });
    }
    return response;
  };
  return 'p015-r4-real-fetch-observer';
})()
`;

const patchFetch = `
(() => {
  window.__p015R4Calls = [];
  window.__p015R4OriginalFetch = window.fetch;
  window.fetch = async (input, init) => {
    const url = String(input);
    if (!url.includes('/api/agent-mcp/identity-management') || init?.method !== 'POST') {
      return window.__p015R4OriginalFetch(input, init);
    }
    const args = JSON.parse(init.body || '{}');
    if (args.ownerId !== ${JSON.stringify(owner)}) throw new Error('unexpected mutation owner');
    window.__p015R4Calls.push(args);
    if (args.action === 'switch' && window.__p015R4Calls.filter(x => x.action === 'switch').length === 1) {
      return new Response(JSON.stringify({ok:false,error:'synthetic R-4 failure; prior applied identity retained'}), {status:503,headers:{'content-type':'application/json'}});
    }
    const revision = { specificationRevision: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', stateRevision: 'synthetic-r4-state' };
    let body;
    if (args.action === 'preview') {
      body = { ok: true, changed: true, action: 'preview', delivery: 'relaunch-with-carry', stack: ['domain:research-steward'], replaced: 'domain:papercusp-engineer', ...revision, diff: [{ field: 'configuration.roles[0]', applied: 'domain:papercusp-engineer', selected: 'research-steward', origin: 'synthetic-r4-verification' }], activation: { desired: revision, prepared: revision, applied: { specificationRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', stateRevision: 'seed-old-state' }, status: 'prepared' }, nudge: { queued: false, reason: 'synthetic-r4-verification' } };
    } else if (args.action === 'switch') {
      body = { ok: true, changed: true, action: 'switch', delivery: 'relaunch-with-carry', stack: ['domain:research-steward'], replaced: 'papercusp-engineer', ...revision, diff: [], activation: { desired: revision, prepared: null, applied: { specificationRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', stateRevision: 'seed-old-state' }, status: 'failed', failure: 'synthetic R-4 failed activation; prior applied identity retained' }, nudge: { queued: false, reason: 'synthetic-r4-verification' } };
    } else if (args.action === 'rollback') {
      const restored = { specificationRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', stateRevision: 'seed-old-state' };
      body = { ok: true, changed: true, action: 'rollback', delivery: 'relaunch-with-carry', stack: ['domain:papercusp-engineer'], replaced: 'research-steward', ...restored, diff: [], activation: { desired: restored, prepared: null, applied: restored, status: 'applied' }, nudge: { queued: false, reason: 'synthetic-r4-verification' } };
    } else {
      throw new Error('unexpected mutation action ' + args.action);
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return 'p015-r4-fetch-patched';
})()
`;

const artifact = (revision) => ({
  schemaVersion: 1,
  specificationRevision: revision,
  compilerVersion: "p015-r4-fixture",
  source: { id: "p015-r4-fixture", kind: "harness", contentHash: "d".repeat(64) },
  configuration: { roles: [{ stack: ["domain:papercusp-engineer"] }] },
  inputs: [],
  stack: ["domain:papercusp-engineer"],
  provenance: [{ path: "roles[0].stack[0]", sourceRef: "identity:papercusp-engineer", sourceRevision: revision }],
});

async function seed() {
  const launchSpec = {
    v: 1,
    agent: "codex",
    workspaceId: workspace,
    harnessSlug: null,
    profile: "engineer",
    contextSize: "trimmed",
    personaTier: null,
    model: null,
    planSlug: null,
    launchedBy: "p015-r4-driver",
    autoMode: false,
    drainMode: false,
    loopArmed: false,
    fleet: { slug: null, role: null },
    stack: ["domain:papercusp-engineer"],
    specificationRevision: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    stateRevision: "seed-new-state",
    principalId: owner,
    specificationArtifact: artifact("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
    identityHistory: [{ stack: ["domain:papercusp-engineer"], specificationRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", stateRevision: "seed-old-state", specificationArtifact: artifact("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), recordedAt: new Date().toISOString() }],
  };
  const control = {
    stack: ["domain:papercusp-engineer"],
    activation: {
      schemaVersion: 1,
      attribution: { actorId: owner, principalId: owner, sessionId: owner },
      desired: { specificationRevision: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", stateRevision: "seed-new-state" },
      prepared: null,
      applied: { specificationRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", stateRevision: "seed-old-state" },
      status: "applied",
    },
  };
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO harness_shared.coord_presence
        (owner_id, owner_label, workspace_id, source, intent, current_plan_slug, current_files, host, pid, started_at, heartbeat_at, last_active_at, agent_role, pot_slug, capability_tags)
      VALUES (${owner}, ${label}, ${workspace}, 'p015-r4-driver', 'R-4 identity UI verification', null, '[]'::jsonb, 'isolated-verifier', ${process.pid}, now(), now(), now(), 'su', 'papercusp', '[]'::jsonb)
      ON CONFLICT (owner_id) DO UPDATE SET heartbeat_at = now(), last_active_at = now()
    `;
    const sessions = await tx`
      INSERT INTO harness_shared.adv_sessions
        (workspace_id, mode, pid, label, started_at, coord_owner_id, agent, role, launch_spec)
      VALUES (${workspace}, 'console', ${process.pid}, ${label}, now(), ${owner}, 'codex', 'su', ${tx.json(launchSpec)})
      RETURNING id
    `;
    sessionId = Number(sessions[0].id);
    await tx`
      INSERT INTO harness_shared.session_briefs (owner_id, workspace_id, owner_label, source, intent, current_plan_slug, harness_slug, control_state, control_updated_at)
      VALUES (${owner}, ${workspace}, ${label}, 'p015-r4-driver', 'R-4 identity UI verification', null, null, ${tx.json(control)}, now())
      ON CONFLICT (owner_id) DO UPDATE SET control_state = EXCLUDED.control_state, control_updated_at = now()
    `;
    await tx`
      INSERT INTO harness_shared.session_identity_activation_events
        (workspace_id, owner_id, actor_id, principal_id, session_id, adv_session_id,
         transition_id, control_generation, phase, source, specification_revision,
         state_revision, stack_refs, failure, recorded_at)
      VALUES (${workspace}, ${owner}, ${owner}, ${owner}, ${owner}, ${sessionId},
        ${`fixture:${owner}:1`}, 1, 'applied', 'p015-r4-driver-seed',
        ${launchSpec.identityHistory[0].specificationRevision}, 'seed-old-state',
        ${tx.json(["domain:papercusp-engineer"])}, null, now())
    `;
  });
  evidence.steps.push({ label: "seed", owner, sessionId, workspace });
}

async function cleanup() {
  if (!isolationVerified) { await sql.end({ timeout: 2 }); return; }
  await sql`DELETE FROM harness_shared.session_identity_activation_events WHERE workspace_id = ${workspace} AND owner_id = ${owner}`;
  await sql`DELETE FROM harness_shared.session_briefs WHERE workspace_id = ${workspace} AND owner_id = ${owner}`;
  await sql`DELETE FROM harness_shared.adv_sessions WHERE workspace_id = ${workspace} AND coord_owner_id = ${owner}`;
  await sql`DELETE FROM harness_shared.coord_presence WHERE workspace_id = ${workspace} AND owner_id = ${owner}`;
  await sql.end({ timeout: 2 });
}

try {
  const [dbIdentity] = await sql`SHOW data_directory`;
  const dataRelative = relative(dirname(isolatedHome), dbIdentity.data_directory);
  if (!dataRelative || dataRelative.startsWith(`..${sep}`) || dataRelative === ".." || dataRelative.startsWith(sep)) {
    throw new Error("Postgres data_directory is outside this isolated verifier directory");
  }
  isolationVerified = true;
  evidence.databaseDataDirectory = dbIdentity.data_directory;
  evidence.frozenSpaIndexSha256 = createHash("sha256").update(readFileSync(resolve(required("VERIFY_TAURI_SPA_DIST"), "index.html"))).digest("hex");
  execFileSync("bash", [required("VERIFY_TAURI_LIVENESS_CHECK")], { stdio: "inherit", timeout: 15_000 });
  await seed();
  const rosterResponse = await fetch(`${required("VERIFY_TAURI_DEV_URL")}/api/adv/roster?workspace=${encodeURIComponent(workspace)}`, { signal: AbortSignal.timeout(30_000) });
  const roster = await rosterResponse.json();
  const fixture = roster.active?.find(x => x.ownerId === owner);
  if (!rosterResponse.ok || !fixture || fixture.sessionState === "ended") throw new Error("owned fixture is absent from active roster");
  evidence.rosterFixture = { ownerId: fixture.ownerId, sessionState: fixture.sessionState, label: fixture.label };
  run(["navigate", `/settings/identities?identityAgent=${encodeURIComponent(owner)}&identityId=research-steward&identitySlot=domain`], "navigate-identities");
  settle();
  check(["--eval", `document.body.innerText.includes(${JSON.stringify(label)})`], "owned-agent-visible");
  check(["--selector", ".pc-identities__identity"], "identity-library-visible");
  if (realBackend) evalFile(captureRealFetch, "observe-real-fetch");
  else evalFile(patchFetch, "patch-fetch");

  check(["--selector", '[aria-label="Agent to manage"]', "--eval", `document.querySelector('[aria-label="Agent to manage"]')?.disabled === false && new URLSearchParams(location.search).get('identityAgent') === ${JSON.stringify(owner)}`], "owned-agent-selected");
  if (realBackend) {
    if (realRecovery) {
      recoveryUrlStateAndBindings();
      // A navigation may replace the document; keep exactly one fetch observer either way.
      evalFile(`window.__p015R4RealCalls ? 'p015-r4-real-fetch-observer-kept' : ${captureRealFetch.trim()}`, "observe-real-fetch-after-navigation");
    }
    selectIdentity("research-steward", "real-select-identity");
    settle();
    click(".pc-identities__actions button", "real-review-switch");
    settle();
    const reviewCall = JSON.parse(evalFile("window.__p015R4RealCalls.at(-1)", "real-review-response"));
    evidence.steps.push({ label: "real-review-response", response: reviewCall });
    if (reviewCall?.status !== 200) throw new Error(`real preview route refused the mutation: ${reviewCall?.body ?? JSON.stringify(reviewCall)}`);
    check(["--eval", "document.querySelector('.pc-identities__diff')?.textContent.includes('Revision diff') && !document.querySelector('[aria-label=\"Apply identity\"]')?.disabled"], "real-review-diff-visible");
    // The "Revision diff" heading renders even over an empty grid, so the check
    // above cannot prove a diff was rendered (R-4 judge gap, 2026-09-27). Read
    // the grid rows the real review produced.
    const reviewDiff = JSON.parse(evalFile(`JSON.stringify((() => {
      const card = document.querySelector('.pc-identities__diff');
      const rows = [...(card?.querySelectorAll('[role="row"]') ?? [])]
        .map((row) => row.innerText.replace(/\\s+/g, ' ').trim()).filter(Boolean);
      return { rowCount: rows.length, rows: rows.slice(0, 12),
        emptyNotice: /produces no configuration difference|Review an identity to compare/.test(card?.innerText ?? '') };
    })())`, "real-review-diff-rows"));
    evidence.reviewDiff = reviewDiff;
    // One header row plus at least one field row.
    if (reviewDiff.emptyNotice || reviewDiff.rowCount < 2) {
      throw new Error(`real review rendered no revision diff rows: ${JSON.stringify(reviewDiff)}`);
    }
    assertAlternativesNotApplied("real-review-alternatives-not-applied");
    // The Library round trip must not have discarded the review the switch applies.
    check(["--eval", "document.querySelector('.pc-identities__diff')?.querySelectorAll('[role=\"row\"]').length >= 2 && !document.querySelector('[aria-label=\"Apply identity\"]')?.disabled"], "real-review-survives-library-check");

    let syncBeforeSwitch = null;
    if (realRecovery) {
      await forcedRealApplyFailure();
      syncBeforeSwitch = syncInvalidations("sync-before-retry-switch");
    }
    click('button[aria-label="Apply identity"]', "real-switch");
    settle();
    const switchResponse = JSON.parse(evalFile("window.__p015R4RealCalls.at(-1)", "real-switch-response"));
    evidence.steps.push({ label: "real-switch-response", response: switchResponse });
    if (switchResponse?.request?.action !== "switch" || switchResponse?.status !== 200) {
      throw new Error(`real switch route did not return a successful switch response: ${JSON.stringify(switchResponse)}`);
    }
    check(["--eval", "document.body.innerText.includes('Change requested') && document.querySelector('.pc-identities__stack-card')?.textContent.includes('domain:papercusp-engineer')"], "real-switch-change-requested");
    // Desired, not applied: the requested alternative must still not borrow the badge.
    assertAlternativesNotApplied("real-switch-requested-alternatives-not-applied");
    if (realRecovery) {
      // The retried switch must reach the page through @papercusp/sync: the route's
      // notifySyncInvalidate('identities.surface') arrives over SSE and refetches
      // the surface, in the same document (no reload marker lost).
      const before = syncBeforeSwitch?.bySseName?.["identities.surface"] ?? 0;
      checkedCommand("bash", [required("VERIFY_TAURI_POLL"), "--require", "body", "--eval", `(window.__sync_metrics__?.snapshot()?.invalidations?.bySseName?.['identities.surface'] ?? 0) > ${Number(before)}`]);
      const syncAfter = syncInvalidations("sync-after-retry-switch");
      check(["--eval", "window.__p015R4NoReload === 'p015-r4-no-reload'"], "retry-switch-same-document");
      evidence.syncInvalidationProven = (syncAfter.bySseName?.["identities.surface"] ?? 0) > before;
    }
    const switchRequested = await observeActivation("real-switch-requested");
    if (switchRequested?.status !== "desired" || !switchRequested?.desired) {
      throw new Error(`real switch did not persist desired activation: ${JSON.stringify(switchRequested)}`);
    }
    await acknowledgeRealHost("real-switch-host-ack");
    settle();
    run(["navigate", `/settings/identities?identityAgent=${encodeURIComponent(owner)}&identityId=research-steward&identitySlot=domain&identityTab=agent&refresh=${Date.now()}`], "real-switch-refresh");
    settle();
    const switchPage = JSON.parse(evalFile("JSON.stringify({ applied: document.body.innerText.includes('Identity applied'), requested: document.body.innerText.includes('Change requested'), stack: document.querySelector('.pc-identities__stack-card')?.textContent || '' })", "real-switch-state"));
    const switchApplied = await observeActivation("real-switch-applied");
    if (switchApplied?.status === "applied") {
      if (switchApplied.applied?.specificationRevision !== switchApplied.desired?.specificationRevision) {
        throw new Error(`real switch claimed applied without a matching activation receipt: ${JSON.stringify(switchApplied)}`);
      }
      check(["--eval", "(document.body.innerText.includes('Identity applied') || document.body.innerText.includes('Change requested')) && document.querySelector('.pc-identities__stack-card')?.textContent.includes('domain:research-steward')"], "real-switch-applied");
    } else {
      check(["--eval", "document.body.innerText.includes('Change requested') && document.querySelector('.pc-identities__stack-card')?.textContent.includes('domain:research-steward')"], "real-switch-pending-after-fresh-context-boundary");
      if (switchApplied?.status !== "desired" || switchApplied?.applied?.specificationRevision === switchApplied?.desired?.specificationRevision) {
        throw new Error(`real switch did not preserve the fresh-context boundary: ${JSON.stringify(switchApplied)}`);
      }
    }
    const callsBeforeRollback = Number(evalFile("window.__p015R4RealCalls.length", "real-rollback-call-count-before"));
    click('button[aria-label="Roll back identity"]', "real-rollback");
    const rollbackCall = requireRollbackResponse({
      poll: () => checkedCommand("bash", [required("VERIFY_TAURI_POLL"), "--require", "body", "--eval",
        `window.__p015R4RealCalls?.slice(${callsBeforeRollback}).some((call) => call.request?.action === 'rollback')`]),
      readResponse: () => JSON.parse(evalFile(
        `window.__p015R4RealCalls.slice(${callsBeforeRollback}).find((call) => call.request?.action === 'rollback')`,
        "real-rollback-response",
      )),
    });
    evidence.steps.push({ label: "real-rollback-response", response: rollbackCall });
    settle();
    check(["--eval", "document.body.innerText.includes('Change requested')"], "real-rollback-change-requested");
    const rollbackRequested = await observeActivation("real-rollback-requested");
    if (rollbackRequested?.status !== "desired" || !rollbackRequested?.desired) {
      throw new Error(`real rollback did not persist desired activation: ${JSON.stringify(rollbackRequested)}`);
    }
    await acknowledgeRealHost("real-rollback-host-ack");
    settle();
    run(["navigate", `/settings/identities?identityAgent=${encodeURIComponent(owner)}&identityId=research-steward&identitySlot=domain&identityTab=agent&refresh=${Date.now()}`], "real-rollback-refresh");
    settle();
    const rollbackPage = JSON.parse(evalFile("JSON.stringify({ applied: document.body.innerText.includes('Identity applied'), requested: document.body.innerText.includes('Change requested'), stack: document.querySelector('.pc-identities__stack-card')?.textContent || '' })", "real-rollback-state"));
    const rollbackApplied = await observeActivation("real-rollback-applied");
    if (rollbackApplied?.status === "applied") {
      if (rollbackApplied.applied?.specificationRevision !== rollbackApplied.desired?.specificationRevision) {
        throw new Error(`real rollback claimed applied without a matching activation receipt: ${JSON.stringify(rollbackApplied)}`);
      }
      check(["--eval", "(document.body.innerText.includes('Identity applied') || document.body.innerText.includes('Change requested')) && document.querySelector('.pc-identities__stack-card')?.textContent.includes('domain:papercusp-engineer')"], "real-rollback-applied");
    } else {
      check(["--eval", "document.body.innerText.includes('Change requested') && document.querySelector('.pc-identities__stack-card')?.textContent.includes('domain:research-steward')"], "real-rollback-pending-after-fresh-context-boundary");
      if (rollbackApplied?.status !== "desired" || rollbackApplied?.applied?.specificationRevision === rollbackApplied?.desired?.specificationRevision) {
        throw new Error(`real rollback did not preserve the fresh-context boundary: ${JSON.stringify(rollbackApplied)}`);
      }
    }
    evidence.hostActivationProven = switchApplied?.status === "applied" && rollbackApplied?.status === "applied";
    if (realRecovery) {
      evidence.recoveryObserved = [
        "nuqs-selection-written", "nuqs-tab-written", "provider-bindings-boundary", "nuqs-state-restored-from-url",
        "forced-real-apply-failure", "prior-state-retained", "retry-reachable", "retry-switch-change-requested",
        evidence.syncInvalidationProven ? "sse-sync-invalidation" : "sse-sync-invalidation-missing",
        rollbackApplied?.status === "applied" ? "rollback-applied" : "rollback-requested",
      ];
    }
    evidence.observed = ["owned-roster-selection", "real-backend-review", "real-review-diff-rows-rendered", ...(evidence.observedChecks ?? []), "real-switch-change-requested", switchApplied?.status === "applied" ? "real-switch-applied" : "real-switch-pending-after-fresh-context-boundary", "real-rollback-change-requested", rollbackApplied?.status === "applied" ? "real-rollback-applied" : "real-rollback-pending-after-fresh-context-boundary"];
  } else {
    selectIdentity("research-steward", "select-identity");
    settle();
    click(".pc-identities__actions button", "review-switch");
    settle();
    check(["--eval", "document.querySelector('.pc-identities__diff')?.textContent.includes('configuration.roles[0]') && !document.querySelector('[aria-label=\"Apply identity\"]')?.disabled"], "review-diff-visible");

    click('button[aria-label="Apply identity"]', "forced-failure");
    settle();
    check(["--eval", "document.body.innerText.includes('Identity change failed: synthetic R-4 failure') && document.querySelector('.pc-identities__stack-card')?.textContent.includes('domain:papercusp-engineer')"], "failure-retains-applied-state");

    click(".pc-identities__actions button", "retry-review");
    settle();
    check(["--text", "Revision diff"], "retry-review-diff-visible");
    await sql`UPDATE harness_shared.session_briefs SET control_state = jsonb_set(control_state, '{activation}', ${sql.json({ desired: { specificationRevision: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", stateRevision: "synthetic-r4-state" }, prepared: null, applied: { specificationRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", stateRevision: "seed-old-state" }, status: "failed", failure: "synthetic R-4 failed activation; prior applied identity retained" })}::jsonb) WHERE workspace_id = ${workspace} AND owner_id = ${owner}`;
    click('button[aria-label="Apply identity"]', "retry-apply");
    settle();
    check(["--text", "The change failed"], "retry-failure-state-visible");

    await sql`UPDATE harness_shared.session_briefs SET control_state = jsonb_set(control_state, '{activation}', ${sql.json({ desired: { specificationRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", stateRevision: "seed-old-state" }, prepared: null, applied: { specificationRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", stateRevision: "seed-old-state" }, status: "applied" })}::jsonb) WHERE workspace_id = ${workspace} AND owner_id = ${owner}`;
    click('button[aria-label="Roll back identity"]', "rollback");
    settle();
    check(["--eval", "document.body.innerText.includes('Identity applied')"], "rollback-applied-state-visible");
    check(["--eval", `JSON.stringify(window.__p015R4Calls.map(x => x.action)) === JSON.stringify(['preview','switch','preview','switch','rollback']) && window.__p015R4Calls.every(x => x.ownerId === ${JSON.stringify(owner)})`], "exact-owner-action-sequence");
    evidence.observed = ["owned-roster-selection", "review-diff", "failure-banner", "retry-review", "rollback-applied-banner"];
  }
  evalFile("({ calls: window.__p015R4Calls || window.__p015R4RealCalls, url: location.href, body: document.querySelector('.pc-identities').innerText })", "final-state");
  evidence.status = "pass";
} catch (error) {
  evidence.status = "fail";
  evidence.error = String(error?.stack || error);
  try {
    evidence.failureDom = JSON.parse(evalFile(`(() => {
      const selectors = ['.pc-identities','.pc-identities__library','.pc-identities__detail','.pc-identities__actions button'];
      const rect = e => { const r=e.getBoundingClientRect(); const s=getComputedStyle(e); return {tag:e.tagName,cls:e.className,x:r.x,y:r.y,width:r.width,height:r.height,clientWidth:e.clientWidth,scrollWidth:e.scrollWidth,scrollLeft:e.scrollLeft,overflowX:s.overflowX,display:s.display,minWidth:s.minWidth}; };
      const e=document.querySelector('.pc-identities__actions button');
      const ancestors=[]; for(let p=e;p;p=p.parentElement) ancestors.push(rect(p));
      return {url:location.href,body:document.querySelector('.pc-identities')?.innerText,calls:window.__p015R4Calls,viewport:{width:innerWidth,height:innerHeight},ancestors,targets:selectors.map(s=>({selector:s,rect:document.querySelector(s)?rect(document.querySelector(s)):null}))};
    })()`, 'failure-dom'));
  } catch (captureError) { evidence.captureError = String(captureError); }
  throw error;
} finally {
  writeFileSync(`${outDir}/evidence.json`, serializeEvidence(evidence));
  await cleanup().catch((error) => { evidence.cleanupError = String(error); evidence.status = "fail"; process.exitCode = 1; });
  writeFileSync(`${outDir}/evidence.json`, serializeEvidence(evidence));
}

console.log(JSON.stringify({ ok: evidence.status === "pass", evidence: `${outDir}/evidence.json`, status: evidence.status, owner, realBackend, syntheticMutationResponses: !realBackend, hostActivationProven: evidence.hostActivationProven }));
}

// isCliEntry, not a hand-rolled import.meta.url comparison: esbuild gives every
// inlined module the BUNDLE entry's import.meta.url, so the hand-rolled form fires
// main() during desktop-sidecar host boot (EI-650 took embedded PG down that way).
if (isCliEntry(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
