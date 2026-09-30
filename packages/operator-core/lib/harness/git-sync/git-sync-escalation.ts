/**
 * Pure decision core for git-sync's failure escalation (EI-18).
 *
 * Background: git-sync escalated merge CONFLICTS (→ merge-resolver) but push
 * ERRORS only ever landed in routine metadata — on 2026-06-05 the push failed
 * silently every tick for ~20h (10.4GB of accumulated Rust target/ artifacts,
 * GitHub HTTP 500) with zero fleet-visible signal. This module decides, from one
 * tick's outcome + the previous tick's counters, whether to:
 *   - write/refresh a `git-sync-error` escalation row (repeated push failures
 *     and/or oversized-file exclusions — both need a human/agent),
 *   - clear it (a genuinely clean pass),
 *   - broadcast a coord message (TRANSITION-only, so a persistent condition
 *     doesn't spam every 10-min tick).
 *
 * Deliberately PG-free: `git-sync-action.ts` reads the previous counters from
 * the routine metadata, calls this, and applies the side effects.
 */
import {
  DEFAULT_MAX_BLOB_BYTES,
  DEFAULT_MAX_COMMIT_TOTAL_BYTES,
  type RepoError,
  type ScopedOversized,
} from './run-git-sync';

/** Consecutive error ticks before the failure escalates (3 ticks ≈ 30 min).
 *  NOTE the name is historical: this counts ANY failing leg, not just pushes
 *  (EI-19275994927087666). */
export const PUSH_FAILURE_ESCALATION_TICKS = 3;

/**
 * EI-21906459740652039 — the CHRONIC cumulative-limit cadence.
 *
 * The oversized broadcast below is EDGE-TRIGGERED on newly-peeled keys, which is
 * right for a one-off stray blob and structurally blind to the condition that
 * actually happened: the SAME set peeled every tick for 13h, silent after the first,
 * because nothing about it was ever "new" again. So the absence of repeated peel
 * broadcasts is not evidence the peel stopped — it is what the edge trigger does by
 * design, and that is precisely why nobody noticed.
 *
 * A persisting peel therefore re-broadcasts on a bounded cadence: loud enough to be
 * noticed, rare enough not to be the per-tick spam the edge trigger exists to
 * prevent. First alarm at 3 consecutive ticks (past a transient bulk import that
 * clears itself), then every 18 ticks (~3h at the 10-min default).
 */
export const CHRONIC_CUMULATIVE_PEEL_TICKS = 3;
export const CHRONIC_CUMULATIVE_REBROADCAST_TICKS = 18;

/** Which LEG of a git-sync tick failed (EI-19275994927087666). */
export type GitSyncFailingLeg = 'commit' | 'push' | 'conflict' | 'config-lock' | 'unknown';

/**
 * PURE: classify which leg actually failed, from the error text git-sync recorded.
 *
 * EI-19275994927087666: both the escalation broadcast and the /admin/git deploy
 * panel used to call EVERY git-sync failure a PUSH failure, and say "commits are
 * NOT reaching origin". That sentence sends a responder at origin / credentials /
 * the pooler. For 32h it was pointing at a corrupt git object in one abandoned
 * scratch pot's tree — a COMMIT-leg fault that never touched the network, while
 * origin/staging was byte-identical to local HEAD.
 *
 * `pushMode` is only a fallback inference: a `commit-only:*` member never pushes,
 * so its failure cannot be a push failure. It is checked LAST on purpose — the
 * real offender's push_mode was `push`, so push_mode alone would not have caught
 * it. The recorded error text is the load-bearing signal.
 */
export function classifyGitSyncFailingLeg(
  lastError: string | null,
  pushMode: string | null,
): GitSyncFailingLeg {
  const e = (lastError ?? '').toLowerCase();
  if (e.includes('conflict')) return 'conflict';
  if (e.includes('could not lock config file') && e.includes('config')) return 'config-lock';
  if (e.includes('commit failed') || e.includes('commit error')) return 'commit';
  if (e.includes('push')) return 'push';
  // No usable error text: a commit-only member still cannot have push-failed.
  if (pushMode?.startsWith('commit-only')) return 'commit';
  return 'unknown';
}

/** The human sentence for a failing leg. Only the 'push' arm may claim anything
 *  about origin — that claim was the whole misdirection. */
export function gitSyncLegPhrase(leg: GitSyncFailingLeg | null): string {
  switch (leg) {
    case 'push':
      return 'push failing — commits NOT reaching origin';
    case 'commit':
      return 'COMMIT failing — nothing has reached the push stage; origin is unaffected';
    case 'conflict':
      return 'merge conflict — needs a resolver';
    case 'config-lock':
      return 'submodule config-lock contention — canonical URL sync blocked locally; origin is unaffected';
    default:
      return "cause unclassified — read that routine's last_error";
  }
}

