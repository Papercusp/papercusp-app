/**
 * Timeout-fallback: the guidance a timeout-wake carries + the detector that
 * surfaces systematic dead-drops (await-timeout-fallback-defaults-2026-07-03 P-003/P-004).
 *
 * When an await's deadline passes without its event, the sweeper fires a `timeout`
 * wake (fired_reason='timeout') so the blocked agent is re-invoked instead of
 * hanging until a human notices. Two concerns live here, both PG-free so they
 * unit-test without Docker/testcontainers:
 *
 *  1. The re-arm GUIDANCE (P-004): the message the woken agent reads — re-orient,
 *     re-check whether the thing already happened, re-arm if it still matters. A
 *     non-event is a prompt to RECONCILE, not a signal to give up.
 *  2. The DETECTOR (P-003): most timeouts are incidental (a slow event). But a key
 *     FAMILY that times out over and over — with ~no matching event ever — is a
 *     systematic dead-drop: a mistyped key, a dead/renamed emitter, an event that
 *     never fires. That is a BUG the fallback would otherwise silently paper over.
 *     `summarizeTimeoutFires` groups a sweep's fires by normalized family;
 *     `recordTimeoutFires` accumulates across sweeps and flags a family the moment
 *     its running total crosses a warn threshold.
 */

import type { AwaitRow } from './types';

/** The re-arm nudge carried in a timeout wake's `summary` (one human line). */
export const TIMEOUT_WAKE_SUMMARY =
  'await deadline passed WITHOUT the event firing — re-orient (coord:orient), check whether the thing you awaited already happened, and re-arm the await if it still matters. Do not assume it will never come.';

/** The structured guidance carried in a timeout wake's `payload.guidance`. */
export const TIMEOUT_WAKE_GUIDANCE =
  'Your await timed out — the event never fired within the window. This is a FALLBACK wake, not the event. Re-orient with coord:orient, reconcile whether the awaited state already changed (a missed / never-emitted event, a dead emitter, or a mistyped key), and if your work is still blocked on it, RE-ARM the await (or take another path). Do not give up silently. ' +
  // EI-21925527092611786: a stale/delayed delivery of an EARLIER, already-retired timeout on the
  // SAME key can surface here even though a re-armed registration on that key is still live and
  // not yet expired. Guard the re-arm behind a mechanical check rather than trusting this wake.
  'BEFORE re-arming, check events:status for this event key: if it appears in active_awaits with a future expires_ts, THIS wake is stale — do NOT re-arm (that would RETIRE the live registration and silently reset its deadline). Re-arm only when the key is genuinely absent from active_awaits.';

export interface PredicateTimeoutSpec {
  tool: string;
  args: Record<string, unknown>;
  path: string;
  op: string;
  value?: unknown;
  intervalSec: number;
  once: boolean;
}

export interface PredicateTimeoutRecovery {
  tool: 'watch:create';
  args: Record<string, unknown>;
}

/** Rebuild the same predicate under a fresh synthetic key after its paired await expires. */
export function buildPredicateTimeoutRecovery(input: {
  spec: PredicateTimeoutSpec;
  timeoutSec?: number;
}): PredicateTimeoutRecovery {
  const predicate: Record<string, unknown> = {
    tool: input.spec.tool,
    args: input.spec.args,
    path: input.spec.path,
    op: input.spec.op,
  };
  if (input.spec.op !== 'exists' && input.spec.op !== 'changed') predicate.value = input.spec.value;

  const args: Record<string, unknown> = {
    pattern: 'predicate-timeout-recovery',
    wake: true,
    once: input.spec.once,
    interval_sec: input.spec.intervalSec,
    on_timeout: 'wake',
    predicate,
  };
  if (input.timeoutSec != null && Number.isFinite(input.timeoutSec) && input.timeoutSec > 0) {
    args.timeout_sec = Math.max(1, Math.ceil(input.timeoutSec));
  }
  return { tool: 'watch:create', args };
}

