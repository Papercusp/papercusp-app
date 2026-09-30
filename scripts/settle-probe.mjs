#!/usr/bin/env node
/**
 * EI-19385008818210514 — the CONFIDENT FALSE DEFECT in headless UI verification.
 *
 * Most non-trivial components in this app are GUARDED on async data — the common
 * shapes are `entry && <Thing entry={entry}/>` and an early `if (!x) return null`.
 * A headless assertion routinely runs BEFORE that data lands, so the component is
 * legitimately absent from the DOM. The failure mode is NOT a flaky red: it is a
 * plausible, confident, WRONG conclusion — "the feature was never implemented."
 *
 * The asymmetry is what makes it dangerous. A race that produces a MISSING element
 * reads as a real finding; a race that produces a PRESENT one just reads as success.
 * So the error only ever fires against someone's finished work.
 *
 * This module is the missing "has the page finished loading?" primitive. It is
 * deliberately BOTH halves of the fix:
 *   1. `VERIFY_TAURI_SETTLE` — a blocking wait an author can put before an assertion.
 *   2. a NOTE attached to every VERIFY_TAURI_POLL failure, so a 0-match result can
 *      never render without its loading context. Half 2 is the durable half: it
 *      reaches the agent who did not know to ask.
 *
 * ⚠ THE LOAD-BEARING RULE — three-state, never two.
 * `window.__sync_metrics__.snapshot().transport.inFlight` is `number | null`, and
 * `null` means NO GATE REGISTERED or THE PROBE THREW — i.e. UNKNOWN, never zero
 * (libs/generic/sync/src/observability/metrics.ts: "A throwing probe must never
 * break the snapshot — report unknown instead"). A settle verdict that read null as
 * "0 in flight ⇒ settled" would rebuild, INSIDE this fix, the exact confident
 * false-negative the fix exists to kill. Hence `settled | busy | unknown`, and
 * `unknown` never satisfies a wait.
 *
 * ⚠ WHY THE NOTE IS SILENT ON A SETTLED PAGE. `formatSettleNote` returns '' for a
 * `settled` verdict, on purpose. A caveat printed on every failure is a caveat
 * readers learn to skip; this one must only appear when it is actually load-bearing.
 * `settle-probe.test.ts` keeps that as a permanent negative control.
 *
 * Neighbouring, and NOT the same trap: VERIFY_TAURI_POLL --require
 * (EI-18781011720418569) guards the VACUOUS GREEN — a negative assertion that is
 * trivially true of an empty DOM. That helper retries until an assertion SUCCEEDS.
 * This item is about a MEASUREMENT (`zoneCaps: 2`) whose value is read as DATA, so
 * no retry helps: nothing is being asserted.
 */

import { spawnSync } from "node:child_process";

import { isCliEntry } from "@papercusp/operator-core/lib/util/cli-entry";

/** The three-state verdict. `unknown` is a first-class answer, not a failure. */
export const SETTLE_VERDICTS = Object.freeze({
  SETTLED: "settled",
  BUSY: "busy",
  UNKNOWN: "unknown",
});

/** settled → 0, busy → 1, unknown → 3. Distinct on purpose: a caller must be able
 * to tell "the page never went quiet" from "I could not tell whether it did". */
export const SETTLE_EXIT_CODES = Object.freeze({
  settled: 0,
  busy: 1,
  unknown: 3,
});

export const DEFAULT_QUIET_MS = 400;
export const DEFAULT_INTERVAL_MS = 250;
export const DEFAULT_TIMEOUT_SEC = 20;

/**
 * The page-side expression handed to `tauri-agent-tools eval`. Returns a JSON
 * STRING (the transport hands values back as JSON, and a string round-trips
 * without depending on how it serialises objects).
 *
 * It reports `metricsPresent: false` rather than throwing when the global is
 * missing, and catches everything — an evaluation that blows up must arrive as
 * `unknown`, never as an absent-and-therefore-idle reading.
 */
