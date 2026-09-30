/**
 * enrichBusy — augment file-lock contention rows with the holder's declared
 * coord intent + focus. Extracted from `locks/acquire.ts` so the file-lock
 * contention formatter can be shared by BOTH `locks:acquire` and the
 * server-side `file-lock-guard` (P-013) WITHOUT the latter dragging the whole
 * `locks:acquire` tool (await/grant-bridge/events machinery) into the
 * capability:write/edit dispatch path.
 */

import { getPresence } from '../coordination/presence';
import { PLACEHOLDER_INTENT, isLifecycleIntent } from '../coordination/presence-payload';
import type { AcquireBusy } from './su-lock-store';
import type { CellReader } from '../../cell-registry';
import type { HolderContext, HolderContextSources } from '../../coord/holder-context';
import { resolveHolderAdvisoryMap } from '../coordination/holder-advisory';

export interface BusyJson {
  path: string;
  /** Canonical owner id of the holder (#5 — unredacted; SU is admin-tier). */
  owner: string;
  owner_label: string | null;
  intent: string;
  expires_ts: string;
  /** Holder's DECLARED coord intent (coord:declare-intent → presence), when
   *  meaningful. The lock's own `intent` is uninformative for the common
   *  hook-acquired edit lock ('PreToolUse:Edit' / 'capability:write'); this
   *  answers "what are they changing?" for a blocked peer. */
  holder_intent?: string;
  /** True when the holder declared THIS path among their current_files. */
  holder_focused?: boolean;
  /** EI-10433: true when the lock's OWN stated intent and the holder's CURRENT
   *  declared coord intent are on clearly different threads AND the holder is
   *  not focused on this path — i.e. the holder acquired this lock for one task,
   *  has since declared they moved to another, and never released it. A blocked
   *  peer reads this as "likely orphaned, not actively contended" so it needn't
   *  cross-reference coord:presence by hand or wait out the full TTL. */
  holder_intent_diverged?: boolean;
  /**
   * P-026 / D-055 A1 — the holder's GOAL and ASSUMPTIONS, in the one shape every
   * D-055 friction point renders (`coord/holder-context.ts`). Omitted entirely
   * when there is nothing disclosable to THIS reader.
   *
   * ⚠ NOT A DUPLICATE OF `holder_intent`, and the two can legitimately differ.
   * `holder_intent` is the holder's CURRENT declared coord presence intent —
   * "what are they on right now", and the input to `holder_intent_diverged`.
   * `holder_context.goalText` is the goal declared on the CLAIM they hold, with
   * its ref, its age and its assumptions. A blocked peer reads the first to judge
   * whether this lock is orphaned, and the second to judge whether to wait.
   */
  holder_context?: HolderContext;
}

export function busyToJson(b: AcquireBusy): BusyJson {
  return {
    path: b.path,
    owner: b.owner,
    owner_label: b.owner_label,
    intent: b.intent,
    expires_ts: b.expires_ts.toISOString(),
  };
}

/** The OMP turn-start hook heartbeats this exact intent every turn, so treat it
 *  as "nothing meaningful declared" rather than surfacing it. */
// PLACEHOLDER_INTENT is imported from coordination/presence-payload (canonical —
// one string shared by the read-side normalization + this busy-holder detection).

/** Hook/dispatch-stamped lock intents that don't identify WHAT the holder is
 *  changing, so the lock's own intent can't be compared against the holder's
 *  declared coord intent (e.g. 'PreToolUse:Edit', 'capability:edit').
 *
 *  Delegates to the canonical predicate (EI-20055604348536487) — this used to be a third local
 *  copy, and the copies had already drifted apart from each other. Kept as a named local alias
 *  because the call sites below read against LOCK intent specifically. */
const isUninformativeLockIntent = isLifecycleIntent;

/** Work-item-ish refs (WI-4138, EI-10433, F-FIX-046, P-011, …). Extracted so a
 *  shared ref between the two intents counts as "same thread, not diverged". */
function intentRefs(s: string): string[] {
  return (s.match(/\b[a-z]{1,4}-\d[\w-]*/gi) ?? []).map((r) => r.toUpperCase());
}

