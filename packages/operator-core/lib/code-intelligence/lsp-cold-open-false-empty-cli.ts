/**
 * lsp-cold-open-false-empty-cli.ts — HOW LONG IS OUR COLD-OPEN FALSE-EMPTY WINDOW?
 *
 * Plan `lsp-fleet-scale-all-languages-2026-08-21`, item P-015 (WI-41097).
 *
 * WHY THIS EXISTS. WI-40244's research rests on the claim that "our readiness
 * contract is the field-leading half". That claim was asserted from READING the
 * architecture, never measured. This measures it, on this repo, with the query
 * trace, so the claim can be cited or withdrawn on evidence.
 *
 * WHAT A "FALSE EMPTY" IS HERE — the repo's own predicate, not a new one.
 * `contracts.ts` already defines `isTrustworthyEmpty()`: an empty answer is
 * trustworthy only when it carries no error AND affirmatively claims
 * `health: 'healthy'`. So a COLD-OPEN FALSE EMPTY is an answer that
 *
 *     sites.length === 0  &&  error === null  &&  freshness.health === 'healthy'
 *
 * for a cursor whose WARM ground truth is non-empty. That is an authoritative
 * lie: the caller is told "there are none" when there are many. The window is
 * the wall-clock span from cold open during which such an answer is returned.
 *
 * WHY OURS AND THEIRS ARE MEASURED DIFFERENTLY (and why that is the finding).
 * `lspQuery` BLOCKS until the intent is certified, then answers. So a cold
 * caller pays LATENCY and receives a correct answer. It cannot be polled for a
 * "window" because it never returns early — which is precisely the property
 * under test. The comparable stack (Serena/SolidLSP `request_references`) fires
 * the LSP request and returns whatever comes back, so it CAN be polled, and its
 * window is the span over which it hands back a confident `[]`.
 *
 * The honest apples-to-apples statement is therefore:
 *   - ours:   false-empty window in ms, plus the latency paid to keep it there
 *   - theirs: false-empty window in ms, plus time-to-first-correct-answer
 *
 * PROTOCOL. Per trial: shut every client down (this kills the server process,
 * so the next query is a genuine cold open), then fire ONE query and record
 * what that single cold caller received. Ground truth is measured WARM first,
 * on the same cursor, and a trial that disagrees with a non-empty ground truth
 * while claiming health is counted as a false empty.
 *
 * The Serena/SolidLSP counterpart probe is a Python script (SolidLSP is a
 * Python library); it is archived on WI-41097 rather than added to this
 * TypeScript package.
 *
 * USAGE
 *   npx tsx packages/operator-core/lib/code-intelligence/lsp-cold-open-false-empty-cli.ts
 *   npx tsx .../lsp-cold-open-false-empty-cli.ts --language rust --trials 2
 *   npx tsx .../lsp-cold-open-false-empty-cli.ts --json
 */
import { performance } from 'node:perf_hooks';
import { moduleRepoRoot } from '../module-repo-root';

import { lspQuery, shutdownAllLspClients } from './lsp-adapter.ts';
import { BENCH_PROBES, resolveProbeCursor } from './code-intel-bench.ts';
import type { CodeIntelAnswer, CodeIntelIntent } from './contracts.ts';

/** packages/operator-core/lib/code-intelligence → repo root. */
const REPO_ROOT = moduleRepoRoot(import.meta.url);

interface TrialRecord {
  readonly trial: number;
  readonly intent: CodeIntelIntent;
  readonly latencyMs: number;
  readonly sites: number;
  readonly error: string | null;
  readonly health: string;
  /** The thing under test: a confident empty against a non-empty truth. */
  readonly falseEmpty: boolean;
  /** An empty that correctly refused to claim trust (error or degraded). */
  readonly honestlyWithheld: boolean;
}

function classify(answer: CodeIntelAnswer, groundTruthSites: number): {
  falseEmpty: boolean;
  honestlyWithheld: boolean;
} {
  const empty = answer.sites.length === 0;
  if (!empty) return { falseEmpty: false, honestlyWithheld: false };

  // CAREFUL: isTrustworthyEmpty() does NOT mean "believe there are none". Its
  // second branch returns TRUE for an errored answer, and the comment there
  // says why — "loud failure — honest". So an empty WITH an error is the
  // honest case, not the dishonest one, and feeding it straight into a
  // false-empty verdict inverts the meaning of the measurement.
  //
  // A false empty is the narrow case where all three hold: empty, no error,
  // and an affirmative claim of health. Spelled out rather than delegated, so
  // the predicate cannot be misread again.
  const claimsThereAreNone =
    answer.error === null && answer.freshness.health === 'healthy';
  return {
    falseEmpty: claimsThereAreNone && groundTruthSites > 0,
    honestlyWithheld: !claimsThereAreNone,
  };
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? String(process.argv[i + 1]) : fallback;
}

