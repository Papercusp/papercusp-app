/**
 * announced-quiesce — a durable, ad-hoc "I am deliberately taking <subject> down for
 * <reason> until <until>" registration any agent can make, and any health guard can
 * read back before alarming on the absence it caused (EI-22040647386284200).
 *
 * WHY THIS IS SEPARATE FROM D-026 (single-primary-check.ts's readD026QuiescenceEvidence):
 * D-026 suppresses the single-primary alarm only for ONE specific, systemd-VERIFIED
 * contract — the release-cut whole-cut unit plus its registered restore leg both active.
 * That is strong evidence (two independent systemd signals), but it is also narrow: an
 * agent that quiesces bg-host by hand — a plain `kill`/`systemctl stop` plus a shell EXIT
 * trap, exactly what a P-101 hyperbee corestore seed-cut re-run does — leaves nothing
 * D-026 can observe. The guard then reads the resulting silence as a genuine crash and
 * instructs every agent on the box to "Start the bg-host" — precisely the action the
 * quiescing agent is relying on nobody taking (observed live 2026-09-01T06:44Z, filed as
 * EI-22040647386284200: the alarm does not merely misreport, it ISSUES the harmful
 * remediation).
 *
 * This module is the missing, broader half of that contract: a small, bounded-duration,
 * self-reported announcement (`supervision:announce-quiesce`) any agent can register, and
 * any guard willing to trust weaker (self-reported, not systemd-verified) evidence can
 * read back. It deliberately does NOT replace D-026 — a systemd-verified cut+restore pair
 * remains stronger evidence than a self-report, so callers should check D-026 FIRST and
 * this SECOND (see single-primary-check.ts's evaluatePrimaryCount).
 *
 * FAIL-CLOSED BY EXPIRY, NOT BY TRUST: `until` is REQUIRED and capped (MAX_QUIESCE_MS) —
 * an unbounded self-reported silence would recreate exactly the failure this closes (a
 * false "everything is fine" that outlives the person who said so, or a mistaken/forgotten
 * announcement that never gets cleared). A record past its `until` reads back as INACTIVE
 * with no separate "end" call required, so a forgotten `end` cannot wedge the alarm off
 * forever. `endQuiesce` exists only for the cheap common case: ending on time or early.
 *
 * Same single-JSONB-row-per-workspace architecture, and the same VITEST-hermetic-fallback
 * DI shape, as supervision/pause-clock.ts (migration 812) and migration 635 — see
 * migration 1092's own comment for the full parallel.
 */
import { readOperatorState, updateOperatorState } from '../operator-state-pg';

/** One subject's currently-registered quiesce window. */
export interface AnnouncedQuiesceRecord {
  /** Why this subject is deliberately down — persisted verbatim into the advisory text. */
  reason: string;
  /** The ownerId (or role fallback) that registered this announcement. */
  by: string;
  /** Epoch ms this window was registered (or last extended). */
  announcedAt: number;
  /** Epoch ms this window expires — REQUIRED; see MAX_QUIESCE_MS. */
  until: number;
}

/** The whole durable payload: one record per announced subject (e.g. 'bg-host'). */
export type AnnouncedQuiesceState = Record<string, AnnouncedQuiesceRecord>;

/**
 * The longest a single announcement may suppress an alarm for. Generous enough for a
 * multi-hour corestore seed-cut (observed live: ~3h per cut, and a re-cut announced
 * 2026-09-01T19:40Z for another ~3h), bounded so a missed/forgotten `end` call cannot
 * silence a REAL outage indefinitely. A caller asking for longer is silently clamped to
 * this ceiling rather than refused — the announcer still gets the maximum available
 * protection, and re-announcing (which extends `until` again) is the correct way to
 * cover a genuinely longer window.
 */
export const MAX_QUIESCE_MS = 12 * 60 * 60 * 1000;

/** What a caller reading a subject's quiesce evidence gets back. `active:false` covers
 *  every non-suppressing case uniformly (no record, expired record, or a failed read) —
 *  a caller must never distinguish those, since a failed read must never be treated as
 *  "quiesced" (fail-closed: an unreadable announcement must not soften a real outage,
 *  the same rule D-026's reader already follows). */
export interface AnnouncedQuiesceEvidence {
  active: boolean;
  subject?: string;
  reason?: string;
  by?: string;
  /** ISO-8601 — rendered for a human/advisory summary, not for further arithmetic. */
  until?: string;
}

/** Test/DI seam mirroring pause-clock.ts's `PauseStoreDeps`. */
export interface AnnouncedQuiesceStoreDeps {
  update(mutate: (current: AnnouncedQuiesceState) => AnnouncedQuiesceState): Promise<AnnouncedQuiesceState>;
  read(): Promise<AnnouncedQuiesceState>;
}

