/**
 * The curation loop — the heart of the curator-operator
 * (plan `curator-operator-2026-06-04`, P0).
 *
 * One tick: gather the fleet's STRUCTURED status → classify each signal with the
 * salience policy → surface the always-surface items as one calm operator
 * message (urgent-first) → fold routine progress + fleet-internal completions
 * into ONE batch digest (rate-limited) → record what was surfaced so it isn't
 * re-nagged. Reuses the existing surface (operator chat), dedup memory
 * (`operator_curation_log`), and coord/work_item readers — almost every piece
 * already existed; this is the orchestration + the salience filter.
 *
 * `runCurationTick` does NO scheduling I/O — it takes injected `deps` (the
 * `autoloop.ts` test convention) so it's unit-testable without PG. The DBOS
 * workflow (`dbos/curation-workflow.ts`) owns the cadence + state; the urgent
 * wake (`urgent-wake.ts`) calls this with `canEmitDigest:false` for an
 * immediate escalation/blocker surface.
 */
import {
  classifyAll,
  partition,
  agingAnnotation,
  SALIENCE_POLICY_VERSION,
  type ClassifiedSignal,
  type FleetSignal,
} from './salience-policy';
import { gatherFleetSignals, type FleetReaders } from './fleet-signals';
import { projectOwnerFacing } from './owner-facing-text';
import type { SurfacedEntry, OpenRecoverableEntry } from './curation-log';
import type { ReportBlock, ReportItem } from '@papercusp/chat-protocol';

// ── Cadence / backoff constants (the "faster when busy, slower when quiet" rule)
/** The adaptive interval floor — how often a busy workspace re-curates. */
export const BASE_INTERVAL_SECONDS = 120;
/** The adaptive interval cap — how slow a quiet workspace backs off to. */
export const MAX_INTERVAL_SECONDS = 900;
/** Don't emit a routine batch digest more often than this (calm cadence). */
export const DIGEST_MIN_GAP_SECONDS = 300;
/** …unless the batch has grown past this many items (surface a digest sooner). */
export const DIGEST_BURST_THRESHOLD = 8;

export interface CurationDeps {
  readers: FleetReaders;
  /** "Already surfaced" ids (the idempotency overlay). */
  loadSurfaced: (windowMs?: number) => Promise<Set<string>>;
  /** Persist what we surfaced/batched this tick. */
  recordSurfaced: (entries: readonly SurfacedEntry[], policyVersion: string) => Promise<void>;
  /** Emit one curated message into the operator's single voice. `report`
   *  (deterministic-status-cards-2026-07-17 P-002) is the structured status
   *  CARD for the same content — the sink persists it on the turn so the chat
   *  renders a card; `text` stays the fallback for text-only surfaces. */
  surface: (text: string, report?: ReportBlock) => Promise<unknown>;
  /** P-003 recovery close-the-loop: previously-surfaced escalation/blocker
   *  signals still considered OPEN (per `curation-log.loadOpenRecoverable`'s
   *  flap guard). Diffed against the current gather each tick to compute
   *  `cleared:<id>` signals. Optional + defaults to "none" so every existing
   *  caller/fake (pre-P-003) keeps compiling without recovery behavior. */
  loadOpenRecoverable?: () => Promise<OpenRecoverableEntry[]>;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Dedup window passed to loadSurfaced. */
  windowMs?: number;
}

export interface RunTickOptions {
  /** Whether routine batched items may be digested this tick (the workflow
   *  rate-limits digests; the urgent wake passes false → urgent-only).
   *  A function receives the pending batch size so the workflow can apply the
   *  burst threshold (digest sooner when a lot has piled up). Defaults true. */
  canEmitDigest?: boolean | ((pendingBatchSize: number) => boolean);
}

export interface CurationTickResult {
  /** Always-surface items emitted this tick. */
  surfacedCount: number;
  /** Routine items folded into the digest (0 if no digest emitted). */
  batchedCount: number;
  /** Routine items deferred (batch present but digest rate-limited this tick). */
  deferredBatchCount: number;
  digestEmitted: boolean;
  hasUrgent: boolean;
  /** The curated messages emitted (for tests / audit). */
  messages: string[];
}

const KIND_MARKER: Record<string, string> = {
  escalation: '⚠',
  blocker: '🚧',
  decision: '❓',
  completion: '✓',
  progress: '·',
  health: '🩺',
  cleared: '✓',
};

const KIND_LABEL: Record<string, string> = {
  escalation: 'Escalation',
  blocker: 'Blocked',
  decision: 'Decision needed',
  completion: 'Done',
  progress: 'Progress',
  health: 'System health',
  cleared: 'Cleared',
};

