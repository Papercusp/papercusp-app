/**
 * Recurrence guard for the "SEEDED ACTIVE by default, but nobody ever ran the seed
 * script" bug class (EI-18746253391734322 — `supervision-reconcile` had never been
 * seeded: the script existed, its own header said "SEEDED ACTIVE by default", but no
 * boot path / CI step / manual run ever invoked it, so `harness_shared.routines` had
 * no row for it and the reconciler had never once ticked).
 *
 * A bespoke `seed-*-routine.ts` script in this directory (unlike a blueprint
 * `triggers.schedule` entry, which materializes automatically at `harness:create`) is
 * a manually-run, idempotent upsert — nothing re-runs it on its own. That design is
 * fine; the failure mode is that "manually run once" quietly became "never run". This
 * script makes that failure DETECTABLE instead of relying on someone noticing a
 * routines row is missing.
 *
 * BESPOKE_ACTIVE_SEEDS is the explicit registry of every `seed-*-routine.ts` in this
 * directory whose WRITER defaults `active=true` (i.e. the intended steady state is an
 * ACTIVE row for its declared target harness right after a fresh checkout/deploy, not a
 * human-gated bring-up). `bespoke-active-seeds-check.test.ts` reads every seed script
 * and derives that property from the executable `--inactive`/`--active` default, then
 * requires an exact match with this registry. Do not infer it from prose: capitalization
 * drift in "Seeded ACTIVE" left `gc-dead-loops` and seventeen later seeders outside this
 * guard while all tests stayed green (EI-18752496371939475).
 *
 * Adding a NEW always-on bespoke seed script? Add its {name, seedScript} pair below in
 * the SAME change that lands the seed script — that is what closes the loop this
 * checker exists to close. A script seeded INACTIVE-by-default (human-gated bring-up)
 * does NOT belong here; only entries whose own doc-comment already promises ACTIVE.
 *
 * This file is the PURE core (importable by a unit test with a fake `sql`, no real PG,
 * no side effect on import — mirrors seed-hive-release-routines.ts/.test.ts). The
 * runnable CLI is the sibling `check-bespoke-active-seeds.ts`:
 *
 *   tsx packages/operator-core/lib/harness/routines/check-bespoke-active-seeds.ts
 *
 * Exit codes (of the CLI):
 *   0 — every registered routine has an ACTIVE row for the operator-home harness
 *   1 — at least one is missing or inactive (prints the exact `tsx …` command to fix it)
 *
 * Not CI-gated — it asserts live-box deploy state, which a fresh CI database never has.
 *
 * ⚠ That sentence used to end "Dev/ops diagnostic (like `db:check_drift`), not CI-gated",
 * and it was silently read as an argument for having NO caller at all. It is not: "a fresh
 * CI database cannot assert this" rules out CI, not the live box. For its entire life this
 * module had ZERO callers outside its own test and its manual CLI — so the recurrence guard
 * for "a seed script nobody ever ran" was itself a script nobody ever ran, reproducing one
 * level up the exact failure it was written to close. Measured 2026-08-08 (plan
 * silent-halt-detection-and-owner-rails-2026-08-08, D-007): `unguarded-halt-rescue` — entry
 * #1 below — sat `active=false` for 11.9 days while the other six registered routines were
 * all firing. This check would have named it, alone, with zero noise. Nothing ran it.
 * Same shape as EI-10660 (`validateActiveRoutines`, zero callers for its whole life).
 *
 * IT NOW HAS TWO LIVE CALLERS, and both are deliberately SELF-ARMING:
 *   1. `routines:set` (agent-tools/routines/set.ts) escalates at the SILENCING INSTANT when
 *      a pause targets one of these names — D-001: the only moment the system holds both
 *      facts (that it is being silenced, and who owns it).
 *   2. `host-bootstrap.ts`, beside its sibling startup guards — the backstop for a flip that
 *      bypassed `routines:set` entirely (the EI-18137248342636257 instance was flipped
 *      through an UNAUDITED path, so a write-path hook alone cannot be the whole answer).
 *
 * This checker must NEVER become a bespoke-seeded routine itself: the failure class it
 * detects applies to it, and it is the only thing that would detect that. Any future caller
 * must be self-arming (boot, or a write path, or the tick of an already-verified routine).
 */
