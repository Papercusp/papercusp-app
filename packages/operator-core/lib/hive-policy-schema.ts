/**
 * hive-policy-schema — the typed, versioned, forward-compatible Hive policy model
 * and the canonical signing surface (shared-hive-owner-enforcement-2026-06-19 EN-1).
 *
 * PURE: no I/O, no PG, no keychain. This module is the SINGLE SOURCE OF TRUTH for
 * the bytes the owner signs and a member verifies — the owner-side signer
 * (hive-policy-author.ts) and the member-side projection (projections/hive-policy.ts)
 * BOTH derive the signed bytes from {@link hivePolicySignedBytes}, so they can never
 * drift (a drift would silently reject every legit policy).
 *
 * FORWARD-COMPATIBILITY (EN-1 build step 2): a policy is an open record. Unknown keys
 * are PRESERVED, never dropped — the canonical form is computed over the WHOLE parsed
 * object, so an older peer that doesn't understand a newer field still (a) round-trips
 * it and (b) verifies the owner signature that covers it. The typed {@link HivePolicy}
 * fields are a *lens* over the stored document, not an exhaustive schema. Default =
 * absent policy ⇒ permissive (no enforcement); existing Hives are unaffected.
 */

import {
  type PlanAdmissionPolicy,
  validatePlanAdmissionPolicy,
} from './agent-tools/plans/plan-admission-policy';

/** Per-member rate caps (EN-2 P-RATE reads these). Absent ⇒ no limiting. */
export interface HivePolicyRate {
  opsPerMin?: number;
  rowsPerHour?: number;
  prsPerDay?: number;
  /**
   * F1-6/P-014 (federated-scout-gym, D-005 hole 3): max federated QD elite puts one
   * source may land in ONE niche per hour. The per-niche axis the `rowsPerHour` cap
   * can't express — it bounds a source's TOTAL elite volume, not concentration on a
   * single locally-empty niche (the novelty-gift FARM vector, since descriptor/niche
   * classification is author-side). Enforced by EliteNicheRateLimiter. Absent ⇒ no
   * per-niche cap (tier-1 backward-compatible).
   */
  elitesPerNichePerHour?: number;
}

/** Membership admission mode (EN-3 P-MEMBER). Absent ⇒ 'open' (today's behavior). */
export type HiveMembershipMode = 'open' | 'approval' | 'allowlist';

/** Moderation policy (EN-3 P-MOD). All optional; absent ⇒ no moderation. */
export interface HivePolicyModeration {
  /** A member may file `report`s against content/members. */
  reportable?: boolean;
  /** GitHub user ids the owner banned (EN-3 reads for rejoin-deny + revoke teeth). */
  bannedGithubIds?: string[];
  /** Content refs the owner took down (EN-3 honors as federated tombstones). */
  takedownList?: string[];
}

export interface HivePolicyComms {
  /** Default comms-trust tier for members (P-012). */
  defaultTier?: 'observe' | 'message' | 'wake' | 'steer';
  /** Forward-compat: future comms knobs are preserved + signed. */
  [k: string]: unknown;
}

/**
 * One canonical-ref rule (G-6 P-030, cross-machine-coord-parity-and-trust-2026-07-01).
 * Keyed by a ref PATTERN in {@link HivePolicyCrefs.rules}; a ref matching the pattern
 * becomes CANONICAL only when `threshold` distinct keys from `allow` have signed it
 * (e.g. `refs/tags/releases/*` → allow = [green-bot key, owner key], threshold 2).
 */
export interface HivePolicyCrefsRule {
  /** Identity pubkeys (base64) whose signatures count toward the threshold. */
  allow?: string[];
  /** How many DISTINCT `allow` keys must have signed the ref (1 ≤ threshold ≤ allow.length). */
  threshold?: number;
  /** Forward-compat: future rule knobs are preserved + signed. */
  [k: string]: unknown;
}

/**
 * Canonical-ref rules (G-6 P-030) — the crefs-style trust rules for release-class refs,
 * owner-signed like the rest of the policy. `rules` maps a ref pattern (exact ref name,
 * or a glob where `*` matches any characters INCLUDING `/` — so `refs/tags/releases/*`
 * covers `refs/tags/releases/v1` and `refs/tags/releases/2026/v1`) to its rule. Resolve
 * with {@link resolveCanonicalRule}. Absent ⇒ no ref is policy-canonical (permissive
 * default, consistent with the rest of the policy model).
 */
