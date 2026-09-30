/**
 * behaviour-suite/runner — Phase 2 of desktop-agent-behaviour-suite-2026-07-03.
 *
 * Runs a REAL agent the way it actually runs (a visible `psu` / fleet:launch-on-plan
 * launch on the owner's desktop), then CAPTURES that agent's own omp session transcript
 * and feeds it to the shared, transport-agnostic scorer (behaviour-suite/{transcript,
 * assertions,report}). This is the "headless-coupled" I/O layer the plan (P-002) calls
 * out — everything side-effectful (spawning the launch, globbing the session tree,
 * reading the jsonl, tearing down) sits behind an injected `RunnerDeps` port so the
 * orchestration is deterministic + unit-testable with fakes, exactly like cert-battery's
 * single injected `chat()` port. The live desktop wiring (node fs + a psu spawn / a
 * fleet:launch-on-plan tool call) is supplied by the caller (the behaviour:run tool).
 *
 * On-disk layout the capture matches (observed live 2026-07-03):
 *   ~/.papercusp/su-omp-homes/session-<id>/agent/sessions/<cwd-slug>/<ts>_<uuid>.jsonl
 * We do NOT parse the psu banner for the session id — we snapshot the set of session
 * dirs BEFORE the launch and detect the NEW one that appears, which is robust to banner
 * changes and to concurrent launches by peers.
 */
import { parseTranscript } from './transcript';
import { runChecks, type BehaviourContext } from './assertions';
import { buildReport, type BehaviourReport } from './report';

/** The default omp-homes root the desktop launches write under. */
export const DEFAULT_OMP_HOMES_ROOT = '~/.papercusp/su-omp-homes';

/** A file discovered on disk with the mtime we pick the newest by. */
export interface FoundFile {
  path: string;
  mtimeMs: number;
}

/** The only side-effect surface the runner touches — injected so the whole orchestration
 *  is deterministic and unit-testable (fake fs + fake launch), and the live run wires
 *  node fs + a real psu/fleet launch. */
export interface RunnerDeps {
  /** Immediate subdirectory names of `dir` (not recursive). [] when `dir` is absent. */
  listDirs(dir: string): string[] | Promise<string[]>;
  /** Every file ending in `ext` under `dir` (recursive), with its mtime. [] when absent. */
  listFilesRec(dir: string, ext: string): FoundFile[] | Promise<FoundFile[]>;
  /** Read a file's UTF-8 contents. */
  readFile(path: string): string | Promise<string>;
  /** Monotonic-ish clock (ms) — injected so the report timestamp + settle logic are testable. */
  now(): number;
  /** Sleep `ms` — injected so tests advance without real time. */
  sleep(ms: number): Promise<void>;
  /** Spawn the REAL agent launch (visible psu / fleet:launch-on-plan). Resolves once the
   *  launch has been fired; the runner then polls the fs for the session it produced. */
  launch(spec: LaunchSpec): Promise<void>;
  /** Optional teardown after capture (kill the terminal, cancel/archive the fixture fleet). */
  teardown?(spec: LaunchSpec): Promise<void>;
}

/** What to launch — the runner is agnostic to HOW (the deps.launch closure decides psu vs
 *  fleet:launch-on-plan); this just carries the knobs a launch + teardown need. */
export interface LaunchSpec {
  /** The fixture plan slug the agent is handed (P-004 mints this in isolation). */
  planSlug: string;
  /** The LOCAL model id to pin, e.g. 'ollama-cc/maxwell1500/ornith-35b:IQ3_M'. */
  model: string;
  /** The agent kind, e.g. 'omp'. */
  agent: string;
  /** Optional fleet slug when launched as a fleet (fleet:launch-on-plan). */
  fleet?: string;
  /** Free-form extra the launch closure understands (workspace, harness, launch-context…). */
  extra?: Record<string, unknown>;
}

