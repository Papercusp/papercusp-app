/**
 * cold-boot-drill-live — P-020's opt-in chaos actuator + mechanical grader.
 *
 * This deliberately REUSES the P-018 carry-respawn host instead of introducing
 * another lifecycle mechanism. `startColdBootDrill` builds the same deterministic
 * carry, crosses the same flush/open-owner gates, and queues the same clean-boundary
 * `carry-respawn`; drill metadata merely lets the host record which fresh native
 * transcript belongs to the sample. `gradeColdBootDrill` then parses that native
 * transcript through the replay parser and extracts only explicit state-recovery
 * tool calls. No LLM judges its own carry.
 *
 * Destructive behavior is DEFAULT-OFF: nothing runs on a timer or watcher. A caller
 * must explicitly invoke `session:carry-drill { op:'start' }`, and the durable drill
 * ledger rate-limits one owner to one cut per 30 minutes.
 */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { buildCarryBrief, type CarryBrief } from './carry-brief';
import { buildOwnerRespawnLaunchSpec, type RespawnLaunchSpec } from './carry-respawn';
import {
  DEFAULT_SUFFICIENCY_PARAMS,
  extractRecoveryLookups,
  gradeColdBootDrills,
  type CarrySufficiencyReport,
  type DrillSample,
  type RecoveryLookup,
} from './cold-boot-drill';
import { resolveModelSpecForOwner } from './compaction-usage';
import { runFlushGate, type FlushGateOutcome } from './enforcement-gate-io';
import {
  PSU_PTY_DIR,
  findLiveHost,
  hostSupports,
  injectIntoHost,
  sanitizeKey,
  sessionClassForHost,
  type PsuPtyHost,
} from './events/await/psu-pty-discovery';
import { modelWindowForSpec } from './agent-config-constants';
import { parseTranscriptJsonl } from './replay/transcript';
import type { ReplayTranscript } from './replay/types';
import { MARKER_AWARE_POST_COMPACTION_RECOVERY_INSTRUCTION } from './agent-tools/coordination/compaction-recovery';
import {
  resolveOwnerIsolatedSessionByPrefix,
  resolveSelfSession,
  type SelfSession,
} from './search/self-session';

export const DEFAULT_COLD_BOOT_DRILL_INTERVAL_MS = 30 * 60_000;
export const DEFAULT_COLD_BOOT_DRILL_WINDOW_TOKENS = 200_000;
const DRILL_LEDGER_MAX_BYTES = 1024 * 1024;
const DRILL_LEDGER_FILE = 'carry-drills.events.jsonl';
const CARRY_ROOT = join(homedir(), '.papercusp', 'launch-context');

/**
 * EI-18133456688790756 (P-021 class-name mismatch): `startColdBootDrill` now
 * always DEFAULTS an omitted `sessionClass` from the canonical classifier
 * (`sessionClassForHost` — see the comment at its call site), but a handful of
 * historical ledger rows (2026-07-17) were requested with an EXPLICIT, hand-typed
 * `sessionClass: 'gateway-claude-headless'` that the classifier has never emitted
 * (confirmed: `git log -S'gateway-claude-headless'` on psu-pty-discovery.ts is
 * empty) — a caller-supplied override, not a classifier bug. Left unaliased those
 * graded drills silently orphan into a phantom class no live headless wake can
 * ever match, so the REAL 'claude-headless' class reads zero drills forever even
 * though a genuinely good drill already ran under a stale label. Alias at
 * READ-time (never mutate the append-only ledger) so old data folds back into
 * the class it was always actually testing. Extend this map only for a CONFIRMED
 * one-off caller-supplied label, never for a class the live classifier can emit.
 */
const LEGACY_SESSION_CLASS_ALIASES: Readonly<Record<string, string>> = {
  'gateway-claude-headless': 'claude-headless',
};

function normalizeSessionClass(sessionClass: string): string {
  return LEGACY_SESSION_CLASS_ALIASES[sessionClass] ?? sessionClass;
}

export type ColdBootDrillLedgerKind =
  | 'carry-drill-requested'
  | 'carry-drill-queued'
  | 'carry-drill-request-failed'
  | 'carry-drill-graded'
  // Host-side lifecycle kinds mirrored into the shared ledger by psu-pty-host's
  // appendSharedDrillLedgerEvent (EI-12655): previously these lived ONLY in the
  // per-owner host event log, so the shared-ledger report saw an eternally
  // pending requested/queued pair for every drill whose grade never landed.
  | 'carry-drill-respawned'
  | 'carry-drill-respawn-failed'
  | 'carry-drill-carry-delivered'
  | 'carry-drill-carry-dropped'
  // EI-12754: NON-terminal marker — a busy-gate-refused carry-respawn drill was
  // re-queued for exactly one deferred retry at the next settled turn. The
  // retry itself ends in a terminal delivered/dropped row; report/verify
  // deliberately ignore this kind (it is sequence context, not an outcome).
  | 'carry-drill-rearm-queued';