export interface EscalationInput {
  /** The harness/install slug whose git-sync tick produced this decision.
   * Broadcasts are fleet-global, so omitting this makes a sibling harness's
   * repo-relative paths and failure streak look like the caller's own. */
  installSlug: string;
  /** `skipped-locked` is intentionally neither a failure escalation nor a clean
   * pass: a live peer lock deferred work, so preserve any existing escalation
   * until a later measured sync/nothing outcome can clear it. */
  status: 'nothing' | 'synced' | 'conflict' | 'error' | 'skipped-locked';
  /** This tick's consecutive-error count (already bumped/reset for this tick). */
  consecutiveErrorTicks: number;
  errors: RepoError[];
  /** EI-19275994927087666: this member's push mode (`push` | `commit-only:*`), used
   *  only as a fallback when the error text alone cannot classify the failing leg.
   *  OPTIONAL on purpose — an omitted value just degrades to the error-text
   *  classification, so no existing caller or fixture has to change. */
  pushMode?: string | null;
  oversized: ScopedOversized[];
  /** Effective per-file dirty-byte limit used by this git-sync tick. */
  maxBlobBytes: number;
  /** Effective cumulative dirty-set limit used by this git-sync tick. */
  maxCommitTotalBytes: number;
  /** `scope:path` keys reported oversized on the PREVIOUS tick (from metadata). */
  prevOversizedKeys: string[];
  /** EI-21906459740652039: consecutive ticks — INCLUDING this one — on which the
   *  cumulative-limit guard peeled at least one file (routine metadata
   *  `consecutive_cumulative_peel_ticks`, computed by the caller exactly like
   *  `consecutive_content_error_ticks`). 0/omitted ⇒ no chronic condition, so no
   *  existing caller or fixture has to change. */
  chronicCumulativeTicks?: number;
  /** EI-21230011589307899: the PREVIOUS tick's own-head-publish refusal, read from
   *  routine metadata (`own_head_publish.refused` / `.blockedAtCommit`).
   *
   *  WHY PREVIOUS: the own-head-publish leg runs AFTER this decision inside a tick
   *  (git-sync-action.ts — record/escalate at the `git-sync:record` step, publish at
   *  `git-sync:own-head-publish`), so THIS tick's refusal is not knowable here. A
   *  one-tick lag is the right trade: it surfaces a frozen device in ~2 ticks instead
   *  of the 51 minutes it took a human to notice on 2026-08-26, when a secret-shaped
   *  test fixture froze all egress and NOTHING raised an alarm — the same silent
   *  metadata-only failure mode EI-18 fixed for the push and oversized legs but not
   *  for this one.
   *
   *  OPTIONAL on purpose — an omitted value simply never raises `publish-refused`, so
   *  no existing caller or fixture has to change. */
  publishRefusal?: { refused: string; blockedAtCommit: string | null } | null;
  /** The refusal's `blockedAtCommit` one tick further back, so a PERSISTING freeze
   *  refreshes the escalation row without re-broadcasting every tick (mirrors
   *  `prevOversizedKeys`). */
  prevPublishBlockedAtCommit?: string | null;
}

export type EscalationReason = 'push-failure' | 'oversized-blobs' | 'publish-refused';

export interface EscalationDecision {
  /** Write/refresh the `git-sync-error` escalation row this tick. */
  escalate: boolean;
  reasons: EscalationReason[];
  /** Clear the `git-sync-error` escalation row (clean pass, nothing wrong). */
  clear: boolean;
  /** Coord broadcast summary — non-null only on a TRANSITION (threshold reached /
   *  new oversized file appeared), never on a persisting condition. */
  broadcast: string | null;
}

const formatMegabytes = (bytes: number): string =>
  Number.isFinite(bytes) ? `${(bytes / 1048576).toFixed(1)}MB` : 'an unknown byte limit';

export const oversizedKey = (f: ScopedOversized): string => `${f.scope}:${f.path}`;

