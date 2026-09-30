/**
 * policy-admission — the ONE owner-enforcement seam (plan
 * `shared-hive-owner-enforcement-2026-06-19`, Phase EN-4).
 *
 * ## Why one module
 * EN-1 (the signed policy), EN-2 (rate), and EN-3 (membership + moderation/ban)
 * built the storage + the PURE deciders. EN-4 CONSOLIDATES them into ONE
 * `applyImpl` decorator — the single place, beside the substrate's op-merge
 * driver, where every inbound op is checked against the owner's signed policy
 * before merge. boot.ts wires exactly one seam:
 *
 *   rateApply = makeRateLimitedApply({ ...EN-2 deps, apply: scopedApply })  // EN-2
 *   enforced  = makePolicyEnforcedApply({ ...EN-4 deps, apply: rateApply })  // EN-4
 *   mergeOpts.applyImpl = enforced
 *
 * So the decision stack on a REMOTE op is: ban → allowlist → takedown → content
 * (this module) → rate (EN-2's nested wrapper) → the real apply. One read of the
 * owner policy per merge pass feeds both layers. "Hard to bypass by omission":
 * enforcement lives at the single merge seam, not per-table, so a new federated
 * table can't silently skip it.
 *
 * ## What this module enforces (the EN-4-owned layers)
 *   - BAN — `isBannedGithubId` (EN-3): a banned author's ops are dropped in EVERY
 *     mode; composes with the C-001 re-key cut-off.
 *   - ALLOWLIST — under `membership:'allowlist'`, `isAllowlisted` (EN-3): a
 *     non-listed author's ops are dropped.  (`approval` mode is NOT re-decided
 *     per-op — it always returns `pending` without the approval store, which would
 *     wrongly drop already-approved authors; approval admission stays the JOIN
 *     gate's job, `hive-membership-admission.ts`. Stated honestly per Brief G.)
 *   - TAKEDOWN — an injected `isContentTakenDown` (EN-3 P-MOD `hive-moderation.ts`,
 *     wired when it lands): a taken-down content op is dropped.
 *   - CONTENT (P-CONTENT, EN-4) — payload size cap / allowed-table allowlist /
 *     banned-pattern.
 * RATE (EN-2) is enforced by the nested `makeRateLimitedApply` wrapper, NOT here.
 *
 * ## Default = no policy ⇒ passthrough
 * With no owner policy (or no EN-4-relevant rules) this is a pure passthrough —
 * existing hives are byte-for-byte unaffected. Local (own-log) ops are NEVER
 * enforced (you don't moderate yourself).
 *
 * ## Owner exemption (WI-2039866, P-004 tower↔VM outage, 2026-09-02)
 * The MEMBERSHIP layers (ban / allowlist / the unresolved-author fail-closed) exist
 * to keep strangers out. They must never lock the pot OWNER's own devices out of
 * the owner's own pot — yet that is exactly what happened: the owner's boot-time
 * policy re-author wrote an allowlist that omitted the login the owner's devices
 * are attested under, and from then on every peer (the owner's own tower and VM
 * included) silently dropped the other's ops as `policy_not_allowlisted` while the
 * merge cursor advanced and "replication live" read green. Two invariants close
 * that class here:
 *   1. `isOwnerSourceLog` — an op whose source log boot resolves to the pot owner
 *      (the device that vouched this joiner in, or a device bound to the same GitHub
 *      identity this peer announces as) is exempt from ban / allowlist / the
 *      unresolved-author drop. Takedown + content rules still apply to everyone.
 *   2. `onDrop` is a CONTRACT, not a nicety — boot wires it into the refused-op
 *      counters + boot-history, so a policy drop is never invisible again.
 *
 * ## Author attribution is unforgeable + fail-closed
 * Attribution keys off the receiver-stamped `op.sourceLogKeyHex` (D-004), resolved
 * via the admission map — NOT the self-declared `writerPubkey`. When an
 * author-dependent rule (ban list / allowlist) is in force but the author is
 * unresolvable, the op fails CLOSED (dropped) — a bad peer can't dodge the gate by
 * stripping its attribution.
 */

import type { OpEnvelope } from './op-envelope-types';
import { originOf } from './rate-limit-admission';
import type { HivePolicy } from '../../hive-policy-schema';
import { isBannedGithubId, isAllowlisted } from '../../hive-membership-policy';

/** Conclusive drop reasons (mirroring the slug-filter's `out_of_scope` — never
 *  retried; the op is permanently dropped by this honest peer). */
export type PolicyDropReason =
  | 'policy_banned'
  | 'policy_not_allowlisted'
  | 'policy_takendown'
  | 'policy_content'
  | 'policy_unresolved_author';

export type PolicyVerdict = { admit: true } | { admit: false; reason: PolicyDropReason };

/** The op's author identity, resolved from its unforgeable source-log key. */
export interface AuthorIdentity {
  githubUserId: number;
  githubUsername: string;
}