export interface ColdBootDrillLedgerEvent {
  ts: string;
  kind: ColdBootDrillLedgerKind;
  drillId: string;
  ownerId: string;
  sessionClass: string;
  detail?: string;
  lookups?: RecoveryLookup[];
  transcriptPath?: string;
  /** Host-mirrored terminal rows (EI-12655): why a carry was dropped / a respawn failed. */
  reason?: string;
  /** Host-mirrored respawn rows (EI-12655): the successor's fresh native session id. */
  nativeId?: string | null;
  /** EI-12754: set on a terminal drop that came from the one-shot re-armed retry. */
  rearmed?: boolean;
}

export interface ColdBootDrillHostEvent {
  ts?: string;
  kind?: string;
  drillId?: string;
  sessionClass?: string;
  nativeId?: string | null;
  mode?: string;
  launchContextPath?: string | null;
  reason?: string;
  /** Wait budget the host stamped on a busy-gate / re-arm row, ms. Read by
   *  carry-respawn-outcome to decide when a `pending` attempt is past the window
   *  in which it could still fire (see isOrphanedPendingRespawn). */
  capMs?: number | null;
}

export function coldBootDrillLedgerPath(dir: string = PSU_PTY_DIR): string {
  return join(dir, DRILL_LEDGER_FILE);
}

export function ownerHostEventPath(ownerId: string, dir: string = PSU_PTY_DIR): string {
  return join(dir, `${sanitizeKey(ownerId)}.events.jsonl`);
}

function parseJsonl<T>(body: string): T[] {
  const out: T[] = [];
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object') out.push(row as T);
    } catch {
      // A host can be appending while the reader snapshots the file. A partial
      // final row is not a drill failure; the next grade/report sees it.
    }
  }
  return out;
}

export async function readColdBootDrillLedger(dir: string = PSU_PTY_DIR): Promise<ColdBootDrillLedgerEvent[]> {
  try {
    return parseJsonl<ColdBootDrillLedgerEvent>(await fs.readFile(coldBootDrillLedgerPath(dir), 'utf8'));
  } catch {
    return [];
  }
}

export async function readOwnerHostEvents(
  ownerId: string,
  dir: string = PSU_PTY_DIR,
): Promise<ColdBootDrillHostEvent[]> {
  try {
    return parseJsonl<ColdBootDrillHostEvent>(await fs.readFile(ownerHostEventPath(ownerId, dir), 'utf8'));
  } catch {
    return [];
  }
}

/** Bounded append in the existing psu-pty event directory. Unlike the host's
 * per-owner log, this small roll-up contains only drill lifecycle/sample rows so
 * a class report never scans thousands of unrelated owner files. */
export async function appendColdBootDrillLedgerEvent(
  event: ColdBootDrillLedgerEvent,
  dir: string = PSU_PTY_DIR,
): Promise<boolean> {
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const path = coldBootDrillLedgerPath(dir);
    try {
      const stat = await fs.stat(path);
      if (stat.size > DRILL_LEDGER_MAX_BYTES) {
        const body = await fs.readFile(path, 'utf8');
        await fs.writeFile(path, body.slice(Math.floor(body.length / 2)).replace(/^[^\n]*\n/, ''), { mode: 0o600 });
      }
    } catch {
      // First append creates the file.
    }
    await fs.appendFile(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    await fs.chmod(path, 0o600);
    return true;
  } catch {
    return false;
  }
}

function latestActiveDrill(
  events: readonly ColdBootDrillLedgerEvent[],
  ownerId: string,
): ColdBootDrillLedgerEvent | null {
  const terminal = new Set(
    events
      .filter((event) => event.ownerId === ownerId && event.kind === 'carry-drill-request-failed')
      .map((event) => event.drillId),
  );
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (
      event.ownerId === ownerId &&
      (event.kind === 'carry-drill-requested' || event.kind === 'carry-drill-queued') &&
      !terminal.has(event.drillId)
    ) return event;
  }
  return null;
}

async function defaultTranscript(ownerId: string): Promise<SelfSession | null> {
  return resolveSelfSession(ownerId);
}

