/**
 * in-flight-retriage.ts — a stale-candidate auto-refire IN PROGRESS, made visible (EI-18669342433807110).
 *
 * ## The gap this closes
 *
 * green-checkpoint.ts's stale-candidate re-triage (see green-checkpoint.ts's `classifyRedAgainstTip`)
 * can decide a red is stale and re-fire the WHOLE gate on a newer tip — but it does that by
 * RECURSING into itself synchronously (`return runGreenCheckpoint(cfg, deps, { candidate: tip, ... })`).
 * The recursion can run a full suite again (minutes), and nothing is written to `gate_health` for
 * that intermediate step — only the run's FINAL verdict (once every refire attempt bottoms out) gets
 * recorded (`recordCheckpointVerdict` / `trackGateStall`, a full-replace write of `gate_health`).
 *
 * So while a refire is in flight, any concurrent reader (`coord:orient.pipeline`, `dev:why`, the
 * /admin Git tab) sees whatever `gate_health` the PREVIOUS completed run left — typically a plain
 * red, with the "a red gate is YOURS to green" directive attached, and no hint that this exact red
 * is already being re-verified. Observed live 2026-07-26: a manual checkpoint run logged `red at
 * 30f88df7 ... re-triage: stale-candidate ... auto-refiring (attempt 1/2)` while every wake in the
 * fleet kept reading `gate: red, failingFiles: [...]` and dutifully going to "fix" tests that were
 * already proven to pass at the tip this same run was mid-way through confirming.
 *
 * ## The fix
 *
 * The refiring run merges (never replaces) a small `gate_health.inFlightRetriage` marker the
 * INSTANT it decides to auto-refire — before the (possibly long) recursive run starts — naming the
 * candidate this red pertains to, the tip being re-verified, and the attempt/cap. A reader
 * (`gate-verdict-freshness.ts`) treats a fresh marker whose `fromCandidate` matches the cached red's
 * candidate as proof the verdict is currently being re-earned, exactly like the other freshness
 * rules — reusing the SAME `verdictStale` plumbing every consumer (gateLabel, gateStage, the
 * `coord:orient` pipeline fold) already respects, so nothing downstream needs its own new branch.
 *
 * The marker self-clears the normal way: the run's eventual FINAL write (`recordCheckpointVerdict`)
 * replaces the whole `gate_health` object and simply does not include `inFlightRetriage`, so it
 * vanishes the moment a real verdict lands. `IN_FLIGHT_RETRIAGE_MAX_AGE_MS` bounds the one failure
 * mode that final write can't cover — a run that crashes mid-refire and never reaches it — so an
 * abandoned marker cannot wedge every future read into "still refiring" forever.
 */
import { mergeGateHealth } from './gate-health-merge';
import type { GateVerdictTarget } from './gate-verdict-target';

/** Bounded by green-checkpoint.ts's `SELF_WATCHDOG_MS` (3h): a run that hangs past that self-kills
 *  and writes a real red verdict, so any in-flight marker older than this is definitely abandoned
 *  (a crashed/orphaned run that never reached its final write), not a genuinely long refire. */
export const IN_FLIGHT_RETRIAGE_MAX_AGE_MS = 3 * 60 * 60_000;

/**
 * WI-38224: wall-clock ms at which THIS PROCESS booted — the instant its module graph was fixed.
 *
 * Derived from `process.uptime()` rather than module-load time on purpose: a module can be loaded
 * long after boot (lazily, or through a second module record), and it is the PROCESS's age that
 * bounds which code it can possibly be running. Evaluated once, so it never drifts.
 */
export const RUNNER_PROCESS_BOOTED_AT_MS = Date.now() - Math.round(process.uptime() * 1000);