/* ------------------------------------------------------------------ *
 * P-CONTENT — typed view over EN-1's opaque `content` field
 * ------------------------------------------------------------------ */

export interface ContentPolicyView {
  /** Max federated payload size in bytes (the JSON-serialized op value). */
  maxPayloadBytes?: number;
  /** Allowlist of federated table tags a member may write. Absent/empty ⇒ all. */
  allowedTableTags?: string[];
  /** Regex source strings; an op whose serialized value matches ANY is dropped. */
  bannedPatterns?: string[];
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** Parse EN-1's opaque `policy.content` into the typed P-CONTENT view, or null
 *  when absent / malformed (⇒ no content enforcement). Defensive; never throws. */
export function parseContentPolicy(raw: unknown): ContentPolicyView | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: ContentPolicyView = {};
  if (typeof r.maxPayloadBytes === 'number' && Number.isFinite(r.maxPayloadBytes) && r.maxPayloadBytes >= 0) {
    out.maxPayloadBytes = r.maxPayloadBytes;
  }
  if (isStringArray(r.allowedTableTags)) out.allowedTableTags = r.allowedTableTags;
  if (isStringArray(r.bannedPatterns)) out.bannedPatterns = r.bannedPatterns;
  return out.maxPayloadBytes === undefined && !out.allowedTableTags && !out.bannedPatterns
    ? null
    : out;
}

/** UTF-8 byte length of an op value's JSON (0 for a del / undefined value). */
function payloadByteLength(value: unknown): number {
  if (value === undefined) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return 0;
  }
}