/** Hermetic fallback used when no `deps` are injected AND PG is unreachable, and the
 *  VITEST-without-`deps` safety gate below — mirrors pause-clock.ts's `hermeticFallback`
 *  exactly (process-local, restores the pre-migration behaviour rather than inventing a
 *  new one). */
let hermeticFallback: AnnouncedQuiesceState = {};

/** Test seam. */
export function _resetAnnouncedQuiesceForTests(): void {
  hermeticFallback = {};
}

async function updateState(
  mutate: (current: AnnouncedQuiesceState) => AnnouncedQuiesceState,
  deps?: Pick<AnnouncedQuiesceStoreDeps, 'update'>,
): Promise<AnnouncedQuiesceState> {
  if (deps) return deps.update(mutate);
  // VITEST-without-`deps` safety gate (same rule as pause-clock.ts): a unit test
  // exercising the pure decision logic must never reach production PG.
  if (process.env.VITEST) {
    hermeticFallback = mutate(hermeticFallback);
    return hermeticFallback;
  }
  try {
    let next: AnnouncedQuiesceState = {};
    await updateOperatorState<AnnouncedQuiesceState>('operator_announced_quiesce_state', {}, (current) => {
      next = mutate(current ?? {});
      return next;
    });
    hermeticFallback = next;
    return next;
  } catch {
    // Fail-soft: registering (or clearing) an announcement must never crash the caller.
    // Degrading to process-local state costs at most a narrower suppression window; it
    // re-derives on the next write that reaches PG.
    hermeticFallback = mutate(hermeticFallback);
    return hermeticFallback;
  }
}

async function readState(deps?: Pick<AnnouncedQuiesceStoreDeps, 'read'>): Promise<AnnouncedQuiesceState> {
  if (deps) {
    try {
      return await deps.read();
    } catch {
      // Fail-CLOSED on read, same as the no-deps path below: this is a promise of
      // `readActiveAnnouncedQuiesce` itself (see AnnouncedQuiesceEvidence's doc comment),
      // not something every injected-deps caller must remember to re-wrap.
      return {};
    }
  }
  if (process.env.VITEST) return hermeticFallback;
  try {
    return (await readOperatorState<AnnouncedQuiesceState>('operator_announced_quiesce_state')) ?? {};
  } catch {
    // Fail-CLOSED on read: an unreadable announcement store must read as "nothing
    // announced", never suppress the caller's alarm on a guess.
    return {};
  }
}

/** Register (or extend) a deliberate quiesce window for `subject`. `untilMs` is clamped
 *  to `now + MAX_QUIESCE_MS`; the caller should re-announce to extend past it. */
export async function announceQuiesce(
  subject: string,
  input: { reason: string; by: string; untilMs: number },
  now: number,
  deps?: Pick<AnnouncedQuiesceStoreDeps, 'update'>,
): Promise<AnnouncedQuiesceRecord> {
  const until = Math.min(input.untilMs, now + MAX_QUIESCE_MS);
  const record: AnnouncedQuiesceRecord = { reason: input.reason, by: input.by, announcedAt: now, until };
  await updateState((current) => ({ ...current, [subject]: record }), deps);
  return record;
}

/** End a quiesce window early (e.g. the announcer finished before `until`). A no-op if
 *  none is currently registered for `subject`. */
export async function endQuiesce(
  subject: string,
  deps?: Pick<AnnouncedQuiesceStoreDeps, 'update'>,
): Promise<void> {
  await updateState((current) => {
    if (!(subject in current)) return current;
    const next = { ...current };
    delete next[subject];
    return next;
  }, deps);
}

/** PURE: is this record still an active suppression at `now`? Expiry is the fail-closed
 *  boundary — a record whose `until` has passed reads as inactive with no separate call,
 *  so a forgotten `endQuiesce` cannot wedge suppression open past the announced window. */
export function announcedQuiesceIsActive(record: AnnouncedQuiesceRecord | undefined, now: number): boolean {
  return record !== undefined && now < record.until;
}

/** Read whether `subject` currently has an active announced quiesce. See
 *  `AnnouncedQuiesceEvidence` for why every non-suppressing case (no record, expired,
 *  or a failed read) is folded into the same `active:false`. */
export async function readActiveAnnouncedQuiesce(
  subject: string,
  now: number,
  deps?: Pick<AnnouncedQuiesceStoreDeps, 'read'>,
): Promise<AnnouncedQuiesceEvidence> {
  const state = await readState(deps);
  const record = state[subject];
  if (!announcedQuiesceIsActive(record, now)) return { active: false };
  return {
    active: true,
    subject,
    reason: record!.reason,
    by: record!.by,
    until: new Date(record!.until).toISOString(),
  };
}
