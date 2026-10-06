/**
 * soak-report.ts — a machine-checkable production-readiness gate for a pot.
 *
 * WI-1501 asks for one deterministic verdict over a rolling 12–24h window:
 * READY only when the pot has stayed healthy across the full window, otherwise
 * NOT-READY with concrete failing reasons. The report is DERIVED on demand from
 * existing durable signals (spawn rows, placement ledger, open escalations,
 * pipeline history, ticker health) plus the local bg-host journal for restart /
 * OOM evidence.
 *
 * The two halves mirror the repo's usual pattern:
 *   - pure parsers + verdict logic (`parseBgHostJournal*`, `computeSoakReport`)
 *   - the production edge (`readPotSoakReport`) that stitches PG + journalctl.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { probeBgHostTicker } from '../service-health';
import { activeWorkspaceId } from '../workspace-registry';
import { getOperatorCache } from '../cache/instance';
import { LOOP_WAKE_SOURCE_PREFIX } from '../agent-tools/coordination/inbox-wake';
import { withPgRetry } from '../pg-transient-retry';
import { isTransientPgConnectionError } from '../host-benign-errors';
import {
  countPlaceableFrontier,
  countQuarantinedFrontier,
  isAdmissionStarved,
  resolvePotMembership,
  type FrontierAdmission,
} from './survey';
import { DEFAULT_STALE_RECOVERING_MS, SUMMARY_INACTIVE_UNIT_STATES } from './placement-watchdog';

const execFileAsync = promisify(execFile);

export const DEFAULT_SOAK_WINDOW_HOURS = 24;
export const MIN_SOAK_WINDOW_HOURS = 12;
export const MAX_SOAK_WINDOW_HOURS = 24;
export const DEPLOY_LATENCY_THRESHOLD_MS = 15 * 60_000;

export interface BgHostJournalMetrics {
  oomKillCount: number;
  restartCount: number;
  /** Unit DEATHS (crash / OOM-kill / watchdog / non-zero exit) in the window —
   *  one systemd `Failed with result '…'` line per death. This, not
   *  `restartCount`, is the readiness red criterion [owner 2026-07-13
   *  "red only on crashes"]: a deliberate `systemctl restart` (how deploys
   *  ship routine fixes) is a clean stop+start and emits no failure line. */
  failureCount: number;
  peakMemoryMb: number | null;
  highMemoryPeakCount: number;
  /** null when the journal was read successfully. Otherwise WHY it could not be —
   *  and the counts above are then zero for want of evidence, NOT because the host
   *  was clean. computeSoakReport reds on this: a gate that cannot see restarts
   *  must say so, never silently pass. */
  journalError: string | null;
  /**
   * False when this PLATFORM has no journal at all — no `journalctl` binary, i.e.
   * no systemd (macOS, a bare container, and the SHIPPED desktop app's embedded-PG
   * target). Distinct from `journalError`, which means "there is a journal and we
   * failed to read it" (precompute-derived-sync-reads-2026-07-19 P-005).
   *
   * The distinction is load-bearing. Treating "this OS has no journald" as a read
   * FAILURE reds the readiness gate permanently for every real user of the shipped
   * app -- a gate that can never be green is not a gate. Absent journald we simply
   * have no unit-restart evidence source, so the gate omits that criterion instead
   * of failing on it; every other criterion still applies.
   */
  journalAvailable: boolean;
}

/** The journal lines the parsers below actually look for. They are ALSO handed to
 *  `journalctl --grep` so the fetch only carries matching lines: this host's 24h
 *  user journal is ~400MB, which blew execFile's maxBuffer, rejected the read, and
 *  hit a catch that returned all-zeros — so the OOM/restart/memory criteria silently
 *  reported CLEAN while bg-host had in fact restarted 9 times and peaked at 23.8GB.
 *  Keeping the fetch filter and the parse patterns in one place is what stops the
 *  two from drifting apart again. */
// Accept pre-rename journal input as well as current unit records.
export const BG_HOST_RESTART_PATTERN = 'Started papercu(?:sp|p)-bg-host\\.service';
export const BG_HOST_OOM_PATTERN = 'OOM killer|FatalProcessOutOfMemory|ReportOOMFailure|Out of memory';
export const BG_HOST_MEMORY_PEAK_PATTERN = 'memory peak';
/** systemd writes exactly ONE `Failed with result '<oom-kill|signal|exit-code|
 *  watchdog>'` line per unit death, and none for a requested stop+start — the
 *  one-per-death marker that separates crashes from deliberate deploy restarts. */
export const BG_HOST_FAILURE_PATTERN = 'Failed with result';

export interface RoleTurnSuccess {
  role: 'cup' | 'mug' | 'kettle';
  totalTerminalTurns: number;
  successfulTurns: number;
  successRate: number | null;
}

export interface EscalationBacklogMetrics {
  openNow: number;
  olderOpenCount: number;
  newerOpenCount: number;
  improving: boolean;
}

export interface InfraCurseMetrics {
  placementsSeen: number;
  infraCurses: number;
  rate: number | null;
  recoveringOpen: number;
  staleRecovering: number;
}

export interface DeployLatencyMetrics {
  samples: number;
  meanMs: number | null;
}

/** Mean injected bytes per loop wake above which the P-001 wake diet has regressed
 *  (compaction-continuity-hardening-2026-07-07 P-008). Post-diet live baseline is
 *  ~1.5k chars mean; the pre-diet full-boilerplate-every-wake behavior sat ≥3k. */