/** deterministic-status-cards-2026-07-17 P-002/D-003: map a signal kind onto a
 *  ReportBlock status token so the card renderer picks the right glyph+tone
 *  (reusing ReportBlockCard's existing status→glyph map — done/resolved → ●
 *  good, wip → ◐ accent, blocked/failing → ■ bad, needs-human/review → review).
 *  The human LABEL is still carried in the row text (information-preservation,
 *  D-006) so escalation-vs-blocker (both ■) stays distinguishable. */
const KIND_STATUS: Record<string, string> = {
  escalation: 'blocked',
  blocker: 'blocked',
  decision: 'needs-human',
  completion: 'done',
  progress: 'wip',
  health: 'failing',
  cleared: 'resolved',
};

/** The signal's rendered BODY — everything after the marker and before the
 *  drill-in ref (label + harness + requested + title + detail + aging). Shared
 *  by the text line (formatSignalLine) and the card row (signalToReportItem) so
 *  the two renditions never drift and no field is dropped (D-006).
 *
 *  ⚠ This is also the OWNER-FACING projection seam (WI-37946). Producers compose
 *  `title`/`detail` as a precise ENGINEERING record — full agent UUIDs,
 *  `system:*` actor names, repo-relative source paths — and are right to. The
 *  owner sees the same string as a notification, so `projectOwnerFacing` runs
 *  once here, where BOTH renditions pass through, rather than in either renderer
 *  (which would drift) or in each producer (which would cost the record).
 *  The drill-in `ref` is deliberately NOT projected — the raw ids stay one click
 *  away, so curation still never hides (D-005). */
function signalBody(c: ClassifiedSignal, now: () => number = Date.now): string {
  const { signal } = c;
  const label = KIND_LABEL[signal.kind] ?? signal.kind;
  const where = signal.harness ? ` [${signal.harness}]` : '';
  const requested = signal.kind === 'completion' && signal.userRequested ? ' (you asked for this)' : '';
  let body = `**${label}**${where}${requested} — ${signal.title}`;
  if (signal.detail) body += ` · ${signal.detail}`;
  const aging = agingAnnotation(signal, now());
  if (aging) body += ` · ${aging}`;
  return projectOwnerFacing(body);
}

/** Format ONE always-surface signal into a calm line, with the drill-in ref
 *  (D-005 — curation never hides; the raw item is always reachable). `now`
 *  (injectable for tests) drives the P-006 aging annotation — a still-open
 *  escalation/blocker at least a day old gets a "still open — day N" tag so a
 *  re-nag past the idempotency window reads as a reminder, not new news.
 *  This is the TEXT rendition (voice/search/text-only surfaces + the card's own
 *  fallback); the card rendition rides the turn's `report` (buildSurfaceReport). */
export function formatSignalLine(c: ClassifiedSignal, now: () => number = Date.now): string {
  const marker = KIND_MARKER[c.signal.kind] ?? '•';
  let line = `${marker} ${signalBody(c, now)}`;
  if (c.signal.ref) line += ` · drill in: \`${c.signal.ref}\``;
  return line;
}

/** One card ROW for a signal — the structured counterpart of formatSignalLine
 *  (P-002). `status` drives the glyph/tone; `ref` becomes the row's actionable
 *  drill-in (P-003/D-004).
 *
 *  ⚠ This used to emit the ref ONLY for an open `escalation:` signal, filtering
 *  out `wi:`, `plan:`, `decision:` and `health:` on the reasoning that "no other
 *  kind has an inbox target". That reasoning DIED with the Inbox pane
 *  (`_retired/inbox-pane/`, hud-consolidation-2026-07-26): a `wi:` ref now opens
 *  the work-item POPUP, which resolves from the ref ALONE and needs no live
 *  attention item at all. The filter therefore dropped precisely the refs that DO
 *  resolve and kept the one kind that CANNOT resolve without a live item.
 *
 *  Measured live 2026-07-28 on the owner's own chat (11 report cards, 39 rows):
 *  ZERO rows offered an Open button. 21 rows arrived with `ref: null` — every one
 *  of them filtered out here — and papercusp's curator feed is 100% `wi:` refs
 *  (40/40), so a FRESH curator turn rendered zero buttons too.
 *
 *  Whether a ref can be opened is NOT knowable here: it depends on the live
 *  destinations the RENDERER holds. That verdict belongs to `resolveDrillInTarget`
 *  via the card's `canDrillIn` predicate, which is where the owner's 2026-07-28
 *  ruling ("if there is nothing to open there should be no open button") is
 *  actually enforced. So carry every ref the signal has and let the gate decide —
 *  a `health:<panelId>` still renders no button, because that resolver returns
 *  null for it. */
