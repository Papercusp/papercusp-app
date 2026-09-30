/**
 * The shared verification-harness runner.
 *
 * Runs a contract's phases in declaration order under never-abort discipline (the
 * eval-battery rule, applied to a phase graph): a failing or throwing phase is recorded and
 * the run continues, and only the phases whose dependencies did not pass are marked
 * `blocked`. Every run owns ONE evidence dir (`<evidenceRoot>/<runId>`, a `phases/<id>/`
 * subdir per phase, `result.json` rewritten after every phase so a killed run still leaves
 * its partial result) and repoints `<evidenceRoot>/latest` at it when it ends.
 */
import { mkdir, readdir, readFile, readlink, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  type HarnessContract,
  type HarnessRunResult,
  type HarnessSelection,
  HarnessContractError,
  type PhaseResult,
  phaseTiers,
  type Tier,
  TIERS,
  validateContract,
} from './contract.js';
import {
  describeGuardRailFailure,
  GUARD_RAIL_SOURCE_ENV,
  type GuardRailProbe,
  type GuardRailReport,
  loadGuardRailsFromCommand,
  runGuardRails,
  selectGuardRails,
} from './guard-rails.js';
import { applyTier, planSelection } from './select.js';
import {
  defaultTierReceiptsPath,
  describeTierRefusal,
  evaluateTierGate,
  loadTierReceipts,
  type PhaseCodeIdentity,
  phaseCodeIdentity,
  recordTierReceipts,
  resolveTier,
  tierGateBlocks,
} from './tier-gate.js';

export type PhaseOutcome = { ok: true; detail?: string } | { ok: false; reasonCode: string; step?: string; detail?: string };

export interface PhaseContext {
  phase: string;
  runId: string;
  /** This phase's own evidence directory (created before the phase runs). */
  evidenceDir: string;
  /** Record the step the phase is in; a failure or throw reports the last one marked. */
  markStep(step: string): void;
}

export interface RunHarnessArgs {
  contract: HarnessContract;
  /** Parent of every run dir; the run lands at `<evidenceRoot>/<runId>`. */
  evidenceRoot: string;
  runPhase: (ctx: PhaseContext) => Promise<PhaseOutcome>;
  /** Fast checks that run before any phase; a failure blocks every phase. */
  preflight?: (ctx: PhaseContext) => Promise<PhaseOutcome>;
  /**
   * Guard-rail probes (or a loader for them). The preflight runs those sharing a tag with
   * contract.scopeTags. Omitted: the command named by VH_GUARD_RAIL_SOURCE, if set.
   */
  guardRails?: readonly GuardRailProbe[] | (() => Promise<readonly GuardRailProbe[]>);
  /** Working directory for guard-rail probes and the source command. */
  guardRailCwd?: string;
  selection?: HarnessSelection;
  /** A prior run (result or its dir) whose passed reusable phases may satisfy dependencies. */
  reuseFrom?: HarnessRunResult | string | null;
  runId?: string;
  now?: () => Date;
  /** Required when the contract declares tiers: which rig this run is on. */
  tier?: Tier | null;
  /** The tier receipt store shared by both tiers (default `<evidenceRoot>/tier-receipts.json`). */
  tierReceipts?: string;
  /** Where phase `code` paths resolve (default: guardRailCwd, else the process cwd). */
  codeRoot?: string;
  /** Run the expensive tier despite a tier-gate refusal. The reason is kept on the result. */
  overrideTierGate?: { reason: string } | null;
  /**
   * How many phases may run at once (default 1: strictly in declaration order). Above 1, a phase
   * starts as soon as its dependencies have settled — independent scenarios of a battery run side
   * by side while a dependent phase still waits for its setup.
   */
  concurrency?: number;
}

/** A FIFO slot pool: at most `n` callbacks in flight. */
function createSlots(n: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let free = n;
  const waiters: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (free > 0) free--;
    else await new Promise<void>((resolve) => waiters.push(resolve));
    try {
      return await fn();
    } finally {
      const next = waiters.shift();
      if (next) next();
      else free++;
    }
  };
}

export const PREFLIGHT_PHASE_ID = 'preflight';

export function newRunId(now: Date): string {
  return `${now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${process.pid}`;
}