/**
 * Keep the existing global cold-by-default classifier Claude-only: changing its
 * vocabulary would alter live wake policy. Drills for another backend instead
 * get a backend-qualified local class so their evidence cannot accidentally
 * satisfy a Claude rollout gate.
 */
function sessionClassForDrill(host: PsuPtyHost, sourceKind: SelfSession['sourceKind']): string {
  if (sourceKind === 'claude') return sessionClassForHost(host);
  return `${sourceKind}-${host.bridgeTty === false ? 'headless' : 'interactive'}`;
}

async function defaultEffectiveWindow(ownerId: string): Promise<number> {
  try {
    const spec = await resolveModelSpecForOwner(ownerId);
    return spec ? modelWindowForSpec(spec) : DEFAULT_COLD_BOOT_DRILL_WINDOW_TOKENS;
  } catch {
    return DEFAULT_COLD_BOOT_DRILL_WINDOW_TOKENS;
  }
}

export interface StartColdBootDrillInput {
  ownerId: string;
  ownerLabel: string;
  workspaceId?: string | null;
  sessionClass?: string;
  effectiveWindowTokens?: number;
  /** Explicit retry acknowledgement for a bounded/unreadable owner-request
   *  history. Never bypasses a known unresolved owner message. */
  acknowledgeOwnerHistoryUncertainty?: boolean;
  /** Optional durable campaign/operator context for the requested ledger row. */
  note?: string;
  minIntervalMs?: number;
}

export interface StartColdBootDrillDeps {
  now: () => number;
  newId: () => string;
  findHost: (ownerId: string) => PsuPtyHost | null;
  resolveTranscript: (ownerId: string) => Promise<SelfSession | null>;
  resolveEffectiveWindow: (ownerId: string) => Promise<number>;
  buildBrief: (ownerId: string, workspaceId?: string) => Promise<CarryBrief | null>;
  flushGate: (input: Parameters<typeof runFlushGate>[0]) => Promise<FlushGateOutcome>;
  buildSpec: (
    ownerId: string,
    input: Parameters<typeof buildOwnerRespawnLaunchSpec>[1],
  ) => Promise<RespawnLaunchSpec | null>;
  inject: typeof injectIntoHost;
  readLedger: () => Promise<ColdBootDrillLedgerEvent[]>;
  appendLedger: (event: ColdBootDrillLedgerEvent) => Promise<boolean>;
}

function startDeps(overrides: Partial<StartColdBootDrillDeps>): StartColdBootDrillDeps {
  return {
    now: Date.now,
    newId: randomUUID,
    findHost: findLiveHost,
    resolveTranscript: defaultTranscript,
    resolveEffectiveWindow: defaultEffectiveWindow,
    buildBrief: async (ownerId, workspaceId) => {
      try { return await buildCarryBrief(ownerId, { workspaceId }); } catch { return null; }
    },
    flushGate: runFlushGate,
    buildSpec: buildOwnerRespawnLaunchSpec,
    inject: injectIntoHost,
    readLedger: readColdBootDrillLedger,
    appendLedger: appendColdBootDrillLedgerEvent,
    ...overrides,
  };
}

export type StartColdBootDrillResult =
  | {
      ok: true;
      drillId: string;
      sessionClass: string;
      queued: true;
      nextAllowedAt: string;
      ownerHistoryUncertaintyAcknowledged?: true;
    }
  | {
      ok: false;
      error: string;
      note: string;
      retryAt?: string;
      tripwires?: unknown[];
      historyStatus?: 'truncated' | 'unreadable';
    };