export const SETTLE_EVAL_EXPRESSION = [
  "(() => {",
  "  var takenAtMs = Date.now();",
  "  try {",
  "    var doc = (typeof document !== 'undefined') ? document : null;",
  '    var domNodes = doc ? doc.getElementsByTagName("*").length : null;',
  "    var domSignature = (doc && doc.body)",
  '      ? (domNodes + ":" + doc.body.innerHTML.length)',
  "      : null;",
  "    var g = (typeof window !== 'undefined') ? window.__sync_metrics__ : null;",
  "    if (!g || typeof g.snapshot !== 'function') {",
  "      return JSON.stringify({",
  "        metricsPresent: false, transport: null,",
  "        domNodes: domNodes, domSignature: domSignature, takenAtMs: takenAtMs",
  "      });",
  "    }",
  "    var snap = g.snapshot();",
  "    var t = (snap && snap.transport) ? snap.transport : null;",
  "    return JSON.stringify({",
  "      metricsPresent: true,",
  "      transport: t ? {",
  "        inFlight: (t.inFlight === undefined ? null : t.inFlight),",
  "        queued: (t.queued === undefined ? null : t.queued),",
  "        limit: (t.limit === undefined ? null : t.limit)",
  "      } : null,",
  "      domNodes: domNodes, domSignature: domSignature, takenAtMs: takenAtMs",
  "    });",
  "  } catch (e) {",
  "    return JSON.stringify({",
  "      metricsPresent: false, transport: null,",
  "      error: String((e && e.message) || e),",
  "      domNodes: null, domSignature: null, takenAtMs: takenAtMs",
  "    });",
  "  }",
  "})()",
].join("\n");

export const SETTLE_USAGE = `Usage: node scripts/settle-probe.mjs [options]

Waits until the webview under test has finished loading, so a DOM assertion cannot
race async data and report a guarded component's absence as a missing feature.

  --pid <n>          Tauri bridge pid            (default: $VERIFY_TAURI_PID)
  --port <n>         dev-bridge port             (default: $VERIFY_TAURI_PORT)
  --token <t>        dev-bridge token            (default: $VERIFY_TAURI_TOKEN)
  --window-label <l> webview window label
  --timeout <sec>    how long to wait            (default: $VERIFY_TAURI_SETTLE_TIMEOUT,
                                                   else $VERIFY_TAURI_DOM_TIMEOUT,
                                                   else ${DEFAULT_TIMEOUT_SEC})
  --quiet-ms <ms>    DOM-quiet window required   (default: ${DEFAULT_QUIET_MS})
  --interval <ms>    sampling interval           (default: ${DEFAULT_INTERVAL_MS})
  --note-only        take a bounded reading, print the note (EMPTY when the page was
                     settled) and ALWAYS exit 0 — for attaching context to another
                     command's failure diagnostic
  --json             print the verdict as JSON on stdout
  --quiet            suppress the human note
  -h, --help         this text

Exit: ${SETTLE_EXIT_CODES.settled} settled · ${SETTLE_EXIT_CODES.busy} still busy at timeout · ${SETTLE_EXIT_CODES.unknown} UNKNOWN (could not tell — treat absence as proving nothing)`;

function makeVerdict(verdict, reason, detail, extra = {}) {
  return { verdict, reason, detail, ...extra };
}

/**
 * Coerce a transport counter. Anything that is not a finite number — `null`,
 * `undefined`, `NaN`, a string — is UNKNOWN, not zero. This is the single line
 * that keeps the whole primitive honest.
 */