/** Predicate keys belong to a poller that is retired with its expired await. */
export function buildPredicateTimeoutFallback(
  eventKey: string,
  predicateRecovery?: PredicateTimeoutRecovery | null,
): { summary: string; guidance: string; predicateRecovery?: PredicateTimeoutRecovery } {
  const summary =
    'Predicate await ' +
    eventKey +
    ' timed out — register a fresh predicate watch and let its own wake registration notify you; do not re-arm the expired key.';
  const guidance = predicateRecovery
    ? 'This synthetic predicate await timed out. Its paired poller is retired when the await expires, so the same key has no emitter. Do NOT call events:await on this expired key. Call predicateRecovery.tool with predicateRecovery.args; watch:create registers the new predicate wake itself. Do NOT call events:await on the returned watch.pattern — end your turn and let the new watch wake you when the predicate crosses or reaches its deadline. The recovery arguments carry the original predicate specification.'
    : 'This synthetic predicate await timed out. Its paired poller is retired when the await expires, so the same key has no emitter. Do NOT call events:await on this expired key. Re-register the original predicate with watch:create (or state:subscribe for its cell); the new registration owns its wake/subscription. Do NOT call events:await on the returned key — end your turn and let the new registration notify you. Recover the original predicate specification from the registration or prior context.';
  return {
    summary,
    guidance,
    ...(predicateRecovery ? { predicateRecovery } : {}),
  };
}

/** Whether a (possibly coalesced) delivery payload carries a timeout fire.
 *  A plain timeout fire is `{ timeout: true }` (the engine sweeper). A COALESCED
 *  wake replaces that headline with `{ coalesced, count, events, latest }`
 *  (engine.ts coalesceDeliveries), so the raw `payload.timeout` is gone — look
 *  inside the union (the latest fire AND any folded event) or the marker would be
 *  silently dropped and the agent told the event FIRED when it actually TIMED OUT. */
export function payloadIsTimeout(payload: unknown): boolean {
  if (payload == null || typeof payload !== 'object') return false;
  const p = payload as {
    timeout?: boolean;
    latest?: { payload?: { timeout?: boolean } };
    events?: { payload?: { timeout?: boolean } }[];
  };
  if (p.timeout === true) return true;
  if (p.latest?.payload?.timeout === true) return true;
  if (Array.isArray(p.events) && p.events.some((e) => e?.payload?.timeout === true)) return true;
  return false;
}

/**
 * EI-20489286325396940: the one-line coord-message SUMMARY for a delivery.
 *
 * The wake BODY (`wakeTurnText`) has carried a loud `[TIMEOUT …]` marker for a
 * while, but the two summary renderers that degrade a wake into coord mail — the
 * inbox fallback (wake-executor `degradeToInboxOrDrop`) and the park nudge
 * (engine `pumpWakeDeliveries`) — hardcoded `<key> fired`. The summary is what the
 * injected `[coord+N]` block renders, so a timed-out `work-item:done:<id>` await
 * read to the woken agent as the SOURCE ITEM COMPLETING (verified live 2026-08-15:
 * WI-39195 and EI-20488444691160764 both showed `work-item:done:… fired` while the
 * items stayed open and blocked — the authoritative rows were
 * `fired_reason='timeout'` at `expires_ts`, and no completion was ever emitted).
 * Telling the two apart needed a second events:status read, so the DEFAULT reading
 * was an unsafe completion inference.
 *
 * So a timeout summary says TIMED OUT and names `fired_reason` outright. An
 * ordinary event fire is byte-identical to before.
 *
 * Lives HERE, beside the other timeout wording, rather than in wake-executor:
 * engine.test.ts mocks `./wake-executor` wholesale with a two-key factory, so an
 * import of this helper from there resolved to `undefined` and threw inside the
 * park nudge's best-effort `catch` — silently deleting the nudge. A pure
 * presentation helper must not sit behind a heavyweight mocked module.
 */