/** What a currently-running stale-candidate auto-refire tells a concurrent reader about itself. */
export interface InFlightRetriageInfo {
  /** The candidate the CACHED red (`gate_health.lastFrom` / the verdict a reader has in hand) was
   *  recorded against — short sha. A reader only trusts this marker for a red pertaining to the
   *  SAME candidate; a marker for a different (already-superseded) red must not silence a genuinely
   *  new one. */
  fromCandidate: string;
  /** The newer tip this refire is re-verifying. */
  refiringCandidate: string;
  /** 1-based CHARGED attempt number, so a reader can say "attempt N/maxRefires".
   *  ⚠ Since EI-19343532231631821 this does NOT advance on every refire — only on a refire whose
   *  failures OVERLAP the set already being rescued (a FAILED rescue). Read `totalRefires` for the
   *  number of refires actually performed; a run whose rescues all succeed holds this at 0 while
   *  `totalRefires` climbs, and that is the healthy case, not a stalled one. */
  refireAttempt: number;
  maxRefires: number;
  /** The failing file(s) this refire is trying to disprove — echoed for a human-readable note. */
  failingFiles: string[];
  /** EI-19343532231631821: did THIS refire consume a slot of the charged budget? `false` ⇒ the
   *  previous rescue SUCCEEDED and these failures are fresh tree churn imported by the newer cut. */
  charged?: boolean;
  /** Refires performed this run, charged or not — bounded by `absoluteCeiling`. */
  totalRefires?: number;
  /** The hard ceiling on `totalRefires`; with every rescue succeeding this, not `maxRefires`, is
   *  what eventually stops the run. */
  absoluteCeiling?: number;
  /** WI-38224: wall-clock ms at which the gate RUNNER PROCESS booted.
   *
   *  Every other field here describes the CANDIDATE — the code being judged. This one describes
   *  the JUDGE, and it is the only field that can answer "is this verdict even capable of
   *  reflecting the runner fix that just landed?".
   *
   *  It matters because `runGreenCheckpoint` recurses IN-PROCESS on an auto-refire (same pid — see
   *  green-checkpoint.ts's own note at the recursion site). The refire re-cuts onto a NEWER
   *  candidate, so every candidate-shaped field here advances and the run looks like it is tracking
   *  tip; the runner's own module graph does not, because Node loaded it once at boot. A fix
   *  committed to green-checkpoint.ts after that instant therefore cannot take effect in this run
   *  no matter how many times it refires — and without this stamp there is nothing in the marker a
   *  reader could use to notice, so a still-red gate reads as "the fix didn't work" and invites
   *  someone to re-fix an already-correct guard. Pair it with {@link describeRunnerCodeFreshness}.
   *
   *  Optional: a marker written before WI-38224 carries none, which reads as `unknown`, never as
   *  fresh. */
  runnerBootedAtMs?: number;
}

/** The shape persisted to `gate_health.inFlightRetriage` — `InFlightRetriageInfo` plus the
 *  write-time stamp a reader needs to judge freshness. */
export interface StoredInFlightRetriage extends InFlightRetriageInfo {
  observedAtMs: number;
}

/**
 * Merge an in-flight-refire marker into the green-checkpoint routine's `gate_health` blob — a
 * shallow merge (`gate_health = gate_health || {inFlightRetriage: ...}`), never a replace, so it
 * cannot clobber the red streak / failing-tests / any other field a concurrent read depends on.
 *
 * Best-effort: swallows its own errors. This is a diagnostic aid riding alongside the real
 * checkpoint run — a write failure here must never break (or even slow) the run itself.
 */
export async function recordInFlightRetriage(target: GateVerdictTarget, info: InFlightRetriageInfo): Promise<void> {
  const stored: StoredInFlightRetriage = { ...info, observedAtMs: Date.now() };
  await mergeGateHealth(target, { inFlightRetriage: stored });
}

/**
 * PURE: interpret the raw `gate_health.inFlightRetriage` value a snapshot read got back from PG.
 * Returns `null` for anything not trustworthy right now — missing, malformed (an old blob / a
 * shape this reader doesn't recognize), or older than {@link IN_FLIGHT_RETRIAGE_MAX_AGE_MS} (an
 * abandoned marker from a crashed run). Unit-testable without PG.
 *
 * ⚠ EI-19343516395023183: this returns an EXPLICIT object literal, so a field added to
 * {@link InFlightRetriageInfo} is silently DROPPED here unless it is also carried below — which is
 * exactly what happened to `charged`/`totalRefires`/`absoluteCeiling`. They were persisted by both
 * publish sites in green-checkpoint.ts from the day EI-19343532231631821 added them and reached no
 * reader at all, so every consumer kept rendering the CHARGED counter alone ("attempt 0/2" for a
 * run five successful rescues deep) and testing `refireAttempt >= maxRefires` for "budget spent" —
 * a test that cannot see the absolute ceiling, i.e. that reports budget remaining when there is
 * none. Add a field to the interface ⇒ add it here, and to {@link describeRefireBudget}.
 */