export function normaliseCount(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * PURE. Turn one page sample (optionally paired with the quiet-window anchor)
 * into a three-state settle verdict. Every path that cannot PROVE the page is
 * idle returns `busy` or `unknown` — never `settled`.
 *
 * ⚠ `opts.previous` is the ANCHOR of the current quiet streak — the FIRST sample
 * of the unbroken run of idle, DOM-stable readings — not merely the immediately
 * preceding sample. Measuring the window between consecutive samples instead
 * makes `elapsed` permanently equal to the polling interval, so a page that is
 * quiet forever never settles. `nextQuietAnchor` maintains it.
 *
 * @param sample  parsed page reading, or null/garbage
 * @param opts    { previous?: sample, quietMs?: number }
 */
export function evaluateSettleSample(sample, opts = {}) {
  const quietMs = normaliseCount(opts.quietMs) ?? 0;
  const previous =
    opts.previous && typeof opts.previous === "object" ? opts.previous : null;

  if (!sample || typeof sample !== "object") {
    return makeVerdict(
      SETTLE_VERDICTS.UNKNOWN,
      "no-sample",
      "the page probe returned nothing that could be read as a sample",
    );
  }
  if (sample.error) {
    return makeVerdict(
      SETTLE_VERDICTS.UNKNOWN,
      "probe-threw",
      `the page probe threw: ${String(sample.error)}`,
    );
  }
  if (sample.metricsPresent !== true) {
    return makeVerdict(
      SETTLE_VERDICTS.UNKNOWN,
      "metrics-global-absent",
      "window.__sync_metrics__ is not installed on this page, so in-flight sync work cannot be observed at all",
    );
  }
  const transport = sample.transport;
  if (!transport || typeof transport !== "object") {
    return makeVerdict(
      SETTLE_VERDICTS.UNKNOWN,
      "transport-absent",
      "the metrics snapshot carried no transport section",
    );
  }

  const inFlight = normaliseCount(transport.inFlight);
  const queued = normaliseCount(transport.queued);
  if (inFlight === null || queued === null) {
    // metrics.ts reports null when NO GATE IS REGISTERED or the probe threw.
    // Reading that as zero is precisely the confident false-negative this file exists to prevent.
    return makeVerdict(
      SETTLE_VERDICTS.UNKNOWN,
      "gate-unregistered",
      "transport.inFlight/queued are null — no sync concurrency gate is registered, or its probe threw. null means UNKNOWN here, never zero",
      { inFlight, queued },
    );
  }
  if (inFlight > 0 || queued > 0) {
    return makeVerdict(
      SETTLE_VERDICTS.BUSY,
      "requests-in-flight",
      `${inFlight} sync request(s) in flight, ${queued} queued`,
      { inFlight, queued },
    );
  }

  if (quietMs > 0) {
    if (!previous) {
      return makeVerdict(
        SETTLE_VERDICTS.BUSY,
        "quiet-window-pending",
        `the sync gate is idle, but no ${quietMs}ms quiet window has been observed yet`,
        { inFlight, queued },
      );
    }
    if (previous.domSignature !== sample.domSignature) {
      return makeVerdict(
        SETTLE_VERDICTS.BUSY,
        "dom-mutating",
        "the DOM changed since the previous sample — rendering is still in progress",
        { inFlight, queued },
      );
    }
    const elapsed = elapsedMs(previous, sample);
    if (elapsed === null) {
      return makeVerdict(
        SETTLE_VERDICTS.UNKNOWN,
        "no-clock",
        "the samples carried no usable takenAtMs, so the quiet window cannot be measured",
        { inFlight, queued },
      );
    }
    if (elapsed < quietMs) {
      return makeVerdict(
        SETTLE_VERDICTS.BUSY,
        "quiet-window-pending",
        `the sync gate is idle and the DOM is unchanged, but only ${elapsed}ms of the required ${quietMs}ms quiet window has elapsed`,
        { inFlight, queued },
      );
    }
  }

  return makeVerdict(
    SETTLE_VERDICTS.SETTLED,
    "idle",
    quietMs > 0
      ? `no sync requests in flight or queued, and the DOM was unchanged for ${quietMs}ms`
      : "no sync requests in flight or queued",
    { inFlight, queued },
  );
}

/**
 * PURE. Advance the quiet-window anchor after a sample.
 *
 * The anchor is the FIRST sample of the current unbroken quiet streak, and it is
 * deliberately KEPT while the streak continues — that is what lets `elapsed` grow
 * past `quietMs`. Anything that breaks the streak (a busy gate, an unknown
 * reading, a DOM mutation) restarts it.
 */
export function nextQuietAnchor(anchor, sample, verdictObj) {
  if (!sample || typeof sample !== "object" || sample.error) return null;
  const verdict = verdictObj && verdictObj.verdict;
  const reason = verdictObj && verdictObj.reason;
  if (verdict === SETTLE_VERDICTS.UNKNOWN) return null;
  // The gate was busy AT this sample, so the quiet streak starts no earlier than
  // the NEXT idle reading — not at this one.
  if (reason === "requests-in-flight") return null;
  if (!anchor || typeof anchor !== "object") return sample;
  if (anchor.domSignature !== sample.domSignature) return sample;
  return anchor;
}

function elapsedMs(previous, sample) {
  const a = normaliseCount(previous.takenAtMs);
  const b = normaliseCount(sample.takenAtMs);
  if (a === null || b === null) return null;
  return Math.max(0, b - a);
}

/**
 * PURE. The note attached to another command's failure diagnostic.
 *
 * ⚠ Returns '' for a `settled` verdict, and that emptiness is the point — see the
 * module header. It is also aimed at a specific VERB: the reader is about to
 * CONCLUDE something from an absence, so the note names that exact wrong conclusion
 * and the falsifier for it, rather than restating the measurement.
 */
export function formatSettleNote(verdictObj, opts = {}) {
  const prefix = typeof opts.prefix === "string" ? opts.prefix : "";
  if (!verdictObj || typeof verdictObj !== "object") return "";
  if (verdictObj.verdict === SETTLE_VERDICTS.SETTLED) return "";

  const lines = [];
  if (verdictObj.verdict === SETTLE_VERDICTS.BUSY) {
    lines.push(
      `SETTLE: the page was STILL LOADING when this ran — ${verdictObj.detail}.`,
    );
  } else {
    lines.push(
      `SETTLE: UNKNOWN whether the page had finished loading — ${verdictObj.detail}.`,
      "That is NOT evidence that it had.",
    );
  }
  lines.push(
    "Do NOT conclude from a missing element that the feature is missing. Most components here",
    "are guarded on async data (`entry && <Thing entry={entry}/>`, `if (!x) return null`), so they",
    "are legitimately absent until that data lands.",
    'Falsifier: re-run this same assertion after `bash "$VERIFY_TAURI_SETTLE"`. If the element',
    "then appears, what you measured was a RACE, not a defect.",
  );
  return lines
    .map((line, i) => `${prefix}${i === 0 ? "⚠ " : "   "}${line}`)
    .join("\n");
}

/**
 * PURE. Recover a sample from whatever `tauri-agent-tools eval` printed. The
 * transport may hand back the JSON string itself, a JSON-encoded string wrapping
 * it, or the decoded object — and may prepend log lines.
 *
 * Returns `{ ok: true, sample }` or `{ ok: false, sample }` where the failing
 * sample is a synthetic `{ error }` reading, so an unparseable probe becomes
 * `unknown` rather than being mistaken for an idle page.
 */
export function parseSettleSample(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) {
    return {
      ok: false,
      sample: { error: "the page probe produced no output" },
    };
  }
  // ⚠ MEASURED LIVE 2026-08-31: `tauri-agent-tools eval` PRETTY-PRINTS an object
  // result across many lines even when the expression returns JSON.stringify(...)
  // — the same trap agent-e2e documents for `grep '"ok":true'`. So the whole
  // output must be parsed as one document FIRST. A line-at-a-time reader finds no
  // valid JSON on any single line and reports "the probe printed no reading",
  // which lands as `unknown` on a perfectly healthy page.
  const candidates = [text];
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }
  for (const line of text
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .reverse()) {
    candidates.push(line);
  }
  for (const candidate of candidates) {
    let value = tryParseJson(candidate);
    for (let depth = 0; typeof value === "string" && depth < 2; depth += 1) {
      value = tryParseJson(value);
    }
    if (value && typeof value === "object") return { ok: true, sample: value };
  }
  return {
    ok: false,
    sample: {
      error: `the page probe printed no JSON reading: ${text.split("\n").pop()}`,
    },
  };
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * PURE. argv for `tauri-agent-tools eval`. Flags MUST follow the subcommand.
 *
 * ⚠ MEASURED LIVE 2026-08-31: a pid and a port are ALTERNATIVE ways to name the
 * target, not complementary ones. Sending both made the tool reach for the port
 * and answer `Bridge error (404)` — and VERIFY_TAURI_PORT is the webview's own
 * Hono+SPA origin, NOT the agent-tools bridge port, so it is exactly the wrong
 * number to volunteer. A resolved pid wins.
 */