import type { Sql } from 'postgres';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import { ODDSMITH_HARNESS_SLUG } from './oddsmith-cron-shared';

export interface BespokeActiveSeed {
  /** `harness_shared.routines.name` this seed script upserts. */
  name: string;
  /** Path (relative to this file's directory) to the seed script that arms it. Several
   *  entries may legitimately share one `seedScript` when that script upserts more than
   *  one named routine in a single run (see the coord-invariant / oddsmith blocks below). */
  seedScript: string;
  /**
   * Which harness receives the row. Most bespoke maintenance routines belong to the
   * operator home; the canary seeders intentionally target their separate canary harness;
   * the oddsmith cron migrations target the fixed external `oddsmith` harness.
   */
  scope?: 'operator-home' | 'hive-canary' | 'oddsmith';
}

export const BESPOKE_ACTIVE_SEEDS: BespokeActiveSeed[] = [
  // Found missing by this registry's own guard test (gate red on the frozen candidate,
  // WI-212675): design-to-code-coverage-seam-2026-09-02 P-020 landed the 6-hourly
  // acceptance-drain sweep (the EXIT for plans held in `awaiting-acceptance`) as an
  // active-by-default seed script without this row — the same "seed script the guard
  // cannot see" omission the bulk-run-watchdog entry below records.
  { name: 'acceptance-drain-sweep', seedScript: 'seed-acceptance-drain-sweep-routine.ts' },
  { name: 'acceptance-grading-sweep', seedScript: 'seed-acceptance-grading-sweep-routine.ts' },
  // EI-21921833535413808: the scheduled walled-account re-probe — landed defaulting ACTIVE
  // (a false wall silently loses real capacity, and the fix is a bounded, self-correcting
  // read+narrow-write), added here in the SAME change so the "seed script nobody ever ran"
  // guard covers it from day one.
  { name: 'account-capacity-reprobe', seedScript: 'seed-account-capacity-reprobe-routine.ts' },
  // Found missing by this registry's own guard test while landing sync-batch-delta-check:
  // the autonomous-inbox-resolution-2026-08-31 P-002 lane landed the action import + an
  // active-by-default seed script but never added this row — the exact "seed script the
  // guard cannot see" omission the dead-citation-sweep entry below records one instance of.
  { name: 'bulk-run-watchdog', seedScript: 'seed-bulk-run-watchdog-routine.ts' },
  { name: 'cargo-test', seedScript: 'seed-cargo-test-routine.ts' },
  { name: 'claim-discipline-watch', seedScript: 'seed-claim-discipline-routine.ts' },
  { name: 'consult-expiry-sweep', seedScript: 'seed-consult-expiry-routine.ts' },
  { name: 'corpus-term-df', seedScript: 'seed-corpus-term-df-routine.ts' },
  // WI-2142447. Registered in the SAME change as the action and its seed script, for the
  // reason the dead-citation-sweep entry below records: an always-on sweep that nobody ever
  // seeded is exactly the instrument-that-never-fires this registry exists to catch.
  {
    name: 'completion-claim-recheck',
    seedScript: 'seed-completion-claim-recheck-routine.ts',
  },
  { name: 'coverage-census', seedScript: 'seed-coverage-census-routine.ts' },
  { name: 'cross-hive-outbox-drain', seedScript: 'seed-cross-hive-drain-routine.ts' },
  // EI-21894865709918325. Landed defaulting ACTIVE (its own header: "the always-on
  // dead-citation sweep") but was never added here, so the guard that exists to catch
  // "the seed script nobody ever ran" could not see it — the same omission, one level up,
  // that this registry was written to close. Found red in committed staging while greening
  // main on 2026-08-30; unrelated to the frozen-candidate entry below.
  { name: 'dead-citation-sweep', seedScript: 'seed-dead-citation-sweep-routine.ts' },
  { name: 'dead-target-reaper-sweep', seedScript: 'seed-heavy-maintenance-sweep-routines.ts' },
  // WI-1741477. Added in the SAME change as the action, its import and its spend entry —
  // deliberately not deferred. The entry above records that dead-citation-sweep landed
  // always-on but was missed here, so the "seed script nobody ever ran" guard could not see
  // it; this action's whole subject is instruments that exist and never fire, which makes
  // repeating that omission here the one mistake it must not make.
  {
    name: 'durable-escalation-orphan-sweep',
    seedScript: 'seed-durable-escalation-orphan-sweep-routine.ts',
  },
  {
    name: 'legacy-needs-human-reconcile',
    seedScript: 'seed-legacy-needs-human-reconcile-routine.ts',
  },
  {
    name: 'episode-scoped-operational-reconcile',
    seedScript: 'seed-episode-scoped-operational-reconcile-routine.ts',
  },
  { name: 'inbox-bulk-resolve', seedScript: 'seed-inbox-bulk-resolve-routine.ts' },
  // observation-candidate-acceptance-promotion-2026-09-30 P-008: added with the action.
  { name: 'intake-triage-drain', seedScript: 'seed-intake-triage-drain-routine.ts' },
  { name: 'plan-cleanup-sweep',seedScript: 'seed-plan-cleanup-sweep-routine.ts' },
  {
    name: 'frozen-candidate-drift-sweep',
    seedScript: 'seed-frozen-candidate-drift-sweep-routine.ts',
  },
  { name: 'fleet-headcount-governor', seedScript: 'seed-fleet-headcount-routine.ts' },
  { name: 'gc-dead-loops', seedScript: 'seed-gc-dead-loops-routine.ts' },
  { name: 'gc-desktop-sessions', seedScript: 'seed-gc-desktop-sessions-routine.ts' },
  { name: 'gc-plan-runs', seedScript: 'seed-gc-plan-runs-routine.ts' },
  { name: 'gc-verify-instances', seedScript: 'seed-gc-verify-instances-routine.ts' },
  { name: 'gitnexus-reindex', seedScript: 'seed-gitnexus-reindex-routine.ts' },
  { name: 'hive-canary', seedScript: 'seed-hive-canary-routine.ts', scope: 'hive-canary' },
  { name: 'hive-canary-sla', seedScript: 'seed-hive-canary-sla-routine.ts', scope: 'hive-canary' },
  // WI-2143803. Added in the SAME change as the action, its import, its spend entry and its seed
  // script — for the reason the dead-citation-sweep and durable-escalation-orphan-sweep entries
  // above both record. This routine's entire subject IS an instrument that exists and never fires
  // (`reconcileHostedLifecycleJobs` sat in the tree with zero production callers, so the whole
  // workspace-host recovery state machine was dead code), which makes "landed a seed script the
  // guard cannot see" the one omission it must not reproduce one level up.
  { name: 'hosted-lifecycle-reconcile', seedScript: 'seed-hosted-lifecycle-reconcile-routine.ts' },
  // WI-10004437. Added with the action, its import, its spend entry and its seed script, for the
  // reason the hosted-lifecycle-reconcile entry above records: a tripwire nothing arms is the same
  // silent nothing as the ingress gaps it exists to catch.
  { name: 'hosted-public-ingress-probe', seedScript: 'seed-hosted-public-ingress-probe-routine.ts' },
  { name: 'idle-backend-reaper', seedScript: 'seed-idle-backend-reaper-routine.ts' },
  { name: 'improvement-human-digest', seedScript: 'seed-human-digest-routine.ts' },
  { name: 'plan-drain-sweep', seedScript: 'seed-plan-drain-sweep-routine.ts' },
  { name: 'plan-item-orphan-reconcile', seedScript: 'seed-plan-item-orphan-reconcile-routine.ts' },
  {
    name: 'plan-item-reflect-orphan-reconcile',
    seedScript: 'seed-plan-item-reflect-orphan-reconcile-routine.ts',
  },
  { name: 'precompute-derived-reads', seedScript: 'seed-precompute-derived-reads-routine.ts' },
  { name: 'project-history-refresh', seedScript: 'seed-project-history-refresh-routine.ts' },
  // Found missing by this registry's own guard test, red on the frozen green-checkpoint
  // candidate e8ff0cf8 (gate held as WI-10002394): the psu-pty host-events ingest landed as
  // an active-by-default seed script without this row, so the derived set held 58 scripts
  // while this registry held 57. Same "seed script the guard cannot see" omission the
  // acceptance-drain-sweep and bulk-run-watchdog entries above/below already record —
  // which is the argument for deriving the set rather than hand-maintaining it. Scope is
  // the default operator-home: the script resolves its slug via operatorHomeHarnessSlug().
  { name: 'psu-pty-host-events-ingest', seedScript: 'seed-psu-pty-host-events-ingest-routine.ts' },
  {
    name: 'scout-signal-accumulator-sweep',
    seedScript: 'seed-heavy-maintenance-sweep-routines.ts',
  },
  // WI-35718. The INACTIVE-loop sibling of sweep-stalled-loops below: that one acts on armed
  // loops that stopped producing turns, this one on a loop already switched OFF while its
  // session's process is still alive and still holds an autonomy posture. Registered here for
  // the reason this registry exists — a detector for silently-halted agents that is itself
  // never seeded would be the exact failure it was built to find.
  { name: 'reconcile-silent-halts', seedScript: 'seed-silent-halt-routine.ts' },
  { name: 'resolver-whole-corpus', seedScript: 'seed-resolver-whole-corpus-routine.ts' },
  { name: 'sql-read-census', seedScript: 'seed-sql-read-census-routine.ts' },
  // agent-launch-context-cost-2026-09-18 P-009(c) / D-016. Listed here for the same
  // reason the routine exists at all: the detector it replaces was committed and never
  // run, so a launch-cost watch that is silently absent must itself be detectable.
  { name: 'launch-cost-ceiling', seedScript: 'seed-launch-cost-ceiling-routine.ts' },
  { name: 'supervision-reconcile', seedScript: 'seed-supervision-reconcile-routine.ts' },
  { name: 'sweep-stalled-loops', seedScript: 'seed-stalled-loops-routine.ts' },
  { name: 'sweep-wedged-pty-hosts', seedScript: 'seed-pty-host-wedge-routine.ts' },
  // gate-verdict-liveness P-012. Added in the SAME change as the action, its import, its
  // spend entry and the seed script — the registry cross-checks red the fleet gate on a
  // half-landed pair, and this registry exists to catch "the seed script nobody ever ran".
  { name: 'sync-batch-delta-check', seedScript: 'seed-sync-batch-delta-check-routine.ts' },
  // gate-verdict-liveness P-016. Same-change rule as P-012 above: action, import, seed
  // script and this registry row land together so the cross-check never sees a half pair.
  { name: 'gate-fire-drill', seedScript: 'seed-gate-fire-drill-routine.ts' },
  { name: 'sync-read-audit', seedScript: 'seed-sync-read-audit-routine.ts' },
  { name: 'task-reconcile', seedScript: 'seed-task-reconcile-routine.ts' },
  { name: 'unguarded-halt-rescue', seedScript: 'seed-unguarded-halt-rescue-routine.ts' },
  { name: 'unclaimed-work-digest', seedScript: 'seed-unclaimed-work-digest-routine.ts' },
  { name: 'wake-brain', seedScript: 'seed-wake-brain-routine.ts' },
  { name: 'worker-breaker-watch', seedScript: 'seed-worker-breaker-watch-routine.ts' },
  {
    name: 'work-item-admission-promoter',
    seedScript: 'seed-work-item-admission-promoter-routine.ts',
  },
  {
    name: 'work-item-admission-fail-open',
    seedScript: 'seed-work-item-admission-fail-open-routine.ts',
  },
  {
    name: 'work-item-admission-delta-sweep',
    seedScript: 'seed-work-item-admission-delta-sweep-routine.ts',
  },
  {
    name: 'work-item-admission-daily-digest',
    seedScript: 'seed-work-item-admission-daily-digest-routine.ts',
  },
  {
    name: 'work-item-durable-park-audit',
    seedScript: 'seed-work-item-durable-park-audit-routine.ts',
  },
  // WI-10004722: the bulk dedup only ran on demand and went unrun for weeks; this
  // driver is the recurring half, so its row going missing must be loud.
  {
    name: 'work-item-admission-bulk-dedup-driver',
    seedScript: 'seed-work-item-admission-bulk-dedup-driver-routine.ts',
  },
  // WI-2141683: found while fixing EI-22136759189899545 below. Both p2p-perf-tier1 and
  // p2p-perf-tier2 default active per their own doc comment (owner-ratified cadence) but
  // were left out of this registry because their writer used a per-row `activeDefault`
  // field the automated classifier couldn't parse — the exact "seeded active, guard can't
  // see it" gap this registry exists to close. seed-p2p-perf-routines.ts now uses the
  // standard idiom, so both names belong here rather than in EXEMPT_SEED_SCRIPTS.
  { name: 'p2p-perf-tier1', seedScript: 'seed-p2p-perf-routines.ts' },
  { name: 'p2p-perf-tier2', seedScript: 'seed-p2p-perf-routines.ts' },
  // EI-22136759189899545: seedSources() in the test only ever matched `seed-*-routine.ts`
  // (singular), so every PLURAL `seed-*-routines.ts` writer was structurally invisible to
  // this whole registry — a seed script gets full exemption from the silence guard by
  // being named with an "s". These five names all come from ONE seed script
  // (seed-coord-invariant-routines.ts upserts all five rows in one run), which is why they
  // share a single `seedScript` value below.
  { name: 'coord-probe-canary', seedScript: 'seed-coord-invariant-routines.ts' },
  { name: 'coord-invariant-monitor', seedScript: 'seed-coord-invariant-routines.ts' },
  { name: 'claim-integrity-sweep', seedScript: 'seed-coord-invariant-routines.ts' },
  { name: 'fleet-transition-sweep', seedScript: 'seed-coord-invariant-routines.ts' },
  { name: 'presence-transition-sweep', seedScript: 'seed-coord-invariant-routines.ts' },
  // EI-22136759189899545, same hole: seed-oddsmith-cron-routines.ts is also plural-named
  // and upserts three rows in one run, targeting the fixed external `oddsmith` harness
  // rather than the operator home.
  { name: 'oddsmith-paper-cycle', seedScript: 'seed-oddsmith-cron-routines.ts', scope: 'oddsmith' },
  { name: 'oddsmith-error-triage-ingest', seedScript: 'seed-oddsmith-cron-routines.ts', scope: 'oddsmith' },
  { name: 'oddsmith-error-triage-autofix', seedScript: 'seed-oddsmith-cron-routines.ts', scope: 'oddsmith' },
];