export interface HivePolicyCrefs {
  rules?: Record<string, HivePolicyCrefsRule>;
  /** Forward-compat: future crefs knobs are preserved + signed. */
  [k: string]: unknown;
}

/**
 * One owner-adjudicated secrets-scan waiver (WI-10002785). Same path grammar as the
 * local table (secrets-guard-exemptions.ts `isPathExempt`): an exact file, or a
 * directory prefix spelled `dir/` or `dir/**`.
 */
export interface HivePolicySecretsGuardExemption {
  path: string;
  /** Why the owner judged the finding a false positive (required — this is a waiver). */
  reason: string;
  createdBy?: string;
  createdAt?: string;
  /** Forward-compat: future per-waiver knobs are preserved + signed. */
  [k: string]: unknown;
}

/**
 * WI-10002785 — owner-signed secrets-scan waivers that travel with the Hive.
 *
 * ROOT CAUSE this closes: `harness_shared.secrets_guard_path_exemptions` is host-local,
 * so a false positive the owner adjudicated on one machine re-refuses on every joined
 * peer that folds the same history (the Mac VM refused refs/heads/staging on 34 findings
 * the tower had waived). Riding the signed policy gives the waiver the policy's trust
 * model for free: only the Swarm holding the Hive key can author it, and every member
 * drops a forged or unsigned policy at apply (projections/hive-policy.ts). A member's
 * local row stays local — a member can never widen what the owner's guards accept.
 */
export interface HivePolicySecretsGuard {
  /** Sorted by path, one entry per path (see {@link withSecretsGuardExemption}). */
  pathExemptions?: HivePolicySecretsGuardExemption[];
  /** Forward-compat: future secrets-guard knobs are preserved + signed. */
  [k: string]: unknown;
}

/** Governance policy extensions. Kept under the existing signed HivePolicy record. */
export interface HivePolicyGovernance {
  /** P-001: exact-plan admission thresholds and ratification epoch rules. */
  planAdmission?: PlanAdmissionPolicy;
  /** Forward-compatibility for future governance policy fields. */
  [k: string]: unknown;
}

/**
 * The typed view of a Hive policy document. This is a forward-compatible OPEN record:
 * the named fields are the EN-1..EN-4 surface, and `[k: string]: unknown` preserves
 * any field a newer authoring client added. The whole object is owner-signed.
 */
export interface HivePolicy {
  /** Owner-signed governance rules, including exact-plan admission. */
  governance?: HivePolicyGovernance;
  rate?: HivePolicyRate;
  membership?: HiveMembershipMode;
  allowlist?: string[];
  moderation?: HivePolicyModeration;
  /** P-018 / D-012 — federated content write authority. 'member' (default for trusted hives) =
   *  any member may overwrite/delete any row (today's behavior). 'author-scoped' = only a row's
   *  owner (its first writer) or a privileged identity may mutate it. Absent ⇒ resolved by
   *  resolveContentWriteMode (an `open` hive defaults to 'author-scoped'). */
  contentWriteAuthority?: 'member' | 'author-scoped';
  /** P-012 (cross-machine-coord-parity-and-trust-2026-07-01, D-004) — the
   *  owner-signed COMMS defaults for members. `defaultTier` is the tier a
   *  member's verified GitHub user gets toward every OTHER member absent that
   *  member's local override (comms-trust.ts effectiveCommsTier: local
   *  override → THIS default → conservative fallback). Lattice:
   *  observe < message < wake < steer. Open record for future comms knobs. */
  comms?: HivePolicyComms;
  /** G-6 P-030 — canonical-ref rules for release-class refs (see {@link HivePolicyCrefs}). */
  crefs?: HivePolicyCrefs;
  /** WI-10002785 — owner-signed secrets-scan path waivers (see {@link HivePolicySecretsGuard}). */
  secretsGuard?: HivePolicySecretsGuard;
  /** EN-4 P-CONTRIB — fork→PR contribution rules. Opaque at EN-1. */
  contrib?: Record<string, unknown>;
  /** EN-4 P-CONTENT — payload/content rules. Opaque at EN-1. */
  content?: Record<string, unknown>;
  /** Forward-compat: any field a newer authoring client added is preserved + signed. */
  [k: string]: unknown;
}