export function decideGitSyncEscalation(i: EscalationInput): EscalationDecision {
  const reasons: EscalationReason[] = [];
  if (i.consecutiveErrorTicks >= PUSH_FAILURE_ESCALATION_TICKS) reasons.push('push-failure');
  if (i.oversized.length > 0) reasons.push('oversized-blobs');
  // EI-21230011589307899: a refused own-head publish freezes this device's egress
  // outright and CANNOT self-clear (the offending blob is already in history), so it
  // escalates on sight — no consecutive-tick threshold like `push-failure`, which
  // exists to absorb transient network flakes this condition never has.
  const publishRefused = i.publishRefusal?.refused ? i.publishRefusal : null;
  if (publishRefused) reasons.push('publish-refused');
  const escalate = reasons.length > 0;

  const parts: string[] = [];
  if (i.consecutiveErrorTicks === PUSH_FAILURE_ESCALATION_TICKS) {
    const detail = i.errors.map((e) => `${e.scope}: ${e.message.split('\n')[0]}`).join('; ').slice(0, 300);
    // EI-19275994927087666: say WHICH leg failed. This used to hardcode "push has
    // FAILED … local commits are NOT reaching origin" for every failure, including
    // commit-leg faults that never reached the network.
    const leg = classifyGitSyncFailingLeg(i.errors.map((e) => e.message).join('; ') || null, i.pushMode ?? null);
    parts.push(
      `⚠ git-sync on ${i.installSlug} has FAILED ${i.consecutiveErrorTicks} consecutive ticks — ${gitSyncLegPhrase(leg)}${detail ? ` (${detail})` : ''}`,
    );
  }
  const newOversized = i.oversized.filter((f) => !i.prevOversizedKeys.includes(oversizedKey(f)));
  if (newOversized.length > 0) {
    const list = newOversized
      .map((f) => `${f.scope === 'superproject' ? '' : `${f.scope}/`}${f.path} (${(f.sizeBytes / 1048576).toFixed(1)}MB)`)
      .join(', ')
      .slice(0, 400);
    const perFile = newOversized.filter((f) => f.exclusionReason !== 'cumulative-limit');
    const cumulative = newOversized.filter((f) => f.exclusionReason === 'cumulative-limit');
    const guards: string[] = [];
    if (perFile.length > 0) {
      guards.push(
        `${perFile.length} file(s) exceeded the configured per-file limit of ${formatMegabytes(i.maxBlobBytes)} ` +
          `(GitHub's individual-blob ceiling is 100MB)`,
      );
    }
    if (cumulative.length > 0) {
      guards.push(
        `the dirty set exceeded the configured cumulative limit of ${formatMegabytes(i.maxCommitTotalBytes)} ` +
          `(${cumulative.length} file(s) peeled; GitHub's 100MB ceiling applies to individual blobs, not this guard)`,
      );
    }
    parts.push(
      `⚠ git-sync on ${i.installSlug} EXCLUDED file(s) from the auto-commit — ${guards.join('; ')}; ` +
        `gitignore or remove them: ${list}`,
    );
  }

  // EI-21906459740652039: the `newOversized` edge trigger above cannot see a
  // CHRONIC peel — the same paths, every tick, never "new" after the first. Say so
  // explicitly on a bounded cadence, and say the thing an operator needs to know:
  // these paths have not been committed for the whole window, so anything derived
  // from them (a regenerated docs mirror, a projected catalog) is stale on disk while
  // git-sync keeps reporting success.
  const chronicTicks = i.chronicCumulativeTicks ?? 0;
  const cumulativeNow = i.oversized.filter((f) => f.exclusionReason === 'cumulative-limit');
  const sinceFirstAlarm = chronicTicks - CHRONIC_CUMULATIVE_PEEL_TICKS;
  if (
    cumulativeNow.length > 0 &&
    sinceFirstAlarm >= 0 &&
    sinceFirstAlarm % CHRONIC_CUMULATIVE_REBROADCAST_TICKS === 0
  ) {
    const list = cumulativeNow
      .slice(0, 6)
      .map((f) => `${f.scope === 'superproject' ? '' : `${f.scope}/`}${f.path}`)
      .join(', ')
      .slice(0, 300);
    parts.push(
      `⚠ git-sync on ${i.installSlug}: the cumulative-limit guard has peeled file(s) for ` +
        `${chronicTicks} CONSECUTIVE ticks — ${cumulativeNow.length} file(s) this tick, and they have NOT ` +
        `been committed for that whole window even though every tick reported success. If any is a ` +
        `generated projection (the internal-docs mirror, a catalog artifact), what is SERVED is stale ` +
        `relative to disk. Raise the cumulative limit, gitignore the offenders, or remove them: ${list}`,
    );
  }

  // Broadcast only when the freeze POINT moves (or first appears) — a persisting
  // refusal still refreshes the escalation row above, but must not re-broadcast every
  // tick for however long it takes someone to clear it.
  if (publishRefused && (publishRefused.blockedAtCommit ?? null) !== (i.prevPublishBlockedAtCommit ?? null)) {
    const at = publishRefused.blockedAtCommit ? publishRefused.blockedAtCommit.slice(0, 12) : 'an unrecorded commit';
    parts.push(
      `⚠ git-sync on ${i.installSlug}: own-head publish REFUSED (${publishRefused.refused}) at ${at} — ` +
        `this device's egress is FROZEN and every later commit queues behind it. Note a bridged install never ` +
        `pushes to origin itself, so a stale origin ref is the SYMPTOM, not the cause; read ` +
        `metadata->'own_head_publish' (healthy = refused:null AND publishedSha==sha). Fixing the offending file ` +
        `forward does NOT clear this — the blob is already in history. Clear a confirmed false positive with ` +
        `pot_git:secrets_exemptions { action:'add', path:'<exact repo-relative path>', reason:'<why>' }.`,
    );
  }

  // A pass is only "clean" when nothing moved wrong AND no oversized files linger —
  // 'nothing' with oversized still has the unpushable file sitting in the tree.
  const clear = !escalate && (i.status === 'synced' || i.status === 'nothing');

  return { escalate, reasons, clear, broadcast: parts.length > 0 ? parts.join('\n') : null };
}