export async function startColdBootDrill(
  input: StartColdBootDrillInput,
  overrides: Partial<StartColdBootDrillDeps> = {},
): Promise<StartColdBootDrillResult> {
  const deps = startDeps(overrides);
  const ownerId = input.ownerId.trim();
  const now = deps.now();
  const interval = Math.max(60_000, input.minIntervalMs ?? DEFAULT_COLD_BOOT_DRILL_INTERVAL_MS);
  if (!ownerId) return { ok: false, error: 'owner_required', note: 'A drill must target the calling session owner.' };

  const host = deps.findHost(ownerId);
  if (!host || !hostSupports(host, 'carry-respawn')) {
    return {
      ok: false,
      error: host ? 'host_missing_carry_respawn_capability' : 'no_live_pty_host',
      note: 'P-020 drills require a live managed psu host advertising carry-respawn; no process was cut.',
    };
  }
  const active = latestActiveDrill(await deps.readLedger(), ownerId);
  const activeAt = active ? Date.parse(active.ts) : NaN;
  if (active && Number.isFinite(activeAt) && now - activeAt < interval) {
    const retryAt = new Date(activeAt + interval).toISOString();
    return {
      ok: false,
      error: 'drill_rate_limited',
      note: `The last live cut for this owner is inside the ${Math.round(interval / 60_000)}-minute chaos interval.`,
      retryAt,
    };
  }

  const transcript = await deps.resolveTranscript(ownerId);
  if (!transcript) {
    return { ok: false, error: 'transcript_unavailable', note: 'The current managed session transcript could not be resolved; no process was cut.' };
  }
  // P-021: Claude keeps the exact canonical classifier vocabulary shared with
  // cold-by-default. Other backends are deliberately qualified locally; their
  // drill samples must never count as evidence for a Claude actuation class.
  // An explicit caller class still wins for scoped campaigns.
  const sessionClass = input.sessionClass?.trim() || sessionClassForDrill(host, transcript.sourceKind);

  const workspaceId = input.workspaceId ?? '*';
  const brief = await deps.buildBrief(ownerId, input.workspaceId ?? undefined);
  const gate = await deps.flushGate({
    boundary: 'compaction',
    ownerId,
    workspaceId,
    sessionId: ownerId,
    sinceIso: new Date(now - 30 * 60_000).toISOString(),
    brief,
    nowMs: now,
  });
  if (gate.verdict === 'refuse') {
    return {
      ok: false,
      error: 'flush_required',
      note: gate.refusalText ?? 'Flush the named state, then explicitly start the drill again.',
      tripwires: gate.tripwires,
    };
  }

  const effectiveWindowTokens =
    typeof input.effectiveWindowTokens === 'number' && input.effectiveWindowTokens > 0
      ? input.effectiveWindowTokens
      : await deps.resolveEffectiveWindow(ownerId);
  const spec = await deps.buildSpec(ownerId, {
    effectiveWindowTokens,
    buildOpts: {
      workspaceId: input.workspaceId ?? undefined,
      ownerLabel: input.ownerLabel,
      transcriptPath: transcript.filePath,
      transcriptSourceKind: transcript.sourceKind,
      boundaryDeliberate: true,
    },
  });
  if (!spec) {
    return { ok: false, error: 'carry_build_failed', note: 'The deterministic carry could not be assembled; the current process remains alive.' };
  }
  const ownerGate = spec.openOwnerQuestion;
  const acknowledgedHistoryUncertainty =
    ownerGate.crossesOpenOwnerMessage &&
    ownerGate.basis === 'history-uncertain' &&
    input.acknowledgeOwnerHistoryUncertainty === true;
  if (ownerGate.crossesOpenOwnerMessage && !acknowledgedHistoryUncertainty) {
    if (ownerGate.basis === 'history-uncertain') {
      return {
        ok: false,
        error: 'owner_history_uncertain',
        historyStatus: ownerGate.historyStatus,
        note:
          `Owner-request history is ${ownerGate.historyStatus ?? 'unknown'}; the drill cannot prove there is no older open request from its bounded tail. ` +
          'After reconciling the owner request and checkpointing the current lane, retry with acknowledgeOwnerHistoryUncertainty:true. ' +
          'That acknowledgement never bypasses a known unresolved owner message.',
      };
    }
    // Missing basis is treated as known-unanswered for compatibility with an
    // older/custom RespawnLaunchSpec: uncertainty is acknowledgeable only when
    // the canonical builder positively typed it as such.
    return {
      ok: false,
      error: 'open_owner_message',
      note: 'The last owner message is unanswered. This deliberate chaos cut refuses rather than crossing it.',
    };
  }

  const drillId = deps.newId();
  const requested: ColdBootDrillLedgerEvent = {
    ts: new Date(now).toISOString(),
    kind: 'carry-drill-requested',
    drillId,
    ownerId,
    sessionClass,
    ...(input.note?.trim() ? { detail: input.note.trim() } : {}),
  };
  if (!(await deps.appendLedger(requested))) {
    return { ok: false, error: 'drill_ledger_unavailable', note: 'The drill could not be durably registered, so no process was cut.' };
  }

  const firstPrompt = [
    `⟦carry-drill:${drillId}⟧`,
    'This is an opt-in P-020 cold-boot carry-sufficiency drill on a fresh process.',
    MARKER_AWARE_POST_COMPACTION_RECOVERY_INSTRUCTION,
    'Continue the carried work.',
    'Do not search/read your prior self session unless the carry is actually insufficient; ordinary source reads are fine.',
    `At the next clean boundary call session:carry-drill { op: "grade", drillId: "${drillId}" } exactly once.`,
  ].join('\n');
  const injected = await deps.inject(host.sock, {
    mode: 'carry-respawn',
    data: firstPrompt,
    // EI-153 addressing: a carry-respawn RE-EXECS the receiving CLI on someone
    // else's carry document, so an UNADDRESSED one is the highest-severity
    // unowned write in this path — the host guard is predicated on `ownerId`
    // being present and ABSTAINS (silently accepts) without it. The autorunner
    // drives this over `listLiveHosts()` with the flag default ON, so every
    // live host is reachable; naming the addressee lets a host that finds
    // itself holding another agent's drill refuse it instead of respawning.
    ownerId,
    systemPromptAddendum: spec.systemPromptAddendum,
    drillId,
    sessionClass,
  });
  if (!injected) {
    await deps.appendLedger({
      ...requested,
      ts: new Date(deps.now()).toISOString(),
      kind: 'carry-drill-request-failed',
      detail: 'control socket did not acknowledge the request',
    });
    return { ok: false, error: 'carry_respawn_inject_failed', note: 'The host did not acknowledge the cut; the current process remains available.' };
  }
  await deps.appendLedger({ ...requested, ts: new Date(deps.now()).toISOString(), kind: 'carry-drill-queued' });
  return {
    ok: true,
    drillId,
    sessionClass,
    queued: true,
    nextAllowedAt: new Date(now + interval).toISOString(),
    ...(acknowledgedHistoryUncertainty ? { ownerHistoryUncertaintyAcknowledged: true as const } : {}),
  };
}