export interface RunBehaviourOptions {
  spec: LaunchSpec;
  /** Scoring context (expected model substr, plan work-item ids, whether a fleet is expected). */
  ctx: BehaviourContext;
  /** Root under which per-session omp homes appear. Default DEFAULT_OMP_HOMES_ROOT. */
  ompHomesRoot?: string;
  /** Max ms to wait for a NEW session dir to appear after launch. Default 120_000. */
  sessionAppearTimeoutMs?: number;
  /** Max ms to wait for the transcript to first appear once the session dir exists. Default 120_000. */
  transcriptAppearTimeoutMs?: number;
  /** Consider the run finished once the transcript file has not grown for this long. Default 30_000. */
  settleMs?: number;
  /** Absolute cap on total capture wait (appear + settle). Default 900_000 (15 min). */
  maxWaitMs?: number;
  /** Poll interval while waiting. Default 3_000. */
  pollMs?: number;
}

export interface RunBehaviourResult {
  report: BehaviourReport;
  /** The session id (dir name suffix) the launch produced, e.g. '9871'. */
  sessionId: string | null;
  /** The transcript file that was scored. */
  transcriptPath: string | null;
  /** Why the capture ended: the transcript settled, or a timeout cap was hit. */
  captureOutcome: 'settled' | 'timeout' | 'no-session' | 'no-transcript';
}

const SESSION_PREFIX = 'session-';
const JSONL = '.jsonl';

/** The `agent/sessions` subtree of one omp-home session dir. */
export function sessionsSubtree(ompHomesRoot: string, sessionDir: string): string {
  return `${ompHomesRoot.replace(/\/$/, '')}/${sessionDir}/agent/sessions`;
}

/** Pick the session dir present in `after` but not `before` (the one the launch created).
 *  If several appeared, the lexically-greatest wins (session ids are monotonic counters,
 *  so the newest launch has the largest suffix). Returns null when none is new. */
export function pickNewSessionDir(before: string[], after: string[]): string | null {
  const had = new Set(before);
  const fresh = after.filter((d) => d.startsWith(SESSION_PREFIX) && !had.has(d));
  if (fresh.length === 0) return null;
  fresh.sort((a, b) => sessionNum(a) - sessionNum(b));
  return fresh[fresh.length - 1];
}

function sessionNum(dir: string): number {
  const n = Number(dir.slice(SESSION_PREFIX.length));
  return Number.isFinite(n) ? n : -1;
}

/** The session id (the part after `session-`), or the whole dir if it has no prefix. */
export function sessionIdOf(sessionDir: string): string {
  return sessionDir.startsWith(SESSION_PREFIX) ? sessionDir.slice(SESSION_PREFIX.length) : sessionDir;
}

/** Newest (by mtime) `*.jsonl` under a session's `agent/sessions` subtree, or null. */
export async function newestTranscript(dir: string, deps: Pick<RunnerDeps, 'listFilesRec'>): Promise<FoundFile | null> {
  const files = await deps.listFilesRec(dir, JSONL);
  if (!files.length) return null;
  return files.reduce((best, f) => (f.mtimeMs > best.mtimeMs ? f : best));
}

/** Pure scoring composition: raw jsonl lines → parsed transcript → checks → report.
 *  This is the seam a HEADLESS runner and the desktop runner share (P-002) — feed the
 *  same lines, get the same scorecard. */
export function scoreTranscriptLines(
  lines: Array<string | Record<string, unknown>>,
  ctx: BehaviourContext,
  meta: BehaviourReport['meta'] = {},
  now: number = Date.now(),
): BehaviourReport {
  const t = parseTranscript(lines);
  return buildReport(runChecks(t, ctx), { ...meta, models: t.models }, now);
}

/** Score an already-captured transcript FILE (read via deps). Used by the runner and by a
 *  "score this past session" path that skips the launch entirely. */
export async function scoreTranscriptFile(
  path: string,
  ctx: BehaviourContext,
  meta: BehaviourReport['meta'],
  deps: Pick<RunnerDeps, 'readFile' | 'now'>,
): Promise<BehaviourReport> {
  const raw = await deps.readFile(path);
  const lines = raw.split('\n');
  return scoreTranscriptLines(lines, ctx, meta, deps.now());
}