/**
 * Claims a run dir EXCLUSIVELY, so no run ever writes into another run's evidence (R-5). The
 * default id is second-resolution + pid, which two runs from one process in the same second
 * share; a non-recursive mkdir fails on EEXIST, and the auto id then takes a `.N` suffix. An
 * explicit `runId` that already exists is refused, never reused.
 */
async function claimRunDir(evidenceRoot: string, explicit: string | undefined, startedAt: Date): Promise<string> {
  await mkdir(evidenceRoot, { recursive: true });
  const isTaken = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'EEXIST';
  if (explicit !== undefined) {
    try {
      await mkdir(path.join(evidenceRoot, explicit));
    } catch (e) {
      if (isTaken(e)) {
        throw new Error(`run ${explicit} already exists under ${evidenceRoot}; a run never reuses another run's evidence dir`);
      }
      throw e;
    }
    return explicit;
  }
  const base = newRunId(startedAt);
  for (let n = 0; ; n++) {
    const runId = n === 0 ? base : `${base}.${n}`;
    try {
      await mkdir(path.join(evidenceRoot, runId));
      return runId;
    } catch (e) {
      if (!isTaken(e)) throw e;
    }
  }
}

export async function loadRunResult(runDir: string): Promise<HarnessRunResult> {
  const parsed = JSON.parse(await readFile(path.join(runDir, 'result.json'), 'utf8')) as HarnessRunResult;
  if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.phases)) {
    throw new Error(`${runDir}/result.json is not a verification-harness result (schemaVersion 1)`);
  }
  return parsed;
}

export async function writeRunResult(result: HarnessRunResult): Promise<void> {
  await mkdir(result.evidenceDir, { recursive: true });
  const file = path.join(result.evidenceDir, 'result.json');
  await writeFile(`${file}.tmp`, `${JSON.stringify(result, null, 2)}\n`);
  await rename(`${file}.tmp`, file);
}

/** Point `<evidenceRoot>/latest` at the run dir (relative link, replaced atomically). */
export async function linkLatest(evidenceRoot: string, runDir: string): Promise<void> {
  const tmp = path.join(evidenceRoot, `.latest-${process.pid}`);
  await rm(tmp, { force: true });
  await symlink(path.relative(evidenceRoot, runDir), tmp);
  await rename(tmp, path.join(evidenceRoot, 'latest'));
}

/**
 * Where a harness keeps its runs when the caller names no root: `$VH_EVIDENCE_ROOT_BASE/<harness>`,
 * else the XDG state dir (`$XDG_STATE_HOME`, default `~/.local/state`) `/verification-harness/<harness>`.
 * vh.sh's `vh_default_root` resolves the same path.
 */
export function defaultEvidenceRoot(harness: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.VH_EVIDENCE_ROOT_BASE?.trim();
  if (explicit) return path.join(explicit, harness);
  const state = env.XDG_STATE_HOME?.trim() || path.join(env.HOME?.trim() || homedir(), '.local', 'state');
  return path.join(state, 'verification-harness', harness);
}

/** Run dirs are named by newRunId (and vh.sh): `<yyyymmddThhmmssZ>-<pid>`, `.N` on a same-second collision. */
const RUN_DIR_RE = /^\d{8}T\d{6}Z-\d+(\.\d+)?$/;
export const DEFAULT_KEEP_RUNS = 30;
/** A run dir with no result.json yet is in progress unless it is older than this. */
const IN_PROGRESS_GRACE_MS = 24 * 60 * 60 * 1000;

export function keepRunsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.VH_KEEP_RUNS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_KEEP_RUNS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_KEEP_RUNS;
}

/**
 * Retention: keep the newest `keep` run dirs under the evidence root and remove older ones. A
 * harness that runs many times a day (a headless UI verify) would otherwise grow the root without
 * bound. Never removes the run `latest` points at, nor a run still in progress (no result.json yet
 * and younger than a day). `VH_KEEP_RUNS` sets the default; 0 disables pruning. Returns the removed
 * run ids.
 */