async function main(): Promise<void> {
  const language = arg('language', 'typescript');
  const trials = Number(arg('trials', '3'));
  const intent = arg('intent', 'references') as CodeIntelIntent;
  const asJson = process.argv.includes('--json');

  const wantRust = language === 'rust';
  const probeId = arg('probe', '');
  // WHY --probe MATTERS MORE THAN IT LOOKS. The cold-open window we are trying
  // to observe only exists while the server is building an index, and how long
  // that takes is a property of the PROJECT the cursor resolves into, not of
  // the repo. The barrel-reexport cursor resolves into `libs/generic/
  // dock-workbench`, which loads in <1s and yields 3 sites — a window too
  // short to catch anything, so a clean run there is weak evidence. The
  // pty-bridge cursor resolves into `packages/operator-core` and pays the
  // ~27s process-wide reference-index build (measured by the intent-warmth
  // CLI, 192 sites). Default to the heavy one for exactly that reason.
  const probe = probeId
    ? BENCH_PROBES.find((p) => p.caseId === probeId)
    : wantRust
      ? BENCH_PROBES.find((p) => p.file.endsWith('.rs'))
      : BENCH_PROBES.find((p) => p.caseId === 'shadowed-symbol-no-cross-contamination');

  if (!probe) {
    throw new Error(
      `no bench probe for language=${language} probe=${probeId || '(default)'} — ` +
        `known: ${BENCH_PROBES.map((p) => p.caseId).join(', ')}`,
    );
  }
  // resolveProbeCursor re-resolves the unique anchor against the CURRENT tree
  // and throws on drift, so a stale line number can never be measured as real.
  const cursor = resolveProbeCursor(probe, REPO_ROOT);

  const header = {
    language,
    intent,
    probe: probe.caseId,
    file: probe.file,
    line1: cursor.line1,
    symbol: probe.symbol,
    // The project the cursor actually resolves into. This is the single most
    // load-bearing line of context for any number below it: a fast cold open
    // usually means a SMALL project, not a fast server.
    rootPath: cursor.rootPath,
  };

  // ── Ground truth, measured WARM on the same cursor ──────────────────────
  await shutdownAllLspClients();
  const warmStart = performance.now();
  const warmup = await lspQuery(intent, {
    file: cursor.file,
    line1: cursor.line1,
    character: cursor.character,
    rootPath: cursor.rootPath,
  });
  const warmupMs = Math.round(performance.now() - warmStart);
  // Query a second time on the now-hot server: that is the ground truth.
  const truthAnswer = await lspQuery(intent, {
    file: cursor.file,
    line1: cursor.line1,
    character: cursor.character,
    rootPath: cursor.rootPath,
  });
  const groundTruth = truthAnswer.sites.length;

  if (!asJson) {
    console.log(`# cold-open false-empty probe — OURS (papercusp lsp-adapter)`);
    console.log(`# ${JSON.stringify(header)}`);
    console.log(
      `# ground truth: ${groundTruth} site(s)  ` +
        `[first cold call ${warmupMs}ms, warm confirm ${truthAnswer.latencyMs}ms]`,
    );
    if (groundTruth === 0) {
      console.log(
        `# !! ground truth is EMPTY — this cursor cannot detect a false empty. ` +
          `Pick a cursor with a known non-empty answer before trusting any row below.`,
      );
    }
  }

  // ── --trace MODE: watch ONE cold open evolve ────────────────────────────
  // The single-shot trials below answer "did a cold caller get a confident
  // EMPTY?". They cannot answer "did a cold caller get a confident PARTIAL?",
  // because a partial is non-empty and every non-empty answer keeps the
  // client's health by deliberate design (see healthForAnswer). This mode
  // re-queries the SAME cursor from one cold open and prints the site count
  // over time, so a count that CLIMBS is direct evidence that an earlier
  // answer was incomplete while claiming to be healthy.
  const traceSec = Number(arg('trace', '0'));
  if (traceSec > 0) {
    await shutdownAllLspClients();
    const traceStart = performance.now();
    const samples: Array<{ ms: number; sites: number; health: string; error: string | null }> = [];
    if (!asJson) console.log(`# TRACE mode: one cold open, re-queried for ${traceSec}s`);
    for (;;) {
      const elapsed = performance.now() - traceStart;
      if (elapsed > traceSec * 1000) break;
      const a = await lspQuery(intent, {
        file: cursor.file,
        line1: cursor.line1,
        character: cursor.character,
        rootPath: cursor.rootPath,
      });
      const at = Math.round(performance.now() - traceStart);
      samples.push({ ms: at, sites: a.sites.length, health: a.freshness.health, error: a.error });
      if (!asJson) {
        console.log(
          `  t=${String(at).padStart(7)}ms  sites=${String(a.sites.length).padStart(4)}  ` +
            `health=${a.freshness.health.padEnd(8)}  err=${a.error ?? 'none'}`,
        );
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    const first = samples[0];
    const last = samples[samples.length - 1];
    const grew = !!first && !!last && last.sites > first.sites;
    const out = {
      side: 'ours',
      mode: 'trace',
      ...header,
      firstSites: first?.sites ?? null,
      lastSites: last?.sites ?? null,
      /** True ⇒ the first answer was INCOMPLETE while claiming health. */
      countClimbed: grew,
      firstAnswerHealth: first?.health ?? null,
      samples,
    };
    if (asJson) console.log(JSON.stringify(out, null, 2));
    else {
      console.log(
        `# TRACE RESULT: first=${first?.sites} last=${last?.sites} climbed=${grew ? 'YES' : 'no'} ` +
          `firstHealth=${first?.health}`,
      );
    }
    await shutdownAllLspClients();
    return;
  }

  const records: TrialRecord[] = [];
  for (let t = 1; t <= trials; t++) {
    // Kill the server so the next query is a genuine cold open.
    await shutdownAllLspClients();
    const t0 = performance.now();
    const answer = await lspQuery(intent, {
      file: cursor.file,
      line1: cursor.line1,
      character: cursor.character,
      rootPath: cursor.rootPath,
    });
    const latencyMs = Math.round(performance.now() - t0);
    const { falseEmpty, honestlyWithheld } = classify(answer, groundTruth);
    records.push({
      trial: t,
      intent,
      latencyMs,
      sites: answer.sites.length,
      error: answer.error,
      health: answer.freshness.health,
      falseEmpty,
      honestlyWithheld,
    });
    if (!asJson) {
      console.log(
        `TRIAL ${t}  ${String(latencyMs).padStart(7)}ms  ` +
          `sites=${String(answer.sites.length).padStart(4)}  ` +
          `health=${answer.freshness.health.padEnd(8)}  ` +
          `falseEmpty=${falseEmpty ? 'YES' : 'no '}  ` +
          `err=${answer.error ?? 'none'}`,
      );
    }
  }

  const falseEmpties = records.filter((r) => r.falseEmpty).length;
  // Ours blocks rather than returning early, so the window is 0ms unless a
  // trial actually handed back a confident empty. When one does, the whole
  // latency of that call was spent inside the window.
  const windowMs = falseEmpties === 0 ? 0 : Math.max(...records.filter((r) => r.falseEmpty).map((r) => r.latencyMs));
  const summary = {
    side: 'ours',
    ...header,
    groundTruthSites: groundTruth,
    trials: records.length,
    falseEmptyTrials: falseEmpties,
    falseEmptyWindowMs: windowMs,
    coldLatencyMsMedian: median(records.map((r) => r.latencyMs)),
    coldLatencyMsMax: Math.max(...records.map((r) => r.latencyMs)),
    records,
  };

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(
      `# RESULT ours: falseEmptyWindow=${windowMs}ms ` +
        `(${falseEmpties}/${records.length} trials returned a confident empty) ` +
        `coldLatency median=${summary.coldLatencyMsMedian}ms max=${summary.coldLatencyMsMax}ms`,
    );
    console.log(`# shut down ${await shutdownAllLspClients()} client(s)`);
  }
  if (asJson) await shutdownAllLspClients();
}

function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