/**
 * Domain-separation tag for the signed message. Binds the signature to THIS protocol
 * + version so a hive-policy signature can never be replayed as a different signed
 * artifact (an announce, a future policy-v2 envelope, …).
 */
export const HIVE_POLICY_SIG_DOMAIN = 'papercusp-hive-policy-v1';

/**
 * Recursively sort object keys so a parsed policy has ONE canonical serialization
 * regardless of insertion / jsonb / wire key order. Arrays preserve order (it is part
 * of the signed content). Primitives pass through. The result feeds JSON.stringify.
 */
function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) out[k] = sortKeysDeep(o[k]);
    return out;
  }
  return v;
}

/**
 * The CANONICAL JSON string of a policy object — deterministic (sorted keys, no
 * whitespace), single-line (JSON.stringify escapes any embedded newline as `\n`), and
 * stable across a parse→canonicalize round trip for our value space (strings, ints,
 * bools, string arrays, nested objects). This is what is STORED in `policy_json` and
 * what the signature covers. Computed over the WHOLE object so unknown keys are signed.
 */
export function canonicalizeHivePolicy(policy: HivePolicy | Record<string, unknown> | null | undefined): string {
  return JSON.stringify(sortKeysDeep(policy ?? {}));
}

/**
 * The EXACT bytes the owner signs and a member verifies. Newline-delimited and
 * unambiguous: the domain tag + workspaceId + potHomeSlug + policyVersion can contain
 * no newline (slugs/ids are newline-free, the version is an int), and `canonicalPolicyJson`
 * is single-line canonical JSON. Binding workspace + slug + version into the signed
 * message prevents cross-Hive / cross-version signature replay.
 */
export function hivePolicySignedBytes(input: {
  workspaceId: string;
  potHomeSlug: string;
  policyVersion: number;
  /** The canonical policy JSON string (the value stored in `policy_json`). */
  canonicalPolicyJson: string;
}): Buffer {
  const msg = [
    HIVE_POLICY_SIG_DOMAIN,
    input.workspaceId,
    input.potHomeSlug,
    String(input.policyVersion),
    input.canonicalPolicyJson,
  ].join('\n');
  return Buffer.from(msg, 'utf8');
}