export function signalToReportItem(c: ClassifiedSignal, now: () => number = Date.now): ReportItem {
  return {
    text: signalBody(c, now),
    status: KIND_STATUS[c.signal.kind] ?? c.signal.kind,
    ...(typeof c.signal.ref === 'string' && c.signal.ref.trim() ? { ref: c.signal.ref } : {}),
  };
}

/** The always-surface (urgent-first) items as a status CARD — the structured
 *  counterpart of formatSurfaceMessage (P-002). Rides the curator turn's
 *  `report`; renders in the chat via ReportBlockCard. */
export function buildSurfaceReport(
  surfaceNow: readonly ClassifiedSignal[],
  now: () => number = Date.now,
): ReportBlock {
  return { plans: [{ title: 'Fleet status', items: surfaceNow.map((c) => signalToReportItem(c, now)) }] };
}

/** Max card rows for the routine digest — the card can show more than the text
 *  digest's 3 samples, but stays bounded so a large batch never balloons it. */
const DIGEST_CARD_MAX_ROWS = 20;

/** The routine batch as a compact rollup CARD (P-004): the count-by-kind header
 *  as the card title, up to DIGEST_CARD_MAX_ROWS signal rows. */
export function buildDigestReport(
  batch: readonly ClassifiedSignal[],
  now: () => number = Date.now,
): ReportBlock {
  const header = formatBatchDigest(batch).split('\n')[0] ?? '📋 Fleet update';
  const rows = batch.slice(0, DIGEST_CARD_MAX_ROWS).map((c) => signalToReportItem(c, now));
  return { title: header, plans: [{ title: 'Recent', items: rows }] };
}

/** Compose the single always-surface message (urgent-first). */
export function formatSurfaceMessage(surfaceNow: readonly ClassifiedSignal[], now: () => number = Date.now): string {
  return surfaceNow.map((c) => formatSignalLine(c, now)).join('\n');
}

/** Compose ONE calm batch digest from routine items: a count-by-kind header
 *  plus up to a few titles. Never per-signal nagging. */
export function formatBatchDigest(batch: readonly ClassifiedSignal[]): string {
  const counts = new Map<string, number>();
  for (const c of batch) counts.set(c.signal.kind, (counts.get(c.signal.kind) ?? 0) + 1);
  const parts: string[] = [];
  const progressed = counts.get('progress') ?? 0;
  const completed = counts.get('completion') ?? 0;
  if (progressed) parts.push(`${progressed} item${progressed === 1 ? '' : 's'} progressed`);
  if (completed) parts.push(`${completed} completed`);
  const health = counts.get('health') ?? 0;
  if (health) parts.push(`${health} health warning${health === 1 ? '' : 's'}`);
  // Any other kinds that slipped into the batch bucket.
  for (const [k, n] of counts) {
    if (k === 'progress' || k === 'completion' || k === 'health') continue;
    parts.push(`${n} ${k}`);
  }
  const header = `📋 Fleet update — ${parts.join(' · ') || `${batch.length} updates`}`;
  const sample = batch.slice(0, 3).map((c) => `· ${c.signal.title}`);
  return [header, ...sample].join('\n');
}

/**
 * P-003 recovery close-the-loop: diff the previously-OPEN recoverable
 * (escalation/blocker-kind) signals against this tick's current gather.
 * Anything open-but-absent gets a `cleared:<id>` signal — "✓ cleared —
 * <title>" — computed here (never emitted by a `FleetReaders` source, since
 * it is a fact about the ABSENCE of a source row, not a row itself). Pure:
 * no I/O, so it's directly unit-testable.
 *
 * Only ever draws from `RECOVERABLE_KINDS` (escalation/blocker), which per
 * `baseDisposition` are ALWAYS 'surface', never 'batch' — so every candidate
 * here was, by construction, actually surfaced (never a batch-only item),
 * satisfying the plan's "only for signals that actually surfaced" rule with
 * no extra filtering.
 */