export function parseInFlightRetriage(raw: unknown, nowMs: number = Date.now()): StoredInFlightRetriage | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const fromCandidate = typeof r.fromCandidate === 'string' ? r.fromCandidate : null;
  const refiringCandidate = typeof r.refiringCandidate === 'string' ? r.refiringCandidate : null;
  const refireAttempt = typeof r.refireAttempt === 'number' ? r.refireAttempt : null;
  const maxRefires = typeof r.maxRefires === 'number' ? r.maxRefires : null;
  const observedAtMs = typeof r.observedAtMs === 'number' ? r.observedAtMs : null;
  if (!fromCandidate || !refiringCandidate || refireAttempt == null || maxRefires == null || observedAtMs == null) {
    return null;
  }
  if (nowMs - observedAtMs > IN_FLIGHT_RETRIAGE_MAX_AGE_MS) return null; // abandoned — see doc above.
  const failingFiles = Array.isArray(r.failingFiles) ? r.failingFiles.filter((f): f is string => typeof f === 'string') : [];
  return {
    fromCandidate,
    refiringCandidate,
    refireAttempt,
    maxRefires,
    failingFiles,
    observedAtMs,
    // Optional by construction: a marker written before EI-19343532231631821 carries none of these,
    // and `describeRefireBudget` degrades to the charged-only reading for exactly that case.
    ...(typeof r.charged === 'boolean' ? { charged: r.charged } : {}),
    ...(typeof r.totalRefires === 'number' ? { totalRefires: r.totalRefires } : {}),
    ...(typeof r.absoluteCeiling === 'number' ? { absoluteCeiling: r.absoluteCeiling } : {}),
    // WI-38224 — same rule as the three above: carried here or it never reaches a reader.
    ...(typeof r.runnerBootedAtMs === 'number' ? { runnerBootedAtMs: r.runnerBootedAtMs } : {}),
  };
}

/** What {@link describeRunnerCodeFreshness} tells a reader about the JUDGE (not the candidate). */
export interface RunnerCodeFreshness {
  /** `stale` ⇒ the runner's own code was committed AFTER this run's process booted, so the run
   *  cannot be executing it. `fresh` ⇒ the runner booted at or after its last code commit.
   *  `unknown` ⇒ one of the two instants is missing — never collapse this to `fresh`. */
  verdict: 'stale' | 'fresh' | 'unknown';
  /** Ready to surface verbatim; on `stale` it carries the operative warning, not just the fact. */
  note: string;
  /** How far the runner's code moved past its own process boot. Positive only when `stale`. */
  behindByMs: number | null;
  runnerBootedAtMs: number | null;
  runnerCodeCommittedAtMs: number | null;
}

/**
 * PURE. Is this run's verdict even CAPABLE of reflecting the runner code currently in the tree?
 *
 * The question this exists to kill: a gate stays red after a correct fix to green-checkpoint.ts
 * lands, and every available signal points at the fix — the marker shows the run refiring onto
 * newer and newer candidates, the fix is committed, the tests pass — so the natural reading is
 * "the fix did not work" and the natural next move is to re-fix an already-correct guard. The
 * actual mechanism is that the auto-refire recurses IN-PROCESS: the candidate advances, the
 * runner's module graph cannot, because Node loaded it at boot. A run that booted before the fix
 * commit will keep producing pre-fix verdicts until it ends, and the NEXT run — a fresh process —
 * picks the fix up on its own. Nothing is broken; the verdict is just older than it looks.
 *
 * Deliberately takes the runner's last-commit instant as an ARGUMENT rather than shelling out to
 * git: this stays pure and unit-testable, and the caller already knows which runner file it cares
 * about (`TZ=UTC git log -1 --format=%cI -- apps/operator/lib/release/green-checkpoint.ts`).
 *
 * ⚠ A missing input yields `unknown`, never `fresh` — an unstamped marker (written before
 * WI-38224) must not read as a positive freshness claim.
 */