const MEMBERSHIP_MODES: ReadonlySet<string> = new Set(['open', 'approval', 'allowlist']);

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * Validate + accept an UNTRUSTED policy input (the authoring API body). Forward-compatible
 * by design: it checks the SHAPE of the known fields when present and otherwise PRESERVES
 * unknown keys (so a newer client's field round-trips + gets signed). Rejects only what is
 * structurally wrong for a known field — never an unknown key. Returns the policy unchanged
 * on success (it is signed verbatim). Used by the route + the tests.
 */
export function coerceHivePolicyInput(
  raw: unknown,
): { ok: true; policy: HivePolicy } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'policy must be a JSON object' };
  }
  const p = raw as Record<string, unknown>;
  if (p.governance !== undefined) {
    if (!p.governance || typeof p.governance !== 'object' || Array.isArray(p.governance)) {
      return { ok: false, error: 'policy.governance must be an object' };
    }
    const governance = p.governance as Record<string, unknown>;
    if (governance.planAdmission !== undefined) {
      const admission = validatePlanAdmissionPolicy(governance.planAdmission);
      if (!admission.ok) return { ok: false, error: admission.error };
    }
  }
  if (p.rate !== undefined) {
    if (!p.rate || typeof p.rate !== 'object' || Array.isArray(p.rate)) {
      return { ok: false, error: 'policy.rate must be an object' };
    }
    const r = p.rate as Record<string, unknown>;
    for (const k of ['opsPerMin', 'rowsPerHour', 'prsPerDay', 'elitesPerNichePerHour'] as const) {
      if (r[k] !== undefined && (typeof r[k] !== 'number' || !Number.isFinite(r[k]) || (r[k] as number) < 0)) {
        return { ok: false, error: `policy.rate.${k} must be a non-negative number` };
      }
    }
  }
  if (p.membership !== undefined && !MEMBERSHIP_MODES.has(p.membership as string)) {
    return { ok: false, error: "policy.membership must be 'open' | 'approval' | 'allowlist'" };
  }
  if (
    p.contentWriteAuthority !== undefined &&
    p.contentWriteAuthority !== 'member' &&
    p.contentWriteAuthority !== 'author-scoped'
  ) {
    return { ok: false, error: "policy.contentWriteAuthority must be 'member' | 'author-scoped'" };
  }
  if (p.allowlist !== undefined && !isStringArray(p.allowlist)) {
    return { ok: false, error: 'policy.allowlist must be a string[]' };
  }
  if (p.comms !== undefined) {
    if (!p.comms || typeof p.comms !== 'object' || Array.isArray(p.comms)) {
      return { ok: false, error: 'policy.comms must be an object' };
    }
    const c = p.comms as Record<string, unknown>;
    if (
      c.defaultTier !== undefined &&
      c.defaultTier !== 'observe' &&
      c.defaultTier !== 'message' &&
      c.defaultTier !== 'wake' &&
      c.defaultTier !== 'steer'
    ) {
      return { ok: false, error: "policy.comms.defaultTier must be 'observe' | 'message' | 'wake' | 'steer'" };
    }
  }
  if (p.crefs !== undefined) {
    if (!p.crefs || typeof p.crefs !== 'object' || Array.isArray(p.crefs)) {
      return { ok: false, error: 'policy.crefs must be an object' };
    }
    const cr = p.crefs as Record<string, unknown>;
    if (cr.rules !== undefined) {
      if (!cr.rules || typeof cr.rules !== 'object' || Array.isArray(cr.rules)) {
        return { ok: false, error: 'policy.crefs.rules must be an object keyed by ref pattern' };
      }
      for (const [pattern, rule] of Object.entries(cr.rules as Record<string, unknown>)) {
        if (pattern.trim() === '') {
          return { ok: false, error: 'policy.crefs.rules: a ref pattern key must be non-empty' };
        }
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
          return { ok: false, error: `policy.crefs.rules['${pattern}'] must be an object` };
        }
        const r = rule as Record<string, unknown>;
        if (!isStringArray(r.allow) || r.allow.length === 0 || r.allow.some((k) => k.trim() === '')) {
          return { ok: false, error: `policy.crefs.rules['${pattern}'].allow must be a non-empty string[] of pubkeys` };
        }
        if (typeof r.threshold !== 'number' || !Number.isInteger(r.threshold) || r.threshold < 1) {
          return { ok: false, error: `policy.crefs.rules['${pattern}'].threshold must be a positive integer` };
        }
        // Unsatisfiable rule = authoring mistake; distinct-key counting can never reach it.
        if (r.threshold > new Set(r.allow).size) {
          return {
            ok: false,
            error: `policy.crefs.rules['${pattern}'].threshold (${r.threshold}) exceeds the number of distinct allow keys (${new Set(r.allow).size})`,
          };
        }
      }
    }
  }
  if (p.moderation !== undefined) {
    if (!p.moderation || typeof p.moderation !== 'object' || Array.isArray(p.moderation)) {
      return { ok: false, error: 'policy.moderation must be an object' };
    }
    const m = p.moderation as Record<string, unknown>;
    if (m.reportable !== undefined && typeof m.reportable !== 'boolean') {
      return { ok: false, error: 'policy.moderation.reportable must be a boolean' };
    }
    if (m.bannedGithubIds !== undefined && !isStringArray(m.bannedGithubIds)) {
      return { ok: false, error: 'policy.moderation.bannedGithubIds must be a string[]' };
    }
    if (m.takedownList !== undefined && !isStringArray(m.takedownList)) {
      return { ok: false, error: 'policy.moderation.takedownList must be a string[]' };
    }
  }
  if (p.secretsGuard !== undefined) {
    if (!p.secretsGuard || typeof p.secretsGuard !== 'object' || Array.isArray(p.secretsGuard)) {
      return { ok: false, error: 'policy.secretsGuard must be an object' };
    }
    const sg = p.secretsGuard as Record<string, unknown>;
    if (sg.pathExemptions !== undefined) {
      if (!Array.isArray(sg.pathExemptions)) {
        return { ok: false, error: 'policy.secretsGuard.pathExemptions must be an array' };
      }
      for (const [i, e] of sg.pathExemptions.entries()) {
        const bad = secretsGuardExemptionProblem(e);
        if (bad) return { ok: false, error: `policy.secretsGuard.pathExemptions[${i}]: ${bad}` };
      }
    }
  }
  return { ok: true, policy: p as HivePolicy };
}