/**
 * P-009 (review-system-rework-reduction-2026-09-23; EI-24015486799447670): a content
 * quarantine must never be SILENT. On 2026-09-23 a secret-shaped test sentinel held 29
 * files out of the auto-commit for 18 ticks (~1h). Its author's session had already
 * ended, the single needs-human message at the fixer-budget tick went to that dead
 * inbox, and nothing re-alarmed. The only signal left was routine metadata. Three
 * notices close that gap:
 *  - `editor-first-tick`: the FIRST quarantined tick tells the file's last editor,
 *    while they are most likely still live and can fix it with one edit.
 *  - `alarm`: the tick the content-fixer budget runs out (the pre-existing
 *    needs-human transition).
 *  - `realarm`: every `realarmEveryTicks` ticks while the quarantine persists after
 *    that, so a quarantine that outlives its first alarm is re-surfaced.
 */
export const CONTENT_QUARANTINE_REALARM_TICKS = 12;

export type ContentQuarantineNotice = 'editor-first-tick' | 'alarm' | 'realarm';

export function decideContentQuarantineNotice(i: {
  /** Consecutive quarantined ticks INCLUDING this one. */
  contentTicks: number;
  /** The count one tick earlier (0 = this is the first quarantined tick). */
  prevContentTicks: number;
  /** The tick on which the content-fixer budget is exhausted. */
  alarmTicks: number;
  realarmEveryTicks?: number;
}): ContentQuarantineNotice | null {
  if (i.contentTicks <= 0) return null;
  const every = Math.max(1, i.realarmEveryTicks ?? CONTENT_QUARANTINE_REALARM_TICKS);
  if (i.contentTicks >= i.alarmTicks) {
    if (i.prevContentTicks < i.alarmTicks) return 'alarm';
    const since = i.contentTicks - i.alarmTicks;
    return since > 0 && since % every === 0 ? 'realarm' : null;
  }
  return i.prevContentTicks === 0 ? 'editor-first-tick' : null;
}

/** Verdicts under which nobody will read the message. */
const CONTENT_NOTICE_UNREACHABLE = new Set(['ended', 'recorded']);
/** Verdicts that prove somebody will read it. */
const CONTENT_NOTICE_REACHABLE = new Set(['live', 'parked', 'draining', 'suspect']);

/**
 * Who receives a content-quarantine notice. `editors` is the attribution result
 * (`['*']` = unattributable) and `stateOf` is the liveness oracle's `sessionState`.
 *
 * A first-tick notice goes only to attributed editors who are not known to be gone,
 * and is never a broadcast. A 1-tick quarantine is usually an agent mid-edit, so
 * waking the fleet for it would be noise. An alarm needs a PROVEN-reachable
 * editor. Otherwise it falls back to the broadcast, because an alarm addressed only
 * to an ended session is the silent failure this exists to prevent.
 */
export function selectContentNoticeRecipients(
  notice: ContentQuarantineNotice,
  editors: readonly string[],
  stateOf: (ownerId: string) => string | null | undefined,
): string[] {
  const attributed = [...new Set(editors.filter((e) => e && e !== '*'))];
  if (notice === 'editor-first-tick') {
    return attributed.filter((e) => !CONTENT_NOTICE_UNREACHABLE.has(stateOf(e) ?? ''));
  }
  const reachable = attributed.filter((e) => CONTENT_NOTICE_REACHABLE.has(stateOf(e) ?? ''));
  return reachable.length > 0 ? reachable : ['*'];
}
