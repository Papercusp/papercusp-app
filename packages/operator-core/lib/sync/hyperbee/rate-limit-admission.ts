/**
 * rate-limit-admission — EN-2 (P-RATE) write/op admission wiring (plan
 * `shared-hive-owner-enforcement-2026-06-19`, Phase EN-2).
 *
 * Wraps the substrate's per-harness op-apply sink (boot.ts `scopedApply`) so that,
 * when an owner has set a `hive_policy.rate` cap (EN-1), an over-cap op FROM A
 * MEMBER is DROPPED at write/op admission — never written to PG, so it never
 * becomes canonical on this (honest) peer. Because every honest peer runs this
 * same wrapper independently, a flooding member's excess is dropped by ALL honest
 * peers and the flood never becomes canonical (the plan's honest-majority teeth).
 *
 * This is the wiring; `rate-limiter.ts` is the pure decider. Responsibilities:
 *   1. ATTRIBUTION — resolve an op's author to a `github_user_id`. For a REMOTE
 *      op the trustworthy key is `op.sourceLogKeyHex` (the receiver-stamped source
 *      log core key — UNFORGEABLE, D-004), resolved via the admission map
 *      (`admittedIdentities`). The self-declared `op.writerPubkey` is NOT trusted.
 *      LOCAL ops (own log) are the operator's own writes and are NEVER limited.
 *   2. CLASSIFICATION — map an op to the rate classes it counts against
 *      (`ops` always; `rows` for content puts). Ephemeral + governance/identity
 *      tables are never limited (heartbeat/usage churn + owner-authored governance
 *      must not be throttled).
 *   3. ENFORCEMENT — consult the limiter; on `drop`, return `false` (the op is not
 *      applied to PG). Default-off: with no policy / no rate caps it is a pure
 *      passthrough (zero behavior change for an un-policed hive).
 *
 * FAIL-CLOSED: when a rate cap IS in force but a remote op's author cannot be
 * resolved (no admission-map entry — e.g. a concurrent revoke), the op is dropped
 * rather than slipping past unattributed (the brief's "no resolvable author under
 * a non-open policy fails closed").
 */

import type { OpEnvelope } from './op-envelope-types';
import { capForClass, type MemberRateLimiter, type RateCaps, type RateClass } from './rate-limiter';
import type { EliteNicheRateLimiter } from './elite-niche-rate-limiter';

/** The op.table (projection tag) of a federated QD elite put — the only op the
 *  per-source-per-niche cap (P-014) applies to. For such an op the wire key
 *  (`op.hbKey`) IS the niche_key (mig 464: "wire key == niche_key"). */
export const GYM_QD_ELITES_TAG = 'gym-qd-elites-by-niche';

/** Resolve the per-source-per-niche elite cap (P-014). `undefined` (⇒ unlimited)
 *  for an unset / negative / non-finite value; a finite `>= 0` (incl. 0 =
 *  block-all elite puts to any one niche) otherwise. Mirrors `capForClass`. */
export function capForNiche(caps: RateCaps | null | undefined): number | undefined {
  const raw = caps?.elitesPerNichePerHour;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return undefined;
  return raw;
}

/**
 * Tables NEVER rate-limited:
 *   - ephemeral system churn (`presence`, `usage`) — heartbeat/telemetry, not a
 *     content-spam vector; limiting them would break normal operation.
 *   - identity/governance (`contributors`, `hive-members`, `hive-settings-by-key`)
 *     — owner/system authored (and `hive-settings` carries the OWNER's signed
 *     policy itself, EN-1; throttling it could choke policy propagation).
 */
export const NEVER_RATE_LIMITED_TABLE_TAGS: ReadonlySet<string> = new Set([
  'presence',
  'usage',
  'contributors',
  'hive-members',
  'hive-settings-by-key',
]);

/**
 * Human-authored CONTENT tables — a put here counts against BOTH `ops` and the
 * `rowsPerHour` cap (the "rows that land in the canonical hive" a flood produces).
 * Everything else not in NEVER_RATE_LIMITED (queue / working-set / claims /
 * item-assignments) counts against `ops` only (orchestration, not content rows).
 */
