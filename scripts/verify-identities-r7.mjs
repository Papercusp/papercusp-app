#!/usr/bin/env node

/**
 * P-015 R-7: the LIVE identity-switch leg of the integrated M2 journey.
 *
 * Unlike R-4 (a disposable fixture in an isolated database), this driver acts on a
 * REAL, already-launched agent (`R7_OWNER`) in the SHARED database, because R-7's
 * chain must connect the actual launched session: attested listing -> install ->
 * launch -> leadership -> UI switch -> applied spans. It therefore REFUSES an
 * isolated verifier database and refuses an owner that is not an active roster
 * agent. It seeds nothing and deletes nothing.
 *
 * Journey (real pointer input in the headless Tauri webview, real backend):
 *   1. switch the owner's domain slot to `R7_TARGET_IDENTITY` (a built-in identity)
 *   2. wait for the REAL host to apply it (relaunch-with-carry: the agent compacts,
 *      its successor acknowledges) — no synthetic acknowledgement is posted
 *   3. switch back to `R7_RETURN_IDENTITY` (the Cupboard-INSTALLED identity) with
 *      a real switch, not a rollback, so the installed identity passes the identity
 *      path (identities-v1 D-124)
 *   4. wait for applied again, then read the layer spans the switched stack opened
 *      and the tool invocations recorded inside them
 *
 * The UI helpers mirror scripts/verify-identities-r4.mjs deliberately rather than
 * refactoring that file: R-4's acceptance evidence is bound to its source bytes.
 *
 * Run: VERIFY_TAURI_SETTLE_MS=... scripts/verify-tauri-headless.sh -- \
 *        env R7_OWNER=<su-id> HARNESS_ADMIN_DATABASE_URL=<dsn> node scripts/verify-identities-r7.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import postgres from "postgres";
import { isCliEntry } from "@papercusp/operator-core/lib/util/cli-entry";
import { checkedCommand, serializeEvidence, toolArgs } from "./verify-identities-r4.mjs";
import { resolveScriptPgUrl } from "./lib/pg-url.mjs";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name} (run through verify-tauri-headless.sh with R7_OWNER set)`);
  return value;
};

/**
 * Whether an activation event row applies a stack containing `layerRef`, after `afterId`.
 *
 * @param {{ id: number|string, phase: string, stack_refs: unknown }} row
 * @param {string} layerRef
 * @param {number} afterId
 * @returns {boolean}
 */
export function appliesLayer(row, layerRef, afterId) {
  const refs = Array.isArray(row.stack_refs) ? row.stack_refs : [];
  return Number(row.id) > afterId && row.phase === "applied" && refs.includes(layerRef);
}

/**
 * The page URL a switch starts from. It deliberately carries NO `identityTab`, so the page opens
 * on its default `library` tab: that is the only tab that renders the `.pc-identities__identity`
 * rows and the `Inspect identity <id>` buttons the switch clicks. Review then moves to the agent
 * tab itself. Pinning the tab param to the agent tab here made the library assertion
 * unsatisfiable, and it failed as a DOM timeout that read like a slow page.
 *
 * @param {string} owner
 * @param {string} identityId
 * @param {number} nonce
 * @returns {string}
 */
export function identitiesUrl(owner, identityId, nonce) {
  return `/settings/identities?identityAgent=${encodeURIComponent(owner)}&identityId=${encodeURIComponent(identityId)}&identitySlot=domain&refresh=${nonce}`;
}

/** Return the action available on the currently loaded identity catalog page. */
export function catalogProbeExpression(identityId) {
  return `(() => {
    if (document.querySelector(${JSON.stringify(`[aria-label="Inspect identity ${identityId}"]`)})) return "found";
    const next = document.querySelector('.pc-identities__catalog-pages button:last-of-type');
    return next && !next.disabled ? "next" : "missing";
  })()`;
}

/**
 * Classify a failed VERIFY_TAURI_SETTLE run. The settle contract exits 1 when the page is still
 * busy at its timeout and 3 when readiness is unknown; both are recorded, not fatal. Anything else
 * (a spawn failure, a killed child, a missing script) is a real error and is rethrown.
 *
 * @param {{ status?: number|null } | null | undefined} error
 * @returns {"busy"|"unknown"|null}
 */