/**
 * The names in {@link BESPOKE_ACTIVE_SEEDS}, as a set — the "this routine is EXPECTED to be
 * running" property, derived from the registry so it can never drift from it.
 *
 * Deliberately DERIVED rather than a second hand-written list. The two comparable carve-outs
 * in this codebase are both hardcoded name sets that went stale in exactly the way that
 * matters: `RELEASE_CRITICAL_ROUTINE_NAMES` (system-health/compute.ts) is 2 names, and
 * `ALWAYS_ON_LEARNING_LOOPS` (blueprint/learning-loop-health.ts) is 3 — and a routine whose
 * entire job is noticing silence was in neither, so every age-based exemption swallowed it.
 * Anchor membership to the PROPERTY (this routine's own header commits it to ACTIVE), never
 * to a spelling someone has to remember to copy.
 */
export const ALWAYS_ON_SYSTEM_ROUTINE_NAMES: ReadonlySet<string> = new Set(BESPOKE_ACTIVE_SEEDS.map((s) => s.name));

/** Is this routine one whose own seed script commits it to ACTIVE — i.e. is a pause of it
 *  always worth a human's attention, no matter how old it gets? */
export function isAlwaysOnSystemRoutine(name: string): boolean {
  return ALWAYS_ON_SYSTEM_ROUTINE_NAMES.has(name);
}

