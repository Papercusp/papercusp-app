/**
 * Recurrence → next-fire-time for the routines engine.
 *
 * Plan: scheduled-recurring-plans-2026-06-16 (P-006, D-004).
 *
 * The engine schedules on the `next_fire_at` TIMESTAMP, not on cron — cron is
 * merely one dialect that computes it (cron.ts), and RRULE is another. We NEVER
 * convert RRULE→cron: cron is strictly less expressive (no interval-from-anchor,
 * COUNT, UNTIL, or nth-weekday). Per cron.ts's own note, the engine depends only
 * on a `(rule, from) -> Date | null` contract; this module is the RRULE branch
 * plus the dispatcher over a routine's `trigger_config` / a plan's `schedule`
 * shape.
 */
import { createRequire } from 'node:module';
import { computeNextFireAt } from './cron';
import type { AgenticPlanExecutionTarget } from '../../agentic-plan-execution-target';

// `rrule` is a CommonJS package: under the ESM/tsx host its classes are exposed on the
// DEFAULT export, NOT as statically-detectable named exports, so `import { RRule } from
// 'rrule'` throws `The requested module 'rrule' does not provide an export named 'RRule'`
// at module load. That took down EVERY consumer of this routine's transitive import graph
// — notably `fleet:place_batch` on the staging operator (:3170), which 500'd on every
// placement. Load it via createRequire (the repo's ESM-safe CJS pattern; cf.
// libs/generic/resource-profile) so the named classes resolve at runtime.
const { RRule, RRuleSet } = createRequire(import.meta.url)('rrule') as typeof import('rrule');

// luxon ships no type declarations in this install (no `types` field / bundled .d.ts) and
// `@types/luxon` is not a dependency, so a static `import { DateTime } from 'luxon'` trips TS7016.
// Load it via createRequire (the same ESM-safe CJS pattern as rrule above) with a minimal local
// type for the slice we use — typed floating-frame conversion without adding a dependency.
interface LuxonDateTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
  setZone(zone: string): LuxonDateTime;
  toJSDate(): Date;
}
const { DateTime } = createRequire(import.meta.url)('luxon') as {
  DateTime: {
    fromJSDate(date: Date, opts?: { zone?: string }): LuxonDateTime;
    fromObject(obj: Record<string, number>, opts?: { zone?: string }): LuxonDateTime;
  };
};

/**
 * tzid handling (EI-1370). The `rrule` lib's own `opts.tzid` mis-handles a calendar-time rule
 * anchored on an absolute-instant DTSTART — `BYHOUR=9` came out at 09:00 UTC, not 09:00 in the
 * zone. So when a `tzid` is set we instead run the rule in a FLOATING frame (a Date's UTC
 * components ARE the wall-clock in `tzid`, per RFC 5545 DTSTART;TZID semantics), converting the
 * query bound IN and each result OUT with luxon. luxon resolves DST correctly (9am ET = 13:00 UTC
 * in summer, 14:00 UTC in winter). Non-tz schedules keep the prior UTC-floating behavior untouched.
 */
/** Real absolute instant → floating Date whose UTC components equal the wall-clock in `tzid`. */
function realToFloating(real: Date, tzid: string): Date {
  const z = DateTime.fromJSDate(real, { zone: 'utc' }).setZone(tzid);
  return new Date(Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second, z.millisecond));
}
/** Floating Date (UTC components = wall-clock in `tzid`) → the real absolute instant. */
function floatingToReal(floating: Date, tzid: string): Date {
  return DateTime.fromObject(
    {
      year: floating.getUTCFullYear(),
      month: floating.getUTCMonth() + 1,
      day: floating.getUTCDate(),
      hour: floating.getUTCHours(),
      minute: floating.getUTCMinutes(),
      second: floating.getUTCSeconds(),
      millisecond: floating.getUTCMilliseconds(),
    },
    { zone: tzid },
  ).toJSDate();
}
/** Normalized non-empty tzid, or null. */
function normTzid(tzid: string | undefined): string | null {
  return tzid && tzid.trim() ? tzid.trim() : null;
}

/**
 * The recurrence config stored on a routine's `trigger_config` (and authored on
 * a plan's `schedule` column). RRULE-native recurrence SET (rrule + rdate +
 * exdate, anchored on dtstart/tzid); `cron` is the alternate input dialect.
 */