export function describeRunnerCodeFreshness(
  marker: Pick<StoredInFlightRetriage, 'runnerBootedAtMs'> | null | undefined,
  runnerCodeCommittedAtMs: number | null | undefined,
): RunnerCodeFreshness {
  const bootedAt = typeof marker?.runnerBootedAtMs === 'number' ? marker.runnerBootedAtMs : null;
  const committedAt = typeof runnerCodeCommittedAtMs === 'number' ? runnerCodeCommittedAtMs : null;
  if (bootedAt == null || committedAt == null) {
    const missing = bootedAt == null ? 'the marker carries no runnerBootedAtMs (written before WI-38224, or by a path that does not stamp it)' : 'no runner-code commit instant was supplied';
    return {
      verdict: 'unknown',
      note: `Runner-code freshness UNKNOWN — ${missing}. Do NOT read this as fresh: an unstamped run may still be executing gate code older than the tree's.`,
      behindByMs: null,
      runnerBootedAtMs: bootedAt,
      runnerCodeCommittedAtMs: committedAt,
    };
  }
  if (committedAt > bootedAt) {
    const behindByMs = committedAt - bootedAt;
    const mins = Math.max(1, Math.round(behindByMs / 60_000));
    return {
      verdict: 'stale',
      note:
        `⚠ RUNNER CODE IS STALE — this run's process booted ${new Date(bootedAt).toISOString()}, but the gate runner's own code was last committed ${new Date(committedAt).toISOString()} (${mins}m later). ` +
        `The auto-refire recurses IN-PROCESS, so every refire in this run executes the runner code the process booted with: a fix committed after boot CANNOT take effect here, however many newer candidates it re-cuts onto. ` +
        `Read this run's verdict as coming from PRE-FIX runner code — it is NOT evidence the fix failed, and re-fixing the guard is the wrong move. The next run is a fresh process and picks the fix up on its own.`,
      behindByMs,
      runnerBootedAtMs: bootedAt,
      runnerCodeCommittedAtMs: committedAt,
    };
  }
  return {
    verdict: 'fresh',
    note: `Runner code is fresh — the process booted ${new Date(bootedAt).toISOString()}, at or after its own last code commit ${new Date(committedAt).toISOString()}, so this run's verdict reflects the runner code in the tree.`,
    behindByMs: null,
    runnerBootedAtMs: bootedAt,
    runnerCodeCommittedAtMs: committedAt,
  };
}

/** What {@link describeRefireBudget} tells a reader about how much rescue budget a live refire has. */
export interface RefireBudget {
  /** Human-readable, naming EVERY bound that is known — never the charged counter alone. */
  label: string;
  /**
   * No further refire is possible: the NEXT red STICKS and a human lever starts to matter.
   * True when EITHER bound is exhausted, which is the whole point — a run whose rescues all
   * SUCCEED holds `refireAttempt` at 0 forever while `totalRefires` climbs to the ceiling, so
   * `refireAttempt >= maxRefires` alone reports budget remaining when there is none.
   */
  atCap: boolean;
}

/**
 * PURE: state a live refire's remaining budget in the producer's own vocabulary
 * (green-checkpoint.ts's `refireBlockedBy`: `charged-budget` | `absolute-ceiling` | `cap-disabled`).
 *
 * Both counters bound the recursion and they advance differently — `refireAttempt` only on a FAILED
 * rescue (`charged`), `totalRefires` on every refire. Reading either alone is wrong in a direction
 * that matters, so this is the ONE place a reader turns the marker into words; `gate-verdict-freshness`
 * and `git-pipeline-position` both call it rather than re-deriving, so their two notes cannot drift
 * apart the way they had by 2026-08-02.
 */
export function describeRefireBudget(marker: Pick<StoredInFlightRetriage, 'refireAttempt' | 'maxRefires' | 'totalRefires' | 'absoluteCeiling'>): RefireBudget {
  const { refireAttempt, maxRefires } = marker;
  const total = typeof marker.totalRefires === 'number' ? marker.totalRefires : null;
  const ceiling = typeof marker.absoluteCeiling === 'number' ? marker.absoluteCeiling : null;
  const chargedSpent = maxRefires > 0 && refireAttempt >= maxRefires;
  const ceilingSpent = total != null && ceiling != null && ceiling > 0 && total >= ceiling;
  const label =
    total != null && ceiling != null
      ? `refire ${total}/${ceiling} performed, charged budget ${refireAttempt}/${maxRefires} spent`
      : `attempt ${refireAttempt}/${maxRefires}`;
  return { label, atCap: maxRefires <= 0 || chargedSpent || ceilingSpent };
}