export const CONTENT_TABLE_TAGS: ReadonlySet<string> = new Set([
  'coord-messages',
  'coord-threads',
  'coord-thread-posts',
  'coord-conversations',
  'issues',
  'engineer-issues',
  'features-by-id',
  'plans-by-slug',
  'plan-parts',
  // F1-1/F1-6 (federated-scout-gym): shareable standing facts are agent-authored
  // CONTENT — a fact-flood is exactly the rowsPerHour spam vector the caps target.
  'agent-facts-by-key',
  // F1-2/F1-6 (federated-scout-gym): foreign QD elites are agent-authored CONTENT
  // too — per-source rowsPerHour caps are the anti-spam floor for elite floods.
  'gym-qd-elites-by-niche',
]);

/**
 * The rate classes an op counts against. `[]` ⇒ never limited (ephemeral /
 * governance / unknown-table). A del counts only against `ops` (it adds no content
 * row); a content put counts against `ops` + `rows`. NOTE: `prs` is never produced
 * here — pull requests ride the CODE plane (git-sync → main), not the substrate.
 */
export function classifyOpRate(op: OpEnvelope): RateClass[] {
  const tag = op.table;
  if (!tag || NEVER_RATE_LIMITED_TABLE_TAGS.has(tag)) return [];
  if (op.type !== 'put' && op.type !== 'del') return [];
  const classes: RateClass[] = ['ops'];
  if (op.type === 'put' && CONTENT_TABLE_TAGS.has(tag)) classes.push('rows');
  return classes;
}

/**
 * A STABLE per-op identity for the limiter's re-fold idempotency. Built from the
 * unforgeable source-log key + table + key + ts + hlc, so the SAME op produces the
 * SAME id across folds (a cursor reset replays it), and distinct ops from one
 * author differ. The hlc (when present) makes two same-key writes at the same ms
 * distinct.
 */
export function buildOpId(op: OpEnvelope): string {
  const src = op.sourceLogKeyHex ?? op.writerPubkey ?? '';
  return `${src}|${op.table ?? ''}|${op.hbKey ?? ''}|${op.ts ?? ''}|${op.hlc ?? ''}`;
}

/** Origin of an op: `local` (own log / synthetic) ops are the operator's own
 *  writes and are never rate-limited; only `remote` member ops are. */
export function originOf(op: OpEnvelope, ownLogKeyHex: string): 'local' | 'remote' {
  if (op.sourceLogKeyHex === undefined) return 'local'; // synthetic / pre-merge op
  return op.sourceLogKeyHex === ownLogKeyHex ? 'local' : 'remote';
}

export interface RateDropInfo {
  authorId: number | null;
  /** The class that tripped, `'unattributable'` for a fail-closed drop, or
   *  `'niche'` for the per-source-per-niche elite cap (P-014). */
  cls: RateClass | 'unattributable' | 'niche';
  cap: number | null;
  table?: string;
  hbKey?: string;
}

export interface RateLimitedApplyDeps {
  /** The pure decider (one instance per booted harness). */
  limiter: MemberRateLimiter;
  /**
   * P-014: the per-(source-author, niche) elite decider. When present AND
   * `caps.elitesPerNichePerHour` is set, a federated elite put is ALSO gated on how
   * many the source has landed in that niche this window (the concentration axis the
   * per-source `rowsPerHour` cap can't express). Omit ⇒ no per-niche enforcement
   * (tier-1 backward-compatible; every other op is unaffected).
   */
  nicheLimiter?: EliteNicheRateLimiter;
  /** This harness's own writable log keyHex — to detect (and skip) local ops. */
  ownLogKeyHex: string;
  /**
   * Resolve a remote op's source log key → the admitted author's github_user_id
   * via the admission map (`admittedIdentities`). Returns null when unresolvable
   * (⇒ fail-closed drop while a cap is in force).
   */
  resolveAuthorId: (sourceLogKeyHex: string) => number | null;
  /**
   * The CURRENT owner-set rate caps (the cached EN-1 `hive_policy.rate` snapshot),
   * or null when there is no policy / no rate caps. Synchronous — boot refreshes
   * the snapshot once per merge pass, not per op.
   */
  currentCaps: () => RateCaps | null;
  /** The underlying apply sink to wrap (boot's per-harness scopedApply). */
  apply: (op: OpEnvelope) => Promise<boolean>;
  /** Best-effort drop observer (boot-history / telemetry). Must not throw. */
  onDrop?: (info: RateDropInfo) => void;
}