/**
 * Full desktop behaviour run: launch a real visible agent, wait for the session it
 * creates, capture its transcript once it settles, score it, tear down. Deterministic
 * given deterministic deps. Every wait is bounded — a run NEVER blocks forever.
 */
export async function runBehaviourSuite(
  opts: RunBehaviourOptions,
  deps: RunnerDeps,
): Promise<RunBehaviourResult> {
  const root = (opts.ompHomesRoot ?? DEFAULT_OMP_HOMES_ROOT).replace(/\/$/, '');
  const sessionAppearTimeoutMs = opts.sessionAppearTimeoutMs ?? 120_000;
  const transcriptAppearTimeoutMs = opts.transcriptAppearTimeoutMs ?? 120_000;
  const settleMs = opts.settleMs ?? 30_000;
  const maxWaitMs = opts.maxWaitMs ?? 900_000;
  const pollMs = opts.pollMs ?? 3_000;
  const started = deps.now();
  const budgetLeft = () => maxWaitMs - (deps.now() - started);

  const meta: BehaviourReport['meta'] = { planSlug: opts.spec.planSlug, agent: opts.spec.agent };

  const before = (await deps.listDirs(root)).filter((d) => d.startsWith(SESSION_PREFIX));
  await deps.launch(opts.spec);

  // 1. Wait for a NEW session dir to appear.
  let sessionDir: string | null = null;
  const appearDeadline = deps.now() + Math.min(sessionAppearTimeoutMs, Math.max(0, budgetLeft()));
  while (deps.now() < appearDeadline) {
    const after = await deps.listDirs(root);
    sessionDir = pickNewSessionDir(before, after);
    if (sessionDir) break;
    await deps.sleep(pollMs);
  }
  if (!sessionDir) {
    return finish(null, null, 'no-session');
  }
  const subtree = sessionsSubtree(root, sessionDir);
  const sessionId = sessionIdOf(sessionDir);

  // 2. Wait for the transcript file to first appear.
  let found: FoundFile | null = null;
  const tAppearDeadline = deps.now() + Math.min(transcriptAppearTimeoutMs, Math.max(0, budgetLeft()));
  while (deps.now() < tAppearDeadline) {
    found = await newestTranscript(subtree, deps);
    if (found) break;
    await deps.sleep(pollMs);
  }
  if (!found) {
    return finish(sessionId, null, 'no-transcript');
  }

  // 3. Wait until the transcript stops growing (agent finished its turn) or the cap hits.
  let lastMtime = found.mtimeMs;
  let stableSince = deps.now();
  let outcome: RunBehaviourResult['captureOutcome'] = 'timeout';
  while (budgetLeft() > 0) {
    await deps.sleep(pollMs);
    const cur = await newestTranscript(subtree, deps);
    if (cur && (cur.path !== found.path || cur.mtimeMs > lastMtime)) {
      found = cur;
      lastMtime = cur.mtimeMs;
      stableSince = deps.now();
      continue;
    }
    if (deps.now() - stableSince >= settleMs) {
      outcome = 'settled';
      break;
    }
  }

  return finish(sessionId, found.path, outcome);

  async function finish(
    sid: string | null,
    transcriptPath: string | null,
    captureOutcome: RunBehaviourResult['captureOutcome'],
  ): Promise<RunBehaviourResult> {
    if (deps.teardown) {
      try {
        await deps.teardown(opts.spec);
      } catch {
        /* teardown is best-effort — a failed cleanup must not mask the scorecard */
      }
    }
    if (!transcriptPath) {
      const empty = buildReport(runChecks(parseTranscript([]), opts.ctx), meta, deps.now());
      return { report: { ...empty, summary: `behaviour ${captureOutcome.toUpperCase()} — ${empty.summary}` }, sessionId: sid, transcriptPath: null, captureOutcome };
    }
    const report = await scoreTranscriptFile(transcriptPath, opts.ctx, { ...meta, sessionId: sid ?? undefined }, deps);
    return { report, sessionId: sid, transcriptPath, captureOutcome };
  }
}