/** {@link attributeRetriageToRun}'s verdict about WHOSE refire a marker describes. */
export interface RetriageAttribution {
  marker: StoredInFlightRetriage;
  /**
   * Does this marker belong to the run currently holding the lock?
   * `true` — written after that run started, so it is certainly its own.
   * `false` — written BEFORE it started, so it belongs to an earlier run (the gate's run-lock is a
   *   singleton, so an earlier writer is a finished or crashed one). Do NOT present it as this
   *   run's rescue: a marker for an already-superseded red must never silence a genuinely new one.
   * `null` — the run's start time was unreadable, so attribution is UNCONFIRMED. Warn, but say so;
   *   the stand-down advice is cheap and correct either way, the attribution claim is not.
   */
  belongsToRun: boolean | null;
}

/**
 * PURE: decide whether a marker read from `gate_health` describes the run that is in flight RIGHT
 * NOW, by comparing its write stamp against that run's start.
 *
 * Needed because the marker is keyed by HARNESS, not by run: it says "a refire is happening", not
 * "run #1234 is refiring". {@link IN_FLIGHT_RETRIAGE_MAX_AGE_MS} bounds abandonment at 3h, which is
 * far too coarse to answer "is the run I am about to interrupt the one that wrote this?".
 */
export function attributeRetriageToRun(
  marker: StoredInFlightRetriage | null,
  run: { started_at?: string | null } | null | undefined,
): RetriageAttribution | null {
  if (!marker) return null;
  const startedAtMs = run?.started_at ? Date.parse(run.started_at) : NaN;
  if (!Number.isFinite(startedAtMs)) return { marker, belongsToRun: null };
  return { marker, belongsToRun: marker.observedAtMs >= startedAtMs };
}

/**
 * The READ twin of {@link recordInFlightRetriage} — is a stale-candidate auto-refire in flight for
 * this harness's gate RIGHT NOW? Scoped IDENTICALLY to the write (`install_slug` + `target_role`)
 * and parsed through {@link parseInFlightRetriage}, so a reader can never disagree with the writer
 * about where the marker lives or when it is trustworthy.
 *
 * Exists because the highest-harm reader is not a dashboard — it is `release:checkpoint-run`, which
 * an agent fires precisely when the gate "looks stuck", and firing into the re-triage window
 * DISCARDS the rescue and costs a full suite (green-checkpoint.ts's own words). That tool had no
 * cheap way to ask; `readGitPipelineStats` computes the whole pipeline snapshot to get here.
 *
 * Best-effort: any failure answers `null` (= "no refire in flight", the pre-existing behaviour),
 * never an exception into a caller whose real job is launching the gate.
 */
export async function readInFlightRetriage(installSlug?: string): Promise<StoredInFlightRetriage | null> {
  try {
    let slug = installSlug ?? null;
    if (!slug) {
      const { operatorHomeHarnessSlug } = await import('../harness/operator-home-harness');
      slug = operatorHomeHarnessSlug() ?? null;
    }
    if (!slug) return null;
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    const rows = (await sql.unsafe(
      `SELECT metadata->'gate_health'->'inFlightRetriage' AS marker
         FROM harness_shared.routines
        WHERE install_slug = $1 AND target_role = 'system:green-checkpoint'
        LIMIT 1`,
      [slug],
    )) as Array<{ marker: unknown }>;
    return parseInFlightRetriage(rows[0]?.marker);
  } catch {
    return null;
  }
}

/**
 * The runner file whose boot-pinned module graph {@link describeRunnerCodeFreshness} is about.
 * Repo-relative on purpose: the same path resolves in the integration tree and in any checkout a
 * caller hands us, and it is the file whose commit instant the doc-comment above prescribes.
 */
export const GATE_RUNNER_SOURCE_PATH = 'apps/operator/lib/release/green-checkpoint.ts';

/** Injectable seam so {@link readRunnerCodeCommittedAtMs} is testable without a git tree.
 *  Returns raw stdout (a `%ct` epoch-seconds line), or null when the read failed. */
export type GitCommitTimeReader = (root: string, relPath: string) => string | null;