function reportFromLedger(events: readonly ColdBootDrillLedgerEvent[]): CarrySufficiencyReport {
  const samples = new Map<string, DrillSample>();
  for (const event of events) {
    if (event.kind !== 'carry-drill-graded' || !Array.isArray(event.lookups)) continue;
    samples.set(event.drillId, {
      sessionClass: normalizeSessionClass(event.sessionClass),
      lookups: event.lookups,
    });
  }
  return gradeColdBootDrills([...samples.values()], DEFAULT_SUFFICIENCY_PARAMS);
}

/** Per-class roll-up of the host-mirrored TERMINAL drill outcomes (EI-12655).
 *  Counts drills (unique drillIds), not raw rows — a retried mirror write can
 *  duplicate a row, and one drill must never count twice. */
export interface ClassTerminalOutcomes {
  sessionClass: string;
  respawned: number;
  respawnFailed: number;
  delivered: number;
  dropped: number;
  /** dropped-drill count per drop reason (busy-gate-expired / never-settled /
   *  no-startup-ready-marker / no-first-prompt / superseded / ...). */
  dropReasons: Record<string, number>;
}

export function terminalOutcomesFromLedger(
  events: readonly ColdBootDrillLedgerEvent[],
): ClassTerminalOutcomes[] {
  const KIND_TO_FIELD: Partial<Record<ColdBootDrillLedgerKind, keyof Omit<ClassTerminalOutcomes, 'sessionClass' | 'dropReasons'>>> = {
    'carry-drill-respawned': 'respawned',
    'carry-drill-respawn-failed': 'respawnFailed',
    'carry-drill-carry-delivered': 'delivered',
    'carry-drill-carry-dropped': 'dropped',
  };
  const byClass = new Map<string, ClassTerminalOutcomes>();
  const seen = new Set<string>();
  for (const event of events) {
    const field = KIND_TO_FIELD[event.kind];
    if (!field || !event.drillId) continue;
    const dedupeKey = `${event.drillId}\x00${event.kind}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const sessionClass = event.sessionClass || 'unknown';
    const agg =
      byClass.get(sessionClass) ??
      ({ sessionClass, respawned: 0, respawnFailed: 0, delivered: 0, dropped: 0, dropReasons: {} } satisfies ClassTerminalOutcomes);
    agg[field] += 1;
    if (field === 'dropped') {
      const reason = event.reason || 'unknown';
      agg.dropReasons[reason] = (agg.dropReasons[reason] ?? 0) + 1;
    }
    byClass.set(sessionClass, agg);
  }
  return [...byClass.values()];
}

// ── EI-12755: carry-drill drop scanning (pure half of the drop watchdog) ─────
// Ledger rows are durable but nobody reads them until someone asks — the 2/2
// silent drill failures of 2026-07-15 sat unnoticed ~40 minutes. The watchdog
// (system-health/carry-drill-drop-watchdog.ts) sweeps the shared ledger with
// this pure scanner and escalates each fresh drop once.

/** The terminal kinds a human should hear about in real time. */
const DROP_ALERT_KINDS: ReadonlySet<string> = new Set([
  'carry-drill-carry-dropped',
  'carry-drill-respawn-failed',
]);

export interface CarryDrillDropAlert {
  drillId: string;
  ownerId: string;
  sessionClass: string;
  kind: string;
  reason: string;
  ts: string;
}

/**
 * Scan ledger events for terminal DROP rows newer than `sinceMs`, deduped per
 * (drillId, kind). Returns the alerts plus the advanced watermark (the newest
 * scanned drop-row ts, or `sinceMs` when nothing qualified) so a caller can
 * sweep incrementally without re-alerting old rows. Pure; exported for tests.
 */
export function scanCarryDrillDrops(
  events: readonly ColdBootDrillLedgerEvent[],
  sinceMs: number,
): { alerts: CarryDrillDropAlert[]; watermarkMs: number } {
  const alerts: CarryDrillDropAlert[] = [];
  const seen = new Set<string>();
  let watermarkMs = sinceMs;
  for (const event of events) {
    if (!DROP_ALERT_KINDS.has(event.kind) || !event.drillId) continue;
    const tsMs = Date.parse(event.ts);
    if (!Number.isFinite(tsMs) || tsMs <= sinceMs) continue;
    const dedupeKey = `${event.drillId}\x00${event.kind}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    if (tsMs > watermarkMs) watermarkMs = tsMs;
    alerts.push({
      drillId: event.drillId,
      ownerId: event.ownerId || 'unknown',
      sessionClass: event.sessionClass || 'unknown',
      kind: event.kind,
      reason: event.reason || 'unknown',
      ts: event.ts,
    });
  }
  return { alerts, watermarkMs };
}