export const WAKE_MEAN_CHAR_BUDGET = 3_000;

/** How long after a compaction an error/owner-kick is attributed to it. */
export const POST_COMPACTION_MARKER_WINDOW_MIN = 15;

/** The post-compaction regression markers: a resumed session acting on hallucinated
 *  schema (column/relation-not-found) right after its context was rebuilt. */
export const POST_COMPACTION_ERROR_MARKER_REGEX = 'column .* does not exist|relation .* does not exist|no such column';

/**
 * Context-burn telemetry (P-008): what the coordination layer itself injects into
 * agent contexts, and how often that forces compactions. WORKSPACE-scoped (wake
 * deliveries + compactions key on owner ids, not harness membership), unlike the
 * pot-scoped metrics above. `requestedCompactions` counts session:request-compaction
 * calls — the disciplined path; native auto-compactions leave no durable row (see
 * session-audit.ts's transcript-marker scan for the reconciled count).
 *
 * WI-4958: `loopWakes`/`meanWakeChars`/`maxWakeChars`/`estMeanWakeTokens` are scoped
 * to deliveries whose `source` carries the LOOP_WAKE_SOURCE_PREFIX ('loop:') stamp —
 * i.e. genuine engine-loop kickoffs (loop-fire.ts stamps the FULL rendered wake text,
 * checkpoint + walls + recipe + owner-directives, as the delivery's `summary`). Before
 * this fix the query counted EVERY `coord:inbox-wake:%` delivery regardless of source —
 * including plain peer-to-peer `coord:send` wakes, whose `summary` is a short one-line
 * headline — so the WAKE_MEAN_CHAR_BUDGET gate (intended to catch the P-001 wake-diet
 * regressing) was silently averaging two very different populations together. The
 * `source` column (migration 387) was added for exactly this scoping but never wired
 * in. `nonLoopInboxWakes` keeps the excluded population visible rather than dropping
 * it on the floor.
 */
export interface ContextBurnMetrics {
  /** LOOP-fired coord:inbox-wake deliveries in the window (source LIKE 'loop:%') —
   *  the wake meter's intended population (D-007 / WI-4958). */
  loopWakes: number;
  /** Mean/max `length(summary)` over loopWakes ONLY — see the interface doc. */
  meanWakeChars: number | null;
  maxWakeChars: number | null;
  /** meanWakeChars / 4 — the usual chars-per-token heuristic. */
  estMeanWakeTokens: number | null;
  /** WI-4958: coord:inbox-wake deliveries in the window whose source is NOT a loop
   *  fire (ordinary coord:send / dispatch / handoff wakes) — excluded from the
   *  budget-gated metrics above but counted here so total wake traffic stays visible. */
  nonLoopInboxWakes: number;
  requestedCompactions: number;
  /** Distinct owners that requested a compaction in the window. */
  sessionsCompacting: number;
  compactionsPerSession: number | null;
  /** Failed tool calls matching POST_COMPACTION_ERROR_MARKER_REGEX within
   *  POST_COMPACTION_MARKER_WINDOW_MIN of the same owner's compaction — the
   *  regression metric for compaction-continuity-hardening-2026-07-07. */
  postCompactionErrorMarkers: number;
}

export interface PotSoakReport {
  potSlug: string;
  surveyScope: 'members' | 'workspace';
  surveySlugs: string[];
  windowHours: number;
  generatedAt: string;
  ready: boolean;
  reasons: string[];
  /** Non-failing observations — criteria that did not APPLY on this platform (e.g.
   *  no journald ⇒ no unit-restart evidence source). Distinct from `reasons`, which
   *  are failures: a note never affects `ready` (P-005). */
  notes: string[];
  bgHost: BgHostJournalMetrics & { tickerUp: boolean; tickerNote: string | null };
  roleSuccess: RoleTurnSuccess[];
  infraCurse: InfraCurseMetrics;
  escalationBacklog: EscalationBacklogMetrics;
  gateGreenRatio: { green: number; total: number; ratio: number | null };
  deployLatency: DeployLatencyMetrics;
  contextBurn: ContextBurnMetrics;
  /** The frontier split by the G2 admission gate — what the pot MAY place vs. what
   *  is withheld from it. A pot with `placeable: 0, quarantined: N>0` is DEADLOCKED,
   *  not idle (see the readiness reason below). */
  frontier: FrontierAdmission;
}

export interface PotSoakReportSnapshot {
  hives: PotSoakReport[];
}

export interface SoakReportInput {
  potSlug: string;
  surveyScope: 'members' | 'workspace';
  surveySlugs: string[];
  windowHours: number;
  generatedAtMs: number;
  bgHost: BgHostJournalMetrics & { tickerUp: boolean; tickerNote: string | null };
  roleSuccess: RoleTurnSuccess[];
  infraCurse: InfraCurseMetrics;
  escalationBacklog: EscalationBacklogMetrics;
  gateGreenRatio: { green: number; total: number; ratio: number | null };
  deployLatency: DeployLatencyMetrics;
  contextBurn: ContextBurnMetrics;
  frontier: FrontierAdmission;
}

function clampWindowHours(windowHours?: number): number {
  const n = Math.trunc(windowHours ?? DEFAULT_SOAK_WINDOW_HOURS);
  if (!Number.isFinite(n)) return DEFAULT_SOAK_WINDOW_HOURS;
  return Math.min(Math.max(n, MIN_SOAK_WINDOW_HOURS), MAX_SOAK_WINDOW_HOURS);
}