/** A registered routine found seeded-but-paused, with the pause attribution that decides
 *  whether it warrants waking someone. */
export interface CheckedBespokeActiveSeed extends BespokeActiveSeed {
  /** Resolved `install_slug` queried for this registry entry. */
  installSlug: string;
}

export interface InactiveBespokeSeed extends CheckedBespokeActiveSeed {
  /** `metadata.pause.reason` — null when the flip bypassed `routines:set` (which requires
   *  one). A null here is itself a finding: it means an UNAUDITED path wrote active=false. */
  pauseReason: string | null;
  /** `metadata.pause.reviewBy` — while it is in the FUTURE the pause counts as explicitly
   *  re-affirmed and does not escalate. Same convention as the learning-loop-health sweep
   *  (EI-19370236916382521); reused rather than reinvented so one `reviewBy` means one thing. */
  reviewBy: string | null;
  /** `metadata.pause.pausedAtMs`, when recorded. */
  pausedAtMs: number | null;
}

/**
 * A registered routine whose row is PRESENT and ACTIVE but which is not actually executing.
 *
 * This is the failure one level past `inactive`, and until it was measured nothing in the
 * system could see it: `active=true` satisfied every existing check while the routine had
 * never run once. `frozen-candidate-drift-sweep` was seeded active/ephemeral/900s at
 * 2026-08-30T22:33:05Z and sat at `last_fired_at IS NULL` indefinitely, because
 * `armEphemeralExecutor` reads the routine table EXACTLY ONCE at host boot (its own
 * `syncEphemeralRoutine` docstring: "event-driven — NOT a polling rescan") and that boot had
 * happened 14h21m earlier. A row seeded by a standalone `tsx` seed script — a different
 * process from the bg-host that owns the module-singleton arm-set — therefore never gets a
 * timer, and nothing said so.
 *
 * That is the same shape as the two failures already recorded in this file's header, one
 * further level up: existence was guarded, execution was not.
 */