async function safeReadCarry(path: string, root: string = CARRY_ROOT): Promise<string | null> {
  try {
    const [realRoot, realPath] = await Promise.all([fs.realpath(root), fs.realpath(path)]);
    if (realPath !== realRoot && !realPath.startsWith(realRoot + sep)) return null;
    const stat = await fs.stat(realPath);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return null;
    return await fs.readFile(realPath, 'utf8');
  } catch {
    return null;
  }
}

export interface GradeColdBootDrillDeps {
  readLedger: () => Promise<ColdBootDrillLedgerEvent[]>;
  appendLedger: (event: ColdBootDrillLedgerEvent) => Promise<boolean>;
  readHostEvents: (ownerId: string) => Promise<ColdBootDrillHostEvent[]>;
  readCarry: (path: string) => Promise<string | null>;
  loadTranscript: (ownerId: string, nativeId: string | null) => Promise<ReplayTranscript | null>;
  now: () => number;
}

function gradeDeps(overrides: Partial<GradeColdBootDrillDeps>): GradeColdBootDrillDeps {
  return {
    readLedger: readColdBootDrillLedger,
    appendLedger: appendColdBootDrillLedgerEvent,
    readHostEvents: readOwnerHostEvents,
    readCarry: safeReadCarry,
    loadTranscript: async (ownerId, nativeId) => {
      const resolved =
        (nativeId ? await resolveOwnerIsolatedSessionByPrefix(ownerId, nativeId) : null) ??
        await resolveSelfSession(ownerId);
      if (!resolved) return null;
      try {
        return parseTranscriptJsonl(await fs.readFile(resolved.filePath, 'utf8'), resolved.filePath);
      } catch {
        return null;
      }
    },
    now: Date.now,
    ...overrides,
  };
}

export type GradeColdBootDrillResult =
  | {
      ok: true;
      drillId: string;
      sample: DrillSample;
      report: CarrySufficiencyReport;
      transcriptPath: string;
      alreadyGraded: boolean;
    }
  | { ok: false; error: string; note: string };