export function settleOutcome(error) {
  if (error?.status === 1) return "busy";
  if (error?.status === 3) return "unknown";
  return null;
}

export async function main() {
  if (process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED === "1") {
    throw new Error("R-7 acts on a REAL launched agent; refusing an isolated verifier database");
  }
  const owner = required("R7_OWNER");
  // The shared-DB wrapper exports no DSN; use the scripts-wide resolution order.
  const dsn = resolveScriptPgUrl().url;
  if (process.argv.includes("--preflight")) process.exit(0);
  const pid = required("VERIFY_TAURI_PID");
  const target = process.env.R7_TARGET_IDENTITY || "research-steward";
  const returnTo = process.env.R7_RETURN_IDENTITY || "papercusp-engineer";
  const workspace = process.env.R7_WORKSPACE || "papercusp-workspace";
  const applyTimeoutMs = Number(process.env.R7_APPLY_TIMEOUT_MS || 480_000);
  // Bound for the in-webview settle/poll subprocesses. It must exceed VERIFY_TAURI_DOM_TIMEOUT
  // and VERIFY_TAURI_SETTLE_TIMEOUT, or the child is killed before its own deadline (under
  // heavy host load, the sync requests a page waits on can take longer than the 45s default).
  const uiTimeoutMs = Number(process.env.R7_UI_TIMEOUT_MS || 45_000);
  const tool = process.env.VERIFY_TAURI_AGENT_TOOLS_BIN || "tauri-agent-tools";
  const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
  const outDir = process.env.R7_OUT || `/tmp/p015-r7-identities-${stamp}`;
  mkdirSync(outDir, { recursive: true });

  const evidence = {
    schemaVersion: "p015-r7-live-switch-v1",
    status: "running",
    journeyId: process.env.R7_JOURNEY_ID || null,
    owner,
    workspace,
    target,
    returnTo,
    realBackend: true,
    syntheticHostAcknowledgement: false,
    treeHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", timeout: 5_000 }).trim(),
    bridgePid: Number(pid),
    launchProvenance: process.env.VERIFY_TAURI_LAUNCH_PROVENANCE || null,
    steps: [],
  };
  const sql = postgres(dsn, { max: 1, connect_timeout: 10, idle_timeout: 2, onnotice: () => {} });

  const run = (args, label) => {
    const result = checkedCommand(tool, toolArgs(pid, args), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 45_000 });
    evidence.steps.push({ label, command: [tool, "--pid", pid, ...args].join(" "), result: result.trim() });
    return result;
  };
  // Settle is a WAIT heuristic, not a gate: under host load one long-lived sync request can keep it
  // reporting busy (exit 1) or unknown (exit 3) although the page is usable. So it is recorded and
  // the run continues; every step that depends on the page polls for its own target element or
  // response instead, and those polls are the gates.
  const settle = (label) => {
    try {
      execFileSync("bash", [required("VERIFY_TAURI_SETTLE")], { stdio: "inherit", timeout: uiTimeoutMs });
      evidence.steps.push({ label: `settle:${label}`, outcome: "settled" });
    } catch (error) {
      const outcome = settleOutcome(error);
      if (!outcome) throw error;
      evidence.steps.push({ label: `settle:${label}`, outcome });
    }
  };
  // Wait for the page's NEXT identity-management response with this action, after `before` calls.
  const waitForCall = (action, before, label) => {
    const match = `(window.__p015R7Seq?.calls || []).filter((c) => c.seq > ${before} && c.request?.action === ${JSON.stringify(action)})`;
    check(["--eval", `${match}.length > 0`], label);
    return JSON.parse(evalFile(`JSON.stringify(${match}.at(-1) || null)`, `${label}-read`));
  };
  // Baseline = sequence number of the last request STARTED so far (see captureFetch).
  const callCount = (label) => Number(evalFile("String(window.__p015R7Seq?.started ?? 0)", `${label}-count`));
  const evalFile = (source, name) => {
    const file = resolve(outDir, `${name}.js`);
    writeFileSync(file, source);
    return run(["eval", "--file", file], `eval:${name}`);
  };
  const check = (args, label) => {
    try {
      const pollArgs = args.includes("--eval") && !args.includes("--require") ? ["--require", "body", ...args] : args;
      checkedCommand("bash", [required("VERIFY_TAURI_POLL"), ...pollArgs], { timeout: uiTimeoutMs });
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
          if (node.scrollWidth > node.clientWidth) { node.scrollLeft += r.left - (window.innerWidth - r.width) / 2; r = e.getBoundingClientRect(); }
          node = node.parentElement;
        }
        r = e.getBoundingClientRect();
      }
      if (r.left < 0 || r.right > window.innerWidth || r.top < 0 || r.bottom > window.innerHeight) {
        throw new Error('pointer target outside viewport: ' + JSON.stringify({left:r.left,right:r.right,top:r.top,bottom:r.bottom}));
      }
      return {x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2)};
    })()`, `pointer-${label}`));
    const env = { ...process.env, DISPLAY: display };
    const window = checkedCommand("xdotool", ["search", "--pid", pid], { env }).trim().split(/\s+/).at(-1);
    const geometry = checkedCommand("xwininfo", ["-id", window], { env });
    const x = Number(/Absolute upper-left X:\s*(-?\d+)/.exec(geometry)?.[1]);
    const y = Number(/Absolute upper-left Y:\s*(-?\d+)/.exec(geometry)?.[1]);
    if (![x, y, rect.x, rect.y].every(Number.isFinite)) throw new Error("invalid X11 client origin");
    checkedCommand("xdotool", ["mousemove", "--sync", String(x + rect.x), String(y + rect.y)], { env });
    checkedCommand("xdotool", ["click", "1"], { env });
    evidence.steps.push({ label, input: "X11 pointer", selector, display, client: rect });
  };
  // A real pointer click can be swallowed when a sync update re-renders the target between
  // mousedown and mouseup (observed: the pointer sat on the button's centre, the hit-test named the
  // button, and no request left). So the click is repeated until its EFFECT is observed, and only
  // while that effect is absent. Every effect used here is a new captured request, which a landed
  // click always produces, so a retry cannot double-apply.
  const clickUntil = (selector, label, effectExpr, attempts = 3) => {
    for (let attempt = 1; ; attempt += 1) {
      click(selector, `${label}#${attempt}`);
      try {
        check(["--eval", effectExpr], `${label}-effect#${attempt}`);
        return attempt;
      } catch (error) {
        if (attempt >= attempts) throw error;
        evidence.steps.push({ label: `${label}-retry`, attempt, reason: "no effect observed after the pointer click" });
      }
    }
  };
  const lastEventId = async () => {
    const [row] = await sql`SELECT coalesce(max(id), 0) AS id FROM harness_shared.session_identity_activation_events WHERE workspace_id = ${workspace} AND owner_id = ${owner}`;
    return Number(row.id);
  };
  const waitApplied = async (layerRef, afterId, label) => {
    const deadline = Date.now() + applyTimeoutMs;
    while (Date.now() < deadline) {
      const rows = await sql`
        SELECT id, phase, control_generation, specification_revision, stack_refs, session_id, adv_session_id, recorded_at
          FROM harness_shared.session_identity_activation_events
         WHERE workspace_id = ${workspace} AND owner_id = ${owner} AND id > ${afterId}
         ORDER BY id`;
      const applied = rows.find((row) => appliesLayer(row, layerRef, afterId));
      if (applied) {
        evidence.steps.push({ label, waitedMs: applyTimeoutMs - (deadline - Date.now()), events: rows });
        return applied;
      }
      await new Promise((r) => setTimeout(r, 5_000));
    }
    const rows = await sql`SELECT id, phase, control_generation, stack_refs, failure, recorded_at FROM harness_shared.session_identity_activation_events WHERE workspace_id = ${workspace} AND owner_id = ${owner} AND id > ${afterId} ORDER BY id`;
    throw new Error(`${label}: ${layerRef} was not applied by the real host within ${applyTimeoutMs}ms; events=${JSON.stringify(rows)}`);
  };
  // Each identity-management request gets a sequence number when it LEAVES (`started`), and its
  // response is recorded with that number when it lands. A click's effect is judged on `started`,
  // so a slow response is not mistaken for a missed click (a re-click would then hit the busy,
  // disabled button). A response is matched by `seq > baseline`, never by array length: navigation
  // is in-app, so the window, an earlier run's observer and an earlier run's ORPHANED request (one
  // whose response never landed) all persist, and a length count then reads a baseline that can
  // never be exceeded (measured: started=2, one response recorded, and it was this run's).
  const captureFetch = `
  (() => {
    const net = window.__p015R7Seq = window.__p015R7Seq || { started: 0, calls: [] };
    if (window.__p015R7SeqPatched) return 'already';
    window.__p015R7SeqPatched = true;
    const original = window.fetch;
    window.fetch = async (input, init) => {
      const seq = String(input).includes('/api/agent-mcp/identity-management') ? ++net.started : 0;
      const response = await original(input, init);
      if (seq) net.calls.push({ seq, request: JSON.parse(init?.body || '{}'), status: response.status, body: await response.clone().text() });
      return response;
    };
    return 'p015-r7-real-fetch-observer';
  })()`;
  const switchTo = async (identityId, label) => {
    run(["navigate", identitiesUrl(owner, identityId, Date.now())], `${label}-navigate`);
    settle(`${label}-navigate`);
    check(["--selector", ".pc-identities__identity"], `${label}-library-visible`);
    evalFile(captureFetch, `${label}-observe-fetch`);
    check(["--eval", `document.querySelector('[aria-label="Agent to manage"]')?.disabled === false && new URLSearchParams(location.search).get('identityAgent') === ${JSON.stringify(owner)}`], `${label}-owner-selected`);
    // identities:list scans a bounded page of source documents. The requested
    // identity can be on a later page even when the library already has rows.
    const nextSelector = ".pc-identities__catalog-pages button:last-of-type";
    let found = false;
    for (let page = 1; page <= 20; page += 1) {
      const action = evalFile(catalogProbeExpression(identityId), `${label}-catalog-probe-${page}`).trim();
      if (action === "found") {
        evidence.steps.push({ label: `${label}-identity-inspectable`, page });
        found = true;
        break;
      }
      if (action !== "next" || page === 20) throw new Error(`${label}: identity ${identityId} absent from catalog at page ${page} (${action})`);
      const nextPage = `Page ${page + 1}`;
      clickUntil(nextSelector, `${label}-catalog-next-${page}`, `document.querySelector('.pc-identities__catalog-pages span')?.textContent?.trim() === ${JSON.stringify(nextPage)}`);
      settle(`${label}-catalog-next-${page}`);
      check(["--eval", `document.querySelector('.pc-identities__catalog-pages span')?.textContent?.trim() === ${JSON.stringify(nextPage)} && !!document.querySelector('.pc-identities__library')`], `${label}-catalog-page-${page + 1}-loaded`);
    }
    if (!found) throw new Error(`${label}: identity ${identityId} not found in catalog`);
    click(`[aria-label="Inspect identity ${identityId}"]`, `${label}-select-identity`);
    settle(`${label}-select-identity`);
    check(["--eval", "!!document.querySelector('.pc-identities__actions button') && !document.querySelector('.pc-identities__actions button').disabled"], `${label}-review-ready`);
    const beforePreview = callCount(`${label}-before-preview`);
    clickUntil(".pc-identities__actions button", `${label}-review`, `(window.__p015R7Seq?.started ?? 0) > ${beforePreview}`);
    settle(`${label}-review`);
    const review = waitForCall("preview", beforePreview, `${label}-review-response`);
    evidence.steps.push({ label: `${label}-review-response`, response: review });
    if (review?.request?.action !== "preview" || review?.status !== 200) throw new Error(`${label}: preview refused: ${JSON.stringify(review)}`);
    check(["--eval", "document.querySelector('.pc-identities__diff')?.textContent.includes('Revision diff') && !document.querySelector('[aria-label=\"Apply identity\"]')?.disabled"], `${label}-diff-visible`);
    const before = await lastEventId();
    const beforeSwitch = callCount(`${label}-before-switch`);
    clickUntil('button[aria-label="Apply identity"]', `${label}-apply`, `(window.__p015R7Seq?.started ?? 0) > ${beforeSwitch}`);
    settle(`${label}-apply`);
    const applied = waitForCall("switch", beforeSwitch, `${label}-switch-response`);
    evidence.steps.push({ label: `${label}-switch-response`, response: applied });
    if (applied?.request?.action !== "switch" || applied?.status !== 200) throw new Error(`${label}: switch refused: ${JSON.stringify(applied)}`);
    check(["--eval", "document.body.innerText.includes('Change requested') || document.body.innerText.includes('Identity applied')"], `${label}-change-requested`);
    return waitApplied(`domain:${identityId}`, before, `${label}-host-applied`);
  };

  try {
    const [dbIdentity] = await sql`SHOW data_directory`;
    evidence.databaseDataDirectory = dbIdentity.data_directory;
    execFileSync("bash", [required("VERIFY_TAURI_LIVENESS_CHECK")], { stdio: "inherit", timeout: 15_000 });
    const rosterResponse = await fetch(`${required("VERIFY_TAURI_DEV_URL")}/api/adv/roster?workspace=${encodeURIComponent(workspace)}`, { signal: AbortSignal.timeout(30_000) });
    const roster = await rosterResponse.json();
    const subject = roster.active?.find((x) => x.ownerId === owner);
    if (!rosterResponse.ok || !subject || subject.sessionState === "ended") throw new Error(`owner ${owner} is not an active roster agent`);
    evidence.rosterSubject = { ownerId: subject.ownerId, sessionState: subject.sessionState, label: subject.label ?? null };

    const first = await switchTo(target, "to-target");
    const second = await switchTo(returnTo, "to-installed");
    evidence.applied = { toTarget: first, toInstalled: second };

    // L6: spans opened by the final applied stack, and tool calls recorded inside them.
    const spanDeadline = Date.now() + Number(process.env.R7_SPAN_TIMEOUT_MS || 240_000);
    let spans = [];
    let calls = [];
    while (Date.now() < spanDeadline) {
      spans = await sql`
        SELECT activation_event_id, session_id, adv_session_id, control_generation, layer_ref, layer_slot, layer_id, active_from, active_until
          FROM harness_shared.session_identity_layer_spans
         WHERE workspace_id = ${workspace} AND owner_id = ${owner} AND activation_event_id >= ${Number(second.id)}
         ORDER BY layer_ref`;
      calls = await sql`
        SELECT t.id, t.tool_name, t.invoked_at, t.status, s.layer_ref
          FROM harness_shared.tool_invocations t
          JOIN harness_shared.session_identity_layer_spans s
            ON s.owner_id = t.coord_owner_id AND s.workspace_id = ${workspace}
           AND s.activation_event_id >= ${Number(second.id)}
           AND t.invoked_at >= s.active_from AND (s.active_until IS NULL OR t.invoked_at < s.active_until)
         WHERE t.coord_owner_id = ${owner}
         ORDER BY t.id LIMIT 50`;
      if (spans.some((s) => s.layer_ref === `domain:${returnTo}`) && calls.length > 0) break;
      await new Promise((r) => setTimeout(r, 5_000));
    }
    evidence.spans = spans;
    evidence.spanToolCalls = calls;
    if (!spans.some((s) => s.layer_ref === `domain:${returnTo}`)) throw new Error("no applied layer span for the installed identity");
    if (calls.length === 0) throw new Error("no tool invocation was recorded inside the applied spans");
    evidence.sessions = await sql`SELECT id, session_id, started_at, ended_at, launch_spec->>'specificationRevision' AS specification_revision, launch_spec->'stack' AS stack FROM harness_shared.adv_sessions WHERE coord_owner_id = ${owner} ORDER BY id`;
    evidence.status = "pass";
  } catch (error) {
    evidence.status = "fail";
    evidence.error = String(error?.stack || error);
    throw error;
  } finally {
    writeFileSync(`${outDir}/evidence.json`, serializeEvidence(evidence));
    await sql.end({ timeout: 2 }).catch(() => {});
  }
  console.log(JSON.stringify({ ok: evidence.status === "pass", evidence: `${outDir}/evidence.json`, status: evidence.status, owner }));
}

if (isCliEntry(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