/**
 * Build the rate-limited apply wrapper. Returns a drop-in replacement for the
 * `applyImpl` the merge driver calls per winning op. When no rate policy is in
 * force it is a pure passthrough.
 */
export function makeRateLimitedApply(
  deps: RateLimitedApplyDeps,
): (op: OpEnvelope) => Promise<boolean> {
  const { limiter, nicheLimiter, ownLogKeyHex, resolveAuthorId, currentCaps, apply, onDrop } = deps;

  const safeOnDrop = (info: RateDropInfo): void => {
    if (!onDrop) return;
    try {
      onDrop(info);
    } catch {
      // observability must never abort the apply
    }
  };

  return async (op: OpEnvelope): Promise<boolean> => {
    const caps = currentCaps();
    // No policy ⇒ no enforcement ⇒ passthrough (zero behavior change).
    if (!caps) return apply(op);

    // Local (own / synthetic) ops are the operator's own writes — never limited.
    if (originOf(op, ownLogKeyHex) === 'local') return apply(op);

    const classes = classifyOpRate(op);
    if (classes.length === 0) return apply(op); // ephemeral / governance / unknown

    // Are any of this op's classes actually capped?
    const capped = classes
      .map((cls) => ({ cls, cap: capForClass(caps, cls) }))
      .filter((c) => c.cap !== undefined) as Array<{ cls: RateClass; cap: number }>;

    // P-014: is the per-source-per-niche elite cap in force for THIS op? (Only a
    // federated elite put, only when a limiter + an `elitesPerNichePerHour` cap are
    // present.) The wire key of an elite put IS the niche_key (mig 464).
    const nicheCap =
      nicheLimiter !== undefined && op.type === 'put' && op.table === GYM_QD_ELITES_TAG
        ? capForNiche(caps)
        : undefined;

    // No class cap AND no niche cap in force ⇒ passthrough (zero behavior change).
    if (capped.length === 0 && nicheCap === undefined) return apply(op);

    // A cap IS in force. Attribute the author (needed by BOTH deciders).
    const authorId = resolveAuthorId(op.sourceLogKeyHex!);
    if (authorId === null) {
      // FAIL-CLOSED: an unattributable op must not bypass an in-force cap.
      safeOnDrop({
        authorId: null,
        cls: 'unattributable',
        cap: capped[0]?.cap ?? nicheCap ?? null,
        table: op.table,
        hbKey: op.hbKey,
      });
      return false;
    }

    const opId = buildOpId(op);
    // Per-source class caps first (empty `capped` ⇒ decide returns 'unlimited', no
    // state touched). A tripped class conclusively drops.
    const outcome = limiter.decide(authorId, opId, op.ts ?? 0, capped);
    if (outcome === 'drop') {
      // Conclusive drop (mirrors the slug-filter's `out_of_scope`): not merged,
      // never canonical. Report the tightest tripped class for observability.
      const tripped = capped[0];
      safeOnDrop({
        authorId,
        cls: tripped?.cls ?? 'ops',
        cap: tripped?.cap ?? null,
        table: op.table,
        hbKey: op.hbKey,
      });
      return false;
    }

    // P-014 per-niche axis, checked AFTER the class caps admit. The (author, niche)
    // decider is a separate deterministic counter (elite-niche-rate-limiter.ts):
    // convergent, but not atomically joined with the class decide above — so a
    // niche-dropped op has already spent a class `rows` slot. That is deterministic
    // on every honest peer (⇒ convergent) and only ever bites an OVER-cap source
    // (honest under-cap traffic trips neither axis), i.e. it fails toward stricter,
    // which is the correct direction for an anti-farming cap.
    if (nicheCap !== undefined) {
      const nicheKey = op.hbKey ?? '';
      const nicheOutcome = nicheLimiter!.decide(authorId, nicheKey, opId, op.ts ?? 0, nicheCap);
      if (nicheOutcome === 'drop') {
        safeOnDrop({ authorId, cls: 'niche', cap: nicheCap, table: op.table, hbKey: op.hbKey });
        return false;
      }
    }
    return apply(op);
  };
}