export async function gradeColdBootDrill(
  ownerId: string,
  drillId: string,
  overrides: Partial<GradeColdBootDrillDeps> = {},
): Promise<GradeColdBootDrillResult> {
  const deps = gradeDeps(overrides);
  const ledger = await deps.readLedger();
  const requested = ledger.find((event) => event.drillId === drillId && event.ownerId === ownerId);
  if (!requested) return { ok: false, error: 'unknown_drill', note: 'No durable drill request matches this owner and id.' };

  const existing = ledger.find(
    (event) => event.drillId === drillId && event.ownerId === ownerId && event.kind === 'carry-drill-graded',
  );
  if (existing?.lookups) {
    const sample = { sessionClass: existing.sessionClass, lookups: existing.lookups };
    return {
      ok: true,
      drillId,
      sample,
      report: reportFromLedger(ledger),
      transcriptPath: existing.transcriptPath ?? '',
      alreadyGraded: true,
    };
  }

  const hostEvents = await deps.readHostEvents(ownerId);
  const respawn = [...hostEvents].reverse().find(
    (event) => event.kind === 'carry-drill-respawned' && event.drillId === drillId,
  );
  if (!respawn) {
    const failure = [...hostEvents].reverse().find(
      (event) => event.kind === 'carry-drill-respawn-failed' && event.drillId === drillId,
    );
    if (failure) {
      return {
        ok: false,
        error: 'respawn_failed',
        note: `The host kept the current process alive because drill respawn preparation failed (${failure.reason ?? 'unknown reason'}).`,
      };
    }
    return { ok: false, error: 'respawn_not_observed', note: 'The host has not durably recorded this drill successor yet.' };
  }
  if (!respawn.launchContextPath) {
    return { ok: false, error: 'carry_path_missing', note: 'The host event lacks the delivered carry-file path; refusing to guess.' };
  }
  const carryText = await deps.readCarry(respawn.launchContextPath);
  if (carryText == null) {
    return { ok: false, error: 'carry_unreadable', note: 'The recorded carry file is absent, unsafe, or unreadable.' };
  }
  const transcript = await deps.loadTranscript(ownerId, respawn.nativeId ?? null);
  if (!transcript) {
    return { ok: false, error: 'successor_transcript_unavailable', note: 'The fresh native transcript is not readable yet; grade at the next clean boundary.' };
  }

  const marker = `⟦carry-drill:${drillId}⟧`;
  const markerAt = transcript.turns.findIndex((turn) => turn.text.includes(marker));
  if (markerAt < 0) {
    return { ok: false, error: 'drill_marker_missing', note: 'The successor transcript does not contain the exact drill marker.' };
  }
  const gradeAt = transcript.turns.findIndex((turn, index) => {
    if (index <= markerAt || turn.role !== 'tool_use') return false;
    return (turn.toolName ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').endsWith('sessioncarrydrill') && turn.text.includes(drillId);
  });
  const window = transcript.turns.slice(markerAt + 1, gradeAt >= 0 ? gradeAt + 1 : undefined);
  const sample: DrillSample = {
    sessionClass: requested.sessionClass,
    lookups: extractRecoveryLookups(window, carryText),
  };
  const graded: ColdBootDrillLedgerEvent = {
    ts: new Date(deps.now()).toISOString(),
    kind: 'carry-drill-graded',
    drillId,
    ownerId,
    sessionClass: requested.sessionClass,
    lookups: sample.lookups,
    transcriptPath: transcript.ref,
  };
  if (!(await deps.appendLedger(graded))) {
    return { ok: false, error: 'grade_persist_failed', note: 'The mechanical sample was computed but could not be durably recorded.' };
  }
  return {
    ok: true,
    drillId,
    sample,
    report: reportFromLedger([...ledger, graded]),
    transcriptPath: transcript.ref,
    alreadyGraded: false,
  };
}

/** The op:'report' shape: graded per-class sufficiency PLUS the host-mirrored
 *  terminal outcomes (EI-12655) — so a class whose drills all DROP (perClass
 *  empty because nothing was ever graded) is visible as dropped counts instead
 *  of an empty report. */
export type ColdBootDrillReport = CarrySufficiencyReport & {
  terminalOutcomes: ClassTerminalOutcomes[];
};

export async function reportColdBootDrills(
  readLedger: () => Promise<ColdBootDrillLedgerEvent[]> = readColdBootDrillLedger,
): Promise<ColdBootDrillReport> {
  const events = await readLedger();
  return { ...reportFromLedger(events), terminalOutcomes: terminalOutcomesFromLedger(events) };
}

// ── op:'verify' — the silent-vanish recurrence guard (EI-12655 fix c) ─────────
// 2/2 first-generation drills failed with NO caller-visible trace: `start`
// returned ok/queued and everything after was fire-and-forget. verify makes the
// post-start lifecycle assertable: given a drillId (or the owner's latest),
// check each durable leg the drill MUST have left behind and report
// per-assertion pass/fail instead of an opaque "grade found nothing".

export interface VerifyColdBootDrillDeps {
  readLedger: () => Promise<ColdBootDrillLedgerEvent[]>;
  readHostEvents: (ownerId: string) => Promise<ColdBootDrillHostEvent[]>;
  socketExists: (ownerId: string) => Promise<boolean>;
}

function verifyDeps(overrides: Partial<VerifyColdBootDrillDeps>): VerifyColdBootDrillDeps {
  return {
    readLedger: readColdBootDrillLedger,
    readHostEvents: readOwnerHostEvents,
    socketExists: async (ownerId) => {
      try {
        return (await fs.stat(join(PSU_PTY_DIR, `${sanitizeKey(ownerId)}.sock`))).isSocket();
      } catch {
        return false;
      }
    },
    ...overrides,
  };
}

export interface VerifyAssertion {
  name: 'ledger-registered' | 'host-respawned' | 'terminal-outcome' | 'owner-socket-live';
  pass: boolean;
  detail: string;
}

export type VerifyColdBootDrillResult =
  | { ok: true; drillId: string; sessionClass: string; pass: boolean; assertions: VerifyAssertion[] }
  | { ok: false; error: string; note: string };

export async function verifyColdBootDrill(
  ownerId: string,
  input: { drillId?: string; sessionClass?: string } = {},
  overrides: Partial<VerifyColdBootDrillDeps> = {},
): Promise<VerifyColdBootDrillResult> {
  const deps = verifyDeps(overrides);
  const ledger = await deps.readLedger();
  const mine = ledger.filter((event) => event.ownerId === ownerId);
  let drillId = input.drillId?.trim() || '';
  if (!drillId) {
    for (let i = mine.length - 1; i >= 0; i -= 1) {
      const event = mine[i];
      if (event.kind !== 'carry-drill-requested') continue;
      if (input.sessionClass && event.sessionClass !== input.sessionClass) continue;
      drillId = event.drillId;
      break;
    }
    if (!drillId) {
      return {
        ok: false,
        error: 'no_drill_found',
        note: 'No drill request is registered for this owner (and session class) in the shared ledger.',
      };
    }
  }
  const rows = mine.filter((event) => event.drillId === drillId);
  const registered = rows.find(
    (event) => event.kind === 'carry-drill-requested' || event.kind === 'carry-drill-queued',
  );
  if (!registered && input.drillId) {
    return { ok: false, error: 'unknown_drill', note: 'No durable drill request matches this owner and id.' };
  }
  const hostEvents = (await deps.readHostEvents(ownerId)).filter((event) => event.drillId === drillId);
  const respawned =
    hostEvents.some((event) => event.kind === 'carry-drill-respawned') ||
    rows.some((event) => event.kind === 'carry-drill-respawned');
  const TERMINAL_KINDS = new Set([
    'carry-drill-carry-delivered',
    'carry-drill-carry-dropped',
    'carry-drill-respawn-failed',
    'carry-drill-request-failed',
    'carry-drill-graded',
  ]);
  const terminal =
    hostEvents.find((event) => TERMINAL_KINDS.has(event.kind ?? '')) ??
    [...rows].reverse().find((event) => TERMINAL_KINDS.has(event.kind));
  const socketLive = await deps.socketExists(ownerId);
  const assertions: VerifyAssertion[] = [
    {
      name: 'ledger-registered',
      pass: Boolean(registered),
      detail: registered
        ? `requested/queued at ${registered.ts} (class ${registered.sessionClass || 'unknown'})`
        : 'no requested/queued row in the shared drill ledger',
    },
    {
      name: 'host-respawned',
      pass: respawned,
      detail: respawned
        ? 'the host durably recorded the successor cut (carry-drill-respawned)'
        : 'no carry-drill-respawned event in the host log or shared ledger — the cut never happened or the host died before recording it',
    },
    {
      name: 'terminal-outcome',
      pass: Boolean(terminal),
      detail: terminal
        ? `${terminal.kind}${terminal.reason ? ` (${terminal.reason})` : ''} at ${terminal.ts ?? 'unknown ts'}`
        : 'no terminal event (delivered/dropped/failed/graded) — the drill is pending or vanished silently (the EI-12655 class)',
    },
    {
      name: 'owner-socket-live',
      pass: socketLive,
      detail: socketLive
        ? 'the owner control socket exists (host alive and injectable)'
        : 'the owner control socket is missing — the host is down; nothing can be injected',
    },
  ];
  const sessionClass = registered?.sessionClass || rows[0]?.sessionClass || input.sessionClass || 'unknown';
  return { ok: true, drillId, sessionClass, pass: assertions.every((a) => a.pass), assertions };
}