export function buildEvalArgs(target = {}) {
  const args = ["eval"];
  if (target.pid) args.push("--pid", String(target.pid));
  else if (target.port) args.push("--port", String(target.port));
  if (target.token) args.push("--token", String(target.token));
  if (target.windowLabel)
    args.push("--window-label", String(target.windowLabel));
  args.push(SETTLE_EVAL_EXPRESSION);
  return args;
}

/** PURE. Verdict → process exit code. */
export function settleExitCode(verdictObj) {
  const verdict = verdictObj && verdictObj.verdict;
  return Object.prototype.hasOwnProperty.call(SETTLE_EXIT_CODES, verdict)
    ? SETTLE_EXIT_CODES[verdict]
    : SETTLE_EXIT_CODES.unknown;
}

/**
 * Keep the readiness guard at least as patient as the DOM assertion it guards.
 * A caller can still give settle its own explicit budget; otherwise inheriting
 * VERIFY_TAURI_DOM_TIMEOUT avoids a contradictory run where settle gives up
 * before VERIFY_TAURI_POLL's advertised assertion window has elapsed.
 */
export function resolveSettleTimeoutSec(env = {}) {
  const guardedAssertionTimeoutSec = numberFrom(
    env.VERIFY_TAURI_DOM_TIMEOUT,
    DEFAULT_TIMEOUT_SEC,
  );
  return numberFrom(
    env.VERIFY_TAURI_SETTLE_TIMEOUT,
    guardedAssertionTimeoutSec,
  );
}