export interface ScheduleTrigger {
  kind?: 'rrule' | 'cron';
  /** RRULE string (RFC 5545), e.g. 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;INTERVAL=2'. */
  rrule?: string;
  /** DTSTART anchor (ISO). Required for INTERVAL/COUNT/UNTIL to be meaningful. */
  dtstart?: string;
  /** IANA tz id for calendar-time recurrence (D-013). */
  tzid?: string;
  /** Explicit added occurrences (RDATE, ISO). */
  rdate?: string[];
  /** Excluded occurrences (EXDATE, ISO) — holidays, a dragged-off instance, etc. */
  exdate?: string[];
  /** Cron dialect (5/6-field) — the alternate input. */
  cron?: string;
  /** Carried with the authored schedule; recurrence math deliberately ignores it. */
  execution?: AgenticPlanExecutionTarget;
}

/**
 * Next fire strictly AFTER `from` (exclusive) for an RRULE recurrence SET, or
 * null when the rule is unparseable / has no further occurrence (COUNT or UNTIL
 * exhausted). Builds an RRuleSet so RDATE additions and EXDATE exclusions are
 * honored (the "edit this occurrence vs all occurrences" model, D-004).
 */
export function computeNextFireFromRrule(cfg: ScheduleTrigger, from: Date): Date | null {
  if (!cfg.rrule || !cfg.rrule.trim()) return null;
  try {
    const opts = RRule.parseString(cfg.rrule);
    const dt = cfg.dtstart ? new Date(cfg.dtstart) : undefined;
    if (dt && Number.isFinite(dt.getTime())) opts.dtstart = dt;
    // NB: we do NOT set opts.tzid — the zone is applied via the floating-frame conversion below
    // (EI-1370); rrule's own tzid path mis-handles an absolute-instant DTSTART.

    const set = new RRuleSet();
    set.rrule(new RRule(opts));
    for (const iso of cfg.rdate ?? []) {
      const d = new Date(iso);
      if (Number.isFinite(d.getTime())) set.rdate(d);
    }
    for (const iso of cfg.exdate ?? []) {
      const d = new Date(iso);
      if (Number.isFinite(d.getTime())) set.exdate(d);
    }

    const tzid = normTzid(cfg.tzid);
    if (tzid) {
      // Calendar-time in `tzid`: convert the query bound IN (real→floating) and the result OUT
      // (floating→real) so BYHOUR/BYMINUTE mean wall-clock in the zone, DST-correct.
      const next = set.after(realToFloating(from, tzid), false);
      return next ? floatingToReal(next, tzid) : null;
    }
    const next = set.after(from, false); // exclusive — strictly after `from`
    return next ?? null;
  } catch {
    return null;
  }
}

/**
 * The engine's recurrence dispatcher: compute the next fire for a routine's
 * `trigger_config` (or a plan's `schedule`), dispatching on shape. RRULE takes
 * precedence when present; otherwise cron. Returns null when neither yields a
 * future occurrence — the same contract `claim.ts` already expects from
 * `computeNextFireAt` (a null next_fire_at deactivates a one-shot).
 */
export function computeNextFire(cfg: ScheduleTrigger | null | undefined, from: Date): Date | null {
  if (!cfg) return null;
  if (cfg.kind === 'rrule' || cfg.rrule) return computeNextFireFromRrule(cfg, from);
  if (cfg.cron) return computeNextFireAt(cfg.cron, from);
  return null;
}

/**
 * All occurrences of a recurrence within [rangeStart, rangeEnd] (inclusive) — the
 * calendar window expansion (P-018). The calendar is driven from these
 * backend-computed occurrences (one source of truth; the calendar lib stays
 * swappable). RRULE uses RRuleSet.between so RDATE additions + EXDATE exclusions
 * are honored; cron is stepped (no native range expansion). A bare `scheduled_at`
 * one-shot carries no rrule/cron and is added by the caller. `limit` bounds a
 * pathological sub-minute cadence over a wide window.
 */