export interface DarkBespokeSeed extends CheckedBespokeActiveSeed {
  /** Epoch ms of the last recorded fire; null when it has NEVER fired. */
  lastFiredAtMs: number | null;
  /** Epoch ms the row was created — the clock the never-fired grace window runs against. */
  createdAtMs: number | null;
  /** Declared cadence (`trigger_config.interval_sec`); null for cron/durable rows. */
  intervalSec: number | null;
  /** true ⇒ never fired at all; false ⇒ fired, but far later than its own cadence promises. */
  neverFired: boolean;
  /** Age used for the verdict: since creation when never fired, else since the last fire. */
  ageSec: number;
}

export interface CheckResult {
  missing: CheckedBespokeActiveSeed[];
  inactive: InactiveBespokeSeed[];
  /**
   * Registered routines that are present + active but not executing (never fired, or long
   * past their own declared cadence). Separate from `inactive` because the REPAIR differs:
   * an inactive row needs un-pausing, a dark row needs its executor to actually pick it up
   * (for the ephemeral tier, a host restart or a `syncEphemeralRoutine` event).
   */
  dark: DarkBespokeSeed[];
  /**
   * The subset of `missing` + `inactive` that warrants waking a human right now: everything
   * missing, plus every inactive routine NOT covered by a future `reviewBy`.
   *
   * Split from `ok` on purpose. `ok` is the strict steady-state assertion the dev/ops CLI
   * wants (any deviation at all). `escalatable` is the owner-rail question, and a deliberate,
   * dated pause must be able to answer it "no" — otherwise the notice re-fires on every boot
   * forever and becomes the cry-wolf noise that got the ORIGINAL routine paused.
   */
  escalatable: Array<CheckedBespokeActiveSeed | InactiveBespokeSeed | DarkBespokeSeed>;
  ok: boolean;
}