function parseMemoryPeakMb(line: string): number | null {
  const m = line.match(/,\s*([0-9.]+)G memory peak/i) ?? line.match(/,\s*([0-9.]+)M memory peak/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return /G memory peak/i.test(line) ? Math.round(n * 1024) : Math.round(n);
}

export function parseBgHostUnitJournal(text: string): BgHostJournalMetrics {
  const lines = text.split('\n').filter(Boolean);
  const restartRe = new RegExp(BG_HOST_RESTART_PATTERN, 'i');
  const oomRe = new RegExp(BG_HOST_OOM_PATTERN, 'i');
  const failureRe = new RegExp(BG_HOST_FAILURE_PATTERN, 'i');
  let oomKillCount = 0;
  let restartCount = 0;
  let failureCount = 0;
  let peakMemoryMb: number | null = null;
  let highMemoryPeakCount = 0;
  for (const line of lines) {
    if (restartRe.test(line)) restartCount += 1;
    if (oomRe.test(line)) oomKillCount += 1;
    if (failureRe.test(line)) failureCount += 1;
    const peakMb = parseMemoryPeakMb(line);
    if (peakMb != null) {
      peakMemoryMb = peakMemoryMb == null ? peakMb : Math.max(peakMemoryMb, peakMb);
      if (peakMb >= 3200) highMemoryPeakCount += 1;
    }
  }
  return {
    oomKillCount,
    restartCount,
    failureCount,
    peakMemoryMb,
    highMemoryPeakCount,
    journalError: null,
    journalAvailable: true,
  };
}

export function parseBgHostGlobalJournal(text: string): number {
  const oomRe = new RegExp(BG_HOST_OOM_PATTERN, 'i');
  return text
    .split('\n')
    .filter((line) => /bg-host/i.test(line))
    .filter((line) => oomRe.test(line)).length;
}

export function computeSoakReport(input: SoakReportInput): PotSoakReport {
  const reasons: string[] = [];
  // Non-failing observations: criteria that did not apply on this platform.
  const notes: string[] = [];
  if (!input.bgHost.tickerUp) {
    reasons.push(`bg-host ticker unhealthy${input.bgHost.tickerNote ? `: ${input.bgHost.tickerNote}` : ''}`);
  }
  // No journal ⇒ no OOM/restart evidence either way. Say so and red, rather than let
  // the zeros below read as a clean bill of health the gate never actually verified.
  //
  // But ONLY when this platform HAS a journal (P-005). `journalAvailable: false`
  // means there is no journald here at all — macOS, a container, and the shipped
  // desktop app's embedded-PG target. Reding on that would make the gate
  // permanently, unfixably red for every real user; a gate that can never go green
  // is not a gate. We omit the unit-restart criterion instead, and say so in the
  // report, while every other criterion still applies.
  if (input.bgHost.journalAvailable === false) {
    notes.push('bg-host unit-restart evidence unavailable on this platform (no journald) — criterion omitted');
  } else if (input.bgHost.journalError) {
    reasons.push(`bg-host journal unreadable — OOM/restart evidence unavailable (${input.bgHost.journalError})`);
  }
  if (input.bgHost.oomKillCount > 0) {
    reasons.push(`bg-host OOM evidence in window (${input.bgHost.oomKillCount})`);
  }
  // [owner 2026-07-13] Red only on UNEXPECTED restarts (crash/OOM/watchdog).
  // Deliberate deploy restarts still show in restartCount for visibility, but a
  // clean stop+start is how fixes ship and must not make readiness unsatisfiable.
  if (input.bgHost.failureCount > 0) {
    reasons.push(
      `bg-host FAILED ${input.bgHost.failureCount} time(s) in window (crash/OOM/watchdog — deliberate restarts excluded)`,
    );
  }
  // ADMISSION DEADLOCK — the pot has work and may place NONE of it.
  //
  // This reason exists because the loop had no way to say why it was idle. On
  // 2026-07-13 papercusp's entire placeable pool was 10 federated `feature` items,
  // all quarantined by the G2 gate (remote origin, no `admit` verdict, no trusted
  // author — and NOTHING in production writes that verdict, so nothing would ever
  // clear them). The Mug woke every ~20min, surveyed a frontier of zero, correctly
  // placed nothing, and reported SUCCESS. Five hours, zero cups, every gate green.
  //
  // A zero frontier is only healthy when there is genuinely nothing to do; when work
  // is being WITHHELD it is a deadlock no amount of waiting resolves. Never let the
  // two look the same again.
  if (isAdmissionStarved(input.frontier)) {
    reasons.push(
      `placement DEADLOCKED: 0 placeable, ${input.frontier.quarantined} item(s) quarantined by the admission gate ` +
        `(remote origin, unaudited) — the loop has work it may never place, and no admit path will clear it`,
    );
  }
  if (input.infraCurse.rate == null) {
    reasons.push('no placement evidence for infra-curse rate');
  } else if (input.infraCurse.infraCurses > 0) {
    reasons.push(`infra-attributed curse rate non-zero (${Math.round(input.infraCurse.rate * 100)}%)`);
  }
  if (input.infraCurse.staleRecovering > 0) {
    reasons.push(
      `stale placement recovery exceeds ${Math.round(DEFAULT_STALE_RECOVERING_MS / 3_600_000)}h (${input.infraCurse.staleRecovering})`,
    );
  }
  for (const role of input.roleSuccess) {
    if (role.successRate == null) {
      reasons.push(`no terminal ${role.role} turns in window`);
    } else if (role.successRate < 1) {
      reasons.push(`${role.role} turn success below 100% (${Math.round(role.successRate * 100)}%)`);
    }
  }
  if (input.escalationBacklog.openNow > 0) {
    reasons.push(`open escalation backlog present (${input.escalationBacklog.openNow})`);
    if (!input.escalationBacklog.improving) {
      reasons.push('open escalation backlog is not shrinking');
    }
  }
  if (input.gateGreenRatio.ratio == null) {
    reasons.push('no green-checkpoint evidence in window');
  } else if (input.gateGreenRatio.ratio < 1) {
    reasons.push(`green-checkpoint ratio below 100% (${Math.round(input.gateGreenRatio.ratio * 100)}%)`);
  }
  if (input.deployLatency.meanMs == null) {
    reasons.push('no deploy-latency evidence in window');
  } else if (input.deployLatency.meanMs > DEPLOY_LATENCY_THRESHOLD_MS) {
    reasons.push(`mean deploy latency above ${Math.round(DEPLOY_LATENCY_THRESHOLD_MS / 60_000)}m`);
  }
  // Context burn (P-008) reds only on POSITIVE bad evidence — a window with no loop
  // wakes / no compactions is a quiet system, not missing evidence (unlike roles/gate
  // above, loops and compactions are not required activity for a healthy pot).
  if (input.contextBurn.meanWakeChars != null && input.contextBurn.meanWakeChars > WAKE_MEAN_CHAR_BUDGET) {
    reasons.push(
      `per-wake injected overhead above budget (mean ${input.contextBurn.meanWakeChars} chars > ${WAKE_MEAN_CHAR_BUDGET})`,
    );
  }
  if (input.contextBurn.postCompactionErrorMarkers > 0) {
    reasons.push(`post-compaction error markers in window (${input.contextBurn.postCompactionErrorMarkers})`);
  }

  return {
    potSlug: input.potSlug,
    surveyScope: input.surveyScope,
    surveySlugs: input.surveySlugs,
    windowHours: input.windowHours,
    generatedAt: new Date(input.generatedAtMs).toISOString(),
    ready: reasons.length === 0,
    reasons,
    notes,
    bgHost: input.bgHost,
    roleSuccess: input.roleSuccess,
    infraCurse: input.infraCurse,
    escalationBacklog: input.escalationBacklog,
    gateGreenRatio: input.gateGreenRatio,
    deployLatency: input.deployLatency,
    contextBurn: input.contextBurn,
    frontier: input.frontier,
  };
}

type SpawnAggRow = {
  child_role: 'cup' | 'mug' | 'kettle';
  total_terminal: number;
  successful: number;
};

type CurseAggRow = {
  placements_seen: number;
  infra_curses: number;
  recovering_open: number;
  stale_recovering: number;
};

type EscalationAggRow = {
  open_now: number;
  older_open_count: number;
  newer_open_count: number;
};

type PipelineAggRow = {
  green_total: number;
  green_success: number;
};

type PipelineEventRow = {
  kind: string;
  status: string;
  created_at: string | Date;
};

type WakeBurnAggRow = {
  loop_wakes: number;
  mean_wake_chars: number | null;
  max_wake_chars: number | null;
  non_loop_wakes: number;
};

type CompactionAggRow = {
  compactions: number;
  sessions: number;
  post_markers: number;
};

function toMs(v: string | Date): number {
  return v instanceof Date ? v.getTime() : new Date(v).getTime();
}

/** Serve-stale-and-revalidate the journal scan after this long. The window it
 *  summarises is 12–24h, so minutes of staleness are meaningless — but a page
 *  load paying the scan is not. */
export const BG_HOST_JOURNAL_SOFT_TTL_MS = 5 * 60_000;
/** Force a blocking re-scan after this long. */
export const BG_HOST_JOURNAL_HARD_TTL_MS = 30 * 60_000;
/** Invalidation tag, so a writer can force an eager refresh via the cache ECA. */
export const BG_HOST_JOURNAL_CACHE_TAG = 'bg-host-journal';

/**
 * Cached front door for {@link readBgHostJournalUncached}.
 *
 * WHY (WI-5454 follow-up, measured 2026-07-19): this read is HOST-GLOBAL — it takes
 * only `windowHours`, never a pot slug — but it sat inside `readPotSoakReport`'s
 * per-pot fan-out. With ~12 hives that meant ~24 concurrent `journalctl` scans of a
 * 1.2GB journal per Learnings tab load, for byte-identical results: `learning.soakReport`
 * measured 27.3s and timed out the panel, and because the sync batch endpoint resolves
 * with `Promise.all` it held every OTHER panel's response (rubrics et al) behind it.
 *
 * The shared operator cache fixes both axes at this one seam, with no caller changes:
 *   - SINGLE-FLIGHT collapses the concurrent per-pot fan-out to ONE scan;
 *   - the TTL stops a 12–24h rolling window being recomputed on every page load.
 * A cache failure falls through to a direct read — never a hard dependency.
 */
async function readBgHostJournal(windowHours: number): Promise<BgHostJournalMetrics> {
  try {
    return await getOperatorCache().getOrSet(
      activeWorkspaceId(),
      `bg-host-journal:${windowHours}`,
      () => readBgHostJournalUncached(windowHours),
      {
        softTtlMs: BG_HOST_JOURNAL_SOFT_TTL_MS,
        hardTtlMs: BG_HOST_JOURNAL_HARD_TTL_MS,
        tags: [BG_HOST_JOURNAL_CACHE_TAG],
      },
    );
  } catch {
    return readBgHostJournalUncached(windowHours);
  }
}

/**
 * EI-19937931088042507: journalctl on this box has been measured taking 20-26s
 * even UNIT-SCOPED on a large/near-full journal, and `execFile` has NO default
 * timeout — an unresponsive/slow journal (disk pressure, journal rotation
 * stall) hangs this call indefinitely. That hang is invisible to the caller's
 * `.catch()` (a hang neither resolves nor rejects), so it silently blocks
 * whatever awaits `readPotSoakReport` — measured hanging `pot:status` past its
 * 55s tool ceiling with pot_placements/agent_activity both cheap and fast.
 * Bound the child process explicitly so a slow journal degrades to the
 * existing `journalError` reporting path instead of hanging the caller.
 */
const JOURNALCTL_TIMEOUT_MS = 8_000;

export async function readBgHostJournalUncached(windowHours: number): Promise<BgHostJournalMetrics> {
  const since = `${windowHours} hours ago`;
  // --grep server-side so only candidate lines cross the pipe (~3KB, not ~400MB).
  const base = ['--user', '--since', since, '--no-pager', '--case-sensitive=false'];
  const maxBuffer = 32 * 1024 * 1024;
  try {
    const [unit, global] = await Promise.all([
      execFileAsync(
        'journalctl',
        [
          ...base,
          '-u',
          'papercusp-bg-host.service',
          '--grep',
          [BG_HOST_RESTART_PATTERN, BG_HOST_OOM_PATTERN, BG_HOST_MEMORY_PEAK_PATTERN, BG_HOST_FAILURE_PATTERN].join(
            '|',
          ),
        ],
        { maxBuffer, timeout: JOURNALCTL_TIMEOUT_MS },
      ),
      // MUST stay unit-scoped. Without `-u` this walks EVERY unit in the user
      // journal: measured 25.97s to return 17 bytes on a 1.2GB journal, versus
      // 7.58s for the unit-scoped scan above. Kernel OOM kills land in the SYSTEM
      // journal, not `--user`, so the unscoped walk was paying a full-journal scan
      // for records that cannot appear in it (2026-07-19).
      execFileAsync(
        'journalctl',
        [...base, '-u', 'papercusp-bg-host.service', '--grep', BG_HOST_OOM_PATTERN],
        { maxBuffer, timeout: JOURNALCTL_TIMEOUT_MS },
      ),
    ]);
    const parsed = parseBgHostUnitJournal(unit.stdout);
    return {
      ...parsed,
      oomKillCount: Math.max(parsed.oomKillCount, parseBgHostGlobalJournal(global.stdout)),
    };
  } catch (err) {
    // journalctl exits 1 when --grep matches nothing: that is a genuinely clean
    // window, not a failed read. Anything else (missing binary, no user journal,
    // maxBuffer) leaves the counts UNKNOWN, and journalError makes the gate say so.
    const e = err as { code?: unknown; stdout?: unknown; stderr?: unknown; killed?: unknown; signal?: unknown };
    // A `timeout`-triggered kill has no meaningful exit code (code is null/undefined,
    // killed:true) and its default Node error message doesn't say "timeout" — label
    // it explicitly so journalError reads as a bounded degradation, not a mystery.
    if (e.killed) {
      return {
        oomKillCount: 0,
        restartCount: 0,
        failureCount: 0,
        peakMemoryMb: null,
        highMemoryPeakCount: 0,
        journalError: `journalctl read timed out after ${JOURNALCTL_TIMEOUT_MS}ms (signal ${String(e.signal ?? '?')}) — journal likely slow/large; counts below are UNKNOWN, not clean`,
        journalAvailable: true,
      };
    }
    if (e.code === 1 && !String(e.stderr ?? '').trim()) {
      return {
        oomKillCount: 0,
        restartCount: 0,
        failureCount: 0,
        peakMemoryMb: null,
        highMemoryPeakCount: 0,
        journalError: null,
        journalAvailable: true,
      };
    }
    // PLATFORM CAPABILITY, not a failure (P-005): ENOENT means there is no
    // `journalctl` binary — no systemd. That is the NORMAL state on macOS, in a
    // container, and on the shipped desktop app's embedded-PG target. Reporting it
    // as a read error reds the readiness gate permanently for every such user, so
    // the gate omits the unit-restart criterion instead of failing on it.
    if (e.code === 'ENOENT') {
      return {
        oomKillCount: 0,
        restartCount: 0,
        failureCount: 0,
        peakMemoryMb: null,
        highMemoryPeakCount: 0,
        journalError: null,
        journalAvailable: false,
      };
    }
    const why = String(e.stderr ?? '').trim() || (err as Error)?.message || 'journalctl read failed';
    return {
      oomKillCount: 0,
      restartCount: 0,
      failureCount: 0,
      peakMemoryMb: null,
      highMemoryPeakCount: 0,
      journalError: why.slice(0, 200),
      journalAvailable: true,
    };
  }
}

function roleSuccessRowsToView(rows: SpawnAggRow[]): RoleTurnSuccess[] {
  const byRole = new Map(rows.map((row) => [row.child_role, row]));
  return (['cup', 'mug', 'kettle'] as const).map((role) => {
    const row = byRole.get(role);
    const totalTerminalTurns = Number(row?.total_terminal ?? 0);
    const successfulTurns = Number(row?.successful ?? 0);
    return {
      role,
      totalTerminalTurns,
      successfulTurns,
      successRate: totalTerminalTurns > 0 ? successfulTurns / totalTerminalTurns : null,
    };
  });
}

function computeDeployLatency(rows: PipelineEventRow[]): DeployLatencyMetrics {
  const ordered = rows.slice().sort((a, b) => toMs(a.created_at) - toMs(b.created_at));
  let pendingGreenAt: number | null = null;
  const deltas: number[] = [];
  for (const row of ordered) {
    if (row.kind === 'green_checkpoint' && (row.status === 'advanced' || row.status === 'up-to-date')) {
      pendingGreenAt = toMs(row.created_at);
      continue;
    }
    if (row.kind === 'deploy' && row.status === 'ok' && pendingGreenAt != null) {
      deltas.push(Math.max(0, toMs(row.created_at) - pendingGreenAt));
      pendingGreenAt = null;
    }
  }
  return {
    samples: deltas.length,
    meanMs: deltas.length ? Math.round(deltas.reduce((sum, n) => sum + n, 0) / deltas.length) : null,
  };
}

/**
 * Context-burn telemetry (P-008), extracted (EI-12456) so its one load-bearing
 * subtlety — event_wake_deliveries is a single flat plane pinned to
 * DEFAULT_COORD_WORKSPACE regardless of the firing pot's real workspace, while
 * tool_invocations correctly carries the pot's own workspaceId — is isolated
 * behind a narrow, independently-testable seam instead of buried inside
 * readPotSoakReport's 9-query Promise.all. See the WakeBurnAggRow query's
 * comment below for the full root-cause story (WI-3575 / migration 361).
 */
export async function readContextBurnMetrics(
  sql: Sql,
  opts: { workspaceId: string; windowHours: number },
): Promise<ContextBurnMetrics> {
  const { workspaceId, windowHours } = opts;
  const [wakeBurnRows, compactionRows] = await Promise.all([
    // EI-12456: this table is NOT pot-workspace-scoped — WI-3575 made events:await
    // a single flat plane, so every row lands under DEFAULT_COORD_WORKSPACE
    // ('default') regardless of which pot's loop fired it (see
    // inbox-wake-arm.ts's deprecated `workspaceId` param docs + the same
    // DEFAULT_COORD_WORKSPACE fold-in in issues-engineer.ts). Filtering on this
    // pot's `workspaceId` (activeWorkspaceId(), e.g. 'papercusp-workspace')
    // instead of DEFAULT_COORD_WORKSPACE matched ZERO rows for every non-'default'
    // pot — loop:status showed real fires while this metric silently read
    // 0/null, making the public-readiness context-overhead gate blind.
    // WI-4958: `mean_wake_chars`/`max_wake_chars` are computed FILTERED to
    // source LIKE 'loop:%' (LOOP_WAKE_SOURCE_PREFIX) — genuine engine-loop
    // kickoffs, whose `summary` carries the full rendered wake text
    // (loop-fire.ts's renderLoopWakeText: checkpoint + walls + recipe + owner
    // directives). An ordinary coord:send wake stamps `source` with the
    // sender's ownerId (never the 'loop:' prefix) and its `summary` is a short
    // one-line headline — counting it into the SAME average silently diluted/
    // skewed the WAKE_MEAN_CHAR_BUDGET gate, which the comment on that budget
    // constant has always documented as a per-LOOP-wake measure. `non_loop_wakes`
    // keeps the excluded population visible (never dropped) rather than folding
    // it into a number the field name doesn't claim to represent.
    sql<WakeBurnAggRow[]>`
      SELECT count(*) FILTER (WHERE source LIKE ${LOOP_WAKE_SOURCE_PREFIX + '%'})::int AS loop_wakes,
             round(avg(length(summary)) FILTER (WHERE source LIKE ${LOOP_WAKE_SOURCE_PREFIX + '%'}))::int AS mean_wake_chars,
             max(length(summary)) FILTER (WHERE source LIKE ${LOOP_WAKE_SOURCE_PREFIX + '%'})::int AS max_wake_chars,
             count(*) FILTER (WHERE source IS DISTINCT FROM NULL AND source NOT LIKE ${LOOP_WAKE_SOURCE_PREFIX + '%'})::int AS non_loop_wakes
        FROM harness_shared.event_wake_deliveries
       WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE}
         AND event_key LIKE 'coord:inbox-wake:%'
         AND created_at >= now() - make_interval(hours => ${windowHours})
    `,
    // Requested compactions per owner + the post-compaction error markers: failed
    // calls matching the hallucinated-schema class within the attribution window
    // of the SAME owner's compaction. tool_invocations DOES carry the real
    // workspaceId correctly (unlike event_wake_deliveries above) — no fold-in
    // needed here.
    sql<CompactionAggRow[]>`
      WITH compactions AS (
        SELECT coord_owner_id AS owner, invoked_at
          FROM harness_shared.tool_invocations
         WHERE workspace_id = ${workspaceId}
           AND tool_name = 'session:request-compaction'
           AND status = 'ok'
           AND invoked_at >= now() - make_interval(hours => ${windowHours})
      )
      SELECT (SELECT count(*) FROM compactions)::int AS compactions,
             (SELECT count(DISTINCT owner) FROM compactions WHERE owner IS NOT NULL)::int AS sessions,
             (SELECT count(*)
                FROM harness_shared.tool_invocations ti
               WHERE ti.workspace_id = ${workspaceId}
                 AND ti.invoked_at >= now() - make_interval(hours => ${windowHours})
                 AND ti.status <> 'ok'
                 AND ti.error_message ~* ${POST_COMPACTION_ERROR_MARKER_REGEX}
                 AND EXISTS (
                   SELECT 1
                     FROM compactions c
                    WHERE c.owner IS NOT NULL
                      AND c.owner = ti.coord_owner_id
                      AND ti.invoked_at >= c.invoked_at
                      AND ti.invoked_at < c.invoked_at + make_interval(mins => ${POST_COMPACTION_MARKER_WINDOW_MIN})
                 ))::int AS post_markers
    `,
  ]);

  const wakeBurn = wakeBurnRows[0] ?? { loop_wakes: 0, mean_wake_chars: null, max_wake_chars: null, non_loop_wakes: 0 };
  const compaction = compactionRows[0] ?? { compactions: 0, sessions: 0, post_markers: 0 };
  const meanWakeChars = wakeBurn.mean_wake_chars != null ? Number(wakeBurn.mean_wake_chars) : null;
  const sessionsCompacting = Number(compaction.sessions ?? 0);

  return {
    loopWakes: Number(wakeBurn.loop_wakes ?? 0),
    meanWakeChars,
    maxWakeChars: wakeBurn.max_wake_chars != null ? Number(wakeBurn.max_wake_chars) : null,
    estMeanWakeTokens: meanWakeChars != null ? Math.round(meanWakeChars / 4) : null,
    nonLoopInboxWakes: Number(wakeBurn.non_loop_wakes ?? 0),
    requestedCompactions: Number(compaction.compactions ?? 0),
    sessionsCompacting,
    compactionsPerSession: sessionsCompacting > 0 ? Number(compaction.compactions ?? 0) / sessionsCompacting : null,
    postCompactionErrorMarkers: Number(compaction.post_markers ?? 0),
  };
}

export async function readPotSoakReport(
  potSlug: string,
  opts: { windowHours?: number; sql?: Sql } = {},
): Promise<PotSoakReport> {
  const windowHours = clampWindowHours(opts.windowHours);
  const sql = opts.sql ?? getOrgPg().sql;
  const workspaceId = activeWorkspaceId();
  const membership = await resolvePotMembership(workspaceId, potSlug);
  const surveySlugs = membership.surveySlugs.length > 0 ? membership.surveySlugs : [potSlug];

  const [
    ticker,
    journal,
    spawnRows,
    curseRows,
    escalationRows,
    pipelineAggRows,
    pipelineEventRows,
    contextBurn,
    placeableCount,
    quarantinedCount,
    // EI-19934273886988915: every leg below is a READ-ONLY fan-out (no
    // mutation ever touches this pool), so retrying the whole batch on a
    // postgres-js connection-setup failure cannot double-apply anything —
    // at worst it re-runs a handful of idempotent SELECTs. This is the exact
    // failure connect-retry.ts documents for `withWorkspace` (EI-9279:
    // PgBouncer idle-reaps a pooled connection between sessions; the first
    // query issued against it fails immediately with `CONNECTION_CLOSED`),
    // but `readPotSoakReport` calls `getOrgPg().sql` directly and never
    // routes through `withWorkspace`, so it never inherited that protection.
    // `isTransientPgConnectionError` is deliberately broader than
    // `withPgRetry`'s CONNECT_TIMEOUT-only default (which exists because
    // THAT module's callers may be mutating) — see its own doc: "Read-only
    // call sites MAY pass a broader predicate."
  ] = await withPgRetry(
    () =>
      Promise.all([
        probeBgHostTicker(),
        readBgHostJournal(windowHours),
        sql<SpawnAggRow[]>`
      SELECT child_role,
             count(*) FILTER (WHERE status IN ('done', 'failed', 'cancelled', 'reaped'))::int AS total_terminal,
             count(*) FILTER (WHERE status = 'done')::int AS successful
        FROM harness_shared.spawned_agents
       WHERE workspace_id = ${workspaceId}
         AND harness_slug = ANY(${sql.array(surveySlugs)})
         AND child_role IN ('cup', 'mug', 'kettle')
         AND started_at >= now() - make_interval(hours => ${windowHours})
       GROUP BY 1
    `,
    sql<CurseAggRow[]>`
      WITH scoped AS (
        SELECT p.*,
               EXISTS (
                 SELECT 1
                   FROM harness_shared.harness_features_consolidated u
                  WHERE u.workspace_id = p.workspace_id
                    AND u.feature_id = p.work_item_id
                    AND (p.harness_slug IS NULL OR u.harness_slug = p.harness_slug)
                    AND u.status <> ALL(${sql.array(SUMMARY_INACTIVE_UNIT_STATES)})
               ) AS unit_active
          FROM harness_shared.pot_placements p
         WHERE p.workspace_id = ${workspaceId}
           AND p.install_slug = ${potSlug}
      )
      SELECT count(*) FILTER (
               WHERE updated_at >= now() - make_interval(hours => ${windowHours})
             )::int AS placements_seen,
             count(*) FILTER (
               WHERE status = 'cursed'
                 AND COALESCE(fail_count, 0) = 0
                 AND COALESCE(infra_loss_count, 0) > 0
                 AND updated_at >= now() - make_interval(hours => ${windowHours})
             )::int AS infra_curses,
             count(*) FILTER (
               WHERE status = 'recovering' AND unit_active
             )::int AS recovering_open,
             count(*) FILTER (
               WHERE status = 'recovering'
                 AND unit_active
                 AND COALESCE(recovery_started_at, last_recovery_at, updated_at, placed_at)
                   <= now() - ${DEFAULT_STALE_RECOVERING_MS} * interval '1 millisecond'
             )::int AS stale_recovering
        FROM scoped
    `,
    sql<EscalationAggRow[]>`
      WITH scoped AS (
        SELECT ts
          FROM harness_shared.coord_open_escalations
         WHERE workspace_id = ${workspaceId}
           AND COALESCE(
                 body::jsonb ->> 'harnessSlug',
                 body::jsonb ->> 'harness_slug',
                 body::jsonb ->> 'harness',
                 ''
               ) = ANY(${sql.array(surveySlugs)})
      )
      SELECT count(*)::int AS open_now,
             count(*) FILTER (
               WHERE ts < now() - make_interval(hours => ${Math.max(1, Math.floor(windowHours / 2))})
             )::int AS older_open_count,
             count(*) FILTER (
               WHERE ts >= now() - make_interval(hours => ${Math.max(1, Math.floor(windowHours / 2))})
             )::int AS newer_open_count
        FROM scoped
    `,
    sql<PipelineAggRow[]>`
      SELECT count(*) FILTER (
               WHERE kind = 'green_checkpoint'
                 -- Deliberately NOT a 'skipped-%' prefix: 'skipped-misconfigured' (a gate that
                 -- can never promote, WI-10006317) must count as an unsuccessful gate fire.
                 AND status NOT IN ('skipped-disabled', 'skipped-locked')
             )::int AS green_total,
             count(*) FILTER (
               WHERE kind = 'green_checkpoint'
                 AND status IN ('advanced', 'up-to-date')
             )::int AS green_success
        FROM harness_shared.pipeline_events
       WHERE install_slug = ${potSlug}
         AND created_at >= now() - make_interval(hours => ${windowHours})
    `,
    sql<PipelineEventRow[]>`
      SELECT kind, status, created_at
        FROM harness_shared.pipeline_events
       WHERE install_slug = ${potSlug}
         AND created_at >= now() - make_interval(hours => ${windowHours})
         AND (
           (kind = 'green_checkpoint' AND status IN ('advanced', 'up-to-date'))
           OR (kind = 'deploy' AND status = 'ok')
         )
       ORDER BY created_at ASC
    `,
    // Context burn (P-008), extracted to readContextBurnMetrics (EI-12456) — see
    // its doc comment for the event_wake_deliveries single-flat-plane story.
    readContextBurnMetrics(sql, { workspaceId, windowHours }),
    // The two halves of the frontier: what the pot MAY place, and what the admission
    // gate is withholding from it. Both, or the readiness gate cannot tell an idle
    // pot (nothing to do) from a deadlocked one (work it may never touch).
        countPlaceableFrontier(sql, workspaceId, surveySlugs),
        countQuarantinedFrontier(sql, workspaceId, surveySlugs),
      ]),
    { classifier: isTransientPgConnectionError, label: 'readPotSoakReport' },
  );

  const curse = curseRows[0] ?? { placements_seen: 0, infra_curses: 0, recovering_open: 0, stale_recovering: 0 };
  const escalation = escalationRows[0] ?? { open_now: 0, older_open_count: 0, newer_open_count: 0 };
  const pipeline = pipelineAggRows[0] ?? { green_total: 0, green_success: 0 };
  const deployLatency = computeDeployLatency(pipelineEventRows);

  return computeSoakReport({
    potSlug,
    surveyScope: membership.scope,
    surveySlugs,
    windowHours,
    generatedAtMs: Date.now(),
    bgHost: {
      ...journal,
      tickerUp: ticker.up,
      tickerNote: ticker.note ?? null,
    },
    roleSuccess: roleSuccessRowsToView(spawnRows),
    frontier: { placeable: placeableCount, quarantined: quarantinedCount },
    infraCurse: {
      placementsSeen: Number(curse.placements_seen ?? 0),
      infraCurses: Number(curse.infra_curses ?? 0),
      rate:
        Number(curse.placements_seen ?? 0) > 0
          ? Number(curse.infra_curses ?? 0) / Number(curse.placements_seen ?? 0)
          : null,
      recoveringOpen: Number(curse.recovering_open ?? 0),
      staleRecovering: Number(curse.stale_recovering ?? 0),
    },
    escalationBacklog: {
      openNow: Number(escalation.open_now ?? 0),
      olderOpenCount: Number(escalation.older_open_count ?? 0),
      newerOpenCount: Number(escalation.newer_open_count ?? 0),
      improving: Number(escalation.newer_open_count ?? 0) <= Number(escalation.older_open_count ?? 0),
    },
    gateGreenRatio: {
      green: Number(pipeline.green_success ?? 0),
      total: Number(pipeline.green_total ?? 0),
      ratio:
        Number(pipeline.green_total ?? 0) > 0
          ? Number(pipeline.green_success ?? 0) / Number(pipeline.green_total ?? 0)
          : null,
    },
    deployLatency,
    contextBurn,
  });
}