/** PURE. Argument parsing, split out so it is testable without a live webview. */
export function parseSettleCliArgs(argv, env = {}) {
  const opts = {
    pid: env.VERIFY_TAURI_PID || "",
    // NOT defaulted from VERIFY_TAURI_PORT: that is the webview's Hono+SPA origin
    // port, not the agent-tools bridge port, and volunteering it produces a
    // `Bridge error (404)` that this probe would then report as `unknown`.
    port: "",
    token: env.VERIFY_TAURI_TOKEN || "",
    windowLabel: "",
    timeoutSec: resolveSettleTimeoutSec(env),
    quietMs: numberFrom(env.VERIFY_TAURI_SETTLE_QUIET_MS, DEFAULT_QUIET_MS),
    intervalMs: numberFrom(
      env.VERIFY_TAURI_SETTLE_INTERVAL_MS,
      DEFAULT_INTERVAL_MS,
    ),
    noteOnly: false,
    json: false,
    quiet: false,
    help: false,
    error: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[(i += 1)];
    switch (arg) {
      case "--pid":
        opts.pid = next();
        break;
      case "--port":
        opts.port = next();
        break;
      case "--token":
        opts.token = next();
        break;
      case "--window-label":
        opts.windowLabel = next();
        break;
      case "--timeout":
        opts.timeoutSec = numberFrom(next(), opts.timeoutSec);
        break;
      case "--quiet-ms":
        opts.quietMs = numberFrom(next(), opts.quietMs);
        break;
      case "--interval":
        opts.intervalMs = numberFrom(next(), opts.intervalMs);
        break;
      case "--note-only":
        opts.noteOnly = true;
        break;
      case "--json":
        opts.json = true;
        break;
      case "--quiet":
        opts.quiet = true;
        break;
      case "-h":
      case "--help":
        opts.help = true;
        break;
      default:
        opts.error = `unknown option: ${arg}`;
        return opts;
    }
  }
  return opts;
}