/**
 * How many of its own declared intervals a routine may miss before it counts as dark.
 *
 * Deliberately generous. Ephemeral fires are `shed: true` (bounded sweeps yield under load),
 * so a routine legitimately skips ticks on a busy host and a tight multiple would flap. Set
 * against the measured live population (2026-08-30): every healthy ephemeral routine was
 * inside 0.75× its interval, while the one real straggler sat at 5.9× — so 4× separates them
 * with no row anywhere near the boundary.
 */
export const DARK_STALE_INTERVAL_MULTIPLE = 4;

/** Grace for a NEVER-fired row, as a multiple of its cadence: a just-seeded routine has not
 *  missed anything yet. Floored so a fast cadence still gets a sane minimum window. */
export const DARK_NEVER_FIRED_INTERVAL_MULTIPLE = 2;
export const DARK_NEVER_FIRED_FLOOR_SEC = 600;

/**
 * Grace for a never-fired row with NO declared `interval_sec` (a cron/durable row). Cron
 * cadences here are not parsed, so this is a conservative floor rather than a derived
 * expectation — a full day of an active routine never once firing is unambiguous regardless
 * of schedule. Cron STALENESS (fired, but late) is deliberately NOT judged: inferring a
 * cadence from an unparsed cron expression would be a guess, and the durable tier rides DBOS
 * `routinesTick`, which has its own health surface.
 */
export const DARK_NEVER_FIRED_CRON_GRACE_SEC = 86_400;