export async function pruneRuns(evidenceRoot: string, keep = keepRunsFromEnv(), now = Date.now()): Promise<string[]> {
  if (!(keep > 0)) return [];
  let names: string[];
  try {
    names = (await readdir(evidenceRoot, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && RUN_DIR_RE.test(d.name))
      .map((d) => d.name);
  } catch {
    return [];
  }
  names.sort(); // the timestamp prefix sorts chronologically
  let latest: string | null = null;
  try {
    latest = path.basename(await readlink(path.join(evidenceRoot, 'latest')));
  } catch {
    /* no latest link yet */
  }
  const removed: string[] = [];
  for (const name of names.slice(0, Math.max(0, names.length - keep))) {
    if (name === latest) continue;
    const dir = path.join(evidenceRoot, name);
    const finished = await stat(path.join(dir, 'result.json')).then(() => true, () => false);
    if (!finished) {
      const born = await stat(dir).then((s) => s.mtimeMs, () => now);
      if (now - born < IN_PROGRESS_GRACE_MS) continue;
    }
    await rm(dir, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

export function deriveVerdict(result: Pick<HarnessRunResult, 'preflight' | 'phases' | 'tierGate'>): {
  verdict: HarnessRunResult['verdict'];
  firstFailure: HarnessRunResult['firstFailure'];
} {
  if (tierGateBlocks(result.tierGate)) {
    const p = result.tierGate!.phases.find((q) => q.status === 'refused')!;
    return { verdict: 'tier-refused', firstFailure: { phase: p.phase, step: null, reasonCode: p.reasonCode } };
  }
  if (result.preflight && result.preflight.status !== 'passed') {
    const p = result.preflight;
    return { verdict: 'preflight-failed', firstFailure: { phase: p.phase, step: p.step, reasonCode: p.reasonCode } };
  }
  const bad = result.phases.find((p) => p.status === 'failed') ?? result.phases.find((p) => p.status === 'blocked');
  if (!bad) return { verdict: 'pass', firstFailure: null };
  return { verdict: 'fail', firstFailure: { phase: bad.phase, step: bad.step, reasonCode: bad.reasonCode } };
}

/** One greppable line: `HARNESS_RESULT harness=… verdict=… first_failure=phase/step/reason … evidence=…`. */
export function formatSummaryLine(result: HarnessRunResult): string {
  const count = (s: PhaseResult['status']) => result.phases.filter((p) => p.status === s).length;
  const ff = result.firstFailure;
  const first = ff ? `${ff.phase}/${ff.step ?? '-'}/${ff.reasonCode ?? '-'}` : 'none';
  const gr = result.guardRails;
  const rails = !gr
    ? ''
    : gr.source === 'unconfigured'
      ? ' guard_rails=unconfigured'
      : ` guard_rails=${gr.results.filter((r) => r.ok).length}/${gr.selected}`;
  const tg = result.tierGate;
  const tier = !result.tier
    ? ''
    : ` tier=${result.tier}` +
      (tg ? ` tier_gate=${tg.refused > 0 ? `refused:${tg.refused}${tg.override ? ':overridden' : ''}` : 'admitted'}` : '');
  return (
    `HARNESS_RESULT harness=${result.harness} verdict=${result.verdict} run=${result.runId} first_failure=${first}` +
    ` passed=${count('passed')} failed=${count('failed')} blocked=${count('blocked')} skipped=${count('skipped')}` +
    ` reused=${count('reused')}${rails}${tier} evidence=${result.evidenceDir}`
  );
}

/** The identifying fields of a `HARNESS_RESULT` line — what {@link parseSummaryLine} reads back. */
export interface SummaryLineFields {
  harness: string;
  verdict: string;
  runId: string;
  /** null when the line says `first_failure=none`. `-` placeholders read back as null. */
  firstFailure: { phase: string; step: string | null; reasonCode: string | null } | null;
}

const SUMMARY_LINE_RE = /\bHARNESS_RESULT\s+harness=(\S+)\s+verdict=(\S+)\s+run=(\S+)\s+first_failure=(\S+)/;

/**
 * The inverse of {@link formatSummaryLine}, for consumers that only have the log (the attempt
 * ledger's failure fingerprint). Keeping both halves here means the line has one owner: a
 * format change that the parser does not follow fails this package's round-trip test.
 * `first_failure` is `phase/step/reason`; the phase is the first segment and the reason the
 * last, so a step containing `/` still reads back whole. Returns null for any other line.
 */
export function parseSummaryLine(line: string): SummaryLineFields | null {
  const m = SUMMARY_LINE_RE.exec(line);
  if (!m) return null;
  const [, harness, verdict, runId, first] = m as unknown as [string, string, string, string, string];
  if (first === 'none') return { harness, verdict, runId, firstFailure: null };
  const a = first.indexOf('/');
  const z = first.lastIndexOf('/');
  if (a < 0 || z === a) return { harness, verdict, runId, firstFailure: null };
  const dash = (s: string): string | null => (s === '-' || s === '' ? null : s);
  return {
    harness,
    verdict,
    runId,
    firstFailure: { phase: first.slice(0, a), step: dash(first.slice(a + 1, z)), reasonCode: dash(first.slice(z + 1)) },
  };
}

/**
 * Runs the guard rails that apply to `tags` into `evidenceDir`. Returns the report plus a
 * preflight outcome: any rail that does not hold (or a source that cannot answer) fails it.
 */
export async function checkGuardRails(args: {
  tags: readonly string[];
  guardRails?: RunHarnessArgs['guardRails'];
  cwd?: string;
  evidenceDir: string;
}): Promise<{ report: GuardRailReport | null; outcome: PhaseOutcome }> {
  if (args.tags.length === 0) return { report: null, outcome: { ok: true } };
  const sourceCmd = process.env[GUARD_RAIL_SOURCE_ENV]?.trim();
  const source: GuardRailReport['source'] = args.guardRails ? 'arg' : sourceCmd ? 'command' : 'unconfigured';
  if (source === 'unconfigured') {
    return { report: { source, selected: 0, results: [] }, outcome: { ok: true, detail: 'guard rails unconfigured' } };
  }
  let probes: readonly GuardRailProbe[];
  try {
    const g = args.guardRails;
    probes = g ? (typeof g === 'function' ? await g() : g) : await loadGuardRailsFromCommand(sourceCmd!, args.tags, { cwd: args.cwd });
  } catch (err) {
    return {
      report: { source, selected: 0, results: [] },
      outcome: { ok: false, reasonCode: 'guard-rail-source-failed', step: 'guard-rails', detail: err instanceof Error ? err.message : String(err) },
    };
  }
  const selected = selectGuardRails(probes, args.tags);
  const run = await runGuardRails(selected, { cwd: args.cwd, evidenceDir: args.evidenceDir });
  const report: GuardRailReport = { source, selected: selected.length, results: run.results };
  if (run.firstFailure) {
    return {
      report,
      outcome: {
        ok: false,
        reasonCode: `guard-rail:${run.firstFailure.key}`,
        step: 'guard-rails',
        detail: run.results.filter((r) => !r.ok).map(describeGuardRailFailure).join('; '),
      },
    };
  }
  return { report, outcome: { ok: true, detail: `${selected.length} guard rail(s) hold` } };
}

async function runOne(
  id: string,
  fn: (ctx: PhaseContext) => Promise<PhaseOutcome>,
  runId: string,
  runDir: string,
  now: () => Date,
): Promise<PhaseResult> {
  const evidenceDir = path.join(runDir, 'phases', id);
  await mkdir(evidenceDir, { recursive: true });
  let step: string | null = null;
  const started = now();
  let outcome: PhaseOutcome;
  try {
    outcome = await fn({ phase: id, runId, evidenceDir, markStep: (s) => { step = s; } });
  } catch (err) {
    outcome = { ok: false, reasonCode: 'threw', detail: err instanceof Error ? err.message : String(err) };
  }
  const ended = now();
  const base = {
    phase: id,
    evidenceDir,
    startedAt: started.toISOString(),
    endedAt: ended.toISOString(),
    elapsedMs: Math.max(0, ended.getTime() - started.getTime()),
  };
  if (outcome.ok) return { ...base, status: 'passed', step, reasonCode: null, ...(outcome.detail ? { detail: outcome.detail } : {}) };
  return {
    ...base,
    status: 'failed',
    step: outcome.step ?? step,
    reasonCode: outcome.reasonCode,
    ...(outcome.detail ? { detail: outcome.detail } : {}),
  };
}

function notRun(id: string, runDir: string, status: 'blocked' | 'skipped' | 'reused', reasonCode: string | null, extra: Partial<PhaseResult> = {}): PhaseResult {
  return {
    phase: id,
    status,
    step: null,
    reasonCode,
    evidenceDir: path.join(runDir, 'phases', id),
    startedAt: null,
    endedAt: null,
    elapsedMs: 0,
    ...extra,
  };
}

export async function runHarness(args: RunHarnessArgs): Promise<HarnessRunResult> {
  const { contract } = args;
  validateContract(contract);
  const now = args.now ?? (() => new Date());
  const selection: HarnessSelection = args.selection ?? { only: null, from: null };
  const tier = resolveTier(contract, args.tier);
  const prior =
    typeof args.reuseFrom === 'string' ? await loadRunResult(args.reuseFrom) : (args.reuseFrom ?? null);
  if (prior && (prior.tier ?? null) !== tier) {
    throw new HarnessContractError(
      `${contract.name}: cannot reuse run ${prior.runId} (${prior.tier ?? 'untiered'}) in a ${tier ?? 'untiered'} run`,
    );
  }
  const plan = applyTier(contract, planSelection(contract, selection, prior), tier, selection);
  const byId = new Map(contract.phases.map((p) => [p.id, p]));
  const gated = (id: string) => tier !== null && phaseTiers(contract, byId.get(id)!).length === TIERS.length;
  const codeRoot = args.codeRoot ?? args.guardRailCwd ?? process.cwd();
  const receiptsPath = args.tierReceipts ?? defaultTierReceiptsPath(args.evidenceRoot);
  const startedAt = now();
  const runId = await claimRunDir(args.evidenceRoot, args.runId, startedAt);
  const runDir = path.join(args.evidenceRoot, runId);

  const result: HarnessRunResult = {
    schemaVersion: 1,
    harness: contract.name,
    runId,
    evidenceDir: runDir,
    selection,
    reuseFromRunId: prior?.runId ?? null,
    preflight: null,
    phases: [],
    verdict: 'fail',
    firstFailure: null,
    ...(tier ? { tier } : {}),
    startedAt: startedAt.toISOString(),
    endedAt: null,
  };
  const checkpoint = async () => {
    Object.assign(result, deriveVerdict(result));
    await writeRunResult(result);
  };

  // The tier gate runs BEFORE preflight: an expensive run it refuses pays for nothing. It
  // leaves `latest` alone, because a refused run holds no passes to reuse.
  const gatedHashes = new Map<string, string | null>();
  if (tier === 'expensive') {
    const toRun = plan.filter((s) => s.action === 'run').map((s) => s.phase);
    const identities = new Map<string, PhaseCodeIdentity>();
    for (const id of toRun.filter(gated)) identities.set(id, await phaseCodeIdentity(byId.get(id)!, codeRoot));
    for (const [id, ident] of identities) gatedHashes.set(id, ident.hash);
    const store = await loadTierReceipts(receiptsPath, contract.name);
    result.tierGate = evaluateTierGate({ contract, phases: toRun, identities, store, receiptsPath, override: args.overrideTierGate });
    if (tierGateBlocks(result.tierGate)) {
      const refused = new Map(result.tierGate.phases.filter((p) => p.status === 'refused').map((p) => [p.phase, p]));
      for (const step of plan) {
        const r = refused.get(step.phase);
        result.phases.push(
          step.action === 'skip'
            ? notRun(step.phase, runDir, 'skipped', step.reason ?? 'not-selected')
            : step.action === 'reuse'
              ? notRun(step.phase, runDir, 'reused', null, { reusedFromRunId: step.reuseFromRunId! })
              : notRun(step.phase, runDir, 'blocked', r?.reasonCode ?? 'tier-gate:run-refused', r ? { detail: describeTierRefusal(r) } : {}),
        );
      }
      result.endedAt = now().toISOString();
      await checkpoint();
      return result;
    }
  } else if (tier === 'cheap') {
    result.tierReceipts = { tier: 'cheap', receiptsPath, recorded: [], unrecorded: [] };
  }

  // The harness's own preflight and the guard rails both run (never-abort), so one run reports
  // every broken precondition; the first failure names the reason.
  const tags = contract.scopeTags ?? [];
  if (args.preflight || tags.length > 0) {
    const own = args.preflight;
    result.preflight = await runOne(
      PREFLIGHT_PHASE_ID,
      async (ctx) => {
        const first = own ? await own(ctx) : ({ ok: true } as PhaseOutcome);
        const rails = await checkGuardRails({ tags, guardRails: args.guardRails, cwd: args.guardRailCwd, evidenceDir: ctx.evidenceDir });
        result.guardRails = rails.report;
        if (!first.ok) return rails.outcome.ok ? first : { ...first, detail: [first.detail, rails.outcome.detail].filter(Boolean).join('; ') };
        if (!rails.outcome.ok) return rails.outcome;
        return { ok: true, detail: [first.detail, rails.outcome.detail].filter(Boolean).join('; ') || undefined };
      },
      runId,
      runDir,
      now,
    );
    await checkpoint();
  }
  const preflightFailed = result.preflight !== null && result.preflight.status !== 'passed';

  // A gated phase is hashed right before it runs and again after: an expensive phase whose code
  // moved since the gate admitted it is blocked, and a cheap pass is recorded only when the code
  // that passed is the code that was hashed.
  const runTiered = async (id: string): Promise<PhaseResult> => {
    if (!gated(id)) return runOne(id, args.runPhase, runId, runDir, now);
    const before = (await phaseCodeIdentity(byId.get(id)!, codeRoot)).hash;
    if (tier === 'expensive' && gatedHashes.has(id) && before !== gatedHashes.get(id)) {
      return notRun(id, runDir, 'blocked', 'tier-gate:code-changed-during-run', {
        detail: `${id}: code changed after the tier gate admitted it; re-run the cheap tier`,
      });
    }
    const r = await runOne(id, args.runPhase, runId, runDir, now);
    if (tier !== 'cheap' || r.status !== 'passed') return r;
    const after = (await phaseCodeIdentity(byId.get(id)!, codeRoot)).hash;
    const receipts = result.tierReceipts!;
    if (before === null || after !== before) {
      receipts.unrecorded.push({
        phase: id,
        reasonCode: before === null ? 'tier-gate:code-unresolved' : 'tier-gate:code-changed-during-run',
      });
      return r;
    }
    await recordTierReceipts(receiptsPath, contract.name, [{ phase: id, codeHash: before, runId, passedAt: r.endedAt! }]);
    receipts.recorded.push({ phase: id, codeHash: before });
    return r;
  };

  const statusOf = new Map<string, PhaseResult['status']>();
  const notRunFor = (step: (typeof plan)[number]): PhaseResult | null => {
    if (step.action === 'skip') return notRun(step.phase, runDir, 'skipped', step.reason ?? 'not-selected');
    if (step.action === 'reuse') return notRun(step.phase, runDir, 'reused', null, { reusedFromRunId: step.reuseFromRunId! });
    if (preflightFailed) return notRun(step.phase, runDir, 'blocked', 'preflight-failed');
    return null;
  };
  const unmetDependency = (id: string): PhaseResult | null => {
    const unmet = (byId.get(id)!.dependsOn ?? []).find((d) => statusOf.get(d) !== 'passed' && statusOf.get(d) !== 'reused');
    return unmet ? notRun(id, runDir, 'blocked', `dependency:${unmet}:${statusOf.get(unmet) ?? 'unknown'}`) : null;
  };
  const concurrency = Math.max(1, Math.floor(args.concurrency ?? 1));

  if (concurrency === 1) {
    for (const step of plan) {
      const r = notRunFor(step) ?? unmetDependency(step.phase) ?? (await runTiered(step.phase));
      statusOf.set(step.phase, r.status);
      result.phases.push(r);
      await checkpoint();
    }
  } else {
    // A phase starts once every dependency has settled and a slot is free; results stay in
    // declaration order, and result.json is rewritten (serially) as each phase settles.
    const slot = createSlots(concurrency);
    const settled = new Map<string, Promise<PhaseResult>>();
    const ordered: (PhaseResult | undefined)[] = [];
    let writes: Promise<void> = Promise.resolve();
    plan.forEach((step, i) => {
      const run = async (): Promise<PhaseResult> => {
        const early = notRunFor(step);
        if (early) return early;
        await Promise.all((byId.get(step.phase)!.dependsOn ?? []).map((d) => settled.get(d)));
        return unmetDependency(step.phase) ?? slot(() => runTiered(step.phase));
      };
      settled.set(
        step.phase,
        run().then(async (r) => {
          statusOf.set(step.phase, r.status);
          ordered[i] = r;
          result.phases = ordered.filter((x): x is PhaseResult => x !== undefined);
          writes = writes.then(checkpoint);
          await writes;
          return r;
        }),
      );
    });
    await Promise.all(settled.values());
  }

  result.endedAt = now().toISOString();
  await checkpoint();
  await linkLatest(args.evidenceRoot, runDir);
  await pruneRuns(args.evidenceRoot);
  return result;
}