/** Pure content verdict: does this op satisfy the P-CONTENT rules? */
export function contentAdmits(op: OpEnvelope, content: ContentPolicyView): boolean {
  if (
    Array.isArray(content.allowedTableTags) &&
    content.allowedTableTags.length > 0 &&
    !content.allowedTableTags.includes(op.table ?? '')
  ) {
    return false;
  }
  if (typeof content.maxPayloadBytes === 'number' && payloadByteLength(op.value) > content.maxPayloadBytes) {
    return false;
  }
  if (Array.isArray(content.bannedPatterns) && content.bannedPatterns.length > 0) {
    let text = '';
    try {
      text = JSON.stringify(op.value ?? null);
    } catch {
      text = '';
    }
    for (const pat of content.bannedPatterns) {
      let re: RegExp | null = null;
      try {
        re = new RegExp(pat);
      } catch {
        re = null; // a malformed owner pattern is ignored, never crashes the gate
      }
      if (re && re.test(text)) return false;
    }
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * The pure per-op policy decision (ban → allowlist → takedown → content)
 * ------------------------------------------------------------------ */

/** Does the policy have an EN-4-layer rule that REQUIRES the op's author? */
export function needsAuthor(policy: HivePolicy): boolean {
  const banned = policy.moderation?.bannedGithubIds;
  if (Array.isArray(banned) && banned.length > 0) return true;
  if (policy.membership === 'allowlist') return true;
  return false;
}

export interface PolicyDecisionDeps {
  /** Optional EN-3 P-MOD takedown predicate (wired when `hive-moderation.ts`
   *  lands). Returns true when this op's content has been taken down by the owner. */
  isContentTakenDown?: (policy: HivePolicy, op: OpEnvelope) => boolean;
}

/**
 * THE EN-4 per-op decision against the owner policy (the layers EN-4 owns; RATE is
 * the nested EN-2 wrapper's job). Pure: no I/O, no throw. Precedence:
 *   1. banned author              → policy_banned
 *   2. allowlist-mode + not listed → policy_not_allowlisted
 *   3. taken-down content          → policy_takendown
 *   4. content rule violated       → policy_content
 * An author-dependent rule with a null author fails CLOSED.
 *
 * `ownerExempt` (see the module header): the op comes from the pot OWNER's own
 * device, so the membership layers (1, 2, and the unresolved-author drop) are
 * skipped — the owner cannot be banned from, or left off the allowlist of, their
 * own pot. Layers 3 and 4 still apply.
 */
export function decidePolicyOp(
  op: OpEnvelope,
  policy: HivePolicy,
  author: AuthorIdentity | null,
  deps?: PolicyDecisionDeps,
  ownerExempt = false,
): PolicyVerdict {
  if (!ownerExempt) {
    if (needsAuthor(policy) && author === null) {
      return { admit: false, reason: 'policy_unresolved_author' };
    }

    // 1 — ban (every mode). EN-3 `isBannedGithubId` (matches the stable numeric id).
    if (author !== null && isBannedGithubId(policy, author.githubUserId)) {
      return { admit: false, reason: 'policy_banned' };
    }

    // 2 — allowlist mode (EN-3 `isAllowlisted`, case-insensitive login). `approval`
    // is NOT decided here (the join gate owns it — see the module header).
    if (policy.membership === 'allowlist') {
      if (author === null || !isAllowlisted(policy, author.githubUsername)) {
        return { admit: false, reason: 'policy_not_allowlisted' };
      }
    }
  }

  // 3 — takedown (EN-3 P-MOD), when the predicate is wired.
  if (deps?.isContentTakenDown && deps.isContentTakenDown(policy, op)) {
    return { admit: false, reason: 'policy_takendown' };
  }

  // 4 — content rules (P-CONTENT).
  const content = parseContentPolicy(policy.content);
  if (content && !contentAdmits(op, content)) {
    return { admit: false, reason: 'policy_content' };
  }

  return { admit: true };
}

/* ------------------------------------------------------------------ *
 * The applyImpl decorator — the single boot.ts wiring point
 * ------------------------------------------------------------------ */

export interface PolicyEnforcedDropInfo {
  reason: PolicyDropReason;
  author: number | null;
  table?: string;
  hbKey?: string;
}

export interface PolicyEnforcedApplyDeps {
  /** The CURRENT owner-signed policy (the cached EN-1 `getHivePolicy().policy`
   *  snapshot), or null ⇒ no enforcement. Synchronous — boot refreshes it once per
   *  merge pass, the SAME snapshot EN-2's `currentCaps` views. */
  currentPolicy: () => HivePolicy | null;
  /** Resolve a remote op's unforgeable `sourceLogKeyHex` → its admitted author
   *  identity, or null when unresolvable (⇒ fail-closed under an author rule). */
  resolveAuthor: (sourceLogKeyHex: string) => AuthorIdentity | null;
  /** This harness's own writable log keyHex — to skip (never enforce) local ops. */
  ownLogKeyHex: string;
  /** The inner apply sink to wrap. In boot.ts this is EN-2's `makeRateLimitedApply`
   *  result, so the composed stack is ban/allowlist/content/takedown → rate → PG. */
  apply: (op: OpEnvelope) => Promise<boolean>;
  /** Optional EN-3 takedown predicate (P-MOD); wired when `hive-moderation.ts` lands. */
  isContentTakenDown?: (policy: HivePolicy, op: OpEnvelope) => boolean;
  /**
   * Owner exemption (module header): is this remote op's source log one of the pot
   * OWNER's own devices? True ⇒ the membership layers (ban / allowlist / the
   * unresolved-author drop) are skipped for it. Boot resolves it from the admitted
   * identity of the source log (device == the vouching owner device on a joiner, or
   * GitHub identity == the identity this peer itself announces as on the owner box).
   * Absent ⇒ no exemption (the pre-WI-2039866 behavior).
   */
  isOwnerSourceLog?: (sourceLogKeyHex: string, author: AuthorIdentity | null) => boolean;
  /**
   * Drop observer. NOT optional in spirit (module header): boot wires it into the
   * refused-op counters + boot-history so a policy drop is never a silent cursor
   * advance. Left optional in the type only for hermetic unit tests. Must not throw.
   */
  onDrop?: (info: PolicyEnforcedDropInfo) => void;
}

/**
 * Build the EN-4 policy-enforced apply decorator: the OUTER layer of the single
 * enforcement seam. Drops a remote op that violates the owner's ban/allowlist/
 * takedown/content rules before it reaches the inner apply (which boot composes as
 * the EN-2 rate-limited apply). Pure passthrough when there's no policy / no
 * EN-4-relevant rule; never enforces local ops.
 */
export function makePolicyEnforcedApply(
  deps: PolicyEnforcedApplyDeps,
): (op: OpEnvelope) => Promise<boolean> {
  const { currentPolicy, resolveAuthor, ownLogKeyHex, apply, isContentTakenDown, isOwnerSourceLog, onDrop } =
    deps;
  const decisionDeps: PolicyDecisionDeps | undefined = isContentTakenDown
    ? { isContentTakenDown }
    : undefined;

  const safeOnDrop = (info: PolicyEnforcedDropInfo): void => {
    if (!onDrop) return;
    try {
      onDrop(info);
    } catch {
      // observability must never abort the apply
    }
  };

  return async (op: OpEnvelope): Promise<boolean> => {
    const policy = currentPolicy();
    if (!policy) return apply(op); // no policy ⇒ passthrough
    if (originOf(op, ownLogKeyHex) === 'local') return apply(op); // own writes never enforced

    const author = op.sourceLogKeyHex != null ? resolveAuthor(op.sourceLogKeyHex) : null;
    let ownerExempt = false;
    if (isOwnerSourceLog && op.sourceLogKeyHex != null) {
      try {
        ownerExempt = isOwnerSourceLog(op.sourceLogKeyHex, author) === true;
      } catch {
        ownerExempt = false; // a resolver fault never widens admission
      }
    }
    const verdict = decidePolicyOp(op, policy, author, decisionDeps, ownerExempt);
    if (!verdict.admit) {
      safeOnDrop({
        reason: verdict.reason,
        author: author?.githubUserId ?? null,
        table: op.table,
        hbKey: op.hbKey,
      });
      return false; // dropped — never merged on this honest peer
    }
    return apply(op);
  };
}