function normIntent(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * EI-10433: true when the lock's OWN stated intent and the holder's CURRENT
 * declared coord intent are on clearly different threads — the "orphaned lock"
 * signal. Conservative (favours NOT flagging): an uninformative/placeholder
 * lock intent, an empty/equal holder intent, a substring relationship, or a
 * shared work-item ref all mean "not diverged".
 */
export function intentsDiverged(lockIntent: string, holderIntent: string): boolean {
  if (isUninformativeLockIntent(lockIntent)) return false;
  const a = normIntent(lockIntent);
  const b = normIntent(holderIntent);
  if (!a || !b || a === b) return false;
  if (a.includes(b) || b.includes(a)) return false; // one thread refining the other
  const [ra, rb] = [intentRefs(a), intentRefs(b)];
  if (ra.length && rb.length && ra.some((r) => rb.includes(r))) return false; // same work-item
  return true;
}

/**
 * Enrich busy rows with the holder's declared coord intent (presence) and, when
 * the blocked caller is identified, their P-026 {@link HolderContext}.
 *
 * Best-effort: a presence miss just leaves the row unenriched. One getPresence
 * per DISTINCT holder, and only on contention, so the cost is paid rarely — the
 * holder-context legs ride the same per-holder fan-out.
 *
 * ⚠ `reader` IS OPTIONAL BUT ITS ABSENCE FAILS CLOSED, never open. Holder context
 * is reader-relative (a holder's assumptions are audience-scoped), so a caller
 * that cannot identify its reader gets NO context rather than a default audience
 * — `resolveHolderContext` enforces this, for the same reason `getCell` requires
 * a reader: a defaulted audience is a defaulted access check.
 */
export async function enrichBusy(
  rows: AcquireBusy[],
  reader?: CellReader,
  opts: { sources?: HolderContextSources; nowMs?: number } = {},
): Promise<BusyJson[]> {
  const owners = [...new Set(rows.map((r) => r.owner))];
  const byOwner = new Map<string, Awaited<ReturnType<typeof getPresence>>>();

  /**
   * ⚠ ROUTED THROUGH THE SHARED FAN-OUT (P-012). This used to call
   * `resolveHolderContext` directly in the per-owner loop below — a second copy of
   * "resolve once per holder", in the SAME directory as `locks/queue.ts`, which
   * already went through the shared wiring. Two surfaces resolving one projection
   * two ways is the divergence D-038 axis 5 forbids, and it cost something real
   * here: `resolveHolderAdvisoryMap` caps the distinct-holder fan-out at
   * HOLDER_ADVISORY_DISTINCT_CAP and reports what it skipped, while the local copy
   * was UNBOUNDED — one resolution per distinct owner contending the lock, however
   * many that turned out to be.
   *
   * ⚠ NO `subjectRef`, and that is correct rather than an omission: D-094 subtracts
   * the subject from `competing` so a holder is never named as its own rival, but
   * the subject HERE is a lock PATH, which can never appear in a competing list of
   * item refs (`HolderAdvisoryOpts.subjectRef` says exactly this).
   */
  const [advisory] = await Promise.all([
    resolveHolderAdvisoryMap(reader ? owners : [], reader, { sources: opts.sources, nowMs: opts.nowMs }),
    Promise.all(owners.map(async (o) => void byOwner.set(o, await getPresence(o).catch(() => null)))),
  ]);
  return rows.map((b) => {
    const json = busyToJson(b);
    const p = byOwner.get(b.owner) ?? null;
    const intent = p?.intent?.trim();
    if (intent && intent !== PLACEHOLDER_INTENT) json.holder_intent = intent;
    // ⚠ DECLARED files ONLY — never derive this from the holder's lock holdings
    // (EI-18776963284535761). The holder holds a lock on `b.path` by definition (that is
    // why this row is contended), so a lock-derived `currentFiles` makes this term
    // CONSTANT-TRUE, the veto below always fires, and `holder_intent_diverged` can never
    // be reported again. That is the mirror image of the bug this comment came from: the
    // column used to be wiped by every coord:orient, making the term constant-FALSE and
    // the veto dead — so a live, actively-focused holder got advertised as "likely
    // orphaned". Both directions are silent. The signal only means anything while it is
    // what the holder SAID they are on, independent of what they hold.
    if (p?.currentFiles?.includes(b.path)) json.holder_focused = true;
    // EI-10433: flag a likely-orphaned lock — the holder's CURRENT declared
    // intent has moved off the lock's OWN stated intent and they aren't focused
    // on this path, so it's stale rather than actively contended.
    if (
      json.holder_intent &&
      json.holder_focused !== true &&
      intentsDiverged(b.intent, json.holder_intent)
    ) {
      json.holder_intent_diverged = true;
    }
    const ctx = advisory.forRow(b.owner);
    if (ctx) json.holder_context = ctx;
    return json;
  });
}