/**
 * Why a waiver entry is malformed, or null when it is well-formed. A waiver switches
 * scanning OFF, so the grammar is strict: a non-empty repo-relative path (no leading
 * `/`, no `..` segment, no newline) and a non-empty reason.
 */
export function secretsGuardExemptionProblem(e: unknown): string | null {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return 'must be an object';
  const r = e as Record<string, unknown>;
  if (typeof r.path !== 'string' || r.path.trim() === '') return 'path must be a non-empty string';
  if (r.path.startsWith('/') || r.path.split('/').includes('..') || /[\r\n]/.test(r.path)) {
    return 'path must be repo-relative (no leading "/", no ".." segment, no newline)';
  }
  if (typeof r.reason !== 'string' || r.reason.trim() === '') return 'reason must be a non-empty string';
  return null;
}

/**
 * The well-formed waiver entries of a (verified) policy. Defensive on a READ: a malformed
 * entry is skipped, never thrown — the read path must not crash on a junk document, and
 * skipping a waiver only keeps scanning ON (the fail-safe direction).
 */
export function policySecretsGuardExemptions(policy: HivePolicy | null | undefined): HivePolicySecretsGuardExemption[] {
  const list = policy?.secretsGuard?.pathExemptions;
  if (!Array.isArray(list)) return [];
  return list.filter((e): e is HivePolicySecretsGuardExemption => secretsGuardExemptionProblem(e) === null);
}

function withExemptionList(policy: HivePolicy, list: HivePolicySecretsGuardExemption[]): HivePolicy {
  const sorted = [...list].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const secretsGuard: HivePolicySecretsGuard = { ...(policy.secretsGuard ?? {}), pathExemptions: sorted };
  if (sorted.length === 0) delete secretsGuard.pathExemptions;
  const next: HivePolicy = { ...policy, secretsGuard };
  if (Object.keys(secretsGuard).length === 0) delete next.secretsGuard;
  return next;
}

/**
 * PURE: the policy with `entries` added (an entry for an existing path REPLACES it).
 * Sorted by path so the canonical bytes do not depend on authoring order — two owners'
 * devices adding the same set produce the same signed document.
 */
export function withSecretsGuardExemptions(
  policy: HivePolicy,
  entries: readonly HivePolicySecretsGuardExemption[],
): HivePolicy {
  const byPath = new Map(policySecretsGuardExemptions(policy).map((e) => [e.path, e]));
  for (const e of entries) byPath.set(e.path, e);
  return withExemptionList(policy, [...byPath.values()]);
}

/** PURE: the policy with the waiver for each of `paths` removed (absent paths are a no-op). */
export function withoutSecretsGuardExemptions(policy: HivePolicy, paths: readonly string[]): HivePolicy {
  const drop = new Set(paths);
  const current = policySecretsGuardExemptions(policy);
  const kept = current.filter((e) => !drop.has(e.path));
  // Nothing to remove ⇒ the SAME object, so the canonical bytes (and the re-sign skip in
  // mutateHivePolicyIfChanged) are untouched.
  if (kept.length === current.length) return policy;
  return withExemptionList(policy, kept);
}

/**
 * A resolved canonical-ref rule: which keys may make a matching ref canonical and how
 * many distinct signatures it takes. `pattern` is the (most specific) rule key that
 * matched — useful for logging/audit; consumers only need `allow` + `threshold`.
 */
export interface ResolvedCanonicalRule {
  pattern: string;
  allow: string[];
  threshold: number;
}

/**
 * Match a crefs ref PATTERN against a concrete ref name. PURE. Pattern language is
 * deliberately tiny (trust rules must be unambiguous): every character is literal
 * except `*`, which matches ANY sequence of characters INCLUDING `/` (so
 * `refs/tags/releases/*` covers nested release tags). No `?`, no character classes.
 */