export function wakeSummaryHeadline(eventKey: string, payload: unknown): string {
  return payloadIsTimeout(payload)
    ? `[await-event] ${eventKey} TIMED OUT (fired_reason: timeout — your deadline elapsed; ` +
      'the event did NOT fire and the awaited source did NOT complete)'
    : `[await-event] ${eventKey} fired`;
}

/**
 * Normalize an event key to its FAMILY for detector grouping: collapse any
 * segment that carries an id (a digit anywhere, or a long hex/uuid run) to `*`,
 * so `lock:grant:t123` and `lock:grant:t456` both group as `lock:grant:*` and
 * `work-item:done:WI-1` groups as `work-item:done:*`. Static words (grant, done,
 * deploy) are preserved — they are what makes a family recognizable in the log.
 */
export function eventKeyFamily(key: string): string {
  return key
    .split(':')
    .map((seg) => (/\d/.test(seg) || /^[0-9a-f]{16,}$/i.test(seg) ? '*' : seg))
    .join(':');
}

export interface TimeoutFireSummary {
  /** The normalized key family (ids collapsed to `*`). */
  family: string;
  /** How many awaits in this batch timed out on keys in this family. */
  count: number;
  /** The distinct raw keys that timed out (deduped, capped for log sanity). */
  keys: string[];
}

/**
 * Group a batch of timed-out awaits by key family, most-frequent first — the
 * per-sweep detector signal. Pure; reads only each await's `eventKey`.
 */
export function summarizeTimeoutFires(awaits: Array<Pick<AwaitRow, 'eventKey'>>): TimeoutFireSummary[] {
  const counts = new Map<string, number>();
  const rawKeys = new Map<string, Set<string>>();
  for (const a of awaits) {
    const fam = eventKeyFamily(a.eventKey);
    counts.set(fam, (counts.get(fam) ?? 0) + 1);
    const set = rawKeys.get(fam);
    if (set) set.add(a.eventKey);
    else rawKeys.set(fam, new Set([a.eventKey]));
  }
  return [...counts.entries()]
    .map(([family, count]) => ({ family, count, keys: [...(rawKeys.get(family) ?? [])].slice(0, 10) }))
    .sort((a, b) => b.count - a.count || a.family.localeCompare(b.family));
}

// ── cumulative cross-sweep detector ────────────────────────────────────────────
// A family that times out ONCE is noise; one that keeps timing out is the signal.
// Accumulate per-family totals across sweeps (process-lifetime, in-memory — no
// schema needed) and report each family the moment its running total crosses the
// warn threshold, so the operator log gets ONE loud line per systematic dead-drop
// rather than a trickle that blends into the noise.

const cumulativeTotals = new Map<string, number>();

/** Warn once a family's lifetime timeout-fire total reaches this. */
export const TIMEOUT_FIRE_WARN_THRESHOLD = 10;

export interface TimeoutFireCrossing {
  family: string;
  total: number;
}

/**
 * Fold a sweep's per-family summaries into the lifetime totals; return the
 * families that JUST crossed the warn threshold on THIS call (edge-triggered —
 * reported once at the crossing, not on every sweep thereafter).
 */
export function recordTimeoutFires(summaries: TimeoutFireSummary[]): TimeoutFireCrossing[] {
  const crossed: TimeoutFireCrossing[] = [];
  for (const s of summaries) {
    const prev = cumulativeTotals.get(s.family) ?? 0;
    const total = prev + s.count;
    cumulativeTotals.set(s.family, total);
    if (total >= TIMEOUT_FIRE_WARN_THRESHOLD && prev < TIMEOUT_FIRE_WARN_THRESHOLD) {
      crossed.push({ family: s.family, total });
    }
  }
  return crossed;
}

/** Snapshot the lifetime per-family totals (detector inspection / tests). */
export function timeoutFireTotals(): Record<string, number> {
  return Object.fromEntries(cumulativeTotals);
}

/** Test hook: reset the cumulative counter between cases. */
export function __resetTimeoutFireTotals(): void {
  cumulativeTotals.clear();
}