export function computeClearedSignals(
  currentSignalIds: ReadonlySet<string>,
  openRecoverable: readonly OpenRecoverableEntry[],
  now: () => number = Date.now,
): FleetSignal[] {
  const nowIso = new Date(now()).toISOString();
  const out: FleetSignal[] = [];
  for (const o of openRecoverable) {
    if (currentSignalIds.has(o.id)) continue; // still open — not cleared
    out.push({
      id: `cleared:${o.id}`,
      kind: 'cleared',
      title: o.title ?? o.id,
      ref: o.id,
      ts: nowIso,
    });
  }
  return out;
}

/**
 * Run one curation tick. Pure over `deps` — no scheduling/state I/O.
 */
export async function runCurationTick(
  deps: CurationDeps,
  opts: RunTickOptions = {},
): Promise<CurationTickResult> {
  const gathered = await gatherFleetSignals(deps.readers);
  const alreadySurfaced = await deps.loadSurfaced(deps.windowMs);
  const openRecoverable = deps.loadOpenRecoverable ? await deps.loadOpenRecoverable() : [];
  const currentIds = new Set(gathered.map((s) => s.id));
  const cleared = computeClearedSignals(currentIds, openRecoverable, deps.now);
  const signals = cleared.length > 0 ? [...gathered, ...cleared] : gathered;
  const verdicts = classifyAll(signals, { alreadySurfaced });
  const { surfaceNow, batch, hasUrgent } = partition(signals, verdicts);
  const canEmitDigest =
    typeof opts.canEmitDigest === 'function'
      ? opts.canEmitDigest(batch.length)
      : opts.canEmitDigest ?? true;

  const messages: string[] = [];
  const recorded: SurfacedEntry[] = [];

  // 1) Always-surface items → one calm operator message (urgent leads).
  if (surfaceNow.length > 0) {
    const text = formatSurfaceMessage(surfaceNow, deps.now ?? Date.now);
    await deps.surface(text, buildSurfaceReport(surfaceNow, deps.now ?? Date.now));
    messages.push(text);
    for (const c of surfaceNow) recorded.push({ id: c.signal.id, kind: c.signal.kind, title: c.signal.title });
  }

  // 2) Routine batch → ONE digest, only when the workflow allows it this tick.
  //    Deferred items are NOT recorded, so they re-accumulate until digested.
  let digestEmitted = false;
  let batchedCount = 0;
  let deferredBatchCount = 0;
  if (batch.length > 0) {
    if (canEmitDigest) {
      const text = formatBatchDigest(batch);
      await deps.surface(text, buildDigestReport(batch, deps.now ?? Date.now));
      messages.push(text);
      digestEmitted = true;
      batchedCount = batch.length;
      for (const c of batch) recorded.push({ id: c.signal.id, kind: c.signal.kind, title: c.signal.title });
    } else {
      deferredBatchCount = batch.length;
    }
  }

  if (recorded.length > 0) {
    await deps.recordSurfaced(recorded, SALIENCE_POLICY_VERSION);
  }

  return {
    surfacedCount: surfaceNow.length,
    batchedCount,
    deferredBatchCount,
    digestEmitted,
    hasUrgent,
    messages,
  };
}

// ── Pure scheduling/backoff helpers (the workflow + wake use these) ───────────

/** Next adaptive interval: reset to BASE when something surfaced this tick
 *  (busy → re-curate soon), else grow geometrically toward MAX (quiet → back off). */
export function nextInterval(prevSeconds: number, surfacedThisTick: boolean): number {
  if (surfacedThisTick) return BASE_INTERVAL_SECONDS;
  const grown = Math.round((prevSeconds || BASE_INTERVAL_SECONDS) * 1.5);
  return Math.min(MAX_INTERVAL_SECONDS, Math.max(BASE_INTERVAL_SECONDS, grown));
}

/** Whether a cadence tick should actually run the (relatively heavy) curation,
 *  honoring the adaptive interval since the last run. */
export function shouldRunTick(
  lastRunAtMs: number | null,
  currentIntervalSeconds: number,
  nowMs: number,
): boolean {
  if (lastRunAtMs == null) return true;
  return nowMs - lastRunAtMs >= Math.max(1, currentIntervalSeconds) * 1000;
}

/** Whether a routine batch digest may be emitted now (rate-limited by
 *  DIGEST_MIN_GAP, or forced when the pending batch is large). */
export function canEmitDigestNow(
  lastDigestAtMs: number | null,
  pendingBatchSize: number,
  nowMs: number,
): boolean {
  if (pendingBatchSize <= 0) return false;
  if (pendingBatchSize >= DIGEST_BURST_THRESHOLD) return true;
  if (lastDigestAtMs == null) return true;
  return nowMs - lastDigestAtMs >= DIGEST_MIN_GAP_SECONDS * 1000;
}