function numberFrom(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function takeSample(opts) {
  const bin = process.env.VERIFY_TAURI_AGENT_TOOLS_BIN || "tauri-agent-tools";
  const result = spawnSync(bin, buildEvalArgs(opts), {
    encoding: "utf8",
    timeout: Math.max(5000, opts.intervalMs * 8),
  });
  if (result.error) {
    return { error: `could not run ${bin}: ${result.error.message}` };
  }
  const parsed = parseSettleSample(result.stdout);
  if (!parsed.ok && result.status !== 0) {
    const stderr = (result.stderr || "").trim().split("\n").slice(-1)[0] || "";
    return {
      error: `${bin} eval exited ${result.status}${stderr ? `: ${stderr}` : ""}`,
    };
  }
  return parsed.sample;
}

function sleepMs(ms) {
  if (ms <= 0) return;
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, ms);
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const opts = parseSettleCliArgs(argv, env);
  if (opts.error) {
    process.stderr.write(`${opts.error}\n\n${SETTLE_USAGE}\n`);
    process.exit(2);
  }
  if (opts.help) {
    process.stdout.write(`${SETTLE_USAGE}\n`);
    process.exit(0);
  }
  if (!opts.pid && !opts.port) {
    process.stderr.write(
      "FATAL: no target — pass --pid/--port or run inside verify-tauri-headless.sh (which exports VERIFY_TAURI_PID).\n",
    );
    process.exit(2);
  }

  // --note-only takes a BOUNDED reading (two samples one interval apart) so it can
  // observe DOM churn without ever becoming a second wait. It must not be able to
  // break the diagnostic it decorates, so it always exits 0. Its quiet window is
  // collapsed to the smallest positive value: the DOM-mutation check still runs,
  // but a genuinely settled page reaches `settled` inside the bounded reading —
  // otherwise every diagnostic would carry a spurious "still loading" note, which
  // is the caveat-fatigue failure this note exists to avoid.
  const quietMs = opts.noteOnly ? Math.min(opts.quietMs, 1) : opts.quietMs;
  const deadline =
    Date.now() + (opts.noteOnly ? opts.intervalMs * 2 : opts.timeoutSec * 1000);
  let anchor = null;
  let current = evaluateSettleSample(null, { quietMs });
  for (;;) {
    const sample = takeSample(opts);
    current = evaluateSettleSample(sample, { previous: anchor, quietMs });
    anchor = nextQuietAnchor(anchor, sample, current);
    if (current.verdict === SETTLE_VERDICTS.SETTLED) break;
    if (Date.now() >= deadline) break;
    sleepMs(opts.intervalMs);
  }

  if (opts.json) process.stdout.write(`${JSON.stringify(current)}\n`);
  if (opts.noteOnly) {
    const note = formatSettleNote(current);
    if (note) process.stdout.write(`${note}\n`);
    process.exit(0);
  }
  if (!opts.quiet && current.verdict !== SETTLE_VERDICTS.SETTLED) {
    process.stderr.write(`${formatSettleNote(current)}\n`);
  }
  process.exit(settleExitCode(current));
}

if (isCliEntry(import.meta.url)) main();