/**
 * The IMPURE half of the runner-freshness read: when was the gate runner's own source last
 * COMMITTED in `root`? Pairs with {@link describeRunnerCodeFreshness}, which stays pure and takes
 * this as an argument.
 *
 * `%ct` (committer date, epoch SECONDS) is the right instant, not author date: git-sync commits a
 * swept tree, so author time can predate the commit that actually put the code where the runner
 * would have loaded it. Scaled to ms so it compares directly against `runnerBootedAtMs`.
 *
 * Best-effort, exactly like {@link readInFlightRetriage}: ANY failure — no git, untracked file,
 * unreadable root — answers `null`, which drives the verdict to `unknown` rather than to a false
 * `fresh`. Never throws into a caller whose real job is something else.
 */
export async function readRunnerCodeCommittedAtMs(
  root?: string | null,
  readCommitTime?: GitCommitTimeReader,
): Promise<number | null> {
  try {
    let repo = root ?? null;
    if (!repo) {
      const { integrationRoot } = await import('../release-deploy-launch');
      repo = integrationRoot();
    }
    if (!repo) return null;
    let raw: string | null;
    if (readCommitTime) {
      raw = readCommitTime(repo, GATE_RUNNER_SOURCE_PATH);
    } else {
      const { spawnSync } = await import('node:child_process');
      const out = spawnSync(
        'git',
        ['-C', repo, 'log', '-1', '--format=%ct', '--', GATE_RUNNER_SOURCE_PATH],
        { encoding: 'utf8', timeout: 5_000 },
      );
      raw = out.status === 0 ? String(out.stdout ?? '') : null;
    }
    const sec = Number(String(raw ?? '').trim());
    return Number.isFinite(sec) && sec > 0 ? sec * 1000 : null;
  } catch {
    return null;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════════
 * main-green-status-visible-2026-09-03 P-009 — THE RE-TRIAGE WINDOW AS A READ.
 *
 * ## The gap this closes (audit entry 21)
 *
 * CLAUDE.md gives this question its own 🚨 alarm block — firing a manual
 * `release:checkpoint-run` inside the re-triage window "discards the rescue and costs a
 * full suite" — and yet, until this cell, the only two ways to LEARN you were inside that
 * window were:
 *
 *   1. attempt the destructive action and read its refusal, or
 *   2. dig `retriageDetail` / `inFlightCandidate` / `verdictlessRefire` out of routine
 *      metadata by hand.
 *
 * Both arrive AFTER the decision to act. A rule whose only enforcement is a refusal you
 * must provoke is not readable in advance, which is exactly why an alarm block was needed
 * for it in the first place. This projection puts the answer on the state plane so it
 * arrives BEFORE the destructive action rather than as its refusal.
 *
 * ## Derivation — one path, no second reading
 *
 * Projected from the ALREADY-MAPPED `gate.checkpointRunInFlight` leg (rung 1 of the
 * derived-truth ladder), never from a second query. That leg has already fused the live
 * run-lock, the cached run reading and this module's own freshness-checked marker; a
 * parallel read here could disagree with the value published one field away, which is the
 * class of defect `judgingShaSource` was filed for.
 *
 * `failingFiles` is the single exception, and it is CARRIED, not re-read: the mapped leg
 * genuinely does not project it, so the raw marker is passed alongside — and consulted
 * ONLY once the mapped leg has established that a refire is in flight, so a stale or
 * unattributed marker can never contribute a file list to a reading that says it is not.
 *
 * ## The tri-state is load-bearing, in the direction that costs a suite
 *
 * `inFlight: null` means BOTH liveness reads failed — never "no refire in flight". A
 * reader that collapses unknown to false gets exactly the destructive green-light this
 * cell exists to withhold, so `standDown` is TRUE on `no-run-reading`: unknown HOLDS you, it
 * does not release you. The stand-down advice is cheap and correct either way (see
 * {@link attributeRetriageToRun}); the claim that nothing is in flight is not.
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * The subset of `gate.checkpointRunInFlight` this projection reads, declared STRUCTURALLY
 * rather than imported from `git-pipeline-position`. That module already imports this one;
 * importing back would close the cycle, and the shape is small enough that restating it is
 * cheaper than the seam. `mapCheckpointRunInFlight`'s return type is assignable to it.
 */
export interface RetriageRunReading {
  active: boolean;
  inRetriageWindow?: true;
  fromCandidate?: string | null;
  candidate?: string | null;
  refireAttempt?: number;
  maxRefires?: number;
  totalRefires?: number;
  absoluteCeiling?: number;
  asOfAgeMs?: number | null;
}

/** Assessment codes for `gate.greenCheckpoint.retriage`. */
export type RetriageCellCode =
  | 'no-run-reading'
  | 'no-run'
  | 'no-refire'
  | 'in-flight'
  | 'in-flight-at-cap';

/** The shape `gate.greenCheckpoint.retriage` publishes. */
export interface RetriageCellProjection {
  code: RetriageCellCode;
  /** True when neither liveness read answered. Hoisted as the cell's unknown. */
  unmeasured: boolean;
  /**
   * THE headline (audit entry 21): is an auto-refire / re-triage in flight RIGHT NOW?
   * `null` = NOT MEASURED. Never read a null here as `false`.
   */
  inFlight: boolean | null;
  /** Is a checkpoint run active at all? `null` = not measured. */
  runActive: boolean | null;
  /**
   * Would firing `release:checkpoint-run` right now be destructive or futile?
   * TRUE on `in-flight*` (it discards a live rescue) AND on `no-run-reading` (unknown holds
   * you). FALSE only when the reading positively says there is nothing to discard.
   */
  standDown: boolean;
  /** The candidate this refire MOVED OFF — a red you are still reasoning about may be its. */
  fromCandidate: string | null;
  /** The newer candidate being re-verified. */
  refiringCandidate: string | null;
  /**
   * The files the ABANDONED red named. Surfaced so a reader does not go fix tests whose
   * verdict this run has already discarded. `null` when no refire is in flight — a measured
   * absence of the subject, not an empty list of files.
   */
  abandonedFailingFiles: string[] | null;
  /** `describeRefireBudget().label` — names EVERY known bound, never the charged counter alone. */
  budgetLabel: string | null;
  /** No further refire is possible: the NEXT red STICKS. `null` when unknown. */
  atCap: boolean | null;
  refireAttempt: number | null;
  maxRefires: number | null;
  totalRefires: number | null;
  absoluteCeiling: number | null;
  /** When the marker was written, and how old that is. Null when there is no marker. */
  observedAtMs: number | null;
  ageMs: number | null;
  /** How stale the underlying cached run reading is, in ms. Null when it carried no stamp. */
  asOfAgeMs: number | null;
  /** One line, ready to quote. Leads with STAND DOWN when it applies. */
  summary: string;
}

/**
 * PURE: the assessment code for a run reading. Split out so the truth table in
 * `cell-assessment-reality.test.ts` exercises the same function the projection does.
 */
export function assessRetriage(run: RetriageRunReading | null | undefined): RetriageCellCode {
  if (run == null) return 'no-run-reading';
  if (run.active !== true) return 'no-run';
  if (run.inRetriageWindow !== true) return 'no-refire';
  // Budget is only knowable once both charged counters are present. A marker carrying
  // neither degrades to plain `in-flight` — STAND DOWN either way, which is the only part
  // of this reading a caller must not get wrong.
  if (typeof run.refireAttempt !== 'number' || typeof run.maxRefires !== 'number') return 'in-flight';
  const { atCap } = describeRefireBudget({
    refireAttempt: run.refireAttempt,
    maxRefires: run.maxRefires,
    ...(typeof run.totalRefires === 'number' ? { totalRefires: run.totalRefires } : {}),
    ...(typeof run.absoluteCeiling === 'number' ? { absoluteCeiling: run.absoluteCeiling } : {}),
  });
  return atCap ? 'in-flight-at-cap' : 'in-flight';
}

/**
 * PURE: project the re-triage reading into the shape `gate.greenCheckpoint.retriage` publishes.
 *
 * Emitted UNCONDITIONALLY — an unmeasured reading yields `code: 'no-run-reading'` with null
 * fields, never a bare `null` in place of the object, for the same two reasons as
 * `projectFreezeDispositionCell`: the cell contract requires the declared assessment path
 * to exist in every live payload, and "I could not measure it" is itself an answer a reader
 * must be able to branch on.
 */
export function projectRetriageCell(
  run: RetriageRunReading | null | undefined,
  marker: StoredInFlightRetriage | null | undefined,
  nowMs: number = Date.now(),
): RetriageCellProjection {
  const code = assessRetriage(run);
  const inFlight = code === 'in-flight' || code === 'in-flight-at-cap';
  if (code === 'no-run-reading') {
    return {
      code,
      unmeasured: true,
      inFlight: null,
      runActive: null,
      // Unknown HOLDS you. See the module note above: collapsing this to false is the
      // destructive green-light this cell exists to withhold.
      standDown: true,
      fromCandidate: null,
      refiringCandidate: null,
      abandonedFailingFiles: null,
      budgetLabel: null,
      atCap: null,
      refireAttempt: null,
      maxRefires: null,
      totalRefires: null,
      absoluteCeiling: null,
      observedAtMs: null,
      ageMs: null,
      asOfAgeMs: null,
      summary:
        'Re-triage status NOT MEASURED — neither the run lock nor the cached run reading answered. ' +
        'This is NOT "no refire in flight". Do not fire release:checkpoint-run on this reading.',
    };
  }
  const r = run!;
  const asOfAgeMs = typeof r.asOfAgeMs === 'number' ? r.asOfAgeMs : null;
  if (!inFlight) {
    return {
      code,
      unmeasured: false,
      inFlight: false,
      runActive: r.active === true,
      standDown: false,
      fromCandidate: null,
      refiringCandidate: null,
      abandonedFailingFiles: null,
      budgetLabel: null,
      atCap: null,
      refireAttempt: null,
      maxRefires: null,
      totalRefires: null,
      absoluteCeiling: null,
      observedAtMs: null,
      ageMs: null,
      asOfAgeMs,
      summary:
        code === 'no-run'
          ? 'No checkpoint run is active, so no auto-refire can be in flight. Nothing to stand down for.'
          : 'A checkpoint run is active but NO auto-refire is in flight — no rescue to discard. ' +
            'A manual release:checkpoint-run would still collide with the running one (already_running).',
    };
  }
  // In flight. The mapped leg is authoritative for every field it carries; the raw marker
  // contributes only what that leg does not project, and only now that in-flight is settled.
  const refireAttempt = typeof r.refireAttempt === 'number' ? r.refireAttempt : null;
  const maxRefires = typeof r.maxRefires === 'number' ? r.maxRefires : null;
  const totalRefires = typeof r.totalRefires === 'number' ? r.totalRefires : null;
  const absoluteCeiling = typeof r.absoluteCeiling === 'number' ? r.absoluteCeiling : null;
  const budget =
    refireAttempt !== null && maxRefires !== null
      ? describeRefireBudget({
          refireAttempt,
          maxRefires,
          ...(totalRefires !== null ? { totalRefires } : {}),
          ...(absoluteCeiling !== null ? { absoluteCeiling } : {}),
        })
      : null;
  const observedAtMs = typeof marker?.observedAtMs === 'number' ? marker.observedAtMs : null;
  const fromCandidate = r.fromCandidate ?? null;
  const refiringCandidate = r.candidate ?? null;
  const files = marker?.failingFiles ?? [];
  return {
    code,
    unmeasured: false,
    inFlight: true,
    runActive: true,
    standDown: true,
    fromCandidate,
    refiringCandidate,
    abandonedFailingFiles: files,
    budgetLabel: budget?.label ?? null,
    atCap: budget ? budget.atCap : null,
    refireAttempt,
    maxRefires,
    totalRefires,
    absoluteCeiling,
    observedAtMs,
    ageMs: observedAtMs === null ? null : Math.max(0, nowMs - observedAtMs),
    asOfAgeMs,
    summary:
      `🚨 AUTO-REFIRE IN FLIGHT — STAND DOWN. This run has moved off ${fromCandidate ?? 'an earlier candidate'} ` +
      `and is re-verifying ${refiringCandidate ?? 'a newer candidate'}` +
      (budget ? ` (${budget.label})` : '') +
      '. Firing release:checkpoint-run now DISCARDS the rescue and costs a full suite. ' +
      (files.length > 0
        ? `The abandoned red named ${files.join(', ')} — do NOT go fix those on its account. `
        : '') +
      (code === 'in-flight-at-cap'
        ? 'Budget is SPENT: the next red sticks, and a human lever starts to matter.'
        : 'Wait for it to land a verdict.'),
  };
}
