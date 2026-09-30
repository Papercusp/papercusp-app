/**
 * su-cold-by-default — P-021's verdict-gated cold-by-default resolver
 * (deterministic-context-carry-2026-07-14, Phase 7 tail) + the shared
 * "is this owner's carry drill-proven?" read P-026 reuses.
 *
 * P-021: "Cold-by-default at boundaries (wakes, resumes, post-compaction, drone
 * hops) once drills pass; warm continuation stays within active interactive
 * exchanges and hot working sets." The DECISION half is pure and lives here
 * (decideClassDefaultCold); the LIVE half (classDefaultColdForWake) resolves the
 * inputs — the kill-switch flag, the canonical session class from the live host
 * discovery record (psu-pty-discovery.sessionClassForHost), the drill-ledger
 * verdict (cold-boot-drill-live.reportColdBootDrills, memoized ~30s so a busy
 * wake pump doesn't re-parse the ledger per wake), and the active-interactive-
 * exchange guard (host.lastInputAt — human keystrokes ONLY; socket-injected
 * agent wakes bypass stdin and never bump it, psu-pty-host P-003).
 *
 * SAFETY LADDER (all must hold before a wake colds WITHOUT the per-loop opt-in):
 *   1. SU_COLD_AUTO master gate         — resolved by the caller (engine.ts),
 *                                         exactly as for opt-in cold;
 *   2. COLD_BY_DEFAULT_PROVEN_CLASSES   — the P-021 kill-switch (default ON;
 *                                         evidence-gates below make ON safe);
 *   3. the session's class is DRILL-PROVEN (gradeColdBootDrills sufficient —
 *      enough drills, zero counted gaps per DEFAULT_SUFFICIENCY_PARAMS);
 *   4. NO ACTIVE INTERACTIVE EXCHANGE   — no human keystroke into the host's
 *                                         bridged TTY within ACTIVE_EXCHANGE_WINDOW_MS
 *                                         (the plan's "warm continuation stays
 *                                         within active interactive exchanges");
 *   5. a carry-note anchor exists       — enforced downstream by decideColdWake
 *                                         (P-006), unchanged.
 *
 * FAIL-SOFT end to end: any resolution failure (flag store, ledger read, host
 * fields) returns false — the wake stays warm; the cold-by-default path can
 * never DROP or corrupt a wake, only decline to engage.
 */

import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { reportColdBootDrills } from './cold-boot-drill-live';
import { sessionClassForHost, type PsuPtyHost } from './events/await/psu-pty-discovery';

/**
 * How recently a human keystroke keeps a session "in an active interactive
 * exchange" — inside this window a cold-by-default wake NEVER fires (the human's
 * live context outranks any drill verdict). 30 minutes: long enough to span a
 * human stepping away mid-conversation, short enough that an overnight-idle
 * interactive session still benefits from cold wakes. Env-tunable.
 */
export const ACTIVE_EXCHANGE_WINDOW_MS = 30 * 60_000;