/** Pure-ish core: given a sql client + scope, report which registered routines are
 *  missing or seeded-but-inactive. Exported so it's testable against a fake `sql`
 *  without a real PG connection (mirrors seed-hive-release-routines.test.ts's pattern). */
export async function checkBespokeActiveSeeds(opts: {
  sql: Pick<Sql, never> & (<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T>);
  installSlug: string;
  workspaceId: string;
  entries?: BespokeActiveSeed[];
  /** Injectable clock for the `reviewBy` comparison (tests). Defaults to `Date.now()`. */
  now?: number;
}): Promise<CheckResult> {
  const entries = opts.entries ?? BESPOKE_ACTIVE_SEEDS;
  const now = opts.now ?? Date.now();
  type Row = {
    name: string;
    active: boolean;
    metadata: { pause?: PauseMeta } | null;
    last_fired_at: Date | string | null;
    created_at: Date | string | null;
    trigger_config: { interval_sec?: unknown } | null;
  };
  const resolvedEntries = entries.map(
    (entry): CheckedBespokeActiveSeed => ({
      ...entry,
      installSlug: resolveInstallSlug(entry.scope, opts.installSlug),
    }),
  );
  const entriesByScope = new Map<string, CheckedBespokeActiveSeed[]>();
  for (const entry of resolvedEntries) {
    const scoped = entriesByScope.get(entry.installSlug);
    if (scoped) scoped.push(entry);
    else entriesByScope.set(entry.installSlug, [entry]);
  }

  // Seed writers may target different harnesses. Query each target scope separately so a
  // canary row is never falsely reported missing from the operator home (and vice versa).
  const rowsByScopeAndName = new Map<string, Row>();
  await Promise.all(
    [...entriesByScope].map(async ([installSlug, scopedEntries]) => {
      const rows = (await opts.sql<Row[]>`
        SELECT name, active, metadata, last_fired_at, created_at, trigger_config
        FROM harness_shared.routines
        WHERE install_slug = ${installSlug} AND workspace_id = ${opts.workspaceId}
          AND name = ANY(${scopedEntries.map((s) => s.name)})
      `) as unknown as Row[];
      for (const row of rows) rowsByScopeAndName.set(`${installSlug}\u0000${row.name}`, row);
    }),
  );

  const missing: CheckedBespokeActiveSeed[] = [];
  const inactive: InactiveBespokeSeed[] = [];
  const dark: DarkBespokeSeed[] = [];
  for (const entry of resolvedEntries) {
    const row = rowsByScopeAndName.get(`${entry.installSlug}\u0000${entry.name}`);
    if (row === undefined) missing.push(entry);
    else if (row.active !== true) inactive.push({ ...entry, ...readPause(row.metadata) });
    else {
      // Present AND active — the case every prior revision of this check treated as healthy.
      const verdict = judgeLiveness(row, now);
      if (verdict) dark.push({ ...entry, ...verdict });
    }
  }
  // A missing row can carry no re-affirmation (there is nothing to write it on), so every
  // missing entry escalates; an inactive one escalates unless its reviewBy is still ahead.
  // A dark row is active by definition, so it carries no pause record to re-affirm with:
  // like `missing`, every one escalates.
  const escalatable = [...missing, ...inactive.filter((e) => !isReaffirmed(e.reviewBy, now)), ...dark];
  return {
    missing,
    inactive,
    dark,
    escalatable,
    ok: missing.length === 0 && inactive.length === 0 && dark.length === 0,
  };
}