export function matchRefPattern(pattern: string, refName: string): boolean {
  if (!pattern.includes('*')) return pattern === refName;
  // Escape regex specials in the literal segments, splice `.*` where the `*`s were.
  const rx = pattern
    .split('*')
    .map((seg) => seg.replace(/[.+^${}()|[\]\\?]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${rx}$`).test(refName);
}

/**
 * Resolve the canonical-ref rule governing `refName` under `policy` (G-6 P-030). PURE:
 * a lookup over the owner-signed policy document, no I/O. Returns the matching rule's
 * `{ allow, threshold }` (+ the matched `pattern`), or `null` when NO rule pattern
 * matches `refName` at all — null means the ref is NOT policy-canonical (nothing to
 * enforce), the permissive default. When several patterns match, the MOST SPECIFIC
 * wins: most literal (non-`*`) characters, then fewest wildcards, then
 * lexicographically smallest pattern (a deterministic tiebreak) — determined FIRST,
 * over every matching pattern regardless of shape validity.
 *
 * FAIL CLOSED, not permissive, on stored junk (WI-1553): if the MOST SPECIFIC matching
 * pattern's rule is malformed (wrong shape — predates or bypassed `validateHivePolicy`),
 * this does NOT fall through to a broader, valid, possibly-WEAKER rule (a real
 * `refs/heads/release` rule with `allow: []` must never be satisfied by a laxer
 * `refs/*` catch-all). Instead it returns a poisoned, unsatisfiable rule —
 * `{ pattern, allow: [], threshold: 1 }` — so every consumer's satisfiability check
 * (`allow.length >= threshold`-shaped) denies by construction. The read path still
 * never throws on junk (a `null`-vs-poison distinction, not a crash).
 */
export function resolveCanonicalRule(
  policy: HivePolicy | null | undefined,
  refName: string,
): ResolvedCanonicalRule | null {
  const rules = policy?.crefs?.rules;
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) return null;
  // Pass 1: find the MOST SPECIFIC matching PATTERN, independent of the rule's shape
  // validity — a malformed entry still "claims" its pattern and must not be silently
  // skipped in favor of a less-specific one.
  let best: { pattern: string; rule: unknown; literals: number; wildcards: number } | null = null;
  for (const [pattern, rule] of Object.entries(rules)) {
    if (!matchRefPattern(pattern, refName)) continue;
    const wildcards = pattern.split('*').length - 1;
    const literals = pattern.length - wildcards;
    if (
      !best ||
      literals > best.literals ||
      (literals === best.literals && wildcards < best.wildcards) ||
      (literals === best.literals && wildcards === best.wildcards && pattern < best.pattern)
    ) {
      best = { pattern, rule, literals, wildcards };
    }
  }
  if (!best) return null; // nothing matched — the permissive default.
  // Pass 2: validate ONLY the winning entry. A malformed winner is poisoned (fail
  // closed), never a reason to fall back to a different, broader match.
  const r = best.rule as HivePolicyCrefsRule | null | undefined;
  const isValidRule =
    !!r &&
    typeof r === 'object' &&
    !Array.isArray(r) &&
    isStringArray(r.allow) &&
    r.allow.length > 0 &&
    typeof r.threshold === 'number' &&
    Number.isInteger(r.threshold) &&
    r.threshold >= 1;
  if (!isValidRule) {
    return { pattern: best.pattern, allow: [], threshold: 1 };
  }
  return { pattern: best.pattern, allow: [...(r as HivePolicyCrefsRule).allow!], threshold: (r as HivePolicyCrefsRule).threshold! };
}

/**
 * Parse a stored `policy_json` TEXT into the typed view. Defensive: a malformed /
 * non-object value returns an empty policy `{}` (permissive) rather than throwing —
 * the read path must never crash on a junk row, and the signature check at apply
 * already rejected anything forged before it could be stored.
 */
export function parseHivePolicyJson(policyJson: string | null | undefined): HivePolicy {
  if (!policyJson) return {};
  try {
    const v = JSON.parse(policyJson) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as HivePolicy) : {};
  } catch {
    return {};
  }
}