function activeExchangeWindowMs(): number {
  const raw = Number(process.env.PAPERCUSP_COLD_ACTIVE_EXCHANGE_WINDOW_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : ACTIVE_EXCHANGE_WINDOW_MS;
}

/** Drill-verdict memo TTL — the wake pump can evaluate many wakes per minute;
 *  the ledger verdict changes at drill cadence (~30-min rate limit), so a short
 *  memo removes the per-wake ledger parse without meaningfully delaying a flip. */
export const DRILL_VERDICT_CACHE_MS = 30_000;

/** The minimal host view the decision needs (a live PsuPtyHost satisfies it). */
export type ColdByDefaultHostView = Pick<PsuPtyHost, 'bridgeTty' | 'lastInputAt'>;

export interface ClassDefaultColdInput {
  /** The P-021 kill-switch flag value (COLD_BY_DEFAULT_PROVEN_CLASSES). */
  flagOn: boolean;
  /** The canonical class of this wake's session (sessionClassForHost). */
  sessionClass: string;
  /** Classes whose carry the drill ledger proves sufficient. */
  sufficientClasses: readonly string[];
  /** ms epoch of the host's most recent HUMAN keystroke (null = none recorded). */
  lastHumanInputAtMs: number | null;
  nowMs: number;
  /** Override for tests; defaults to ACTIVE_EXCHANGE_WINDOW_MS (env-tunable). */
  windowMs?: number;
}

export type ClassDefaultColdDecision = { cold: boolean; reason: string };

/**
 * Is a HUMAN actively in this exchange right now — i.e. did a real keystroke land
 * on the host's bridged TTY inside {@link ACTIVE_EXCHANGE_WINDOW_MS}?
 *
 * THE ONE DEFINITION OF HUMAN PRESENCE, shared by BOTH cold routes (EI-21572316039386007).
 * It used to be inlined in decideClassDefaultCold, which meant the guard protected the
 * IMPLICIT cold-by-default route and nothing protected the EXPLICIT `carry:'cold'`
 * opt-in — so an explicitly cold-armed loop reset a session mid-conversation while its
 * owner was typing, twice destroying an answer the owner was waiting to read. The rule
 * "NEVER use 'cold' for an interactive/human-present session (D-005)" was stated in
 * loop:arm's own description but enforced on only one of the two paths that reach cold.
 * Extracted so decideColdWake (su-cold-loop.ts) enforces the SAME window from the SAME
 * source rather than a second hand-maintained copy of it.
 *
 * `lastHumanInputAtMs` is human keystrokes ONLY: socket-injected agent wakes bypass
 * stdin and never bump it (psu-pty-host P-003), so an agent's own loop traffic can
 * never masquerade as a present human. A headless session has no bridged TTY and
 * therefore no timestamp — null ⇒ false ⇒ cold proceeds exactly as before. Pure.
 */
export function isActiveInteractiveExchange(input: {
  /** ms epoch of the most recent HUMAN keystroke (null = none recorded). */
  lastHumanInputAtMs: number | null;
  nowMs: number;
  /** Override for tests; defaults to ACTIVE_EXCHANGE_WINDOW_MS (env-tunable). */
  windowMs?: number;
}): boolean {
  const window = input.windowMs ?? activeExchangeWindowMs();
  return (
    input.lastHumanInputAtMs != null &&
    Number.isFinite(input.lastHumanInputAtMs) &&
    input.nowMs - input.lastHumanInputAtMs < window
  );
}

/**
 * The PURE P-021 decision: should this wake go cold WITHOUT the per-loop
 * `carry:'cold'` opt-in? True only when the kill-switch is on, the session's
 * class is drill-proven, and no active interactive exchange is in flight.
 * Exported for direct unit test; the live resolver below feeds it.
 */
export function decideClassDefaultCold(input: ClassDefaultColdInput): ClassDefaultColdDecision {
  if (!input.flagOn) {
    return { cold: false, reason: 'cold-by-default disabled (COLD_BY_DEFAULT_PROVEN_CLASSES off)' };
  }
  if (!input.sufficientClasses.includes(input.sessionClass)) {
    return { cold: false, reason: `class '${input.sessionClass}' not drill-proven` };
  }
  if (
    isActiveInteractiveExchange({
      lastHumanInputAtMs: input.lastHumanInputAtMs,
      nowMs: input.nowMs,
      windowMs: input.windowMs,
    })
  ) {
    return { cold: false, reason: 'active interactive exchange (recent human input) — stays warm' };
  }
  return { cold: true, reason: `class '${input.sessionClass}' drill-proven cold-by-default (P-021)` };
}

// ── Live resolvers ───────────────────────────────────────────────────────────

let verdictMemo: { atMs: number; classes: string[] } | null = null;

/** Test hook: reset the drill-verdict memo. */
export function _resetColdByDefaultMemoForTests(): void {
  verdictMemo = null;
}

export interface ColdByDefaultDeps {
  getFlagFn?: (flag: string, scope: string) => Promise<boolean>;
  reportFn?: () => Promise<{ sufficientClasses: string[] }>;
  now?: () => number;
}

/** The drill ledger's sufficient classes, memoized DRILL_VERDICT_CACHE_MS.
 *  Fail-soft: a read failure returns [] (nothing proven ⇒ nothing colds). */
async function sufficientClassesCached(deps: ColdByDefaultDeps): Promise<string[]> {
  const now = (deps.now ?? Date.now)();
  if (verdictMemo && now - verdictMemo.atMs < DRILL_VERDICT_CACHE_MS) return verdictMemo.classes;
  try {
    const report = await (deps.reportFn ?? reportColdBootDrills)();
    const classes = Array.isArray(report.sufficientClasses) ? report.sufficientClasses : [];
    verdictMemo = { atMs: now, classes };
    return classes;
  } catch {
    return verdictMemo?.classes ?? [];
  }
}

/**
 * The wake-executor's injected `classDefaultCold` dep (engine.ts wires it): given
 * the live host record of the wake's target session, resolve the full P-021
 * ladder. Never throws — any failure is a warm (false) verdict.
 */
export async function classDefaultColdForWake(
  host: ColdByDefaultHostView | null | undefined,
  deps: ColdByDefaultDeps = {},
): Promise<boolean> {
  try {
    if (!host) return false; // no live host view ⇒ cannot classify ⇒ warm
    const flagOn = await (deps.getFlagFn ?? getFlag)(
      FLAGS.COLD_BY_DEFAULT_PROVEN_CLASSES,
      'system',
    );
    if (!flagOn) return false; // skip the ledger read entirely when killed
    const sufficientClasses = await sufficientClassesCached(deps);
    if (sufficientClasses.length === 0) return false;
    return decideClassDefaultCold({
      flagOn,
      sessionClass: sessionClassForHost(host),
      sufficientClasses,
      lastHumanInputAtMs: typeof host.lastInputAt === 'number' ? host.lastInputAt : null,
      nowMs: (deps.now ?? Date.now)(),
    }).cold;
  } catch {
    return false;
  }
}

/**
 * The wake-executor's injected `activeInteractiveExchange` dep (engine.ts wires it):
 * given the live host record of the wake's target session, is a human actively in the
 * exchange? Applies to BOTH cold routes — unlike {@link classDefaultColdForWake}, which
 * the explicit `carry:'cold'` opt-in deliberately never consults (EI-21572316039386007).
 *
 * FAIL-SOFT FALSE, and the direction is deliberate: false means "no human detected",
 * which lets cold proceed exactly as it does today. A genuinely headless session has no
 * bridged TTY and thus no `lastInputAt`, so it must land here — returning true on an
 * unreadable host would force EVERY headless cold loop warm and silently retire the
 * cold-loop lifecycle. This guard may only ever DECLINE to cold a session with a
 * demonstrably present human; it must never cold something, nor warm everything.
 */
export function activeInteractiveExchangeForWake(
  host: ColdByDefaultHostView | null | undefined,
  deps: { now?: () => number } = {},
): boolean {
  try {
    if (!host) return false; // no live host view ⇒ no keystrokes observable ⇒ no human
    return isActiveInteractiveExchange({
      lastHumanInputAtMs: typeof host.lastInputAt === 'number' ? host.lastInputAt : null,
      nowMs: (deps.now ?? Date.now)(),
    });
  } catch {
    return false;
  }
}

/**
 * P-026's shared read (WI-5001): the owner's canonical session class IF the
 * drill ledger proves that class's carry sufficient, else null. The enrichment-
 * retirement callsite (compact-reprime.ts) uses this to decide whether the
 * post-compaction speculative re-prime is still needed — it deliberately does
 * NOT apply the active-exchange guard (a compaction already happened; there is
 * no live exchange to protect). Fail-soft null (⇒ keep the enrichment).
 */
export async function carryProvenClassForOwner(
  ownerId: string,
  deps: ColdByDefaultDeps & {
    findHostFn?: (ownerId: string) => ColdByDefaultHostView | null;
  } = {},
): Promise<string | null> {
  try {
    if (!ownerId) return null;
    const findHost =
      deps.findHostFn ??
      ((await import('./events/await/psu-pty-discovery')).findLiveHost as (
        ownerId: string,
      ) => ColdByDefaultHostView | null);
    const host = findHost(ownerId);
    if (!host) return null; // no live host ⇒ cannot classify ⇒ keep the enrichment
    const sessionClass = sessionClassForHost(host);
    const sufficientClasses = await sufficientClassesCached(deps);
    return sufficientClasses.includes(sessionClass) ? sessionClass : null;
  } catch {
    return null;
  }
}