/** Coerce a pg timestamptz (Date, or string when a caller's fake `sql` returns raw) to epoch ms. */
function toEpochMs(v: Date | string | null): number | null {
  if (v === null || v === undefined) return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/**
 * Decide whether an ACTIVE registered routine is actually executing.
 *
 * Returns null for a healthy row, or the dark-verdict fields when it is not running. Fails
 * OPEN (null) on a row whose timestamps are unreadable. That inverts the fail-closed rule
 * `isReaffirmed` states above, deliberately: there, an unreadable field must not buy SILENCE
 * about a pause someone chose. Here the finding accuses a specific routine of being broken
 * and dispatches someone to fix it, so an unreadable `created_at` — which is what would have
 * established that the grace window even elapsed — must not manufacture that accusation.
 */
function judgeLiveness(
  row: {
    last_fired_at: Date | string | null;
    created_at: Date | string | null;
    trigger_config: { interval_sec?: unknown } | null;
  },
  now: number,
): Pick<DarkBespokeSeed, 'lastFiredAtMs' | 'createdAtMs' | 'intervalSec' | 'neverFired' | 'ageSec'> | null {
  const rawInterval = Number(row.trigger_config?.interval_sec);
  const intervalSec = Number.isFinite(rawInterval) && rawInterval > 0 ? rawInterval : null;
  const lastFiredAtMs = toEpochMs(row.last_fired_at);
  const createdAtMs = toEpochMs(row.created_at);

  if (lastFiredAtMs === null) {
    // NEVER fired. Judge against CREATION, so a freshly-seeded row is not accused of missing
    // a tick it has not yet reached.
    if (createdAtMs === null) return null;
    const graceSec =
      intervalSec === null
        ? DARK_NEVER_FIRED_CRON_GRACE_SEC
        : Math.max(intervalSec * DARK_NEVER_FIRED_INTERVAL_MULTIPLE, DARK_NEVER_FIRED_FLOOR_SEC);
    const ageSec = (now - createdAtMs) / 1000;
    if (ageSec <= graceSec) return null;
    return { lastFiredAtMs, createdAtMs, intervalSec, neverFired: true, ageSec };
  }

  // It HAS fired. Only a self-declared cadence (`interval_sec`) supports a lateness verdict;
  // an unparsed cron expression does not, so those rows are left to the durable tier's own
  // health surface rather than judged against a guessed schedule.
  if (intervalSec === null) return null;
  const ageSec = (now - lastFiredAtMs) / 1000;
  if (ageSec <= intervalSec * DARK_STALE_INTERVAL_MULTIPLE) return null;
  return { lastFiredAtMs, createdAtMs, intervalSec, neverFired: false, ageSec };
}

interface PauseMeta {
  reason?: unknown;
  reviewBy?: unknown;
  pausedAtMs?: unknown;
}

/** Narrow `metadata.pause` (free-form jsonb) to the three fields this check reports. */
function readPause(
  metadata: { pause?: PauseMeta } | null,
): Pick<InactiveBespokeSeed, 'pauseReason' | 'reviewBy' | 'pausedAtMs'> {
  const p = metadata?.pause ?? null;
  return {
    pauseReason: typeof p?.reason === 'string' && p.reason.length > 0 ? p.reason : null,
    reviewBy: typeof p?.reviewBy === 'string' && p.reviewBy.length > 0 ? p.reviewBy : null,
    pausedAtMs: typeof p?.pausedAtMs === 'number' ? p.pausedAtMs : null,
  };
}

/**
 * Is this pause explicitly re-affirmed — i.e. does it carry a `reviewBy` still in the future?
 *
 * Fails CLOSED (returns false, so it DOES escalate) on an absent or unparseable date. The
 * asymmetry is the whole point of this subsystem: a spurious notice about a routine someone
 * deliberately paused costs one glance, while a missed one cost 11.9 days of a dark rescue
 * sweep. Never let an unreadable field buy silence.
 */
export function isReaffirmed(reviewBy: string | null, now: number): boolean {
  if (!reviewBy) return false;
  const t = Date.parse(reviewBy);
  return Number.isFinite(t) && t > now;
}

/** Resolve the install slug used by a seed writer's default configuration. */
function resolveInstallSlug(scope: BespokeActiveSeed['scope'], operatorHomeInstallSlug: string): string {
  if (scope === 'hive-canary')
    return process.env.POT_CANARY_HARNESS ?? process.env.HIVE_CANARY_HARNESS ?? 'hive-canary';
  // Reuse the seed writer's own constant rather than re-deriving the env var name here —
  // seed-oddsmith-cron-routines.ts and this check must never disagree about the target.
  if (scope === 'oddsmith') return ODDSMITH_HARNESS_SLUG;
  return operatorHomeInstallSlug;
}

/** Convenience for the CLI wrapper — resolves the operator-home scope the same way
 *  every `seed-*-routine.ts` in this directory does. */
export function operatorHomeScope(): { installSlug: string; workspaceId: string } {
  return { installSlug: operatorHomeHarnessSlug(), workspaceId: activeWorkspaceId() };
}