export function expandOccurrences(
  cfg: ScheduleTrigger | null | undefined,
  rangeStart: Date,
  rangeEnd: Date,
  limit = 500,
): Date[] {
  if (!cfg || rangeEnd.getTime() < rangeStart.getTime()) return [];
  if (cfg.rrule) {
    try {
      const opts = RRule.parseString(cfg.rrule);
      const dt = cfg.dtstart ? new Date(cfg.dtstart) : undefined;
      if (dt && Number.isFinite(dt.getTime())) opts.dtstart = dt;
      // NB: zone applied via the floating-frame conversion below, not opts.tzid (EI-1370).
      const set = new RRuleSet();
      set.rrule(new RRule(opts));
      for (const iso of cfg.rdate ?? []) {
        const d = new Date(iso);
        if (Number.isFinite(d.getTime())) set.rdate(d);
      }
      for (const iso of cfg.exdate ?? []) {
        const d = new Date(iso);
        if (Number.isFinite(d.getTime())) set.exdate(d);
      }
      // `limit` MUST be enforced by rrule's stopping iterator, never by slicing the
      // result: `between()` materializes EVERY occurrence in the range before it
      // returns, so a post-hoc `.slice(0, limit)` bounds the ARRAY while leaving the
      // WORK unbounded — cost stays linear in the range, not in `limit`. Returning
      // false halts expansion at the source (CallbackIterResult.add: true pushes and
      // continues, false stops WITHOUT pushing, so `len < limit` yields exactly
      // `limit`). Measured on the live FREQ=MINUTELY;INTERVAL=15 schedule: a 50y
      // window cost 10.2s sliced vs 4.9ms bounded. That 48-92s main-thread block is
      // what the event-loop sentinel SIGKILLed papercup-bg-host for, 181 times, and
      // bg-host is the git-sync/routines primary — so this starved the whole fleet's
      // commit path (WI-37716).
      const stopAtLimit = (_d: Date, len: number): boolean => len < limit;
      const tzid = normTzid(cfg.tzid);
      if (tzid) {
        // Expand in the zone: bounds IN (real→floating), each occurrence OUT (floating→real).
        const occ = set.between(
          realToFloating(rangeStart, tzid),
          realToFloating(rangeEnd, tzid),
          true,
          stopAtLimit,
        );
        return occ.map((d) => floatingToReal(d, tzid));
      }
      return set.between(rangeStart, rangeEnd, true, stopAtLimit); // inclusive bounds
    } catch {
      return [];
    }
  }
  if (cfg.cron) {
    const out: Date[] = [];
    // step from just before rangeStart so an occurrence exactly at the bound is included
    let cursor = new Date(rangeStart.getTime() - 1);
    for (let i = 0; i < limit; i++) {
      const next = computeNextFireAt(cfg.cron, cursor);
      if (!next || next.getTime() > rangeEnd.getTime()) break;
      out.push(next);
      cursor = next;
    }
    return out;
  }
  return [];
}

/**
 * A warning if a schedule fires very frequently — the doable half of "warn on
 * expensive × frequent" (P-013 / D-012): frequency is knowable at author time,
 * expense is not until runs accrue. Returns null for a one-shot / reasonable cadence.
 * Measures the gap between the next two occurrences from `from`.
 */
export function frequencyWarning(
  cfg: ScheduleTrigger | null | undefined,
  from: Date,
  minIntervalMs = 15 * 60_000,
): string | null {
  if (!cfg || (!cfg.rrule && !cfg.cron)) return null;
  const f1 = computeNextFire(cfg, from);
  if (!f1) return null;
  const f2 = computeNextFire(cfg, f1);
  if (!f2) return null; // no second occurrence ⇒ effectively one-shot / exhausted
  const interval = f2.getTime() - f1.getTime();
  if (interval >= minIntervalMs) return null;
  const mins = Math.max(1, Math.round(interval / 60_000));
  return `This schedule fires very frequently (~every ${mins} min); each fire spawns a run — watch cost (set schedule.costCapCents; global/per-plugin budget caps also apply).`;
}

/**
 * Validate an authored RRULE string before it's stored (P-014). Checks it parses
 * and carries a FREQ (the one required RRULE part); a parse error or a missing FREQ
 * is rejected with a reason. Does NOT require a future occurrence — an exhausted
 * COUNT/UNTIL is an expiry concern, not an authoring error.
 */
export function validateRrule(rrule: string): { ok: true } | { ok: false; error: string } {
  if (!rrule || !rrule.trim()) return { ok: false, error: 'empty rrule' };
  try {
    const opts = RRule.parseString(rrule);
    if (opts.freq === undefined || opts.freq === null) {
      return { ok: false, error: 'rrule missing FREQ' };
    }
    new RRule(opts); // construct to surface an invalid option combination
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'invalid rrule' };
  }
}
