/**
 * agent-facts store — the generalized STANDING-FACTS ledger
 * (queen-memory-hybrid-2026-07-02 L1b; owner-approved 2026-07-02).
 *
 * A fact is a deterministic, scoped, TTL'd CONCLUSION an agent asserts so it is
 * folded VERBATIM into future briefs/dossiers/orients. It fills the gap none of
 * the other memory surfaces cover:
 *   • mem0 (`memory:*`)        — fuzzy semantic recall; may or may not surface.
 *   • agent-insights docs      — long-form how-it-works runbooks.
 *   • work-item checkpoints    — task-scoped in-flight progress.
 *   • queen carry-journal      — per-wake reasoning trajectory.
 * A fact WILL appear in every relevant fold until it expires or is retracted —
 * "WI-1439 is owner-residue, exclude it" must never depend on embedding
 * similarity (the Queen re-derived exactly that ~6 consecutive wakes,
 * 2026-07-02, before this existed).
 *
 * Scoping (owner amendment D-001: harness/work_item OPTIONAL):
 *   workspace (ref NULL) | role | owner | harness | work_item.
 * Upsert identity: (workspace, scope, coalesce(ref,''), key). Soft-retract.
 * Hygiene: ordinary facts require an explicit lifetime (typed slots and confidence
 * tiers may supply their documented defaults), per-scope cap, expiry sweep on the
 * routines tick. The cap evicts by the ranking at the ORDER BY around L1221 —
 * confidence, then the remaining fraction of declared TTL, with
 * `updated_at DESC` only as a tiebreak. An ordinary write that would evict
 * another author's `verified` fact is refused before insertion. It is NOT
 * "LRU-ish / oldest-updated", which is what this line said until 2026-08-04
 * and which stopped being true at WI-7292; two agents chased that stale
 * sentence to opposite wrong conclusions about a live eviction. Read the
 * ORDER BY, not this summary.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { InvalidInputError } from '@papercusp/tooldef';
import { pinModuleState } from '@papercusp/module-singleton';
import { GUARD_RAIL_TAG } from '@papercusp/verification-harness';
import { activeWorkspaceId } from '../workspace-registry';
import { boundedOrgTxn } from '../pg-bounded-txn';
// P-008 (b): the unknown vocabulary a failed dependency read records. Imported,
// never re-declared — cell-contract.ts declares itself the canonical home and
// forbids a local copy, and a second enumeration is precisely how a caller's
// branch set silently diverges from the contract it thinks it implements.
import type { CellUnknownCode } from '../cell-contract';

export const FACT_SCOPES = ['workspace', 'role', 'owner', 'harness', 'work_item'] as const;
export type FactScope = (typeof FACT_SCOPES)[number];

/**
 * EI-18681964809855890 (owner-filed 2026-07-26): a fact's EVIDENCE STRENGTH —
 * orthogonal to `scope` (what it's about) the same way `audienceScope` is
 * orthogonal to who receives it. `facts:assert` used to render a peer's single
 * unreplicated run at IDENTICAL authority to a verified, replicated
 * measurement — this is the dimension that was missing. NULL (unset) is the
 * legacy/default shape and renders exactly as before (no badge) —
 * fully backward compatible; an explicit confidence changes fold rendering,
 * while only 'provisional'/'suspected' also supply a default TTL.
 *   verified    — you (or the platform) confirmed it directly / replicated it.
 *   provisional — a single run / one data point; plausible but unreplicated.
 *   suspected   — a hunch / a peer's hedge relayed second-hand; weakest tier.
 */
export const FACT_CONFIDENCE_LEVELS = ['verified', 'provisional', 'suspected'] as const;
export type FactConfidence = (typeof FACT_CONFIDENCE_LEVELS)[number];

/**
 * P-008 (b) / D-019 DEFECT 1 (migration 690) — the claim MODALITY.
 *
 * ⚠ THIS IS NOT `scope`, AND THAT IS THE WHOLE POINT. `scope`
 * (workspace|role|owner|harness|work_item) says WHO a fact is ABOUT. `kind` says
 * WHAT KIND OF CLAIM it is. D-019 killed the separate assumption ledger P-001
 * proposed on the grounds that "an assumption IS a fact" — but that only becomes
 * mechanically true, rather than a convention nobody can query, once the three
 * modalities are distinguishable:
 *
 *   conclusion  — a settled finding. Today's default behaviour, stated.
 *   assumption  — provisional; pairs with {@link FactDependency} so it can go
 *                 stale on its own declared terms (D-007/D-019).
 *   convention  — normative ("we do X here"); P-018's target.
 *   undecidable — NOT determinable from the available evidence, recorded so
 *                 peers STOP RE-DERIVING it (agent-epistemics-2026-08-02 P-002).
 *
 * `undecidable` is the odd one out and deliberately so: the first three assert
 * that something IS so, while this one asserts the ABSENCE of a determination.
 * It earns a modality rather than a table because subject, scope, TTL and
 * upsert-by-key semantics are all identical — only the claim's shape differs.
 *
 * It exists because 2026-08-02 cost four agents ~90 minutes producing four
 * contradictory answers to one question that was not answerable from the fields
 * they were reading. "Nobody can determine this" was knowable early, and had to
 * be written in four non-authoritative places (CLAUDE.md, a carry-note, a
 * broadcast, a work-item) because no addressable home existed. A fact is that
 * home: it upserts by key and folds VERBATIM into every orient until retracted.
 *
 * ⚠ An `undecidable` REQUIRES `settledBy` (enforced in {@link assertFact}, not
 * only in the tool). Without it the record cannot stop re-derivation — a reader
 * cannot distinguish "nobody COULD determine this" from "nobody has tried
 * lately", and the cheapest way to tell those apart is to try again.
 *
 * Workspace-scope CORRELATES with conventions but is not identical to them (a
 * workspace-scoped conclusion is not a convention), so correlation cannot
 * substitute — which is exactly why D-019 recorded the absence as a DEFECT.
 *
 * NULL = not declared, and it is never rewritten to 'conclusion'. Inventing a
 * modality nobody stated is the same manufactured-certainty failure the nullable
 * `confidence` column already refuses.
 */
export const FACT_KINDS = ['conclusion', 'assumption', 'convention', 'undecidable'] as const;
export type FactKind = (typeof FACT_KINDS)[number];

/**
 * An `undecidable` fact must name what WOULD settle the question.
 *
 * Validated in the STORE rather than only in the tool for the same reason
 * {@link validateConventionEnforcement} is: a non-tool caller (a routine, a
 * backfill) must not be able to write an exit-less UNKNOWN. The rule is the
 * substance of P-002, not the tool's manners.
 *
 * Returns an error string, or null when the input is acceptable.
 */
export function validateUndecidableSettledBy(
  kind: string | null,
  settledBy: string | null | undefined,
): string | null {
  if (kind !== 'undecidable') {
    // Not an error to omit it elsewhere — but silently STORING it on another
    // modality would invent a meaning no reader could look up.
    return settledBy != null && settledBy.trim() !== ''
      ? `settledBy is only meaningful for kind:'undecidable' (got kind:'${kind ?? 'null'}') — it names what would settle an open question, so on a settled claim it has no referent`
      : null;
  }
  if (settledBy == null || settledBy.trim() === '') {
    return "kind:'undecidable' requires settledBy — name the evidence that WOULD settle this question. An undecidable with no stated exit does not stop re-derivation, it invites it: a reader cannot tell \"nobody COULD determine this\" from \"nobody has tried lately\"";
  }
  return null;
}

/**
 * P-018 / D-016: the enforcement tiers, STRONGEST FIRST — the order is the
 * ruling ("always prefer this tier"), so keep it.
 *
 *   structural — impossible to do wrong; no agent decision is involved.
 *   gate       — refused at a chokepoint.
 *   detector   — measured and reported, never silently tolerated. LAST RESORT.
 *
 * ⚠ `prompt` is deliberately ABSENT. D-016: *"The prompt/playbook is NOT a tier.
 * Adding 'agents should declare assumptions' to the su playbook is precisely the
 * 47.1→34.9 mechanism."* A documentation-only convention must therefore be
 * UNABLE to claim a tier — claiming one is exactly how prose exhortation passes
 * itself off as structure. Such a convention is still declarable; it simply
 * leaves `enforcement` unset and reads as untiered, which is the honest record.
 */
export const CONVENTION_ENFORCEMENT_TIERS = ['structural', 'gate', 'detector'] as const;
export type ConventionEnforcementTier = (typeof CONVENTION_ENFORCEMENT_TIERS)[number];

/** The tiers D-016 calls "tier-2 and tier-3" — the ones that ship with a floor. */
const MEASURED_TIERS: ReadonlySet<ConventionEnforcementTier> = new Set<ConventionEnforcementTier>([
  'gate',
  'detector',
]);

/**
 * P-018 / D-075 R2 — HOW a convention is enforced (migration 692).
 *
 * `floor`/`reviewBy` are REQUIRED for a measured tier and REFUSED for
 * `structural`; see {@link validateConventionEnforcement} for why each direction
 * is a refusal rather than a default.
 */
export interface ConventionEnforcement {
  tier: ConventionEnforcementTier;
  /** Adoption floor as a rate in (0,1]. D-016: below floor at review = failing. */
  floor?: number;
  /** ISO date the floor is judged at. D-016: "an adoption floor and a review date". */
  reviewBy?: string;
}

// EI-18681984560352579 / migration 664 (2026-07-26): raised 500 -> 1200. The
// old 500-char cap was silently amputating the OPERATIVE clause of facts
// (which fold VERBATIM as binding context) — observed 3x in one session,
// once removing a discriminator rule's verdict sentence entirely. 1200 is
// generous enough that a tight, front-loaded conclusion essentially never
// truncates, while the clamp-not-reject fallback below (clampFactBody)
// still guarantees a write is never lost outright for genuine overflow.
// Keep in sync with the DB CHECK constraint (agent_facts_body_check, mig 664).
export const FACT_BODY_MAX_CHARS = 1200;
/** P-010: each half of a standing fact's executable recheck contract is a
 * compact instruction, not a runbook. Keep this in sync with migration 940. */
export const FACT_RECHECK_FIELD_MAX_CHARS = 500;

/**
 * How a future reader can actively re-verify a standing fact, and the concrete
 * observation that disproves it. The pair is atomic: a probe without a
 * falsifier produces evidence with no verdict, while a falsifier without a
 * probe cannot be sought repeatably.
 */
export interface FactRecheck {
  probe: string;
  falsifier: string;
  /** P-004 (1240): the probe's executable form — a guard rail harness preflights run. */
  exec?: FactRecheckExec;
}

/**
 * A shell command whose `expectExitCode` (and `stdoutIncludes`, when set) means the fact still
 * HOLDS. Contract-conforming harnesses (libs/generic/verification-harness) run it in preflight
 * when `scope` shares a tag with theirs; only local-origin facts are ever executed (D-003).
 */
export interface FactRecheckExec {
  command: string;
  expectExitCode: number;
  stdoutIncludes?: string;
  scope: string[];
}

export const FACT_RECHECK_EXEC_MAX_SCOPE_TAGS = 8;
const RECHECK_EXEC_KEYS = new Set(['command', 'expectExitCode', 'stdoutIncludes', 'scope']);

function validateFactRecheckExec(input: unknown): string | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return 'recheck.exec must be an object { command, expectExitCode, stdoutIncludes?, scope }';
  }
  const raw = input as Record<string, unknown>;
  const extra = Object.keys(raw).find((k) => !RECHECK_EXEC_KEYS.has(k));
  if (extra !== undefined) return `recheck.exec has unknown key ${JSON.stringify(extra)}`;
  if (typeof raw.command !== 'string' || raw.command.trim() === '') {
    return 'recheck.exec.command must be a non-empty string';
  }
  if (raw.command.trim().length > FACT_RECHECK_FIELD_MAX_CHARS) {
    return `recheck.exec.command exceeds the ${FACT_RECHECK_FIELD_MAX_CHARS}-character cap`;
  }
  const code = raw.expectExitCode;
  if (typeof code !== 'number' || !Number.isInteger(code) || code < 0 || code > 255) {
    return 'recheck.exec.expectExitCode must be an integer 0..255';
  }
  if (raw.stdoutIncludes !== undefined) {
    if (typeof raw.stdoutIncludes !== 'string' || raw.stdoutIncludes === '') {
      return 'recheck.exec.stdoutIncludes must be a non-empty string when set';
    }
    if (raw.stdoutIncludes.length > FACT_RECHECK_FIELD_MAX_CHARS) {
      return `recheck.exec.stdoutIncludes exceeds the ${FACT_RECHECK_FIELD_MAX_CHARS}-character cap`;
    }
  }
  const scope = raw.scope;
  if (!Array.isArray(scope) || scope.length === 0 || scope.length > FACT_RECHECK_EXEC_MAX_SCOPE_TAGS) {
    return `recheck.exec.scope must name 1..${FACT_RECHECK_EXEC_MAX_SCOPE_TAGS} tags`;
  }
  const bad = scope.find((t) => typeof t !== 'string' || !GUARD_RAIL_TAG.test(t));
  if (bad !== undefined) {
    return `recheck.exec.scope has invalid tag ${JSON.stringify(bad)} (lowercase, digits and :._-, at most 64 chars)`;
  }
  return null;
}

/** Store-boundary validation for the recheck contract. PURE. */
export function validateFactRecheck(input: unknown): string | null {
  if (input == null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    return 'recheck must be an object { probe, falsifier, exec? }';
  }
  const raw = input as Record<string, unknown>;
  const keys = Object.keys(raw)
    .filter((k) => k !== 'exec')
    .sort();
  if (keys.length !== 2 || keys[0] !== 'falsifier' || keys[1] !== 'probe') {
    return 'recheck must contain exactly probe and falsifier (plus an optional exec)';
  }
  for (const field of ['probe', 'falsifier'] as const) {
    const value = raw[field];
    if (typeof value !== 'string' || value.trim() === '') {
      return `recheck.${field} must be a non-empty string`;
    }
    if (value.trim().length > FACT_RECHECK_FIELD_MAX_CHARS) {
      return `recheck.${field} exceeds the ${FACT_RECHECK_FIELD_MAX_CHARS}-character cap`;
    }
  }
  if ('exec' in raw) return validateFactRecheckExec(raw.exec);
  return null;
}

/** Canonical form of an already-validated recheck: trimmed text, de-duplicated scope. */
function canonicalFactRecheck(raw: Record<string, unknown>): FactRecheck {
  const out: FactRecheck = { probe: (raw.probe as string).trim(), falsifier: (raw.falsifier as string).trim() };
  if (raw.exec !== undefined) {
    const e = raw.exec as Record<string, unknown>;
    out.exec = {
      command: (e.command as string).trim(),
      expectExitCode: e.expectExitCode as number,
      ...(e.stdoutIncludes !== undefined ? { stdoutIncludes: e.stdoutIncludes as string } : {}),
      scope: [...new Set(e.scope as string[])],
    };
  }
  return out;
}

/** Validate + canonicalize a caller-supplied recheck contract at the store seam. */
export function normalizeFactRecheck(input: unknown): FactRecheck | null {
  const error = validateFactRecheck(input);
  if (error) throw new InvalidInputError(`facts:assert — ${error}`);
  if (input == null) return null;
  return canonicalFactRecheck(input as Record<string, unknown>);
}

/** Defensive DB/wire read: malformed legacy or out-of-band data never folds. */
export function parseFactRecheck(raw: unknown): FactRecheck | null {
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (validateFactRecheck(raw)) return null;
  if (raw == null) return null;
  return canonicalFactRecheck(raw as Record<string, unknown>);
}
/** P-007: bounded verbatim quote inside a source-provenance stamp (fold-friendly —
 *  mirrors RELAY_RENDER_CHARS; a fold can carry 12+ facts, so quotes stay short). */
export const FACT_PROVENANCE_QUOTE_CHARS = 160;
/** Legacy resolver fallback retained only for total-function compatibility; ordinary
 * writes are rejected before resolution when they declare no lifetime. */
export const FACT_DEFAULT_TTL_SEC = 7 * 24 * 3600;
/** PostgreSQL's canonical no-expiry timestamptz representation. */
export const FACT_PERMANENT_EXPIRY = 'infinity';

/** True for the only unbounded expiry representation emitted by this store. */
export function isPermanentFactExpiry(expiresAt: string): boolean {
  return expiresAt === FACT_PERMANENT_EXPIRY;
}
/**
 * A volatile measurement is a snapshot, not a standing property. An explicit
 * longer TTL is refused at the write boundary rather than silently preserving
 * the incident's multi-day stale-claim window.
 */
export const FACT_VOLATILE_MAX_TTL_SEC = 15 * 60;
/** EI-18681964809855890: a 'provisional' fact (one unreplicated run) defaults
 *  to a much shorter TTL than an ordinary bounded conclusion — "stale
 *  certainty is worse than stale doubt" (the owner's framing). Overridable
 *  via an explicit `ttlSec` like every other default here. */
export const FACT_PROVISIONAL_DEFAULT_TTL_SEC = 24 * 3600;
/** 'suspected' (the weakest tier — a hunch / second-hand hedge) decays faster
 *  still; it should be gone from the fold well before anyone could mistake it
 *  for settled fact. */
export const FACT_SUSPECTED_DEFAULT_TTL_SEC = 6 * 3600;
/** Per-(scope,ref) live-fact CEILING. Past this an ORDINARY write is REFUSED —
 *  no incumbent is destroyed to seat it (P-002 / D-003). The VOLATILE
 *  partition still evicts by the ranking below; bounded snapshot churn is that
 *  partition's declared purpose (see FACTS_VOLATILE_PER_SCOPE_CAP).
 *
 *  The eviction ranking (confidence, then remaining TTL FRACTION `DESC`,
 *  `updated_at DESC` only as tiebreak — see the ORDER BY around L1221) is
 *  therefore now VOLATILE-ONLY. It is retained, not deleted: it is still the
 *  live policy for that partition, and its history below is the evidence for
 *  why the ordinary partition stopped evicting at all.
 *
 *  ⚠ THE HISTORY BELOW IS WHY THE MECHANISM CHANGED, NOT JUST ITS SIZE. Both
 *  prior raises answered the SAME symptom — the ranked population pinned at
 *  EXACTLY cap continuously, so every assert by any agent destroyed an
 *  incumbent. Each bought time; neither changed the outcome. A third raise
 *  would have re-saturated too, because the cap was acting as the primary GC
 *  on a store that already has a working one (every fact declares a lifetime,
 *  and `sweepExpiredFacts` hard-deletes 30d past expiry). D-003 keeps a bound
 *  and changes what happens AT it.
 *
 * EI-19931982603802383: raised 50 -> 200. Measured 2026-08-09 on the two
 * busiest scopes on this box (`workspace` global, `harness:papercusp`): the
 * non-exempt (ranked) population sat pinned at EXACTLY 50/50 continuously —
 * i.e. permanently AT cap, not merely spiking there. With ~20 concurrently
 * live fleet agents each periodically asserting into those two shared
 * scopes, that means every single assert by ANY agent evicts the
 * worst-ranked incumbent, so a scope's effective "survival window" for any
 * one fact is however long it takes the REST of the fleet to produce ~50
 * more writes — reported as low as ~20 minutes twice in a row for the SAME
 * fact (once at workspace scope, once at harness scope after re-asserting
 * there). This is not a ranking defect (the ranking chose correctly among a
 * saturated 50) — it is the cap being sized for a much lower write-volume
 * regime than a 20+-agent fleet actually produces in a shared scope.
 *
 * EI-22176887065789447: raised 200 -> 500. The identical saturation pattern
 * recurred at roughly 5x the fleet scale. Measured live 2026-09-02T19:12Z
 * (querying `capPopulationPredicate()`'s own predicate, not a hand-rolled
 * count): `harness:papercusp` sat AT 200/200 (0 headroom — every write there
 * evicted an incumbent) and had cap-evicted 23 facts from 16 distinct
 * authors in the preceding 24h; `workspace` sat at 195/200. This predates
 * and is independent of the trigger below — chronic background saturation,
 * not a one-off spike. It was surfaced by a compounding trigger: the
 * standing-facts expiry audit's un-expire action (WI-2141854) restores a
 * LAPSED fact to live, and a lapsed fact costs no seat while a restored one
 * does — so one apply that un-expired ~480 facts evicted 27 workspace-scoped
 * incumbents within the same minute, with no cost estimate or guard on that
 * restore path (a separate, still-open hardening question — see
 * EI-22176887065789447). Raising the cap here addresses the underlying
 * capacity shortfall directly, not merely the audit's collateral batch.
 *
 * P-002 / D-003: raised 500 -> 5000 AND converted from an eviction trigger to
 * a refusal ceiling. Sizing, measured 2026-09-02T21:45Z against
 * `capPopulationPredicate()`'s own predicate: UNCLIPPED demand — live plus
 * already-evicted-but-still-unexpired rows, i.e. what the population would be
 * had nothing been destroyed — is 362 for `harness:papercusp` (200 live + 162
 * evicted-still-valid) and 269 for `workspace` (200 + 69). Every OTHER scope
 * on the box is <= 49. Those two figures are LOWER BOUNDS: a row evicted and
 * since expired is invisible to them.
 *
 * 5000 is therefore ~14x measured demand. That margin is the point of the
 * number, not slack: at a refusal ceiling, hitting the bound must mean a
 * genuine runaway writer rather than ordinary fleet traffic, because the cost
 * is now paid by the writer (a refused assert) instead of silently by a
 * stranger (a destroyed fact). Sized just above demand it would refuse honest
 * writes; unbounded it would stop being a backstop at all.
 *
 * It does not change the fold budget (`FACTS_FOLD_LIMIT`, unchanged at 12) — a
 * ceiling governs how many facts may EXIST in a scope, never how many are
 * injected into any one orient/context. Nor does it change table growth
 * materially: the whole table is ~37.5k rows / 44 MB, and time-bounded GC, not
 * this ceiling, is what keeps it that way. */
export const FACTS_PER_SCOPE_CAP = 5000;
/**
 * Volatile measurements are short-lived snapshots, not standing conclusions.
 * Keep a separate, deliberately smaller population so a burst of snapshots
 * cannot evict ordinary facts, while still bounding snapshot-key churn within
 * each selector.
 *
 * ⚠ DELIBERATELY DECOUPLED from FACTS_PER_SCOPE_CAP (P-002). This was
 * `cap / 4`, which was coherent while both numbers were eviction bounds of the
 * same kind. They are now different MECHANISMS: the ordinary cap is a refusal
 * ceiling sized far above demand, while this stays an eviction bound sized to
 * real churn. Left derived, raising the ceiling 500 -> 5000 would have
 * silently raised this churn bound 125 -> 1250 as a side effect of a change
 * that has nothing to do with it. 125 preserves the value this partition
 * already had.
 *
 * Measured 2026-09-02T21:45Z: the volatile partition holds ZERO rows in every
 * scope on this box, so this bound is currently inert either way — which is
 * exactly why it must not be allowed to drift silently.
 */
export const FACTS_VOLATILE_PER_SCOPE_CAP = 125;
/** Fold budget: max facts per scope-selector in one fold read. */
export const FACTS_FOLD_LIMIT = 12;

/**
 * P-015 (deterministic-context-carry) dead-end slot key prefix — the canonical
 * home of the convention. A dead-end fact (a tried-and-failed approach, asserted
 * via facts:assert { slot:'dead-end' }) is keyed `dead-end:<slug>` so it is
 * machine-greppable in SQL (`key LIKE 'dead-end:%'`). Defined HERE (not the tool
 * layer) so the WRITE convention (facts/assert.normalizeDeadEndSlot, which
 * re-exports this) and the READ filter ({@link foldDeadEndFacts}, the P-006
 * dead-end matcher live leg's fact source) share one source of truth — a drift
 * between them would silently hide every dead-end fact from the matcher.
 */
export const DEAD_END_KEY_PREFIX = 'dead-end:';

/**
 * owner-wall-ttl-lapse-hardening-2026-07-26 (EI-18669544162414270) — the WALL
 * fact slot. A standing fact expires on TTL whether or not the condition it
 * describes resolved; when the fact encodes an OWNER-GATED WALL (e.g. "still
 * LIVE = NOT rotated"), that turns a safety signal into a time bomb — absence
 * of the fact becomes indistinguishable from "the wall cleared" (TTL decay
 * always fails toward "clear", the wrong direction for an unremediated risk).
 * `facts:assert { slot:'wall' }` (facts/assert.ts normalizeWallSlot) keys the
 * fact under this prefix — machine-greppable (`key LIKE 'wall:%'`), same
 * convention as {@link DEAD_END_KEY_PREFIX} — and defaults its TTL to
 * {@link WALL_DEFAULT_TTL_SEC}; unlike an ordinary fact, this typed slot has
 * an explicit store-owned lifetime so a routine decay window can't silently
 * clear it. {@link listLapsedWallFacts}
 * is the read leg the wall-lapse watchdog sweeps so an eventual lapse is LOUD
 * (an escalation), never silent.
 */
export const WALL_KEY_PREFIX = 'wall:';
/** Default TTL applied to a `slot:'wall'` assert when the caller omits
 *  `ttlSec` — the schema's own max (90d, no schema change needed). Long
 *  enough that a shorter ordinary lifetime cannot silently clear an
 *  unremediated risk;
 *  the wall-lapse watchdog is the loud backstop for when even 90d elapses
 *  without a re-assert or an explicit retract. */
export const WALL_DEFAULT_TTL_SEC = 90 * 24 * 3600;

/**
 * EI-21154276512983646 — the GUARD-RAIL fact slot. A settled do-not-repeat
 * instruction is deterministic safety context, not ordinary cap-churn prose:
 * once it has prevented a repeated mistake, silently evicting it makes the
 * next reader indistinguishable from one who never received the ruling.
 * `facts:assert { slot:'guard-rail' }` (facts/assert.ts normalizeGuardRailSlot)
 * keys it under this prefix so the cap and monitor fold share one machine-
 * greppable convention without a schema migration.
 */
export const GUARD_RAIL_KEY_PREFIX = 'guard-rail:';

/**
 * P-007 (coord-authority-hardening): the platform-VERIFIED stamp for a TYPED
 * sourceRef (`msg:<id>` / `wi:<id>`/WI-/EI- / `session_turn:<source>:<session>:<idx>` / `owner-turn`), captured
 * server-side AT ASSERT TIME (H2-tier reuse — see
 * agent-tools/facts/source-provenance-resolve.ts). Folds render it verbatim
 * with zero extra reads. NULL/absent for free-text sourceRefs + legacy rows.
 */
export interface FactSourceProvenance {
  kind: 'msg' | 'work-item' | 'owner-turn';
  /** Did the ref resolve against the platform's own store at assert time? */
  verified: boolean;
  /** Bounded verbatim quote of the source (msg summary/body, WI title, the
   *  owner's human-turn text) — captured server-side, never caller-supplied. */
  quote?: string;
  /** EI-22164571843016048: the captured quote carried a credential-shaped value
   *  and was replaced before persisting. A fold renders a redacted quote as the
   *  marker, so this flag is what lets a reader tell "withheld on purpose" from
   *  "the source had nothing quotable" — the two are otherwise identical. */
  quoteRedacted?: boolean;
  /** Compact source label, e.g. `msg <id> (<handle> → <to>, <ts>)` / `WI-4172 [feature/wip]`. */
  label?: string;
  /** When !verified: why (not_found / resolve_error / …) — rendered LOUDLY. */
  error?: string;
  verifiedAt: string;
}

/**
 * EI-20191740437408337: assert-time metadata for a measurement whose subject
 * may still be changing. The pair is kept together so a timestamp cannot be
 * mistaken for a durable conclusion without the volatility declaration.
 */
export interface FactMeasurement {
  subjectVolatile: true;
  /** ISO timestamp at which the moving subject was sampled. */
  measuredAt: string;
}

/**
 * P-008 (b), migration 690 — ONE declared dependency of a fact on a CELL, with
 * the anchor that makes "has it changed?" a MECHANICAL question.
 *
 * ── WHY A DIGEST AND NOT A VERSION ───────────────────────────────────────────
 *
 * D-012's hard constraint is "reuse the existing clock, do not mint a version
 * counter" — and a cell HAS no counter to reuse. `CellSpec.changeSignal` is
 * `{ kind:'poll', tool, path }`: a POINTER to a resolver, not a stored value, so
 * there is no row whose `fed_ts` could serve. The value only exists once
 * something dispatches the tool. The only honest anchor is therefore the VALUE
 * ITSELF, digested — and a digest is a better fit than it first looks, because
 * it answers precisely the question D-007 asks ("did what I relied on change?")
 * without caring how the underlying store happens to version itself.
 *
 * ── WHY `unknown` IS A FIRST-CLASS ALTERNATIVE TO `digest` ───────────────────
 *
 * A cell that could not be read AT ASSERT TIME has no digest to record. The
 * tempting shortcut is to drop the dependency, or store an empty digest; both
 * launder a non-observation into an observation, and the second is worse — it
 * would later compare equal to another failed read and report FRESH. So an
 * unreadable dependency stores its enumerated {@link CellUnknownCode} instead,
 * and every later verdict on it is `undeterminable`. The fact still records what
 * it MEANT to rest on, which is the part a reader needs.
 *
 * Exactly one of `digest` / `unknown` is set. `observed` is a bounded rendering
 * kept purely so a human reading the fact can see what the value WAS without
 * resolving a hash against nothing.
 */
export interface FactDependency {
  /** The cell id this fact rests on, e.g. `pipeline.myChange`. */
  cell: string;
  /**
   * The SUBJECT the cell was read about, for a `callerRelativity:'parameter'`
   * cell (`state:read`'s `as`). Absent for global/ambient cells.
   *
   * ⚠ STORED, NOT RE-DERIVED, AND THAT IS LOAD-BEARING. The re-read at staleness
   * time MUST use the same subject the digest was taken under, or the comparison
   * silently answers a different question — "has the pipeline position of file A
   * changed?" checked against file B is not a weaker answer, it is a wrong one,
   * and it would report `changed` on two files that both sat perfectly still.
   */
  subject?: string;
  /** ISO timestamp the cell was read at assert time. */
  observedAt: string;
  /** Stable digest of the observed value. Absent iff `unknown` is set. */
  digest?: string;
  /** Bounded human-readable rendering of the observed value (never compared). */
  observed?: string;
  /** The enumerated reason the cell yielded no value at assert time. Absent iff
   *  `digest` is set. `'absent'` is this layer's own code for "the cell does not
   *  exist for this reader" — a CellRead status, not a CellUnknownCode. */
  unknown?: CellUnknownCode | 'absent';
  /**
   * P-021 — digest of the cell's MATERIAL answer at assert time, for a cell that
   * declares `materiality`. Set only alongside `digest`.
   *
   * ⚠ ITS ABSENCE IS LOAD-BEARING AND MUST STAY FAIL-LOUD. A dependency filed
   * before this field existed (or against a cell that declares no materiality,
   * or whose declared path did not resolve) has no material anchor — so a raw
   * change CANNOT be shown to be immaterial and is reported CHANGED, exactly as
   * it is today. Every unanchored case therefore degrades to the loud reading.
   * The opposite default would let a schema gap silently certify a moved cell as
   * "materially unchanged", which is the one failure this whole field must not
   * be able to cause.
   */
  materialDigest?: string;
  /** Bounded rendering of the material answer at assert time (never compared) —
   *  it is what lets a reader CHECK a suppression instead of trusting it. */
  material?: string;
  /** The path the material answer was read from, echoed so the note can name it
   *  without re-reading the spec (and so a later spec change is visible). */
  materialPath?: string;
}

/** P-008 (b) — bound a fact's declared dependency set. A fact rests on a handful
 *  of cells; a declaration long enough to need more than this is not a
 *  dependency list, it is a design document in the wrong field. Enforced in code
 *  rather than by a CHECK so an over-long declaration CLIPS like an over-long
 *  body instead of failing the write (this table's standing P-007 rule). */
export const FACT_MAX_DEPENDENCIES = 12;
/**
 * Bound one assertion's cross-key retirement fan-out. A fact correction should
 * be able to collapse a small cluster of overlapping conclusions, not become an
 * unbounded bulk-delete surface.
 */
export const FACT_MAX_SUPERSEDES = 12;
/** Bound for {@link FactDependency.observed} — a label, not a payload. */
export const FACT_DEPENDENCY_OBSERVED_CHARS = 120;

export interface AgentFact {
  scope: FactScope;
  scopeRef: string | null;
  key: string;
  body: string;
  sourceRef: string | null;
  /** P-007: fold-delivery audience restriction (v1 grammar `fleet:<slug>`);
   *  null = unrestricted. Orthogonal to `scope` (what the fact is ABOUT). */
  audienceScope: string | null;
  /** P-007: assert-time verification stamp for a typed sourceRef; null otherwise. */
  sourceProvenance: FactSourceProvenance | null;
  /** EI-18681964809855890: evidence-strength; null = unset (legacy/default,
   *  renders unbadged — see {@link renderFactsFold}). */
  confidence: FactConfidence | null;
  /** EI-20191740437408337: assert-time snapshot metadata; absent on legacy rows. */
  measurement?: FactMeasurement | null;
  /** P-010 / migration 940: executable re-verification + falsification pair. */
  recheck?: FactRecheck | null;
  /** P-008 (b) / D-019: the claim MODALITY (see {@link FactKind}); null = not
   *  declared (every pre-migration-690 row). Distinct from `scope`. */
  kind: FactKind | null;
  /** P-008 (b): the CELLS this fact rests on, captured at assert time. Empty
   *  array when nothing was declared — an assumption without dependencies is
   *  legal, it simply cannot go stale on its own terms. */
  dependsOn: FactDependency[];
  /** P-008 (b) / D-019 DEFECT 2: the optional TYPED assertion P-011 compares,
   *  e.g. `{ subject: 'cell:gate.greenCheckpoint.verdict', assertion: '…' }`.
   *  `body` remains the prose a human reads; null when none was filed. */
  claim: Record<string, unknown> | null;
  /** P-018 / D-016: HOW this convention is enforced (migration 692). null = not
   *  declared — including for every convention whose only enforcement is
   *  documentation, which D-016 rules out as a tier. */
  enforcement: ConventionEnforcement | null;
  /** P-002 / migration 730: what evidence WOULD settle this question — present
   *  only for kind:'undecidable', and ABSENT (not null) when the read did not
   *  select the column, so "not projected" stays distinguishable from "an
   *  undecidable with no exit", which is a defect rather than a narrow read. */
  settledBy?: string | null;
  createdBy: string;
  updatedAt: string;
  /** ISO timestamp, or PostgreSQL's `infinity` for an unbounded convention. */
  expiresAt: string;
  /** Migration 801: deliberate retraction audit metadata. These fields are
   * selected by the version-history read; ordinary live folds omit them. */
  retractedAt?: string | null;
  retractedBy?: string | null;
  retractionReason?: string | null;
  /**
   * P-008 (a): this VERSION's immutable row id — the thing a D-003 pointer names
   * (P-009's `assumption_set_id`). Optional because the fold/list reads do not
   * select it; present on an assert result and on every {@link factVersions} row.
   */
  id?: number;
  /** P-008 (a): when this version was replaced; null/absent ⇒ it is CURRENT. */
  supersededAt?: string | null;
  /** P-008 (a): the id of the version this one replaced; null for the first. */
  supersedesId?: number | null;
  /**
   * P-008 (c) / D-012 / D-077: this fact's CELL VERSION — the hybrid-logical-clock
   * key stamped alongside `fed_ts` by `stamp_local_federated_write` (migration 693).
   *
   * An HLC is a TOTAL ORDER on its own (it embeds the wall clock, a counter and a
   * node id), so it is directly comparable as a string — hence it, not the local
   * `id` sequence, is the delta cursor. D-012's hard constraint is explicit that a
   * cell version must ride this scheme: the `id` sequence is per-database, so two
   * hives both mint id 5 and cells silently break under federation.
   *
   * `null` for any row written BEFORE migration 693 and not rewritten since — those
   * carry no version, so no delta claim can be made about them (they are never
   * reported as changed). They self-heal on their next write.
   */
  cellVersion?: string | null;
}

/**
 * WI-7298: one fact the cap sweep DESTROYED to make room for an assert.
 *
 * Reported to the WRITER, who is the only party positioned to react. WI-6935
 * (b) already made eviction distinguishable AFTER the fact (`evicted_at IS NOT
 * NULL` ⇒ the cap chose it), but only to a forensic reader running SQL — the
 * author saw an unqualified `ok:true` and never learned they had displaced a
 * still-valid neighbour.
 */
export interface FactEviction {
  key: string;
  /** The victim's own evidence strength — a displaced 'verified' is the costly case. */
  confidence: FactConfidence | null;
  /** How much life it had left; the author declared this TTL deliberately. */
  expiresAt: string;
  /** WHOSE fact this was — the actionable field ("I just cost a peer their note"). */
  createdBy: string;
  /**
   * EI-21393210182770949: a bounded excerpt of what was displaced, so the writer
   * can judge whether it mattered WITHOUT a second round-trip.
   *
   * The receipt used to report only key/confidence/expiresAt/createdBy and then
   * instruct "if a listed fact still matters, re-assert it" — un-honourable
   * advice, because nothing in the receipt said what the fact SAID. That gap is
   * why EI-21393210182770949 was filed believing the body had been destroyed; it
   * had not (eviction is a soft-delete), but the receipt gave no way to see it.
   *
   * An EXCERPT rather than the full body on purpose: every assert into a
   * saturated scope evicts, so this is a hot path, and bodies run to
   * {@link FACT_BODY_MAX_CHARS}. Inlining them in full would push the receipt
   * itself against the result budget — the failure mode where the fix for a
   * missing field truncates the fields that were already working. The full text
   * stays one call away via `facts:list { scope, key, versions:true, full:true }`,
   * which the receipt note names.
   */
  bodyExcerpt: string;
  /** True when {@link bodyExcerpt} was cut — tells the reader an excerpt is not the whole body. */
  bodyTruncated: boolean;
}

/**
 * How much of an evicted body the receipt inlines. Enough to identify the fact
 * and judge relevance; short enough that N victims cannot crowd out the rest of
 * the receipt.
 */
export const FACT_EVICTION_EXCERPT_CHARS = 240;

/**
 * Build the excerpt fields for one evicted row.
 *
 * Shared by BOTH producers ({@link assertFact}'s real eviction and the
 * would-evict preview) so the preview cannot promise a shape the real eviction
 * reports differently — a drift that would be invisible, since the preview is
 * what a caller uses to decide whether to write at all.
 *
 * A null/absent body degrades to an empty excerpt rather than throwing: the
 * column is NOT NULL today, and a receipt is the wrong place to discover
 * otherwise.
 */
export function excerptEvictedBody(body: string | null | undefined): {
  bodyExcerpt: string;
  bodyTruncated: boolean;
} {
  const text = typeof body === 'string' ? body : '';
  if (text.length <= FACT_EVICTION_EXCERPT_CHARS) return { bodyExcerpt: text, bodyTruncated: false };
  return { bodyExcerpt: text.slice(0, FACT_EVICTION_EXCERPT_CHARS), bodyTruncated: true };
}

/**
 * WI-7298: what {@link assertFact} returns — the fact, plus what the write COST.
 *
 * ⚠ Deliberately NOT a field on {@link AgentFact}. `AgentFact` is what
 * `foldFacts` / `listFacts` / `factVersions` return, and an eviction report is a
 * property of the WRITE, not of the fact; hanging it there would typecheck for
 * every fold reader while being permanently absent. The intersection confines it
 * to the assert path.
 *
 * ⚠ Also deliberately NOT a wrapper (`{ fact, evicted }`). That shape strands
 * every caller and fixture that reads assertFact's return. Because `evicted` is
 * OPTIONAL, a plain `AgentFact` stays assignable to this type, so the
 * `assertFact: typeof assertFact` dependency stubs keep compiling untouched.
 */
export type AssertFactResult = AgentFact & {
  /**
   * CURRENT local sibling keys this write actually retired via `supersedes`.
   * Absent when none matched — missing, wrong-scope, expired-only-history, and
   * already-retired keys are deliberately not reported as changed.
   */
  retiredKeys?: string[];
  /**
   * Facts the cap evicted to seat THIS write. Absent when nothing was displaced
   * — never an empty array, so `if (result.evicted)` reads correctly.
   *
   * A non-empty value also means the scope is AT cap: the sweep only fires past
   * `FACTS_PER_SCOPE_CAP - 1` incumbents. That is why there is no separate
   * `atCap` flag — reporting at-cap when nothing was evicted would cost a COUNT
   * query on every assert, and this carries the same signal for free.
   */
  evicted?: FactEviction[];
  /**
   * EI-19451909636567773: whether THIS write is going to survive.
   *
   * `evicted` above reports the fact you DESTROYED — the half you can do nothing
   * about. This reports the half you can: where your own row landed in the same
   * ranking, and whether the next assert into this scope destroys it.
   */
  survival?: FactSurvival;
  /**
   * P-006 / D-011: repairs this write applied to a recoverable caller intent, instead of
   * refusing it. Absent when the input needed no repair — never an empty object, matching
   * the `evicted` convention above, so `if (result.normalized)` reads correctly.
   *
   * This field is the whole reason the normalization is legitimate rather than a surprise:
   * a silent repair teaches the caller nothing and they keep making the same call forever.
   */
  normalized?: FactNormalization;
};

/**
 * What {@link assertFact} repaired rather than refused (P-006 / D-011).
 *
 * Each field is stated as WHAT WAS INFERRED / CHANGED, not merely that something happened,
 * so the receipt is actionable on its own without re-reading the tool schema.
 */
export type FactNormalization = {
  /**
   * `subjectVolatile:true` was inferred because `measuredAt` was supplied without it.
   * Carries the consequence, not just the flag: the fact is now a SNAPSHOT with a
   * bounded TTL, which is a materially different lifetime from an ordinary fact.
   */
  subjectVolatileInferred?: true;
  /** The ttlSec originally requested, before the volatile ceiling clamped it. */
  ttlClampedFrom?: number;
  /** The ceiling actually applied. */
  ttlClampedTo?: number;
  /** One line a caller can act on, assembled from whichever repairs fired. */
  note: string;
};

/**
 * EI-19451909636567773: the written fact's OWN standing in the victim ranking.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────
 * WI-7292 stopped a write from evicting the row it had just inserted. It did
 * NOT stop the row from being evicted by the very NEXT writer, and the receipt
 * still says nothing about it. A fact is exempt from its own write's sweep and
 * from no other, so on a saturated scope the real lifetime of a bottom-ranked
 * fact is "until anyone else asserts here" — 38 seconds, measured
 * 2026-08-03T16:52:57Z→16:53:35Z on `gate-red-e53a0758-fully-stale`.
 *
 * The author saw `ok:true` with an `expiresAt` two days out. Standing agent
 * instruction is that a fact is folded verbatim into every future orient until
 * retracted, so an author who gets that receipt reasonably stops carrying the
 * conclusion anywhere else. For a bottom-ranked fact that is currently false,
 * and undetectable without a follow-up SQL read of `evicted_at`.
 *
 * ── WHY THE EXISTING SIGNALS DO NOT COVER IT ───────────────────────────────
 * `notify-evicted` tells the author AFTER the fact is already gone, which is
 * the right message at the wrong time: the TTL is only changeable at write
 * time. The assert note's advice ("a SHORT TTL is what makes a fact cheap for
 * the cap to choose") is correct but arrives attached to somebody ELSE's loss,
 * phrased as general advice, at the one moment the reader is least likely to
 * hear it as being about themselves.
 *
 * ── SCOPE (deliberate) ─────────────────────────────────────────────────────
 * Computed ONLY on a write that actually evicted, reusing the query that was
 * already running there. That leaves exactly one blind write per scope: the one
 * that takes a scope from CAP-1 to CAP evicts nothing, so it gets no survival
 * report even though it may land last. Closing that needs a COUNT on every
 * assert — the same cost the `evicted`/`atCap` note above already declines to
 * pay — and it is self-limiting: the NEXT write into that scope reports, and if
 * it evicts the blind fact, that author is notified. Cheap fix, real residue,
 * stated rather than hidden.
 */
export interface FactSurvival {
  /** 1 = safest. Position among live facts, in the SAME order the sweep ranks victims. */
  rank: number;
  /** Live facts in the scope after this write (== FACTS_PER_SCOPE_CAP on this path). */
  liveCount: number;
  /**
   * True ⇒ this fact is the bottom of the ranking, so the next assert into this
   * scope BY ANY WRITER evicts it. The single actionable bit in this object.
   */
  nextVictim: boolean;
  /**
   * The remaining-life FRACTION of the fact ranked immediately ABOVE this one —
   * the bar this write failed to clear on key 2. Null when this fact is not last
   * (nothing to beat) or the neighbour could not be determined.
   *
   * A fraction of DECLARED TTL (1 = just written, 0 = expiring now), because
   * that is what the ranking compares since EI-19483432832662150. This was
   * `survivingTtlFloor`, an absolute `expires_at`, back when key 2 was
   * `expires_at DESC`. The rename is deliberate and not cosmetic: the old field
   * existed to tell an author "re-assert with a TTL beyond this", and that is
   * now the one lever that provably CANNOT help — a fresh write already scores
   * ~1.0, the maximum the key can produce, so a longer TTL buys nothing. Keeping
   * the old name would have kept emitting advice the ranking no longer honours.
   */
  survivingFractionFloor: number | null;
};

export interface AssertFactInput {
  scope: FactScope;
  /** Required for every scope except 'workspace' (D-001). */
  scopeRef?: string | null;
  /** Stable slug — the upsert/retract target. */
  key: string;
  body: string;
  /**
   * Other CURRENT local keys in this exact workspace/scope/ref whose conclusion
   * this assertion replaces. They are soft-retracted atomically with the new
   * row, preserving their audit/history records. The asserted key itself is
   * refused; same-key correction already has append-version semantics.
   */
  supersedes?: readonly string[] | null;
  sourceRef?: string | null;
  /** P-007: restrict fold delivery to an audience (v1: `fleet:<slug>`).
   *  Validated via {@link validateAudienceScope} — reject a typo loudly rather
   *  than silently hiding the fact from every reader. */
  audienceScope?: string | null;
  /** P-007: the assert-time verification stamp (resolved by the tool layer —
   *  the store persists it verbatim). */
  sourceProvenance?: FactSourceProvenance | null;
  /** EI-18681964809855890: evidence-strength (see {@link FactConfidence}).
   *  Omitted/null = unset — legacy shape, unbadged in folds, ordinary TTL. */
  confidence?: FactConfidence | null;
  /**
   * EI-20191740437408337: declare that the asserted values were sampled from a
   * subject that may still be changing. Requires `measuredAt`; the stored fact
   * is rendered as a SNAPSHOT and is bounded to a short TTL.
   */
  subjectVolatile?: boolean;
  /** ISO timestamp at which a volatile subject was sampled. */
  measuredAt?: string | null;
  /** P-008 (b) / D-019: the claim modality. Omitted/null = not declared. */
  kind?: FactKind | null;
  /**
   * P-008 (b): the fact's declared CELL dependencies, ALREADY RESOLVED to
   * digests by the caller — same division of labour as `sourceProvenance`,
   * which the store also persists verbatim. Resolving a cell means dispatching
   * its resolver tool, and a storage module that reaches into the tool
   * dispatcher to do that would invert the dependency (and make every fact
   * write, including the ones inside routines, depend on the whole tool
   * registry). `captureFactDependencies` in agent-tools/facts owns the capture.
   */
  dependsOn?: readonly FactDependency[] | null;
  /** P-008 (b) / D-019 DEFECT 2: the optional typed assertion P-011 compares. */
  claim?: Record<string, unknown> | null;
  /** P-018 / D-016: the enforcement tier. Validated by
   *  {@link validateConventionEnforcement} — a tier on a non-convention, a
   *  floorless gate/detector, and a floored structural are all REFUSED. */
  enforcement?: ConventionEnforcement | null;
  /** P-002: what evidence WOULD settle this question. REQUIRED for
   *  kind:'undecidable' and refused on any other kind — validated by
   *  {@link validateUndecidableSettledBy}. An UNKNOWN with no stated exit
   *  invites the re-derivation it exists to prevent. */
  settledBy?: string | null;
  /** P-010: how to re-run the claim and what concrete result disproves it. */
  recheck?: FactRecheck | null;
  createdBy: string;
  /**
   * P-001 (facts-require-explicit-expiry-2026-09-02) — one half of the REQUIRED
   * lifetime declaration; see {@link validateFactLifetime}. There is no silent 7d
   * fallback any more: a write that declares no lifetime AT ALL is refused. A
   * volatile subject's ttlSec is still CLAMPED to {@link FACT_VOLATILE_MAX_TTL_SEC},
   * never refused (D-011).
   */
  ttlSec?: number;
  /**
   * P-002 — the other half: permanence stated SEMANTICALLY rather than as a magic
   * number. Accepted ONLY where {@link isFactCapExempt} already holds
   * (kind:'convention', or a wall:/dead-end:/guard-rail: key), because eviction ranks
   * by remaining-TTL-fraction DESC — so an unbounded row in the RANKED population is
   * the LEAST evictable row there and becomes an unevictable squatter that crowds out
   * live observations. Refused outright for a volatile subject: a snapshot of a moving
   * subject is never a standing fact.
   */
  permanent?: boolean;
  workspaceId?: string;
  /** F0-2 (federated-scout-gym): OPT-IN federation egress — only shareable
   *  facts ever leave the hive. Default false (privacy default, D-001/D-005). */
  shareable?: boolean;
  /**
   * F1-1 federation identity (mig 461 `harness_slug` — "the Hive home slug;
   * NULL = un-hived local fact"). REQUIRED for a shareable fact to actually
   * federate: the capture routes the outbox row by it AND the peer-side wire
   * validator (`isAgentFactWireRow`) rejects a null harness_slug, so a
   * shareable assert without it is captured-then-dropped. Resolve via
   * {@link resolveFactFederationSlug} (member harness → its hive home).
   */
  potHomeSlug?: string | null;
}

/**
 * EI-18681964809855890: the TTL default a confidence tier implies when the
 * caller omits an explicit `ttlSec` — 'provisional'/'suspected' facts decay
 * far faster than an ordinary bounded fact so a hedge can't quietly calcify
 * into settled fact. Returns undefined for null/undefined/'verified'; those
 * callers must provide an explicit TTL or another applicable lifetime rule.
 * PURE — no IO, unit-tested without PG.
 */
export function defaultTtlSecForConfidence(confidence: FactConfidence | null | undefined): number | undefined {
  if (confidence === 'provisional') return FACT_PROVISIONAL_DEFAULT_TTL_SEC;
  if (confidence === 'suspected') return FACT_SUSPECTED_DEFAULT_TTL_SEC;
  return undefined; // null / undefined / 'verified' — caller must declare a lifetime
}

/**
 * D-002 — a `dead-end:` is a claim about CURRENT CODE, so it gets a long but FINITE
 * life rather than permanence. Long enough that it cannot silently lapse at the old 7d
 * and become reaper-eligible (the WI-2141838 defect); finite enough that a dead-end
 * invalidated by a later fix is eventually re-affirmed instead of standing forever.
 *
 * A `guard-rail:` is a standing DECISION, not a claim about code, so it is permanent —
 * that asymmetry is the decision, not an oversight. `wall:` stays finite for a third
 * reason again: its lapse watchdog fires ON the lapse.
 */
export const DEAD_END_DEFAULT_TTL_SEC = WALL_DEFAULT_TTL_SEC;

/** The shape {@link validateFactLifetime} and {@link resolveFactLifetime} both read. */
export interface FactLifetimeInput {
  key: string;
  // FactKind, not a bare string: this value is forwarded to isFactCapExempt, which
  // takes Pick<AssertFactInput,'key'|'kind'>. Widening it here re-opens a TS2322 at
  // that call and, worse, would let a typo'd kind silently miss the 'convention' test.
  kind?: FactKind | null;
  ttlSec?: number | null;
  permanent?: boolean;
  confidence?: FactConfidence | null;
  subjectVolatile?: boolean;
}

/**
 * P-001/P-002/P-003 (plan facts-require-explicit-expiry-2026-09-02) — the LIFETIME
 * DECLARATION, and the one thing this store will not choose on a caller's behalf.
 *
 * ⚠ THE SILENT DEFAULT IS GONE ON PURPOSE. `FACT_DEFAULT_TTL_SEC` used to apply to any
 * write that said nothing — measured 2,104 writes in 7 days (papercusp-workspace,
 * 2026-09-02) whose lifetime nobody chose, which then expired unread. The owner's
 * ruling was "Require explicit expiry; drop default-forever", and BOTH halves bind:
 * defaulting to permanent instead was REJECTED on the eviction evidence below.
 *
 * A lifetime is declared in exactly one of five ways; the first that applies wins:
 *
 *   1. `permanent: true`   — explicit, and GATED (see below).
 *   2. `ttlSec: <int>`     — explicit and bounded.
 *   3. `kind:'convention'` — normative state, permanent. The P-002 semantic route.
 *   4. a typed safety slot — `guard-rail:` permanent; `dead-end:`/`wall:` long but
 *                            FINITE (D-002, {@link DEAD_END_DEFAULT_TTL_SEC}).
 *   5. `confidence:'provisional'|'suspected'` — these ALREADY imply a short TTL
 *      (EI-18681964809855890), so stating one is stating a lifetime.
 *
 * Anything else is refused. That is exactly the write which declared nothing at all —
 * NOT the ~22,000 writes a week that already pass an explicit ttlSec, and not the
 * high-frequency system writers, all of which are already compliant by construction.
 *
 * ⚠ WHY PERMANENCE IS GATED ON CAP-EXEMPTION rather than offered freely: eviction ranks
 * by confidence, then REMAINING TTL FRACTION DESC. An unbounded row has the maximal
 * remaining fraction, so inside the ranked population it is the LEAST evictable thing
 * there. Free permanence would therefore not make facts durable — it would fill a
 * capped, contended pool with near-unevictable rows, converting a legible failure ("my
 * fact expired") into a silent one ("my fact was evicted immediately, or crowded out a
 * real convention"). {@link isFactCapExempt} is REUSED rather than re-spelled as
 * `kind === 'convention'` so the exempt population keeps exactly one definition.
 *
 * Validated in the STORE and not only in the tool, for the same reason as
 * {@link validateUndecidableSettledBy} and {@link validateConventionEnforcement}: a
 * non-tool caller (a routine, a backfill) must not be able to write a lifetime nobody
 * chose. Tool-only enforcement is the same hole, one layer down.
 *
 * PURE — no IO, unit-testable without PG. Returns an error string, or null when the
 * input declares a lifetime.
 */
export function validateFactLifetime(input: FactLifetimeInput): string | null {
  const key = (input.key ?? '').trim();
  const hasTtl = input.ttlSec != null;
  const wantsPermanent = input.permanent === true;

  if (hasTtl && wantsPermanent) {
    return (
      'facts:assert — declare ONE lifetime, not two: this call passed both ttlSec and permanent:true. ' +
      'Drop ttlSec for an unbounded fact, or drop permanent:true for a bounded one.'
    );
  }

  if (wantsPermanent) {
    // A snapshot of a moving subject is never a standing fact. Refused rather than
    // clamped: clamping an explicit ttlSec shortens a stated intent (D-011), but
    // silently converting "permanent" to 15 minutes would invert one.
    if (input.subjectVolatile === true) {
      return (
        'facts:assert — permanent:true is refused for a volatile measurement: a snapshot of a moving subject ' +
        `is never a standing fact. Pass ttlSec instead (it is clamped to ${FACT_VOLATILE_MAX_TTL_SEC}s), or drop ` +
        'the volatile marker if the claim really is a standing property rather than a measured value.'
      );
    }
    if (!isFactCapExempt({ key, kind: input.kind ?? null })) {
      return (
        'facts:assert — permanent:true is accepted only for a fact EXEMPT from the per-scope cap: ' +
        `kind:'convention', or a key under '${WALL_KEY_PREFIX}' / '${DEAD_END_KEY_PREFIX}' / ` +
        `'${GUARD_RAIL_KEY_PREFIX}'. An unbounded row in the ranked population has the maximal remaining-TTL ` +
        'fraction, which makes it the LEAST evictable row there: it would never expire AND would crowd out live ' +
        "observations. If this is a standing rule, declare kind:'convention' — that makes it permanent on its " +
        'own. If it is a finding about current code, it SHOULD expire: pass ttlSec and a recheck.'
      );
    }
    return null;
  }

  if (hasTtl) return null;
  if (input.kind === 'convention') return null;
  // The typed safety slots declare durability by construction; isFactCapExempt with a
  // null kind is exactly the "is this a wall:/dead-end:/guard-rail: key" question.
  if (isFactCapExempt({ key, kind: null })) return null;
  if (input.confidence === 'provisional' || input.confidence === 'suspected') return null;

  return (
    'facts:assert — state how long this fact should live; there is no default any more. Pass ttlSec:<seconds> ' +
    "for a bounded fact, or permanent:true for a standing one (accepted for kind:'convention' and the " +
    "wall:/dead-end:/guard-rail: slots). Declaring kind:'convention' makes it permanent on its own, and " +
    "confidence:'provisional'|'suspected' already implies a short TTL. The silent 7-day default was removed " +
    'because it was being applied to facts whose lifetime nobody had chosen, which then expired unread.'
  );
}

/**
 * Resolve the DECLARED lifetime to what gets stored. Total by construction: every
 * caller runs {@link validateFactLifetime} first, so the un-declared case cannot reach
 * here — the final fallback exists only to keep this a total function.
 *
 * Takes `effectiveTtlSec` (the caller's ttlSec AFTER the volatile clamp) rather than the
 * raw input, so the D-011 clamp stays in exactly one place instead of being re-derived.
 *
 * PURE — no IO, unit-testable without PG.
 */
export function resolveFactLifetime(
  input: Omit<FactLifetimeInput, 'ttlSec'> & { subjectVolatile: boolean; effectiveTtlSec: number | null },
): { permanent: boolean; ttlSec: number } {
  const key = (input.key ?? '').trim();

  // An explicit (already-clamped) TTL always wins — including over a slot default, so a
  // caller who deliberately wants a short-lived wall or dead-end still gets one.
  if (input.effectiveTtlSec != null && input.effectiveTtlSec > 0) {
    return { permanent: false, ttlSec: input.effectiveTtlSec };
  }
  // A volatile subject can never reach the permanent branches below.
  if (input.subjectVolatile) return { permanent: false, ttlSec: FACT_VOLATILE_MAX_TTL_SEC };

  if (input.permanent === true) return { permanent: true, ttlSec: 0 };

  // A TYPED SLOT OUTRANKS `kind` — and these three branches must stay ABOVE the
  // `kind:'convention'` one below. A slot is a declaration about THIS fact's epistemic
  // status ("a tried-and-failed approach", "an owner-gated blocker"); `kind` only names
  // its modality. D-002 reasoned each slot's lifetime explicitly, so a `kind` passed
  // alongside must not silently overwrite it.
  //
  // Ordered the other way round — as they were until 2026-09-05 — `kind:'convention'`
  // short-circuited and granted permanence to the two slots D-002 deliberately kept
  // FINITE ("a dead-end is a claim about CURRENT code ... re-affirmed rather than
  // standing forever"). Measured live at the time of the fix: 57/57 `dead-end:` and 4/4
  // `wall:` facts carrying kind:'convention' had expires_at = infinity, and NOT ONE of
  // the 61 carried a recheck — every one a permanent, never-re-verified claim about code
  // that had moved on. For `wall:` it also disabled the slot's entire purpose: the
  // wall-lapse watchdog fires on the LAPSE, so an infinite wall can never escalate.
  //
  // Nothing is lost for a caller who genuinely wants an unbounded slot fact: the
  // explicit `permanent:true` branch above still wins, and `isFactCapExempt` accepts it
  // for exactly these three prefixes (13 live rows already take that deliberate route).
  if (key.startsWith(GUARD_RAIL_KEY_PREFIX)) return { permanent: true, ttlSec: 0 }; // D-002
  if (key.startsWith(DEAD_END_KEY_PREFIX)) return { permanent: false, ttlSec: DEAD_END_DEFAULT_TTL_SEC }; // D-002
  if (key.startsWith(WALL_KEY_PREFIX)) return { permanent: false, ttlSec: WALL_DEFAULT_TTL_SEC };

  if (input.kind === 'convention') return { permanent: true, ttlSec: 0 };

  const byConfidence = defaultTtlSecForConfidence(input.confidence);
  if (byConfidence != null) return { permanent: false, ttlSec: byConfidence };

  // UNREACHABLE while validateFactLifetime runs first — pinned from BOTH directions by
  // describe('the two functions AGREE — resolve is only ever reached past validate') in
  // agent-facts/fact-lifetime.test.ts: the only input that reaches this line is exactly the
  // one validate REFUSES, and every input validate ACCEPTS resolves above it. Never treat
  // this as a default.
  return { permanent: false, ttlSec: FACT_DEFAULT_TTL_SEC };
}

/**
 * EI-18681964809855890: bare EMPIRICAL-CERTAINTY language in a fact body that
 * carries no `confidence` tag — the write-time nudge for "never write a
 * peer's provisional evidence to a durable surface at higher confidence than
 * they stated it" (the rule the incident violated). Warn-only, mirrors the
 * existing provenanceLint contract (never blocks the write); the tool layer
 * folds this into the response only when it fires. PURE — no IO.
 *
 * Deliberately narrow (a handful of unhedged-certainty words) rather than a
 * general sentiment classifier — false positives on a genuinely verified fact
 * are harmless noise (the caller sees a suggestion, not a block), but a
 * classifier broad enough to catch every phrasing would fire on ordinary
 * prose constantly and train agents to ignore it.
 */
const UNHEDGED_CERTAINTY_RE = /\b(verified|confirmed|confirms|proven|proves)\b/i;

export function certaintyLanguageWithoutConfidence(
  body: string,
  confidence: FactConfidence | null | undefined,
): string | null {
  if (confidence) return null; // an explicit tag of ANY tier already answers the question
  const m = UNHEDGED_CERTAINTY_RE.exec(body);
  if (!m) return null;
  return (
    `confidence_lint: this fact's body asserts certainty ("${m[0]}") but no \`confidence\` was set. ` +
    `EI-18681964809855890: a peer's single unreplicated run rendered at IDENTICAL authority to a verified ` +
    `measurement once cost four agents a false regression chase. Pass confidence:'verified' if you replicated ` +
    `this yourself, 'provisional' for a single/unreplicated data point, or 'suspected' for a hunch / second-hand ` +
    `hedge — never write a peer's provisional evidence at higher confidence than they stated it.`
  );
}

/** Validate scope/ref pairing per D-001. Returns an error string or null. */
export function validateFactScope(scope: string, scopeRef?: string | null): string | null {
  if (!(FACT_SCOPES as readonly string[]).includes(scope)) {
    return `unknown scope '${scope}' — one of ${FACT_SCOPES.join('|')}`;
  }
  const ref = (scopeRef ?? '').trim();
  if (scope === 'workspace' && ref) return "scope 'workspace' carries no scope_ref";
  if (scope !== 'workspace' && !ref) return `scope '${scope}' requires scope_ref`;
  return null;
}

/** A work-item id: the shape `scope:'work_item'` requires, and the one most often
 *  mis-filed under another scope (see validateFactScopeRefShape). */
const WORK_ITEM_REF_RE = /^(WI|EI|F)-[0-9]+$/;

/**
 * EI-22179589084262757 — reject a `scope_ref` whose SHAPE can never match the fold
 * selector for its scope. Presence is already checked by validateFactScope above;
 * this checks that the ref could plausibly BE what the scope means.
 *
 * WHY THIS IS A LOUD REFUSAL AND NOT A LINT: every reader is selector-scoped
 * (`orient` folds {workspace}, {owner,ownerId}, {harness,slug}), so a row keyed to
 * the wrong KIND of identifier is unreadable BY CONSTRUCTION — it is written, stored,
 * counted against nothing, and never folded. Nothing reports it, so the author
 * believes the fact stands. Measured 2026-09-02 on papercusp-workspace: 41 such rows,
 * from 12+ independent callers over six weeks, the newest a day old. The dominant
 * shape is a work-item id under scope 'harness' or 'owner' (33 rows) — agents
 * recording the PROVENANCE of a finding in the nearest string field. `source_ref`
 * is that field, which is why this error names it.
 *
 * DENYLIST, NOT ALLOWLIST, deliberately: it rejects only shapes proven unfoldable,
 * so a legitimate future owner/harness id form is never refused by a stale pattern.
 * Not wired into `validateFactScope` because `retractFact` shares that function —
 * tightening it there would make the ~41 existing orphans unretractable, blocking
 * the cleanup this enables. PURE; assert-path only.
 */
export function validateFactScopeRefShape(scope: string, scopeRef?: string | null): string | null {
  const ref = (scopeRef ?? '').trim();
  if (!ref || scope === 'workspace') return null; // ref-less scope: presence rules already applied

  const unfoldable = (why: string, remedy: string): string =>
    `scope_ref '${ref}' cannot be a '${scope}' reference — ${why}. A fact is folded by ` +
    `selector (scope + scope_ref), so this row would be stored but UNREADABLE: no ` +
    `orient/carry fold could ever match it, and nothing would report that to you. ${remedy}`;

  if (/\s/.test(ref)) {
    return unfoldable(
      'it contains whitespace, so it is prose rather than an identifier',
      "Put the note in `body`, and the provenance in `source_ref` — scope_ref is a lookup key, not a free-text field.",
    );
  }
  if (ref.includes('/') || ref.includes('\\')) {
    return unfoldable(
      'it is a filesystem path',
      "To record a fact about code, use a scope whose ref is an identity (harness/owner/work_item) and cite the path in `body` or `source_ref`.",
    );
  }
  if (scope === 'work_item') {
    if (!WORK_ITEM_REF_RE.test(ref)) {
      return unfoldable(
        "scope 'work_item' is keyed by a work-item id (WI-/EI-/F-<digits>)",
        'Pass the item id, or choose the scope that matches what the fact is about.',
      );
    }
    return null;
  }
  if (WORK_ITEM_REF_RE.test(ref)) {
    return unfoldable(
      `a work-item id is not a '${scope}' identity`,
      "If the fact is ABOUT that item, use scope:'work_item'. If it is a harness/owner-wide fact you DISCOVERED on that item, keep this scope and record the item in `source_ref`.",
    );
  }
  return null;
}

/** P-007 v1 audience grammar: `fleet:<slug>`. Grows by adding alternatives HERE
 *  (one grammar, shared by assert-validation and any future selector renderer). */
const AUDIENCE_SCOPE_RE = /^fleet:[a-z0-9][a-z0-9._-]*$/i;

/**
 * Validate an audienceScope value. Returns an error string or null. STRICT by
 * design: an unknown/typo'd audience is REJECTED at assert rather than stored —
 * a stored-but-unmatchable audience would silently hide the fact from every
 * reader, the worst failure for a deterministic-delivery surface. PURE.
 */
export function validateAudienceScope(audienceScope: string | null | undefined): string | null {
  const a = (audienceScope ?? '').trim();
  if (!a) return null; // absent = unrestricted
  if (!AUDIENCE_SCOPE_RE.test(a)) {
    return `audienceScope '${a}' does not match the v1 grammar 'fleet:<slug>' — an unmatchable audience would hide the fact from everyone`;
  }
  return null;
}

/**
 * P-018 / D-016 / D-075 R3 — validate an enforcement declaration against the
 * fact's `kind`. Returns an error string or null. PURE.
 *
 * Three refusals, each with a reason that is NOT stylistic:
 *
 * 1. **An enforcement tier on a non-convention is refused.** A tier says how a
 *    NORM is enforced; a conclusion and an assumption are not norms, so there is
 *    no behaviour a tier could describe. Silently dropping it would be worse than
 *    refusing — the caller would believe a tier was recorded.
 *
 * 2. **A `gate`/`detector` tier REQUIRES both `floor` and `reviewBy`.** This is
 *    D-016 made mechanical: *"Every tier-2 and tier-3 behaviour ships with an
 *    adoption floor and a review date"* and *"a detector without a floor is prose
 *    exhortation in a costume."* Left as documentation, that sentence is itself
 *    the prose-exhortation mechanism D-016 exists to reject — the rule only
 *    survives contact as a typed refusal. A `floor` of 0 is refused for the same
 *    reason: a floor nothing can fall below is not a floor.
 *
 * 3. **A `structural` tier REFUSES a floor/reviewBy.** D-016: structural "needs
 *    no enforcement because there is no behaviour to enforce" — so there is
 *    nothing to measure and the adoption rate is not merely unmeasured but
 *    UNDEFINED. Accepting a floor there would put an uncomputable number on the
 *    review docket, and an uncomputable floor reads as *failing* at review, which
 *    under D-016's own rule ("below floor at review = the feature is failing; it
 *    either moves up a tier or is cut") would get a working convention cut.
 */
export function validateConventionEnforcement(
  kind: FactKind | null | undefined,
  enforcement: ConventionEnforcement | null | undefined,
): string | null {
  if (enforcement == null) return null; // absent = untiered, always legal
  if (kind !== 'convention') {
    return (
      `enforcement is only meaningful on kind:'convention' (got ${kind == null ? 'no kind' : `kind:'${kind}'`}) — ` +
      `a tier describes how a NORM is enforced, and a ${kind ?? 'kind-less'} fact is not one`
    );
  }
  const tier = enforcement.tier;
  if (!(CONVENTION_ENFORCEMENT_TIERS as readonly string[]).includes(tier)) {
    return (
      `unknown enforcement tier '${tier}' — one of ${CONVENTION_ENFORCEMENT_TIERS.join('|')}. ` +
      `Note 'prompt' is deliberately not a tier (D-016): a convention enforced only by ` +
      `documentation leaves enforcement unset rather than claiming one`
    );
  }
  const hasFloor = enforcement.floor != null;
  const hasReview = (enforcement.reviewBy ?? '').trim() !== '';
  if (MEASURED_TIERS.has(tier)) {
    if (!hasFloor || !hasReview) {
      const missing = [!hasFloor ? 'floor' : null, !hasReview ? 'reviewBy' : null]
        .filter(Boolean)
        .join(' and ');
      return (
        `tier '${tier}' requires ${missing} (D-016: every tier-2/tier-3 behaviour ships with an ` +
        `adoption floor and a review date — "a detector without a floor is prose exhortation in a costume")`
      );
    }
    const floor = enforcement.floor as number;
    if (!Number.isFinite(floor) || floor <= 0 || floor > 1) {
      return `floor must be a rate in (0,1] (got ${JSON.stringify(enforcement.floor)}) — a floor of 0 is not a floor`;
    }
    const reviewBy = (enforcement.reviewBy ?? '').trim();
    const parsed = Date.parse(reviewBy);
    if (!Number.isFinite(parsed)) {
      return `reviewBy '${reviewBy}' is not a parseable date — an unparseable review date never comes due`;
    }
  } else {
    if (hasFloor || hasReview) {
      const extra = [hasFloor ? 'floor' : null, hasReview ? 'reviewBy' : null]
        .filter(Boolean)
        .join(' and ');
      return (
        `tier 'structural' takes no ${extra} — D-016: structural "needs no enforcement because there ` +
        `is no behaviour to enforce", so the adoption rate is undefined, not merely unmeasured. An ` +
        `uncomputable floor reads as FAILING at review and would get a working convention cut`
      );
    }
  }
  return null;
}

/**
 * P-018: defensive read of the `enforcement` jsonb. Same dual text/object
 * arrival handling as {@link parseFactDependencies}. An unrecognised tier reads
 * as null rather than propagating a tier the contract does not have — the mig-692
 * CHECK already rejects it at write time; this is the read-side backstop for the
 * case a CHECK cannot cover (a LATER migration widening the vocabulary). PURE.
 */
export function parseConventionEnforcement(raw: unknown): ConventionEnforcement | null {
  let v = raw;
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t) return null;
    try {
      v = JSON.parse(t);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const tier = typeof o.tier === 'string' ? o.tier : '';
  if (!(CONVENTION_ENFORCEMENT_TIERS as readonly string[]).includes(tier)) return null;
  const out: ConventionEnforcement = { tier: tier as ConventionEnforcementTier };
  if (typeof o.floor === 'number' && Number.isFinite(o.floor)) out.floor = o.floor;
  if (typeof o.reviewBy === 'string' && o.reviewBy.trim()) out.reviewBy = o.reviewBy.trim();
  return out;
}

/**
 * P-007: defensive read of a source_provenance jsonb round-trip. Absent /
 * malformed / forged-shape → null, never throws (a bad row can't crash a fold).
 * Accepts BOTH an already-parsed object and raw JSON text — whether a jsonb
 * column arrives parsed depends on the postgres.js client's `types` config
 * (a custom types map suppresses the built-in json parser: the test-helper
 * client returns jsonb as text while getOrgPg returns objects). PURE.
 */
export function parseFactSourceProvenance(raw: unknown): FactSourceProvenance | null {
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (s.kind !== 'msg' && s.kind !== 'work-item' && s.kind !== 'owner-turn') return null;
  if (typeof s.verified !== 'boolean') return null;
  if (typeof s.verifiedAt !== 'string' || !s.verifiedAt) return null;
  return {
    kind: s.kind,
    verified: s.verified,
    verifiedAt: s.verifiedAt,
    ...(typeof s.quote === 'string' && s.quote ? { quote: s.quote } : {}),
    ...(s.quoteRedacted === true ? { quoteRedacted: true } : {}),
    ...(typeof s.label === 'string' && s.label ? { label: s.label } : {}),
    ...(typeof s.error === 'string' && s.error ? { error: s.error } : {}),
  };
}

/**
 * Defensive read of the volatile-measurement jsonb round-trip. A malformed or
 * legacy value must never make a fold fail, and an unmarked timestamp must not
 * be presented as a snapshot marker.
 */
export function parseFactMeasurement(raw: unknown): FactMeasurement | null {
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  if (m.subjectVolatile !== true || typeof m.measuredAt !== 'string' || !m.measuredAt.trim()) return null;
  const measuredMs = Date.parse(m.measuredAt);
  if (!Number.isFinite(measuredMs)) return null;
  return { subjectVolatile: true, measuredAt: new Date(measuredMs).toISOString() };
}

/**
 * P-008 (b): defensive read of the `depends_on` jsonb round-trip. Same contract
 * and same reasons as {@link parseFactSourceProvenance}: absent / malformed /
 * wrong-shaped entries are DROPPED rather than thrown on, and both the
 * already-parsed and raw-JSON-text arrivals are accepted (whether a jsonb column
 * arrives parsed depends on the postgres.js client's `types` config — the
 * test-helper client returns text where getOrgPg returns objects, and a parser
 * that handled only one of those would pass its unit tests and fail in
 * production).
 *
 * ⚠ A malformed ENTRY is dropped; it is never coerced into a readable one. An
 * entry with neither `digest` nor `unknown` has no anchor at all, so keeping it
 * would mean reporting a comparison that cannot be made — the exact laundering
 * the `unknown` branch exists to prevent. PURE.
 */
export function parseFactDependencies(raw: unknown): FactDependency[] {
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  const out: FactDependency[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const d = entry as Record<string, unknown>;
    const cell = typeof d.cell === 'string' ? d.cell.trim() : '';
    const observedAt = typeof d.observedAt === 'string' ? d.observedAt : '';
    if (!cell || !observedAt) continue;
    const digest = typeof d.digest === 'string' && d.digest ? d.digest : undefined;
    const unknown =
      typeof d.unknown === 'string' && d.unknown ? (d.unknown as FactDependency['unknown']) : undefined;
    // Exactly one anchor. Neither ⇒ nothing to compare; both ⇒ contradictory,
    // and guessing which one to believe is how a wrong verdict gets minted.
    if ((digest === undefined) === (unknown === undefined)) continue;
    out.push({
      cell,
      ...(typeof d.subject === 'string' && d.subject ? { subject: d.subject } : {}),
      observedAt,
      ...(digest ? { digest } : {}),
      ...(unknown ? { unknown } : {}),
      ...(typeof d.observed === 'string' && d.observed
        ? { observed: d.observed.slice(0, FACT_DEPENDENCY_OBSERVED_CHARS) }
        : {}),
    });
    if (out.length >= FACT_MAX_DEPENDENCIES) break;
  }
  return out;
}

/**
 * P-008 (b): normalize a caller's declared dependencies for STORAGE — trim,
 * de-duplicate by cell, drop anchorless entries, clip `observed`, and bound the
 * list. Returns null when nothing survives, so the column stays NULL rather than
 * holding an empty array (a NULL and a `[]` would otherwise be two encodings of
 * "no dependencies", and readers would have to handle both).
 *
 * De-duplication keeps the FIRST occurrence: a caller that names the same cell
 * twice observed it once: the second entry is a duplicate of that observation,
 * not a second measurement, and keeping both would double-count it in every
 * later verdict. PURE.
 */
export function normalizeFactDependencies(
  deps: readonly FactDependency[] | null | undefined,
): FactDependency[] | null {
  if (!deps || deps.length === 0) return null;
  const seen = new Set<string>();
  const out: FactDependency[] = [];
  for (const d of deps) {
    const cell = (d?.cell ?? '').trim();
    if (!cell || seen.has(cell)) continue;
    const hasDigest = typeof d.digest === 'string' && d.digest.length > 0;
    const hasUnknown = typeof d.unknown === 'string' && d.unknown.length > 0;
    if (hasDigest === hasUnknown) continue; // anchorless or contradictory
    seen.add(cell);
    out.push({
      cell,
      ...(d.subject ? { subject: d.subject } : {}),
      observedAt: d.observedAt || new Date().toISOString(),
      ...(hasDigest ? { digest: d.digest } : {}),
      ...(hasUnknown ? { unknown: d.unknown } : {}),
      ...(d.observed ? { observed: d.observed.slice(0, FACT_DEPENDENCY_OBSERVED_CHARS) } : {}),
    });
    if (out.length >= FACT_MAX_DEPENDENCIES) break;
  }
  return out.length > 0 ? out : null;
}

/**
 * P-007: render a fact's source anchor for folds — the provenance-hydrated form
 * when a stamp exists (`<sourceRef> ✓ "<quote>"` / `<sourceRef> ✗unverified (err)`),
 * else the plain sourceRef. '' when the fact has no source at all. PURE.
 */
export function renderFactSrc(f: Pick<AgentFact, 'sourceRef' | 'sourceProvenance'>): string {
  const ref = f.sourceRef ?? '';
  const p = f.sourceProvenance;
  if (!p) return ref;
  if (!p.verified) return `${ref} ✗unverified${p.error ? ` (${p.error})` : ''}`;
  return p.quote ? `${ref} ✓ "${p.quote}"` : `${ref} ✓${p.label ? ` ${p.label}` : ''}`;
}

/**
 * EI-7517 — fill an OMITTED scopeRef from the caller's context for the
 * ref-bearing scopes that have an unambiguous caller-side default, so the
 * common SELF-scoped assert/list/retract does not force the agent to look up
 * and pass its own id. This closes the recurring "scope 'owner' requires
 * scope_ref" structural error: an agent asserting a fact about "just me"
 * naturally omits the ref, and the tool has enough context to infer it.
 *   owner   → the caller's own ownerId ("owner = just you")
 *   harness → the caller's harness slug (when known)
 *   role    → the caller's derived role
 * An EXPLICIT scopeRef always wins. workspace takes no ref; work_item has no
 * caller-context default (an explicit WI id is still required — there is no
 * "current work item" on the ctx). PURE — unit-tested without ctx/PG.
 */
export function resolveFactScopeRef(
  scope: string,
  scopeRef: string | null | undefined,
  defaults: { ownerId?: string | null; harnessSlug?: string | null; role?: string | null },
): string | null | undefined {
  if ((scopeRef ?? '').trim()) return scopeRef; // an explicit ref always wins
  switch (scope) {
    case 'owner':
      return defaults.ownerId ?? scopeRef;
    case 'harness':
      return defaults.harnessSlug ?? scopeRef;
    case 'role':
      return defaults.role ?? scopeRef;
    default:
      return scopeRef; // workspace (ref-less) / work_item (explicit id required)
  }
}

function sqlOf(inject?: Sql): Sql {
  return inject ?? getOrgPg().sql;
}

/**
 * F1-4 / WI-1564: resolve the workspace partition a FEDERATED (shareable)
 * fact/elite write must land in. The coordination partition
 * (`DEFAULT_COORD_WORKSPACE` = 'default') and the `'*'` wildcard NEVER federate
 * — a shareable write there is captured by the mig-461/462 triggers then
 * stranded (never routed to a peer, the WI-1564 137-stranded-row class, the
 * writer-side twin of the harness_slug drop D-007 fixed). Returns the workspace
 * when it federates, else `undefined` so the writer refuses LOUDLY instead of
 * silently stranding. Shared by the fact writer ({@link assertFact}) and the
 * gym-elite writer so both strand-or-federate identically — the WI-1564
 * "resolver shared by writer + reader" invariant (mirrors
 * p2p/grant-store.ts `resolveP2pGrantWorkspace`).
 */
export function resolveFederationWorkspace(ws: string | null | undefined): string | undefined {
  const w = ws?.trim();
  return w && w !== '*' && w !== DEFAULT_COORD_WORKSPACE ? w : undefined;
}

/** TRUNCATE an over-cap body, don't reject it (code-run-self-state-adoption-2026-07-03
 *  P-007): the old hard throw cost 7 lost facts in 14d — an agent that wrote a slightly-long
 *  conclusion lost the WHOLE write, the worst outcome for a durable-memory surface (the
 *  limit-failure-rate precedent: content fields truncate). The 500-char discipline
 *  ("conclusions, not documents") stays as the stored shape, not an all-or-nothing gate;
 *  the '…' suffix makes a truncation visible in the fold, and the DB CHECK (mig 444,
 *  char_length ≤ 500) remains the backstop. PURE — unit-tested without PG. */
export function clampFactBody(raw: string): string {
  const body = raw.trim();
  if (body.length <= FACT_BODY_MAX_CHARS) return body;
  // P-004 (cold-carry-system-hardening-2026-07-19): clip at a SENTENCE (else word)
  // boundary instead of mid-sentence. A fact folds VERBATIM as BINDING context, and
  // the observed failure mode (2026-07-19, 5× in one night) was a mid-sentence cut
  // eating exactly the operative clause — the fact then reads as a complete
  // instruction that stops halfway. The ' […]' marker keeps the elision visible
  // (EI-10952); the boundary is only taken when it preserves ≥60% of the cap, so a
  // pathological one-sentence body still degrades to the old hard cut.
  const MARKER = ' […]';
  const head = body.slice(0, FACT_BODY_MAX_CHARS - MARKER.length);
  const minKeep = Math.floor(FACT_BODY_MAX_CHARS * 0.6);
  let sentenceEnd = -1;
  for (let i = head.length - 1; i > 0; i -= 1) {
    const ch = head[i];
    if ((ch === '.' || ch === '!' || ch === '?' || ch === ';') && /\s/.test(head[i + 1] ?? body[head.length] ?? ' ')) {
      sentenceEnd = i;
      break;
    }
  }
  if (sentenceEnd + 1 >= minKeep) return `${head.slice(0, sentenceEnd + 1)}${MARKER}`;
  const lastSpace = head.lastIndexOf(' ');
  if (lastSpace >= minKeep) return `${head.slice(0, lastSpace)}${MARKER}`;
  return `${body.slice(0, FACT_BODY_MAX_CHARS - 1)}…`;
}

/** Upsert a fact by identity; refreshes body/TTL/source on re-assert. Enforces
 *  the per-scope cap by evicting the LOWEST-RANKED live incumbents past the cap
 *  — confidence, then remaining declared-TTL fraction (see the ORDER BY below),
 *  so a fact near the end of its own life loses. Not oldest-updated; that ended
 *  at WI-7292. */
export async function assertFact(input: AssertFactInput, inject?: Sql): Promise<AssertFactResult> {
  // EI-21488671343297100: the cap guard, append and sweep are separate
  // statements, so every production write must own one transaction for the
  // transaction-scoped cap lock below to cover the whole decision. Tests may
  // still inject a base Sql for sequential fixtures; concurrent callers must
  // inject a transaction or omit the argument and take this bounded wrapper.
  if (!inject) return boundedOrgTxn((tx) => assertFact(input, tx));

  // EI-7463: these are CALLER-input mistakes (a bad scope/ref pairing, an
  // empty key/body after trim), not server faults — throw InvalidInputError
  // so the dispatcher codes them `invalid_input` (400) instead of the default
  // `handler_error` (500). A `handler_error` inflates facts:assert's telemetry
  // error-rate as a false "tool is broken" signal (the same EI-334 class the
  // schema-validation path already avoids via InvalidInputError).
  const err = validateFactScope(input.scope, input.scopeRef);
  if (err) throw new InvalidInputError(`facts:assert — ${err}`);
  // EI-22179589084262757: the ref is PRESENT (checked above) but may be the wrong KIND
  // of identifier for this scope, which stores an unfoldable row and reports nothing.
  // Assert-path only — retractFact must still be able to address the existing orphans.
  const refShapeErr = validateFactScopeRefShape(input.scope, input.scopeRef);
  if (refShapeErr) throw new InvalidInputError(`facts:assert — ${refShapeErr}`);
  // P-007: a typo'd audience is a caller-input mistake — reject loudly (stored
  // unmatchable = fact hidden from everyone; see validateAudienceScope).
  const audienceErr = validateAudienceScope(input.audienceScope);
  if (audienceErr) throw new InvalidInputError(`facts:assert — ${audienceErr}`);
  const audienceScope = (input.audienceScope ?? '').trim() || null;
  const key = input.key.trim();
  if (!key) throw new InvalidInputError('facts:assert — key required (stable slug)');
  const retiredKeySet = new Set<string>();
  for (const raw of input.supersedes ?? []) {
    const siblingKey = raw.trim();
    if (!siblingKey) continue;
    if (siblingKey === key) {
      throw new InvalidInputError(
        `facts:assert — supersedes cannot contain the asserted key '${key}'; ` +
          're-assert that key normally to append a same-key version',
      );
    }
    retiredKeySet.add(siblingKey);
  }
  if (retiredKeySet.size > FACT_MAX_SUPERSEDES) {
    throw new InvalidInputError(`facts:assert — supersedes accepts at most ${FACT_MAX_SUPERSEDES} distinct keys`);
  }
  // Stable ordering makes the receipt deterministic and gives concurrent
  // cross-key writers the same lock acquisition preference.
  const retiredKeyCandidates = [...retiredKeySet].sort();
  const body = clampFactBody(input.body);
  if (!body) throw new InvalidInputError('facts:assert — body required');
  const measuredAtInput = input.measuredAt?.trim() || null;

  /**
   * P-006 / D-011 — NORMALIZE A RECOVERABLE INTENT INSTEAD OF REFUSING IT.
   *
   * "This is a volatile snapshot" is ONE intent that the schema makes a caller express
   * across THREE co-varying fields (subjectVolatile + measuredAt + a <=15min ttlSec), and
   * every two-of-three combination used to be a hard refusal that stored NOTHING.
   * Measured over 14 days: 41.0% of 7,639 calls rejected, across 576 distinct agents —
   * `measuredAt` without `subjectVolatile` alone accounted for 385 rejections from 192
   * DISTINCT agents. That many agents do not independently misread one field; the shape
   * was the defect.
   *
   * The line adopted (D-011): repair what is UNAMBIGUOUS and deterministic, keep refusing
   * what is ambiguous or whose repair would manufacture a falsehood.
   */
  const volatileInferred = input.subjectVolatile !== true && measuredAtInput !== null;
  const subjectVolatile = input.subjectVolatile === true || volatileInferred;
  const capPartition: FactCapPartition = subjectVolatile ? 'volatile' : 'ordinary';
  const cap = factCapFor(capPartition);

  // KEEP REFUSING. Defaulting measuredAt to now() is the one repair available here, and it
  // would stamp a sample of unknown age as fresh — precisely the lie `measuredAt` exists to
  // prevent. A caller who marked the subject volatile is telling us the value moves; only
  // they know when it was read. Correct to refuse even though it costs ~44 agents.
  if (input.subjectVolatile === true && !measuredAtInput) {
    throw new InvalidInputError(
      'facts:assert — subjectVolatile:true requires measuredAt (the ISO timestamp of the sample). ' +
        'It is NOT defaulted to now(): that would stamp a sample of unknown age as fresh, which is ' +
        'the exact misreading measuredAt exists to prevent.',
    );
  }
  let measurement: FactMeasurement | null = null;
  if (measuredAtInput) {
    const measuredAtMs = Date.parse(measuredAtInput);
    if (!Number.isFinite(measuredAtMs)) {
      throw new InvalidInputError(`facts:assert — measuredAt must be a valid ISO timestamp (got '${measuredAtInput}')`);
    }
    if (measuredAtMs > Date.now() + 60_000) {
      throw new InvalidInputError(
        'facts:assert — measuredAt cannot be more than 60 seconds in the future. ' +
          'Obtain a server-aligned timestamp, then retry with that measuredAt; do not retry with ' +
          'subjectVolatile:true and no measuredAt.',
      );
    }
    measurement = { subjectVolatile: true, measuredAt: new Date(measuredAtMs).toISOString() };
  }
  /**
   * P-006 / D-011 — CLAMP, do not refuse. 676 rejections from 149 distinct agents, and at
   * least five separately-filed work-items reporting it as a bug (EI-21067601687722994,
   * EI-20497443937803976, EI-21034891637991771, EI-20418039553264569, EI-20510170202088917)
   * — five independent reporters is a design signal, not five mistakes.
   *
   * Safe to normalize because the clamp only ever SHORTENS a TTL: the ceiling exists to stop
   * a moving snapshot lingering in the standing-facts fold, and clamping enforces exactly
   * that. The old refusal enforced it too — by storing nothing at all, which serves the
   * caller strictly worse while protecting nothing extra.
   *
   * Disclosed, never silent: `ttlClampedFrom` is returned so the caller learns the ceiling
   * (that is what makes this a teaching normalization rather than a surprise), and a
   * deliberate long-lived fact is still available by simply not marking it volatile.
   */
  let ttlClampedFrom: number | null = null;
  let effectiveTtlSec = input.ttlSec ?? null;
  if (subjectVolatile && effectiveTtlSec != null && effectiveTtlSec > FACT_VOLATILE_MAX_TTL_SEC) {
    ttlClampedFrom = effectiveTtlSec;
    effectiveTtlSec = FACT_VOLATILE_MAX_TTL_SEC;
  }
  const sql = sqlOf(inject);
  const ws = input.workspaceId ?? activeWorkspaceId();
  // F1-4 / WI-1564: a SHAREABLE fact MUST land in a real federating partition.
  // If the resolved workspace is the non-federating coordination/'*' partition,
  // the capture triggers fire but route nowhere, so the fact is captured then
  // stranded (dropped on every peer). Refuse LOUDLY rather than silently strand
  // — a hive-PRIVATE fact (shareable !== true) is unaffected (it never rides the
  // wire, so any partition is fine).
  if (input.shareable === true && !resolveFederationWorkspace(ws)) {
    throw new Error(
      `facts:assert — a shareable fact cannot use the '${ws}' workspace partition ` +
        `(WI-1564): the coordination/'*' partition never federates, so the fact would ` +
        `be captured then stranded on every peer. Assert from a hive-scoped workspace.`,
    );
  }
  const ref = input.scope === 'workspace' ? null : (input.scopeRef ?? '').trim();
  // EI-18681964809855890: an explicit ttlSec always wins; otherwise a
  // provisional/suspected confidence tier supplies its documented short TTL
  // (see defaultTtlSecForConfidence). Ordinary writes are validated above and
  // must declare a lifetime before this resolver is reached.
  // P-028 / EI-20038280125466267: a declared convention is normative state,
  // not a decaying observation. With no explicit TTL, store it with
  // PostgreSQL's `infinity` timestamp; callers can still opt into a bounded
  // convention lifetime by passing ttlSec explicitly.
  // P-006 / D-011: reads `effectiveTtlSec`, NOT `input.ttlSec` — that is what makes the
  // volatile clamp above actually bind. Outside the clamped case the two are identical, so
  // every pre-existing TTL path is unchanged.
  // P-001/P-002/P-003 — the lifetime is DECLARED, never defaulted. This REFUSES the
  // write that chose nothing (the case the old `?? FACT_DEFAULT_TTL_SEC` tail silently
  // absorbed), and it refuses here in the store rather than only in the tool so a
  // routine or a backfill cannot slip past it — the same reasoning that puts
  // validateUndecidableSettledBy and validateConventionEnforcement on this side.
  const lifetimeError = validateFactLifetime({
    key: input.key,
    kind: input.kind ?? null,
    ttlSec: input.ttlSec ?? null,
    permanent: input.permanent,
    confidence: input.confidence ?? null,
    subjectVolatile,
  });
  if (lifetimeError) throw new InvalidInputError(lifetimeError);
  const lifetime = resolveFactLifetime({
    key: input.key,
    kind: input.kind ?? null,
    permanent: input.permanent,
    confidence: input.confidence ?? null,
    subjectVolatile,
    effectiveTtlSec,
  });
  const permanentFact = lifetime.permanent;
  const ttl = lifetime.ttlSec;
  const confidence = input.confidence ?? null;
  // P-008 (b), migration 690. `dependsOn` arrives ALREADY RESOLVED (see
  // AssertFactInput.dependsOn) — the store's job is to normalize and persist it,
  // not to dispatch cell resolvers. `kind` is validated rather than trusted: the
  // DB CHECK would reject a bad value with an opaque constraint error, and an
  // InvalidInputError names the actual mistake (EI-7463's class — a caller-input
  // error must not surface as a 500 that inflates the tool's error rate).
  if (input.kind != null && !(FACT_KINDS as readonly string[]).includes(input.kind)) {
    throw new InvalidInputError(`facts:assert — unknown kind '${input.kind}' — one of ${FACT_KINDS.join('|')}`);
  }
  const kind = input.kind ?? null;
  // P-018 / D-016 / D-075 R3. Validated here rather than only in the tool layer
  // so a non-tool caller (a routine, a migration backfill) cannot write a
  // floorless gate — the rule is D-016's substance, not the tool's manners.
  const enforcementError = validateConventionEnforcement(kind, input.enforcement);
  if (enforcementError) {
    throw new InvalidInputError(`facts:assert — ${enforcementError}`);
  }
  const enforcement = input.enforcement ?? null;
  // P-002, same rationale as the enforcement check above: an exit-less UNKNOWN
  // must be unwritable by ANY caller, not merely discouraged by the tool.
  const settledByError = validateUndecidableSettledBy(kind, input.settledBy);
  if (settledByError) {
    throw new InvalidInputError(`facts:assert — ${settledByError}`);
  }
  const settledBy = input.settledBy?.trim() ? input.settledBy.trim() : null;
  // P-010: validate in the store as well as the tool. Direct callers (routines,
  // migrations, tests) must not be able to persist a half-contract or an
  // unbounded instruction around the published Zod schema.
  const recheck = normalizeFactRecheck(input.recheck);
  const dependsOn = normalizeFactDependencies(input.dependsOn);
  const claim = input.claim && typeof input.claim === 'object' ? input.claim : null;

  // EI-21488671343297100: serialize one cap population's complete seat
  // decision. This MUST be its own statement: under READ COMMITTED PostgreSQL
  // fixes a statement's snapshot before waiting inside it, so folding the lock
  // into the guard query lets a waiter acquire the lock and still read the stale
  // pre-wait population. The following guard/append/sweep statements then see a
  // fresh snapshot while this transaction owns the lock. Exempt facts take no
  // seat and need no cap lock.
  if (!isFactCapExempt({ key, kind })) {
    const partitionKey = JSON.stringify([ws, input.scope, ref ?? '', capPartition]);
    await sql`
      SELECT pg_advisory_xact_lock(
        hashtext('papercusp:agent-facts-cap:v1'),
        hashtext(${partitionKey})
      )`;
  }

  // EI-21442182972969040: an ordinary at-cap write must not silently destroy
  // another author's verified fact. Run this admission check BEFORE the
  // append/supersede statement, so a refusal leaves both the incoming fact and
  // the protected incumbent untouched. The tool layer already places the full
  // multi-query write in boundedOrgTxn; this pre-write check also keeps direct
  // store callers from committing a fact before learning that its cap cost is
  // unacceptable. `previewFactCapImpact` remains the explicit dry-run surface
  // and typed exempt slots bypass this guard because they take no cap seat.
  // Keep malformed direct callers on the database's attributable NOT NULL
  // path. `createdBy` is required by the type contract, but older direct
  // callers can omit it; binding `undefined` in this diagnostic query would
  // mask the real `created_by` error before the INSERT gets a chance to report
  // it (EI-19952118814692217).
  if (capPartition === 'ordinary' && !isFactCapExempt(input)) {
    // P-002 / D-003: the ceiling REFUSES; it never evicts. The predicate is a
    // population count, not a victim search, because there is no longer a
    // victim to find — that is the entire change. `key <> incoming` is what
    // keeps a RE-ASSERT of an existing key legal at the ceiling: it supersedes
    // its own prior version, so it does not grow the population and must not
    // be refused. A saturated scope therefore stays CORRECTABLE (existing
    // facts can be revised or retracted) while being closed to NEW keys, which
    // is the property that makes a refusal recoverable rather than a deadlock.
    //
    // Unlike the guard this replaces, the query binds no `createdBy`, so there
    // is no diagnostic-vs-NOT NULL ordering hazard (EI-19952118814692217) and
    // no reason to gate on it: a malformed direct caller still reaches the
    // database's attributable NOT NULL path exactly as before.
    const incumbents = await countCapPopulationExcludingKey(input, sql, 'ordinary');
    if (incumbents >= cap) {
      // EI-21585375376448939 kept its lesson through the rewrite: name the
      // remedy that actually WORKS first, and never lead with "coordinate with
      // the fact owner" — unreachable on a scope held by 130 authors, and what
      // made the old refusal read as a dead end rather than a choice.
      //
      // What this message must NOT do is imply the writer was unlucky. At 14x
      // measured demand, reaching the ceiling is evidence of a runaway writer,
      // so the message says so and points at the diagnostic — otherwise the
      // refusal gets worked around (narrower scope, new key) and the actual
      // over-writer keeps going, undetected, exactly as it did when the cap
      // silently ate strangers' facts instead of reporting anything at all.
      throw new InvalidInputError(
        `facts:assert — REFUSED before write: scope ${input.scope}${ref ? `:${ref}` : ''} is at its ` +
          `${cap}-fact ceiling (${incumbents} live facts, excluding this key). ` +
          'NOTHING WAS WRITTEN AND NOTHING WAS DESTROYED — this ceiling refuses the incoming write ' +
          "rather than evicting another author's fact to seat it (D-003). " +
          `This ceiling is ~14x normal working demand, so reaching it usually means ONE writer is ` +
          'over-writing rather than that the scope is legitimately full: find it with ' +
          "`facts:list` on this scope grouped by author before working around this. " +
          'Legitimate remedies: re-assert or retract facts you already own here (a re-assert of an ' +
          'EXISTING key supersedes its own version and is never refused, so this scope is still ' +
          'correctable), narrow the scope (harness/owner/work_item instead of workspace), or use a ' +
          'typed slot (dead-end/wall/guard-rail) which takes no seat at all.',
      );
    }
  }

  // P-008 (a): APPEND-VERSIONING, not upsert-in-place (migration 689).
  //
  // This used to be ON CONFLICT DO UPDATE SET body = EXCLUDED.body — which
  // DESTROYED the prior value, violating D-003's invariant that "a pointed-at
  // record is never mutated; corrections append, and the pointer keeps naming
  // the old one." P-009 stamps a pointer AT a fact record, so an in-place
  // rewrite silently changes what an already-stamped pointer resolves to.
  //
  // One statement, so it is atomic without an explicit transaction: the CTE
  // supersedes the current version (taking its row lock) and the INSERT writes
  // the new one chained to it via `supersedes_id`. The identity index is now
  // PARTIAL (`WHERE superseded_at IS NULL`), so it still guarantees exactly one
  // CURRENT version per identity while leaving the superseded tail free.
  //
  // ⚠ LOCAL PARTITION ONLY (`source_hive IS NULL`), matching the cap-eviction
  // and retract paths below: superseding must never touch another hive's
  // independent observation of the same identity (H6).
  //
  // A `retracted_at` row is superseded like any other, which is what revives the
  // identity — the previous code expressed that as `retracted_at = NULL` on the
  // mutated row, i.e. by erasing the evidence that it had ever been retracted.
  // The retraction now survives, on the version that carried it.
  //
  // ⚠ P-008 (b): `depends_on` deliberately does NOT carry forward from the
  // superseded version the way `harness_slug` does. A federation slug is a
  // stable IDENTITY, so inheriting it is correct; a dependency set is an
  // OBSERVATION ("cell X digested to D at time T"). Inheriting one would stamp
  // the old reading onto a new version asserted later, which is exactly the
  // frozen-snapshot defect D-003 forbids — and it would fail in the confident
  // direction, reporting FRESH because the digest it compares against was never
  // re-observed. A re-assert re-declares its dependencies or has none.
  const retractionReason = `superseded by ${key}`;
  const rows = await sql<(AgentFactRow & { retired_keys: string[] | null })[]>`
    WITH superseded AS (
      UPDATE harness_shared.agent_facts
         SET superseded_at = now()
       WHERE workspace_id = ${ws} AND scope = ${input.scope}
         AND coalesce(scope_ref, '') = ${ref ?? ''} AND key = ${key}
         AND source_hive IS NULL
         AND superseded_at IS NULL
      RETURNING id, harness_slug
    ), inserted AS (
      INSERT INTO harness_shared.agent_facts
      (workspace_id, harness_slug, scope, scope_ref, key, body, source_ref, created_by, expires_at, shareable,
       audience_scope, source_provenance, confidence, measurement, recheck, supersedes_id, kind, depends_on, claim,
       enforcement, settled_by)
    VALUES
      (${ws},
       -- keep an already-stamped federation identity when a later assert omits
       -- it (never NULL it back out) — carried forward off the superseded row,
       -- since there is no longer an UPDATE branch to COALESCE against.
       COALESCE(${input.potHomeSlug ?? null}, (SELECT harness_slug FROM superseded)),
       ${input.scope}, ${ref}, ${key}, ${body},
       ${input.sourceRef ?? null}, ${input.createdBy ?? null},
       ${permanentFact ? sql`'infinity'::timestamptz` : sql`now() + make_interval(secs => ${ttl})`},
       ${input.shareable === true},
       ${audienceScope},
       ${input.sourceProvenance ? JSON.stringify(input.sourceProvenance) : null}::text::jsonb,
       ${confidence},
       ${measurement ? JSON.stringify(measurement) : null}::text::jsonb,
       ${recheck ? JSON.stringify(recheck) : null}::text::jsonb,
       (SELECT id FROM superseded),
       ${kind},
       ${dependsOn ? JSON.stringify(dependsOn) : null}::text::jsonb,
       ${claim ? JSON.stringify(claim) : null}::text::jsonb,
       ${enforcement ? JSON.stringify(enforcement) : null}::text::jsonb,
       ${settledBy})
      RETURNING id, superseded_at::text, supersedes_id,
                scope, scope_ref, key, body, source_ref, audience_scope, source_provenance,
                confidence, measurement, recheck, kind, depends_on, claim, enforcement, settled_by, created_by, updated_at::text, expires_at::text
    ), retired AS (
      UPDATE harness_shared.agent_facts
         SET retracted_at = now(),
             retracted_by = ${input.createdBy ?? null},
             retraction_reason = ${retractionReason}
       WHERE workspace_id = ${ws} AND scope = ${input.scope}
         AND coalesce(scope_ref, '') = ${ref ?? ''}
         AND key = ANY(${retiredKeyCandidates as string[]}::text[])
         AND source_hive IS NULL
         AND superseded_at IS NULL
         AND retracted_at IS NULL
      RETURNING key
    )
    SELECT inserted.*,
           COALESCE((SELECT array_agg(key ORDER BY key) FROM retired), ARRAY[]::text[]) AS retired_keys
      FROM inserted`;
  // Cap enforcement — evict the LOWEST-RANKED live incumbents past the cap for
  // this (scope, ref); the ranking is the ORDER BY below, NOT oldest-updated.
  // LOCAL partition only (H6): the local writer's cap must never
  // evict foreign-source observations (those are bounded per-source by the
  // substrate rate caps + each sender's own cap).
  // P-008 (a): the cap counts CURRENT versions only. Counting the superseded
  // tail would make the cap a function of how often facts were CORRECTED rather
  // than how many exist — a heavily-revised fact would evict its own neighbours.
  //
  // WI-6935 (a): the typed SAFETY slots are EXEMPT from cap eviction, and are
  // excluded from the ranking entirely so they neither evict nor count toward the
  // offset.
  // Eviction writes `retracted_at` — the SAME field a deliberate facts:retract
  // writes — so an evicted fact WAS indistinguishable from one somebody decided no
  // longer applies, and listLapsedWallFacts (which filters `retracted_at IS NULL`)
  // can never see it again. For a `wall:` fact that is precisely the failure the
  // slot exists to prevent: absence must never read as "the wall cleared". Ranking
  // by `updated_at DESC` alone made this certain rather than unlikely — a wall is
  // asserted once and then, by design, never touched again, so it sinks to the
  // bottom of the very ordering used to choose victims. Measured 2026-08-02: 11
  // facts evicted from harness:papercusp in 25 minutes, including still-valid ones
  // with TTLs months out. These two prefixes are ~8 live rows across ALL scopes, so
  // exempting them cannot meaningfully weaken the cap.
  //
  // WI-6935 (b): stamp `evicted_at` ALONGSIDE `retracted_at` (migration 722), so a
  // machine eviction is finally distinguishable from a deliberate retract —
  // `evicted_at IS NOT NULL` ⇒ the cap chose it; NULL ⇒ somebody decided it no
  // longer applies. It is stamped IN ADDITION, never INSTEAD: `retracted_at IS NULL`
  // is baked into this table's partial indexes (444/689/690) and the federation
  // update-capture triggers (461/462), so moving eviction off that field would
  // spring every evicted row back into every fold — the cap would silently stop
  // capping. Additive keeps behavior identical and adds only the provenance.
  //
  // WI-6935 (c): rank victims by DECLARED VALUE, not by write-recency.
  // `ORDER BY updated_at DESC` alone made the destruction systematic rather than
  // random: a fact is written once and then, if it stays TRUE, never touched
  // again — so under that ordering the settled conclusions sink to the bottom of
  // the victim list and the churn survives. Correctness was inversely correlated
  // with survival. Measured 2026-08-02: 11 facts evicted from one scope in 25
  // minutes, ordinary `conclusion` rows with TTLs months out.
  //
  // The ranking below keeps the MOST valuable first (the OFFSET drops the tail):
  //   1. confidence — a 'suspected' hedge should die before a 'verified' finding.
  //      An UNSET confidence ranks with 'provisional', deliberately mid: most
  //      existing rows predate the field, and ranking them worst would mass-evict
  //      the entire legacy corpus on the next assert.
  //   2. remaining FRACTION of declared TTL, DESC — how much of the life its
  //      author gave it this fact still has, as a proportion:
  //      (expires_at - now()) / (expires_at - created_at). A fact 10% into a
  //      6-hour life is fresher, and a cheaper thing to keep, than one 90%
  //      through 90 days.
  //
  //      This key was `expires_at DESC` until EI-19483432832662150. Absolute
  //      expiry LOOKS like a value proxy but encodes only how long the
  //      CONDITION lasts, not how much the fact MATTERS — so it priced a long
  //      TTL as a purchase of durability, and those two are unrelated. Measured
  //      2026-08-04T01:19Z on harness:papercusp: the pool sat saturated 50/50,
  //      every row `verified` (so key 1 was inert and this key decided alone),
  //      with a survival floor of ~29.7 DAYS. An urgent 7-day operational fact
  //      (`dev-restart-bg-host-cgroup-blast-radius`, a dev:restart blast-radius
  //      hazard) was asserted 01:19:39 and evicted 01:19:54 — FIFTEEN SECONDS —
  //      by the next agent's unrelated assert, while two 90-day facts written in
  //      the same window were untouched. WI-7292 stopped a fact evicting
  //      ITSELF; the residue was that the next writer did it instead.
  //
  //      It was also a RATCHET: every long-TTL assert raised the floor, which
  //      made short-TTL facts less viable still, converging the scope on
  //      long-TTL facts. A fraction is TTL-NEUTRAL, so there is no floor to
  //      ratchet — a fact competes on how much of its OWN declared life is
  //      left, and a 7-day fact written seconds ago (~100%) outranks a 30-day
  //      fact written eight hours ago (~99%).
  //
  //      ⚠ KNOWN, BOUNDED RISK [self-imposed]: this makes a very short TTL a
  //      cheap way to take a slot — a flood of minute-long facts would churn the
  //      corpus, where before they were self-limiting because they died on
  //      arrival. The lever for that is rate-limiting asserts, NOT this
  //      ordering; if it shows up, fix it there rather than restoring an
  //      ordering known to destroy operational facts. The damage is also
  //      self-healing in a way the old behaviour's was not: short facts expire
  //      and hand their slots back.
  //
  //      ⚠ This key is TIME-DEPENDENT, which `expires_at DESC` was not: the
  //      order between two rows can now swap as they age, with no write at all.
  //      That is the point — it is how a short-lived fact serves its purpose and
  //      then yields — but it means the TS mirror must be evaluated against a
  //      comparable `now`. Exact ties become rarer, not commoner (a continuous
  //      value), so the tied-tail ambiguity below is if anything less likely.
  //   3. updated_at DESC — retained only as the final tiebreak, so behavior is
  //      unchanged among rows the first two keys cannot separate.
  //
  // ⚠ ASSUMPTION, stated rather than hidden [self-imposed]: this ordering is my
  // judgement, not an owner ruling — the routing question has gone unanswered
  // across 4 agent-origin wakes, and leaving `updated_at DESC` in place is ALSO a
  // judgement, one that is actively destroying data. Revisit the key order if the
  // owner rules differently; the guard test pins the intent, not the SQL.
  //
  // WI-7292: the row THIS call just wrote is EXCLUDED from the victim ranking
  // (`id <> writtenId`), and the incumbents are capped at CAP-1 because the new
  // row already occupies one slot. Without the exclusion the sweep ranked the
  // fresh row against the incumbents and, whenever it sorted past the cap,
  // retracted the very row the same statement had just inserted — while
  // `facts:assert` returned ok:true with a future `expiresAt`. Measured
  // 2026-08-03T02:34:38Z: written .710Z, retracted+evicted .714Z. FOUR
  // MILLISECONDS, and the author cannot tell.
  //
  // It was not an edge case. `expires_at DESC` is the #2 key, so on a SATURATED
  // scope every new fact whose TTL is shorter than the 50th incumbent's is
  // destroyed by its own assert, every time — harness:papercusp sat at exactly
  // 50/50 with a soonest-survivor expiry 7 DAYS out and ZERO live facts under a
  // 3-day TTL. That zero is survivorship, not taste: the scope had become
  // structurally closed to short-lived facts. And a short TTL is how an author
  // says "urgent, and it stops being true soon" ("this alarm is false right
  // now") — so the cap preferentially destroyed the operational facts a fleet
  // acts on within the hour, while 90-day architectural facts were immortal.
  //
  // The cap is unchanged: capping incumbents at CAP-1 keeps the live total at
  // CAP exactly, so a scope-full assert now evicts the next-worst INCUMBENT
  // instead of itself. A re-assert of an existing key supersedes its own prior
  // version (excluded by `superseded_at IS NULL`), so it never evicts a
  // neighbour to make room for itself.
  //
  // ⚠ That CAP-1 holds only for a write that JOINS the population. An EXEMPT
  // write (convention / `wall:` / `dead-end:` / `guard-rail:`) does not, and trimming to CAP-1
  // for it destroyed a fact to buy a seat nobody took — EI-20824216187836980.
  // The OFFSET below is therefore computed, not constant; see its note.
  // `IS DISTINCT FROM` (not `<>`) so a NULL id — impossible via the RETURNING
  // above, but cheap to be total about — degrades to the old ranking instead of
  // silently matching nothing and disabling the cap entirely.
  //
  // WI-7298: the sweep RETURNS its victims so the writer can be told what their
  // write cost. This is free — the UPDATE already runs; only the RETURNING is
  // new. Reporting "the scope is at cap" when nothing was evicted would instead
  // need a COUNT on every assert, which is why that is not reported: a non-empty
  // `evicted` already implies at-cap (the sweep fires only past CAP-1).
  const writtenId = rows[0].id ?? null;
  // P-002 / D-003: VOLATILE PARTITION ONLY. The ordinary partition refuses at
  // its ceiling (see the pre-write guard above) and never reaches this sweep,
  // so for an ordinary write `evictedRows` is empty by construction — which is
  // what makes every downstream `evictedRows.length > 0` block (the eviction
  // receipt, the survival ranking, the notify-evicted hop) ordinary-inert
  // without needing its own partition test.
  //
  // Volatile keeps evicting deliberately, and is NOT an oversight to be
  // "finished" later: bounded snapshot churn is this partition's stated
  // purpose. A volatile row is a <=15-minute snapshot its author declared
  // disposable, not a standing conclusion, so displacing one is categorically
  // unlike destroying a stranger's verified fact — and refusing here instead
  // would break exactly the live-fed writers the partition exists to absorb,
  // at exactly the burst moment it exists for.
  const evictedRows: {
    key: string;
    confidence: string | null;
    expires_at: string;
    created_by: string;
    body: string | null;
  }[] =
    capPartition !== 'volatile'
      ? []
      : await sql<
          { key: string; confidence: string | null; expires_at: string; created_by: string; body: string | null }[]
        >`
    UPDATE harness_shared.agent_facts SET retracted_at = now(), evicted_at = now()
     WHERE source_hive IS NULL
       AND superseded_at IS NULL
       AND (workspace_id, scope, coalesce(scope_ref,''), key) IN (
       SELECT workspace_id, scope, coalesce(scope_ref,''), key
         FROM harness_shared.agent_facts
        WHERE ${capPopulationPredicate(sql, ws, input.scope, ref ?? '', capPartition)}
          -- WI-7292: the row THIS call just wrote is excluded from the VICTIM
          -- ranking (it already occupies its slot and must not evict itself).
          -- The survival query below deliberately does NOT carry this clause —
          -- it has to find the written row to rank it. That is the ONE
          -- legitimate difference between the two, which is why it lives here
          -- at the call site and not in the shared fragment.
          AND id IS DISTINCT FROM ${writtenId}
        ORDER BY CASE confidence
                   WHEN 'verified'    THEN 0
                   WHEN 'provisional' THEN 1
                   WHEN 'suspected'   THEN 2
                   ELSE 1
                 END ASC,
                 (EXTRACT(epoch FROM (expires_at - now()))
                    / GREATEST(EXTRACT(epoch FROM (expires_at - created_at)), 1)) DESC,
                 updated_at DESC
       -- EI-20824216187836980: CAP-1 is correct only when the row THIS call just
       -- wrote is itself a MEMBER of the cap population. When it is EXEMPT (a
       -- convention, or a 'wall:'/'dead-end:'/'guard-rail:' safety slot — see
       -- capPopulationPredicate) it never joins that population, so trimming the
       -- incumbents to CAP-1 destroyed a live fact to make room for a row that
       -- was never going to occupy the room. The offset is CAP for such a write.
       --
       -- Measured 2026-08-19 on workspace/papercusp-workspace: 200 non-exempt
       -- rows pinned at exactly the cap beside 121 exempt ones, and 12 of the 28
       -- evictions in the preceding 24h (43%) were bought by exempt writes that
       -- took no seat. The reported symptom was a convention re-assert evicting
       -- an unrelated peer's fact; the append-versioning it was blamed on is NOT
       -- the cause — a non-exempt re-assert already evicts nothing, since its
       -- prior version leaves the population as the new one enters it.
       --
       -- Membership is derived from the SAME predicate rather than re-decided in
       -- TS: a hand-copied exemption test is exactly the drift that had already
       -- broken the survival query (see its note below), and here it would fail
       -- SILENTLY — over-evicting is indistinguishable from ordinary cap
       -- pressure. count(*) is 0 or 1, since id is the primary key.
       OFFSET (SELECT GREATEST(0, ${cap}::int - count(*)::int)
                 FROM harness_shared.agent_facts
                WHERE ${capPopulationPredicate(sql, ws, input.scope, ref ?? '', capPartition)}
                  AND id = ${writtenId}))
    RETURNING key, confidence, expires_at, created_by, body`;
  const row = rows[0];
  if (!row) throw new Error('facts:assert — write returned no row');
  const fact = rowToFact(row) as AssertFactResult;
  if (row.retired_keys?.length) fact.retiredKeys = row.retired_keys;

  // P-006 / D-011: disclose every repair. Attached only when something was actually
  // repaired, so `if (result.normalized)` stays a correct read on the common path.
  if (volatileInferred || ttlClampedFrom !== null) {
    const parts: string[] = [];
    if (volatileInferred) {
      parts.push(
        'subjectVolatile:true was INFERRED because you supplied measuredAt without it — ' +
          'this fact is stored as a SNAPSHOT with a bounded TTL, not an ordinary fact. ' +
          'Omit measuredAt if you meant a durable claim.',
      );
    }
    if (ttlClampedFrom !== null) {
      parts.push(
        `ttlSec was CLAMPED from ${ttlClampedFrom}s to ${FACT_VOLATILE_MAX_TTL_SEC}s: a volatile ` +
          'snapshot may not linger in the standing-facts fold. For a longer-lived claim, assert the ' +
          'invariant conclusion WITHOUT subjectVolatile and point at the live source instead.',
      );
    }
    fact.normalized = {
      ...(volatileInferred ? { subjectVolatileInferred: true as const } : {}),
      ...(ttlClampedFrom !== null ? { ttlClampedFrom, ttlClampedTo: FACT_VOLATILE_MAX_TTL_SEC } : {}),
      note: parts.join(' '),
    };
  }

  if (evictedRows.length > 0) {
    // Dedupe by key. The UPDATE matches on (workspace_id, scope, ref, key), so a
    // key carrying more than one live row would otherwise be reported twice —
    // and a duplicated victim reads as "I destroyed two facts" when I destroyed
    // one. `superseded_at IS NULL` makes that unlikely, not impossible.
    const seen = new Set<string>();
    const evicted: FactEviction[] = [];
    for (const r of evictedRows) {
      if (seen.has(r.key)) continue;
      seen.add(r.key);
      evicted.push({
        key: r.key,
        // Same parser rowToFact uses — never a bare cast, so an unrecognized
        // value degrades to null here exactly as it does everywhere else.
        confidence: parseFactConfidence(r.confidence),
        // Passed through raw, matching rowToFact's `expiresAt: r.expires_at`.
        expiresAt: r.expires_at,
        createdBy: r.created_by,
        ...excerptEvictedBody(r.body),
      });
    }
    // Only attach when non-empty — `evicted: []` would make `if (r.evicted)`
    // truthy on the common path where nothing was displaced.
    fact.evicted = evicted;

    // EI-19442566203468589: WI-7298 made eviction loud to the WRITER (the receipt
    // above). That is the wrong audience — the writer already knows they wrote.
    // The fact's AUTHOR is the one who needs telling, and was told nothing: their
    // fact is documented as folded into every orient UNTIL RETRACTED, so after an
    // eviction it just stops appearing, with nothing anywhere saying why. A
    // missing fact does not error; it quietly stops informing decisions.
    //
    // AWAITED, not fire-and-forget: a floating promise can be dropped when the
    // caller's context ends, which would make delivery non-deterministic — and a
    // notification that usually arrives is worse than one that always does,
    // because you stop checking. `notifyEvictedFactOwners` never throws and never
    // rejects, so a coord-plane failure cannot turn a successful assert into an
    // error; the cost is one coord_event_log insert on an already-at-cap write.
    //
    // Placed HERE (the store) rather than in `facts:assert` because the tool is
    // only 1 of 6 assertFact callers — the routines/gates/bootstrap writers evict
    // exactly like anyone else, and a tool-layer notify would leave every
    // routine-caused eviction silent.
    // EI-19449079650310753: work out which ranking key ACTUALLY decided, so the
    // notice can say so instead of reciting the idealised ordering.
    //
    // The recital is misleading in the only case that occurs: measured
    // 2026-08-03, EVERY scope at or near the cap held exactly ONE confidence
    // tier (harness/papercusp 50/50 verified, workspace 50/50 verified,
    // harness/oddsmith 41/41), so the confidence key is INERT precisely where
    // this sweep runs and remaining-TTL fraction decides alone. Evicted verified
    // facts in that scope averaged 8.9 days of TTL against 61.5 for survivors.
    //
    // One cheap aggregate, and ONLY on a write that actually evicted — the
    // sweep fires solely past CAP-1, so this cannot cost anything on the common
    // path. Ranks are computed with the SAME CASE as the ORDER BY above (unset
    // ranks WITH 'provisional'), because the question is whether the ordering
    // separated anything — not whether the literal strings differ.
    let ranking: import('./notify-evicted').EvictionRankingContext | null = null;
    try {
      // EI-19451909636567773: this query used to be `SELECT DISTINCT confidence`
      // — enough to answer "did confidence discriminate", not enough to answer
      // "will MY write survive". Selecting the ranking columns for the same
      // row set answers both from ONE query, with no extra round-trip and no
      // second copy of the ordering in SQL.
      //
      // EI-20515478467800187: "the same row set" is now enforced rather than
      // asserted — this composes the SAME `capPopulationPredicate` the sweep
      // does, so a verdict can only ever be ranked against rows the sweep can
      // actually evict. It previously carried a hand-copied WHERE that had
      // drifted: it counted `kind:'convention'` rows the sweep is forbidden to
      // touch, inflating liveCount and mis-ranking every write on a scope
      // holding conventions.
      //
      // A `kind:'convention'` write is now legitimately ABSENT from this set,
      // so `rankOfId` returns 0 and no survival is reported for it. That is
      // correct: a convention is exempt from the cap, so it has no victim
      // ranking to report — and the `rank > 0` guard below already handles it.
      const survivors = await sql<
        {
          id: string | number | null;
          confidence: string | null;
          expires_at: string | Date;
          created_at: string | Date;
          updated_at: string | Date;
        }[]
      >`
        SELECT id, confidence, expires_at, created_at, updated_at
          FROM harness_shared.agent_facts
         WHERE ${capPopulationPredicate(sql, ws, input.scope, ref ?? '', capPartition)}`;
      const confRank = (c: FactConfidence | null): number => (c === 'verified' ? 0 : c === 'suspected' ? 2 : 1);
      const values = new Set<FactConfidence | null>();
      for (const r of survivors) values.add(parseFactConfidence(r.confidence));
      for (const v of evicted) values.add(v.confidence);
      const ranks = new Set([...values].map(confRank));
      ranking = {
        confidenceDiscriminated: ranks.size > 1,
        // Named only when every fact shares one LITERAL tier. Equal-rank-but-
        // different-value (unset vs 'provisional') must not be reported as a
        // shared tier — that would be a false claim about the data.
        prevailingConfidence: values.size === 1 ? [...values][0] : null,
      };

      // Rank the written row exactly as the sweep would. The ordering is a
      // MIRROR of the ORDER BY above, extracted to `sweep-ranking.ts` so it is
      // a named function with its own unit control rather than an anonymous
      // comparator — a mirror that drifts reports a confident survival verdict
      // the sweep then contradicts, which is worse than reporting nothing.
      // `survival-ranking-matches-sweep` in the integration suite runs BOTH and
      // fails if they disagree.
      const { orderAsSweepWould, rankOfId, sweepRemainingFraction } = await import('./sweep-ranking');
      // ONE instant for both the ordering and the bar derived from it. Key 2 is
      // time-dependent since EI-19483432832662150, so evaluating them at two
      // different `now`s could report a floor that disagrees with the very
      // ordering it was read out of.
      const nowMs = Date.now();
      const ordered = orderAsSweepWould(survivors, nowMs);
      const rank = rankOfId(ordered, writtenId);
      if (rank > 0) {
        const isLast = rank === ordered.length;
        const neighbourAbove = isLast && rank > 1 ? ordered[rank - 2] : null;
        fact.survival = {
          rank,
          liveCount: ordered.length,
          // Last place ⇒ the next assert by anyone takes this row. On an exact
          // three-key tie SQL may order either row first, so a tied-last fact
          // is reported as next-victim too: it is one of the two candidates,
          // and warning is the conservative side of an ambiguity.
          nextVictim: isLast,
          survivingFractionFloor: neighbourAbove ? sweepRemainingFraction(neighbourAbove, nowMs) : null,
        };
      }
    } catch {
      // Undetermined beats wrong: the notice says so, and an eviction notice
      // must never be lost to a diagnostic query failing. `survival` is simply
      // absent on this path — never a fabricated "you are safe".
      ranking = null;
    }

    const { notifyEvictedFactOwners } = await import('./notify-evicted');
    await notifyEvictedFactOwners({
      evicted,
      ranking,
      writerOwnerId: input.createdBy,
      scope: input.scope,
      scopeRef: ref,
    });
  }
  return fact;
}

/** Soft-retract by identity. Returns whether a live fact was retracted. */
export async function retractFact(
  args: {
    scope: FactScope;
    scopeRef?: string | null;
    key: string;
    workspaceId?: string;
    retractedBy?: string;
    reason?: string;
  },
  inject?: Sql,
): Promise<boolean> {
  const err = validateFactScope(args.scope, args.scopeRef);
  if (err) throw new InvalidInputError(`facts:retract — ${err}`);
  const sql = sqlOf(inject);
  const ws = args.workspaceId ?? activeWorkspaceId();
  const ref = args.scope === 'workspace' ? '' : (args.scopeRef ?? '').trim();
  const retractedBy = args.retractedBy?.trim() || null;
  const reason = args.reason?.trim() || null;
  // LOCAL partition only (H6): retracting YOUR fact must not retract another
  // source's independent observation of the same identity. Your retraction
  // federates to peers' copies of YOUR partition via the mig-461/462 update
  // capture; foreign partitions retract via the projection's deleteFromPg.
  // P-008 (a): retract the CURRENT version. A retraction is a state change on
  // the live value, not a new version — it does not fork the chain, and the
  // superseded tail must stay untouched or history would be rewritten by it.
  const rows = await sql<{ key: string }[]>`
    UPDATE harness_shared.agent_facts
       SET retracted_at = now(), retracted_by = ${retractedBy}, retraction_reason = ${reason}
     WHERE workspace_id = ${ws} AND scope = ${args.scope}
       AND coalesce(scope_ref,'') = ${ref} AND key = ${args.key.trim()}
       AND source_hive IS NULL
       AND superseded_at IS NULL
       AND retracted_at IS NULL
    RETURNING key`;
  return rows.length > 0;
}

export type FactKeyState = 'live' | 'already-retracted' | 'already-superseded' | 'not-found';

/** Read the newest local row for an exact fact identity after a retract miss. */
export async function findFactKeyState(
  args: { scope: FactScope; scopeRef?: string | null; key: string; workspaceId?: string },
  inject?: Sql,
): Promise<FactKeyState> {
  const sql = sqlOf(inject);
  const ws = args.workspaceId ?? activeWorkspaceId();
  const ref = args.scope === 'workspace' ? '' : (args.scopeRef ?? '').trim();
  const rows = await sql<{ retracted_at: string | null; superseded_at: string | null }[]>`
    SELECT retracted_at::text, superseded_at::text
      FROM harness_shared.agent_facts
     WHERE workspace_id = ${ws} AND scope = ${args.scope}
       AND coalesce(scope_ref,'') = ${ref} AND key = ${args.key.trim()}
       AND source_hive IS NULL
     ORDER BY id DESC
     LIMIT 1`;
  const row = rows[0];
  if (!row) return 'not-found';
  if (row.retracted_at) return 'already-retracted';
  if (row.superseded_at) return 'already-superseded';
  return 'live';
}

/** One live fact sharing a key, found at a DIFFERENT (scope, scopeRef) than the one searched. */
export interface FactElsewhereMatch {
  id: number;
  scope: FactScope;
  scopeRef: string | null;
  expiresAt: string;
}

/** One live local fact identity matching a key, regardless of its scope. */
export type FactKeyMatch = FactElsewhereMatch;

/**
 * Find the current local fact identities for a key across every scope.
 *
 * A key is only unique inside `(scope, scopeRef)`, so callers that want to
 * accept a key without an explicit scope must first prove that exactly one
 * current identity matches. The result is deliberately bounded: two rows are
 * enough to refuse an ambiguous key, while the small cap keeps this helper
 * safe on a key shared by many scopes.
 */
export async function findFactKeyMatches(
  args: { key: string; workspaceId?: string },
  inject?: Sql,
): Promise<FactKeyMatch[]> {
  const key = args.key.trim();
  if (!key) return [];
  const sql = sqlOf(inject);
  const ws = args.workspaceId ?? activeWorkspaceId();
  const rows = await sql<{ id: string | number; scope: FactScope; scope_ref: string | null; expires_at: string }[]>`
    SELECT id, scope, scope_ref, expires_at::text
      FROM harness_shared.agent_facts
     WHERE workspace_id = ${ws} AND key = ${key}
       AND source_hive IS NULL
       AND superseded_at IS NULL
       AND retracted_at IS NULL
     ORDER BY expires_at DESC, id DESC
     LIMIT 2`;
  return rows.map((r) => ({ id: Number(r.id), scope: r.scope, scopeRef: r.scope_ref, expiresAt: r.expires_at }));
}

/**
 * EI-19328780288425209: `retractFact` returning `false` is indistinguishable between
 * "this key never existed" and "this key exists, but at a DIFFERENT scope/scopeRef than
 * you searched" — a caller who reads `retracted:false` as global absence can leave a
 * wrong, live fact folding verbatim into every future orient while believing it's gone
 * (the incident this bug report is about: a wrong fact stayed live 5h+ after the author
 * told six agents it had been removed). Call ONLY after a `retractFact` miss, to surface
 * live (unretracted, unsuperseded, LOCAL-partition — foreign observations are a separate
 * partition by design, see H6 above) rows sharing the same key elsewhere in this
 * workspace, so the caller can retract there instead of concluding absence.
 */
export async function findFactKeyElsewhere(
  args: { scope: FactScope; scopeRef: string; key: string; workspaceId?: string },
  inject?: Sql,
): Promise<FactElsewhereMatch[]> {
  const sql = sqlOf(inject);
  const ws = args.workspaceId ?? activeWorkspaceId();
  const ref = args.scope === 'workspace' ? '' : args.scopeRef.trim();
  const rows = await sql<{ id: string | number; scope: FactScope; scope_ref: string | null; expires_at: string }[]>`
    SELECT id, scope, scope_ref, expires_at::text
      FROM harness_shared.agent_facts
     WHERE workspace_id = ${ws} AND key = ${args.key.trim()}
       AND source_hive IS NULL
       AND superseded_at IS NULL
       AND retracted_at IS NULL
       AND NOT (scope = ${args.scope} AND coalesce(scope_ref,'') = ${ref})
     ORDER BY expires_at DESC
     LIMIT 5`;
  return rows.map((r) => ({ id: Number(r.id), scope: r.scope, scopeRef: r.scope_ref, expiresAt: r.expires_at }));
}

/** One fold selector: a (scope, ref) pair to include. */
export interface FactSelector {
  scope: FactScope;
  scopeRef?: string | null;
}

/**
 * The FOLD read — live (unexpired, unretracted) facts for a set of selectors,
 * newest-updated first, bounded per selector. This is what brief/dossier/orient
 * renderers call. Deterministic: no similarity, no ranking model.
 *
 * P-007 audience filtering (`opts.audiences`) — the RECIPIENT's audience
 * memberships (e.g. `['fleet:p2p-git']`):
 *   • omitted / []  → only unrestricted facts fold (audience_scope IS NULL) —
 *                     the conservative default: a reader whose audience context
 *                     is unknown never receives an audience-scoped fact;
 *   • ['fleet:x']   → unrestricted facts + facts scoped to a listed audience;
 * P-018: this read now also selects `id`, so a folded fact can render the exact
 * VERSIONED citation ref ({@link factCitationRef}). A convention cited without
 * its version cannot be checked for staleness precisely, which is most of the
 * point of citing it.
 *
 *   • 'all'         → NO audience filter — the explicit-read escape hatch
 *                     (facts:list): an audience-scoped fact must stay listable
 *                     or it becomes unmanageable (you can't retract what you
 *                     can't see). Audience is delivery RELEVANCE, not secrecy.
 */
/**
 * The scoping + liveness predicate for ONE selector, shared by {@link foldFacts}
 * (which returns a bounded PAGE) and {@link countLiveFacts} (which returns the
 * unbounded CENSUS of that same population).
 *
 * WI-38910: `facts:list` reported `count: 4` — its page size — for a scope
 * holding hundreds of live facts, with no `total`. Agents are told to read
 * standing facts before asserting, so a census that is silently a page makes
 * that dedup check ~1% effective; the duplicate assert then EVICTS a peer's
 * still-valid fact, because the busy scopes run permanently at
 * {@link FACTS_PER_SCOPE_CAP}.
 *
 * The count is therefore only trustworthy if it describes EXACTLY the rows the
 * page draws from. A hand-copied second WHERE is how that guarantee gets lost
 * one edit later — so both callers compose this single fragment, and
 * `count-page-parity` in store.integration.test.ts asserts the two agree.
 */
/**
 * The CAP population — every row the per-scope eviction sweep is allowed to
 * choose a victim from, and therefore the only population a survival verdict
 * may be ranked against.
 *
 * ⚠ This is NOT {@link liveFactPredicate}. That one describes what a FOLD
 * serves; this one describes what the CAP may destroy, and the two differ by
 * exactly the rows that are exempt from eviction: the typed safety slots
 * (`wall:` / `dead-end:` / `guard-rail:`, WI-6935 (a)) and `kind:'convention'` (P-028 —
 * governance rows; their explicit TTL still controls natural expiry, but the
 * per-scope observation cap must never retract policy). Reading one where you
 * meant the other is the whole bug this fragment exists to prevent.
 *
 * ── WHY IT IS SHARED (EI-20515478467800187) ────────────────────────────────
 * The sweep and the survival report each carried their own hand-copied WHERE.
 * They agreed on the safety slots and disagreed on conventions: the sweep
 * excluded them, the survival query counted them. So `survival.liveCount`
 * counted rows the sweep can never evict and `survival.rank` ranked the write
 * against a population interleaved with exempt rows — making the receipt's
 * headline advice ("rank N of M, survives M-N more asserts") arithmetically
 * wrong on any scope holding conventions, and reporting `nextVictim:false`
 * ("you are safe") for a write that really was next to die whenever the
 * bottom-ranked row was a convention. Measured on the live workspace scope at
 * the time of the fix: 285 ranked, but only 202 actually evictable, because 83
 * were conventions. That gap is what the reporter of EI-20515478467800187 hit
 * and could not reconcile. Quoted verbatim from that report as it stood that
 * day: "liveCount 259 against a 200-fact cap" (cap-drift-ok — a DATED reading,
 * not a statement of the enforced cap; that is FACTS_PER_SCOPE_CAP, and every
 * agent-facing string must interpolate it rather than type a digit).
 *
 * The sibling fragment above already learned this lesson for the census/page
 * pair; the cap population simply never got it. `sweep-survival-population-
 * parity` in store.integration.test.ts holds the two together.
 */
type FactCapPartition = 'ordinary' | 'volatile';

/**
 * TEST SEAM (P-002). Lets a suite exercise the cap MECHANISM without
 * materializing its production-tuned MAGNITUDE.
 *
 * Why this exists: the ordinary ceiling is deliberately ~14x working demand
 * (see FACTS_PER_SCOPE_CAP), and a bound is only meaningfully tested against a
 * SATURATED scope. Without this seam every saturation test has to insert 5000
 * rows, so the suite's runtime becomes a function of a number chosen for
 * production capacity reasons — and the integration suite duly went from
 * seconds to over five minutes on the first such test alone when the ceiling
 * was raised. The tests care whether the mechanism refuses/evicts correctly,
 * never how big the number is.
 *
 * Pinned via `pinModuleState` per the shared-package singleton rule: several
 * ordinary seams (bare specifier vs relative path, a symlinked
 * node_modules/@papercusp copy) can give the test file and the code under test
 * SEPARATE module records, and a plain module-scoped `let` would then be
 * written by one and read by the other — the override would silently not
 * apply, which here means the test quietly runs against the production
 * magnitude instead of the one it asked for.
 */
const capSeam = pinModuleState('@papercusp/operator-core.agent-facts.cap-seam', () => ({
  override: null as { ordinary?: number; volatile?: number } | null,
}));

/**
 * Override the per-partition caps for the duration of a test. Pass `null` to
 * restore the production constants — always do this in an `afterAll`, or the
 * override leaks into every later suite sharing the module record.
 */
export function __setFactCapsForTests(next: { ordinary?: number; volatile?: number } | null): void {
  capSeam.override = next;
}

function factCapFor(partition: FactCapPartition): number {
  const override = capSeam.override;
  if (override) {
    const value = partition === 'volatile' ? override.volatile : override.ordinary;
    // A non-positive override would disable the bound entirely rather than
    // shrink it, which is the one thing a cap test must never silently get.
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  }
  return partition === 'volatile' ? FACTS_VOLATILE_PER_SCOPE_CAP : FACTS_PER_SCOPE_CAP;
}

function capPopulationPredicate(
  sql: Sql,
  ws: string,
  scope: string,
  ref: string,
  partition: FactCapPartition,
) {
  const measurementPartition =
    partition === 'volatile'
      ? sql`measurement->'subjectVolatile' = 'true'::jsonb`
      : sql`measurement->'subjectVolatile' IS DISTINCT FROM 'true'::jsonb`;
  return sql`workspace_id = ${ws} AND scope = ${scope}
         AND coalesce(scope_ref,'') = ${ref}
         -- LOCAL partition only (H6): the local writer's cap must never evict
         -- foreign-source observations.
         AND source_hive IS NULL
         -- P-008 (a): CURRENT versions only, so the cap is not a function of
         -- how often a fact was corrected.
         AND superseded_at IS NULL
         AND retracted_at IS NULL AND expires_at > now()
         -- WI-6935 (a): the typed SAFETY slots are exempt, and are excluded
         -- from the ranking entirely so they neither evict nor consume offset.
         AND key NOT LIKE ${`${WALL_KEY_PREFIX}%`}
         AND key NOT LIKE ${`${DEAD_END_KEY_PREFIX}%`}
         AND key NOT LIKE ${`${GUARD_RAIL_KEY_PREFIX}%`}
         -- P-028: conventions are governance rows, not ordinary cap population.
         AND COALESCE(kind, '') <> 'convention'
         -- EI-20365165629381535: partition by the exact JSONB boolean marker.
         -- the JSONB arrow operator preserves the type, so a malformed string marker such as
         -- {subjectVolatile: "true"} remains ordinary rather than joining the
         -- volatile population. IS DISTINCT FROM includes missing, malformed,
         -- and non-true markers in the ordinary partition without turning NULL
         -- into an accidental exclusion.
         AND ${measurementPartition}`;
}

function isFactCapExempt(input: Pick<AssertFactInput, 'key' | 'kind'>): boolean {
  const key = input.key.trim();
  return (
    input.kind === 'convention' ||
    key.startsWith(WALL_KEY_PREFIX) ||
    key.startsWith(DEAD_END_KEY_PREFIX) ||
    key.startsWith(GUARD_RAIL_KEY_PREFIX)
  );
}

/**
 * How many live facts already occupy this (scope, ref) partition, EXCLUDING the
 * incoming key. `>= cap` is exactly the condition under which seating a NEW key
 * would breach the ceiling, so this is the whole refusal predicate.
 *
 * P-002 / D-003 replaced `findCrossAuthorVerifiedCapVictim` with this. That
 * function answered "WHICH fact would I destroy, and am I allowed to?" — a
 * question with no answer once destruction stops being on the table. Its
 * history is worth carrying because it is the argument for this rewrite:
 *
 *  - It refused only when the victim was another author's `verified` fact.
 *    Once a scope saturated with a 100%-verified population — measured 200/200
 *    verified across 123-130 distinct authors on both `workspace` and
 *    `harness:papercusp` — that discriminator was DEGENERATE, so a rail meant
 *    to protect one fact became a scope-wide write lock (EI-21585375376448939).
 *  - Narrowing it to "refuse only when the incoming write does not OUTRANK the
 *    victim" fixed the write lock by permitting the destruction again. Both
 *    settings were reachable only because a stranger's fact was the currency.
 *
 * Counting is also strictly cheaper than the victim search it replaces: one
 * aggregate over the same predicate, versus an ORDER BY + OFFSET cap-1 over the
 * whole partition plus a dynamic `import()` of the shared comparator.
 */
async function countCapPopulationExcludingKey(
  input: AssertFactInput,
  sql: Sql,
  partition: FactCapPartition,
): Promise<number> {
  const ws = input.workspaceId ?? activeWorkspaceId();
  const ref = input.scope === 'workspace' ? null : (input.scopeRef ?? '').trim();
  const key = input.key.trim();
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n
      FROM harness_shared.agent_facts
     WHERE ${capPopulationPredicate(sql, ws, input.scope, ref ?? '', partition)}
       AND key <> ${key}`;
  return Number(rows[0]?.n ?? 0);
}

/**
 * What an assert WOULD cost, computed WITHOUT writing anything
 * (EI-20515478467800187).
 *
 * The eviction cap was the only destructive path in this store with no
 * look-before-you-leap surface: the body-length cap already refuses over-cap
 * writes and previews the exact tail it would drop (assert.ts), while the
 * eviction cap disclosed its victim only in the receipt of the write that had
 * already destroyed them. That asymmetry is what EI-20515478467800187 reported,
 * and it makes remediation hazardous rather than merely annoying: an agent
 * trying to restore an evicted fact cannot see that the restoring write is
 * itself about to displace a third party.
 *
 * ⚠ THIS IS A FORECAST, NOT A RESERVATION — see `raceCaveat`. It reads
 * committed state at one instant; on a shared scope a peer may assert between
 * the preview and the write, which changes both the population and the victim.
 * It narrows a blind write to an informed one; it cannot make it atomic. Do not
 * present it to a caller as a guarantee.
 */
export interface FactCapPreview {
  scope: FactScope;
  scopeRef: string | null;
  /** Rows the sweep may currently evict here — the true cap population. */
  populationSize: number;
  /** The cap this scope is measured against. */
  cap: number;
  /** True when this write would breach {@link cap} — by refusal (ordinary) or eviction (volatile). */
  atCap: boolean;
  /** An upsert of a live key supersedes it, so it consumes no NEW slot. */
  replacesExistingKey: boolean;
  /** Exempt from the cap entirely (a convention, or a typed safety slot). */
  exempt: boolean;
  /**
   * P-002 / D-003: this write would be REFUSED — the ordinary partition is at its
   * ceiling and nothing is evicted to make room. Only ever true for the ordinary
   * partition, and mutually exclusive with a non-empty {@link wouldEvict}.
   *
   * ⚠ A dry run must never report a cost the real write would not pay. Before
   * this field existed, the preview forecast `wouldEvict` for an ordinary write
   * — naming facts that, after this change, CANNOT be destroyed — so a caller
   * deciding "is this assert worth someone else's fact?" was answering a
   * question the store no longer asks. The honest ordinary answer is binary:
   * the write lands, or it is refused.
   */
  wouldRefuse: boolean;
  /**
   * WHO would be destroyed if this write happened now. Empty ⇒ nothing dies.
   * VOLATILE PARTITION ONLY since P-002 — always empty for an ordinary write,
   * which refuses instead (see {@link wouldRefuse}).
   */
  wouldEvict: FactEviction[];
  /**
   * Where the written row would land in the victim ranking; null when exempt.
   * Also null for the ORDINARY partition since P-002: a victim ranking answers
   * "how soon will my fact be destroyed", and nothing in that partition is
   * destroyed by the cap any more, so any rank reported there would be fiction.
   */
  survival: FactSurvival | null;
  raceCaveat: string;
}

/** Sentinel id for the not-yet-written row while it is ranked against incumbents. */
const PREVIEW_ROW_ID = '__preview__';

export async function previewFactCapImpact(
  input: AssertFactInput,
  inject?: Sql,
): Promise<FactCapPreview> {
  const sql = sqlOf(inject);
  const err = validateFactScope(input.scope, input.scopeRef);
  if (err) throw new InvalidInputError(`facts:assert — ${err}`);
  // The real assert path rejects scope refs whose shape cannot match the
  // selector. A dry-run must make the same decision, or it can report a
  // forecast for a write that would be refused.
  const refShapeErr = validateFactScopeRefShape(input.scope, input.scopeRef);
  if (refShapeErr) throw new InvalidInputError(`facts:assert — ${refShapeErr}`);
  const key = input.key.trim();
  if (!key) throw new InvalidInputError('facts:assert — key required (stable slug)');
  const ws = input.workspaceId ?? activeWorkspaceId();
  const ref = input.scope === 'workspace' ? null : (input.scopeRef ?? '').trim();
  const capPartition: FactCapPartition = input.subjectVolatile === true || Boolean(input.measuredAt?.trim()) ? 'volatile' : 'ordinary';
  const cap = factCapFor(capPartition);

  // The exemptions are the SAME three the cap population excludes. Stated here
  // in TS because the row does not exist yet to be filtered by SQL — if you
  // change capPopulationPredicate's exemptions, change these in the same edit.
  const exempt = isFactCapExempt(input);

  const population = await sql<
    {
      id: string | number | null;
      key: string;
      confidence: string | null;
      created_by: string;
      expires_at: string | Date;
      created_at: string | Date;
      updated_at: string | Date;
      body: string | null;
    }[]
  >`
    SELECT id, key, confidence, created_by, expires_at, created_at, updated_at, body
      FROM harness_shared.agent_facts
     WHERE ${capPopulationPredicate(sql, ws, input.scope, ref ?? '', capPartition)}`;

  // An upsert supersedes the live row under the same key, so that row leaves the
  // population as this one enters it — the net slot count is unchanged. Missing
  // this is how a preview would over-predict eviction for every ordinary refresh
  // of an existing fact, which is the single most common assert there is.
  const incumbents = population.filter((r) => r.key !== key);
  // EI-20824216187836980: an exempt row is absent from `population` by
  // construction, so the filter above can NEVER see it — deciding this from the
  // population alone reported a confident `false` for every convention / wall /
  // dead-end refresh, i.e. "this write takes a new slot" about a write that
  // takes none. Ask the table directly on that branch.
  const replacesExistingKey = exempt
    ? (
        await sql<{ hit: number }[]>`
          SELECT 1 AS hit
            FROM harness_shared.agent_facts
           WHERE workspace_id = ${ws} AND scope = ${input.scope}
             AND coalesce(scope_ref,'') = ${ref ?? ''} AND key = ${key}
             AND source_hive IS NULL AND superseded_at IS NULL
             AND retracted_at IS NULL AND expires_at > now()
           LIMIT 1`
      ).length > 0
    : incumbents.length !== population.length;

  const { orderAsSweepWould, rankOfId, sweepRemainingFraction } = await import('./sweep-ranking');
  const nowMs = Date.now();

  // Rank the incumbents exactly as the sweep's ORDER BY would, then take the
  // tail past the offset — the same arithmetic as the sweep's own OFFSET.
  //
  // EI-20824216187836980: that offset is CAP-1 only for a write that JOINS the
  // cap population. An EXEMPT write never does, so it buys no seat and must
  // trim nothing — offset CAP. This mirrors the sweep's computed offset; the
  // integration suite runs BOTH and requires them to name the same victims, so
  // a drift here is a test failure rather than a forecast that quietly
  // over-predicts the destruction its own caller is deciding against.
  const capOffset = Math.max(0, exempt ? cap : cap - 1);
  const orderedIncumbents = orderAsSweepWould(incumbents, nowMs);
  // P-002 / D-003: the ordinary partition refuses instead of evicting, so it
  // forecasts NO victims. `replacesExistingKey` is what keeps this honest for
  // the commonest assert of all: a refresh of a key already live here consumes
  // no new seat, so it is never refused even at the ceiling — mirroring the
  // write path's `key <> incoming` exclusion rather than re-deriving it.
  const wouldRefuse =
    capPartition === 'ordinary' && !exempt && !replacesExistingKey && incumbents.length >= cap;
  const doomed = capPartition === 'volatile' ? orderedIncumbents.slice(capOffset) : [];
  const wouldEvict: FactEviction[] = doomed.map((r) => ({
    key: r.key,
    confidence: parseFactConfidence(r.confidence),
    expiresAt: typeof r.expires_at === 'string' ? r.expires_at : r.expires_at.toISOString(),
    createdBy: r.created_by,
    // Same helper the real eviction uses — a preview that excerpted differently
    // from the write it previews would be a silent lie about what you are about
    // to destroy.
    ...excerptEvictedBody(r.body),
  }));

  let survival: FactSurvival | null = null;
  // P-002 / D-003: a survival rank answers "how soon does the cap destroy my
  // fact". The ordinary partition no longer destroys anything, so reporting a
  // rank there would describe a competition that does not exist. How close the
  // scope is to its ceiling is still answerable — `populationSize` vs `cap`.
  if (!exempt && capPartition === 'volatile') {
    // The hypothetical row. A FRESH write always scores the MAXIMUM on ranking
    // key 2 — the fraction is (expires-now)/(expires-created) and created==now,
    // so it is 1.0 for any positive TTL. The declared TTL therefore cannot
    // change this row's rank, which is why no TTL resolution is duplicated here.
    const survivors = orderedIncumbents.slice(0, Math.max(0, cap - 1));
    const hypothetical = {
      id: PREVIEW_ROW_ID,
      confidence: input.confidence ?? null,
      expires_at: new Date(nowMs + 86_400_000),
      created_at: new Date(nowMs),
      updated_at: new Date(nowMs),
    };
    const ordered = orderAsSweepWould([...survivors, hypothetical], nowMs);
    const rank = rankOfId(ordered, PREVIEW_ROW_ID);
    if (rank > 0) {
      const isLast = rank === ordered.length;
      const neighbourAbove = isLast && rank > 1 ? ordered[rank - 2] : null;
      survival = {
        rank,
        liveCount: ordered.length,
        nextVictim: isLast,
        survivingFractionFloor: neighbourAbove ? sweepRemainingFraction(neighbourAbove, nowMs) : null,
      };
    }
  }

  return {
    scope: input.scope,
    scopeRef: ref,
    populationSize: population.length,
    cap,
    atCap: wouldRefuse || wouldEvict.length > 0,
    replacesExistingKey,
    exempt,
    wouldRefuse,
    wouldEvict,
    survival,
    raceCaveat:
      'FORECAST, NOT A RESERVATION: read from committed state at one instant. A peer asserting ' +
      'into this scope before you write changes both the population and the victim. Re-previewing ' +
      'does not close the gap — it only re-dates it.',
  };
}

function liveFactPredicate(
  sql: Sql,
  ws: string,
  scope: string,
  ref: string,
  keyPrefixes: readonly string[],
  audiences: readonly string[] | 'all',
) {
  return sql`workspace_id = ${ws} AND scope = ${scope}
         AND coalesce(scope_ref,'') = ${ref}
         -- P-008 (a): CURRENT versions only. A fold that saw the superseded tail
         -- would serve an agent both the corrected value and the value it
         -- corrected, as peers.
         AND superseded_at IS NULL
         AND retracted_at IS NULL AND expires_at > now()
         AND ${
           keyPrefixes.length > 0
             ? sql`key LIKE ANY(${keyPrefixes.map((p) => p + '%')})`
             : sql`TRUE`
         }
         AND ${
           audiences === 'all'
             ? sql`TRUE`
             : audiences.length > 0
               ? sql`(audience_scope IS NULL OR audience_scope = ANY(${audiences as string[]}))`
               : sql`audience_scope IS NULL`
         }`;
}

/**
 * How many LIVE facts one selector actually has — the census behind a
 * {@link listFacts} page. Deliberately NOT limited: this is the number that
 * tells a reader whether the page they are holding is the whole population.
 *
 * Returns the count under the same audience semantics the caller will read with
 * ('all' for the explicit facts:list read), so `total` and `count` are directly
 * comparable rather than two different questions.
 */
export async function countLiveFacts(
  sel: FactSelector,
  opts: { workspaceId?: string; audiences?: readonly string[] | 'all'; keyPrefixes?: readonly string[] } = {},
  inject?: Sql,
): Promise<number> {
  const sql = sqlOf(inject);
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const ref = sel.scope === 'workspace' ? '' : (sel.scopeRef ?? '').trim();
  // Same guard foldFacts applies: an unset optional dimension folds nothing, so
  // its census is 0 rather than "every fact in every ref of this scope".
  if (sel.scope !== 'workspace' && !ref) return 0;
  const keyPrefixes = (opts.keyPrefixes ?? []).map((p) => p.trim()).filter(Boolean);
  const audiences =
    opts.audiences === 'all' ? 'all' : (opts.audiences ?? []).map((a) => a.trim()).filter(Boolean);
  const rows = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n
      FROM harness_shared.agent_facts
     WHERE ${liveFactPredicate(sql, ws, sel.scope, ref, keyPrefixes, audiences)}`;
  return Number(rows[0]?.n ?? 0);
}

/**
 * The per-selector CENSUS behind one fold: how many rows the selector actually
 * holds live, versus how many the per-selector LIMIT let through.
 *
 * P-004 / D-006. The fold is `ORDER BY updated_at DESC LIMIT`
 * {@link FACTS_FOLD_LIMIT}, and it rendered that slice under a header
 * ("### Standing facts", see {@link renderFactsFold}) that presents it as the
 * population. Measured 2026-09-02 against harness_shared.agent_facts under this
 * fold's OWN {@link liveFactPredicate}: scope `workspace` held 495 fold-eligible
 * facts and showed 12 (2.4% — 483 never displayed); `harness:papercusp` held 366
 * and showed 12 (3.3%). P-002/D-003 raised the ordinary ceiling 200 -> 5000 and
 * stopped evicting, so that residue now GROWS rather than being destroyed — which
 * is what turns a cosmetic omission into a load-bearing one.
 *
 * This is the rule orient.ts already applies to a mode-NARROWED fold ("a bounded
 * read rendered as a total"), extended to the truncation that fires on EVERY full
 * fold rather than only on monitor ticks. D-006 deliberately does NOT re-rank the
 * fold: recency is correct for a currency question, and value-ranking it would
 * close it to fresh operational facts the way absolute-expiry once closed the cap
 * (EI-19483432832662150). Disclosure is the fix; the ORDER BY is not the defect.
 *
 * `total` comes from a window function in the SAME statement as the rows, so
 * disclosing it costs no extra round-trip — `count(*) OVER ()` is evaluated
 * before LIMIT, which is exactly the property that makes this free.
 */
export interface FactFoldCensus {
  scope: FactScope;
  scopeRef: string | null;
  /** Rows this selector contributed to the fold, after the per-selector LIMIT. */
  shown: number;
  /** Rows the selector holds LIVE under the same predicate — the whole population. */
  total: number;
  /** `total > shown` — the reader is holding a SAMPLE, not a census. */
  truncated: boolean;
}

/**
 * {@link foldFacts} plus the per-selector {@link FactFoldCensus} — the same rows,
 * and the number that says whether they are all of them. Prefer this at any
 * surface that RENDERS the fold to an agent; `foldFacts` remains for callers that
 * only consume the rows.
 */
export async function foldFactsWithCensus(
  selectors: readonly FactSelector[],
  opts: {
    workspaceId?: string;
    limitPerSelector?: number;
    audiences?: readonly string[] | 'all';
    /** Narrow the fold to keys starting with ANY of these prefixes (applied IN
     *  SQL, before the per-selector LIMIT, so a slot's facts are never crowded
     *  out by unrelated ones). One query however many prefixes are passed —
     *  which is the point: {@link foldNeverDropFacts} needs two slots on a
     *  monitor tick and must not pay a round-trip per slot. Empty/omitted ⇒ no
     *  key filter. Used by {@link foldDeadEndFacts} + {@link foldNeverDropFacts}. */
    keyPrefixes?: readonly string[];
  } = {},
  inject?: Sql,
): Promise<{ facts: AgentFact[]; census: FactFoldCensus[] }> {
  if (selectors.length === 0) return { facts: [], census: [] };
  const sql = sqlOf(inject);
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const limit = opts.limitPerSelector ?? FACTS_FOLD_LIMIT;
  const keyPrefixes = (opts.keyPrefixes ?? []).map((p) => p.trim()).filter(Boolean);
  const audiences =
    opts.audiences === 'all'
      ? 'all'
      : (opts.audiences ?? []).map((a) => a.trim()).filter(Boolean);
  const out: AgentFact[] = [];
  const census: FactFoldCensus[] = [];
  for (const sel of selectors) {
    const ref = sel.scope === 'workspace' ? '' : (sel.scopeRef ?? '').trim();
    if (sel.scope !== 'workspace' && !ref) continue; // an unset optional dimension folds nothing
    const rows = await sql<(AgentFactRow & { fold_total: string })[]>`
      SELECT id, scope, scope_ref, key, body, source_ref, audience_scope, source_provenance,
             -- P-002: settled_by rides the FOLD specifically. An undecidable whose exit
             -- is stored but never surfaced cannot stop re-derivation — the reader would
             -- see "nobody could determine this" with no way to act on it, which is the
             -- half-finish this modality exists to prevent.
             confidence, measurement, recheck, kind, depends_on, claim, enforcement, settled_by, created_by, updated_at::text, expires_at::text,
             -- P-008 (c): the cell version, so the fold can mark what changed since
             -- the reader's cursor without a second query.
             fed_hlc,
             -- P-004 / D-006: the population this LIMIT is a slice OF. A window
             -- function is evaluated BEFORE the LIMIT, so this is the full live
             -- count and it costs no second statement. Without it the fold cannot
             -- tell a reader that 483 of 495 facts were dropped, and "### Standing
             -- facts" reads as the corpus rather than the newest 12 of it.
             count(*) OVER () AS fold_total
        FROM harness_shared.agent_facts
       WHERE ${liveFactPredicate(sql, ws, sel.scope, ref, keyPrefixes, audiences)}
       ORDER BY updated_at DESC
       LIMIT ${limit}`;
    out.push(...rows.map(rowToFact));
    // No rows ⇒ no window row to read ⇒ the population is genuinely 0, which is
    // the one reading a caller IS entitled to treat as a census.
    const total = rows.length > 0 ? Number(rows[0]!.fold_total) : 0;
    census.push({
      scope: sel.scope,
      scopeRef: sel.scope === 'workspace' ? null : ref,
      shown: rows.length,
      total,
      truncated: total > rows.length,
    });
  }
  return { facts: out, census };
}

export async function foldFacts(
  selectors: readonly FactSelector[],
  opts: {
    workspaceId?: string;
    limitPerSelector?: number;
    audiences?: readonly string[] | 'all';
    /** See {@link foldFactsWithCensus}. */
    keyPrefixes?: readonly string[];
  } = {},
  inject?: Sql,
): Promise<AgentFact[]> {
  return (await foldFactsWithCensus(selectors, opts, inject)).facts;
}

/**
 * Fold the in-scope DEAD-END facts (the P-015 slot: keys `dead-end:%`) for a set
 * of selectors — the fact source the P-006 dead-end matcher live leg ticks off.
 * Same scoping + audience semantics as {@link foldFacts}, narrowed to the
 * dead-end slot IN SQL so the per-selector limit is spent only on dead-ends. The
 * default per-selector limit is raised above FACTS_FOLD_LIMIT: this fold isn't a
 * brief budget, it's the matcher's full candidate set for one tick.
 */
export async function foldDeadEndFacts(
  selectors: readonly FactSelector[],
  opts: { workspaceId?: string; limitPerSelector?: number; audiences?: readonly string[] | 'all' } = {},
  inject?: Sql,
): Promise<AgentFact[]> {
  return foldFacts(selectors, { ...opts, keyPrefixes: [DEAD_END_KEY_PREFIX] }, inject);
}

/**
 * The NEVER-DROP fact slots: dead-ends ({@link DEAD_END_KEY_PREFIX}), walls
 * ({@link WALL_KEY_PREFIX}), and guard rails ({@link GUARD_RAIL_KEY_PREFIX}).
 * All exist to OVERRIDE a stale plan — a dead-end says "that approach is already
 * falsified", a wall says "this is still gated", and a guard rail says "do not
 * repeat the settled mistake" — so their absence actively misleads a reader.
 *
 * Defined HERE, beside the prefixes themselves, for the same single-source-of-
 * truth reason {@link DEAD_END_KEY_PREFIX} spells out: a caller that hand-listed
 * the prefixes would silently drift from them.
 */
export const NEVER_DROP_KEY_PREFIXES: readonly string[] = [
  DEAD_END_KEY_PREFIX,
  WALL_KEY_PREFIX,
  GUARD_RAIL_KEY_PREFIX,
];

/**
 * Fold ONLY the never-drop facts ({@link NEVER_DROP_KEY_PREFIXES}) — the bounded
 * subset a context-budgeted caller folds when it cannot afford the full standing
 * fold. Same scoping + audience semantics as {@link foldFacts}, narrowed in SQL
 * to ONE query per selector regardless of prefix count.
 *
 * EI-18725816532600240: coord:orient's monitor tick used to skip the facts fold
 * ENTIRELY for context budget, which deleted exactly the override signal a stale
 * carry-note needs (a cold wake was told to go implement an approach a dead-end
 * fact had already falsified). Ordinary bounded conclusions can wait for a full
 * orient; these two slots cannot.
 */
export async function foldNeverDropFacts(
  selectors: readonly FactSelector[],
  opts: { workspaceId?: string; limitPerSelector?: number; audiences?: readonly string[] | 'all' } = {},
  inject?: Sql,
): Promise<AgentFact[]> {
  return foldFacts(selectors, { ...opts, keyPrefixes: NEVER_DROP_KEY_PREFIXES }, inject);
}

/** A wall fact whose TTL has LAPSED (expired) but was never retracted — the
 *  wall-lapse watchdog's candidate set. Cross-scope/cross-workspace by design
 *  (a lapsed wall is a page regardless of who asserted it or where). */
export interface LapsedWallFact {
  workspaceId: string;
  scope: FactScope;
  scopeRef: string | null;
  key: string;
  body: string;
  createdBy: string;
  expiresAt: string;
}

/**
 * Every WALL fact (`key LIKE 'wall:%'`) that has expired without being
 * retracted — the read leg {@link WALL_KEY_PREFIX}'s callers sweep. Bounded +
 * oldest-lapsed-first (the wall that has been silently "cleared" the longest
 * is the most urgent). Distinct from {@link sweepExpiredFacts}, which only
 * hard-deletes rows >30d past expiry/retraction — a lapsed wall is a page
 * target from the MOMENT it lapses, long before that deletion sweep would
 * ever touch it.
 */
export async function listLapsedWallFacts(
  opts: { limit?: number } = {},
  inject?: Sql,
): Promise<LapsedWallFact[]> {
  const sql = sqlOf(inject);
  const limit = opts.limit ?? 200;
  const rows = await sql<Array<{
    workspace_id: string;
    scope: FactScope;
    scope_ref: string | null;
    key: string;
    body: string;
    created_by: string;
    expires_at: string;
  }>>`
    SELECT workspace_id, scope, scope_ref, key, body, created_by, expires_at::text
      FROM harness_shared.agent_facts
     WHERE key LIKE ${WALL_KEY_PREFIX + '%'}
       -- P-008 (a): only the CURRENT version of a wall can be lapsed. A
       -- superseded version's expiry is a historical fact, not a page.
       AND superseded_at IS NULL
       AND retracted_at IS NULL
       AND expires_at < now()
     ORDER BY expires_at ASC
     LIMIT ${limit}`;
  return rows.map((r) => ({
    workspaceId: r.workspace_id,
    scope: r.scope,
    scopeRef: r.scope_ref,
    key: r.key,
    body: r.body,
    createdBy: r.created_by,
    expiresAt: r.expires_at,
  }));
}

/** List facts for one selector (the facts:list tool read; includes near-expiry).
 *  Audience-UNfiltered by design ('all') — an explicit list must show
 *  audience-scoped facts (visible `audienceScope` field) so they stay
 *  manageable/retractable; only the automatic FOLDS filter by recipient. */
export async function listFacts(
  sel: FactSelector,
  opts: { workspaceId?: string; limit?: number } = {},
  inject?: Sql,
): Promise<AgentFact[]> {
  return foldFacts(
    [sel],
    { workspaceId: opts.workspaceId, limitPerSelector: opts.limit ?? 50, audiences: 'all' },
    inject,
  );
}

/** Default lookback window for {@link listFactEvictionDisclosures}. Bounded so the
 *  read stays a cheap grouped COUNT rather than an unbounded scan, and so a scope's
 *  eviction disclosure retires once the churn that produced it has aged out — old
 *  eviction noise must not accumulate forever in a permanently-saturated scope. */
export const FACT_EVICTION_DISCLOSURE_WINDOW_SEC = 24 * 3600;

/**
 * EI-19485000346355077: reader-visible disclosure that a scope has RECENTLY had
 * facts cap-evicted (`evicted_at IS NOT NULL`, {@link FactEviction}) — so an
 * ordinary reader whose expected standing fact is silently absent from a
 * {@link foldFacts} / {@link listFacts} result can tell "the cap took it" apart
 * from "nobody ever asserted it", without needing raw SQL access to `evicted_at`.
 *
 * ── WHY THIS EXISTS SEPARATELY FROM THE EXISTING SIGNALS ──────────────────────
 * WI-6935 (b) already made a cap eviction distinguishable AFTER the fact
 * (`evicted_at IS NOT NULL` on the row itself), and WI-7298 ({@link
 * AssertFactResult.evicted}) + `notify-evicted.ts` report it to the WRITER whose
 * assert caused it. Both are writer-facing. An ORDINARY reader — everyone folding
 * `coord:orient` or calling `facts:list` who is not the agent who happened to
 * evict something — has no path to that information at all: {@link
 * liveFactPredicate} filters `retracted_at IS NULL`, so a cap-evicted row is
 * simply gone from every existing read, identically to a key nobody ever wrote.
 *
 * ── SCOPE (deliberate) ─────────────────────────────────────────────────────────
 * Per-SELECTOR count + latest timestamp, not a per-key list of what was evicted.
 * A busy scope can evict a fact every few seconds (WI-7292's measured case: 11
 * evictions in 25 minutes), so a per-key list only relocates the unbounded-growth
 * problem the cap itself exists to solve into this response instead. The bounded
 * count is enough to answer the question this exists for ("is my missing fact
 * cap-evicted or never-asserted?") — a reader missing one specific key already
 * has the exact tool to resolve it (`facts:list { key }`, `key_required` mode).
 *
 * Deliberately ADDITIVE: {@link AgentFact}, {@link foldFacts} and {@link
 * listFacts} are UNCHANGED — every existing caller/fixture keeps compiling and
 * reading exactly what it read before. This is a second, opt-in, bounded read
 * threaded into `facts:list` and `coord:orient` by their own callers.
 */
export interface FactEvictionDisclosure {
  scope: FactScope;
  scopeRef: string | null;
  /** Facts cap-evicted from this selector within the lookback window. Always > 0 —
   *  callers omit the disclosure entirely for a selector with nothing to report,
   *  the same "silence in the common case" convention {@link AssertFactResult.evicted}
   *  already uses. */
  recentEvictedCount: number;
  /** The most recent in-window eviction timestamp. */
  latestEvictedAt: string;
  /** What this means, and how to recover — rendered so it stands alone next to a fold. */
  meaning: string;
}

/**
 * Grouped read behind {@link FactEvictionDisclosure} — one bounded COUNT query
 * per selector (mirrors {@link foldFacts}'s per-selector loop shape), scoped to
 * cap evictions inside {@link FACT_EVICTION_DISCLOSURE_WINDOW_SEC}. Returns only
 * selectors with a non-zero count (see the field doc above) — the common case is
 * an empty array, and callers should treat that as "nothing to disclose", not
 * "the read failed" (a caller wanting fail-soft behavior on a DB error should
 * catch around this call, same as every other facts read here).
 */
export async function listFactEvictionDisclosures(
  selectors: readonly FactSelector[],
  opts: { workspaceId?: string; windowSec?: number } = {},
  inject?: Sql,
): Promise<FactEvictionDisclosure[]> {
  if (selectors.length === 0) return [];
  const sql = sqlOf(inject);
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const windowSec = opts.windowSec ?? FACT_EVICTION_DISCLOSURE_WINDOW_SEC;
  const windowHoursLabel = Math.max(1, Math.round(windowSec / 3600));
  const out: FactEvictionDisclosure[] = [];
  for (const sel of selectors) {
    const ref = sel.scope === 'workspace' ? '' : (sel.scopeRef ?? '').trim();
    if (sel.scope !== 'workspace' && !ref) continue; // same guard foldFacts applies
    const rows = await sql<{ n: string; latest: string | null }[]>`
      SELECT count(*)::text AS n, max(evicted_at)::text AS latest
        FROM harness_shared.agent_facts
       WHERE workspace_id = ${ws} AND scope = ${sel.scope}
         AND coalesce(scope_ref,'') = ${ref}
         AND evicted_at IS NOT NULL
         AND evicted_at > now() - make_interval(secs => ${windowSec})`;
    const n = Number(rows[0]?.n ?? 0);
    const latest = rows[0]?.latest ?? null;
    if (n === 0 || !latest) continue; // silence in the common case, per the field doc above
    out.push({
      scope: sel.scope,
      scopeRef: sel.scopeRef ?? null,
      recentEvictedCount: n,
      latestEvictedAt: latest,
      meaning:
        `${n} fact(s) were cap-evicted from this scope's VOLATILE snapshot partition ` +
        `(FACTS_VOLATILE_PER_SCOPE_CAP=${FACTS_VOLATILE_PER_SCOPE_CAP}) in the ` +
        `last ${windowHoursLabel}h. Ordinary standing facts are never evicted — since D-003 an ` +
        `over-ceiling ordinary write is REFUSED instead, so an ordinary fact missing here was not ` +
        `destroyed to seat someone else's. A snapshot you expect but don't see may have been evicted, not ` +
        `never-asserted — facts:list only shows LIVE rows. Check with the scope's recent writers, or ` +
        `re-assert it yourself if the conclusion still holds.`,
    });
  }
  return out;
}

/**
 * P-018: every live DECLARED CONVENTION (`kind='convention'`) in the workspace,
 * across scopes — the fact half of the conventions read model.
 *
 * Cross-scope BY DESIGN, unlike every other read here, and that is the point:
 * P-018 requires a convention be "discovered without knowing which plan it came
 * from", and requiring the caller to already know a fact's SCOPE is the same
 * defect one axis over. Optionally narrowed to the scopes a given caller is
 * actually governed by (`scopeRefs`) — a harness/role/owner convention that
 * names someone else's ref governs THEM, not you.
 *
 * Audience-UNfiltered ('all' semantics): a convention is normative, and hiding a
 * rule from the agent it binds is strictly worse than showing one that turns out
 * to be irrelevant. Uses the mig-690 partial index (workspace_id, kind, …), so
 * this stays a small index scan over live current rows rather than the seq scan
 * a `kind` filter without that index would be.
 */
export async function listConventionFacts(
  opts: {
    workspaceId?: string;
    /** Restrict role/owner/harness/work_item scopes to these refs. A workspace-
     *  scoped convention is unconditional and always included. */
    scopeRefs?: readonly string[];
    limit?: number;
  } = {},
  inject?: Sql,
): Promise<AgentFact[]> {
  const sql = sqlOf(inject);
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const refs = (opts.scopeRefs ?? []).map((r) => r.trim()).filter(Boolean);
  const rows = await sql<AgentFactRow[]>`
    SELECT id, scope, scope_ref, key, body, source_ref, audience_scope, source_provenance,
           confidence, measurement, recheck, kind, depends_on, claim, enforcement, created_by, updated_at::text, expires_at::text
      FROM harness_shared.agent_facts
     WHERE workspace_id = ${ws} AND kind = 'convention'
       AND superseded_at IS NULL AND retracted_at IS NULL AND expires_at > now()
       AND ${
         refs.length > 0 ? sql`(scope = 'workspace' OR coalesce(scope_ref,'') = ANY(${refs as string[]}))` : sql`TRUE`
       }
     ORDER BY updated_at DESC
     LIMIT ${opts.limit ?? 100}`;
  return rows.map(rowToFact);
}

/**
 * Is this fact an ASSUMPTION? (D-087 R2)
 *
 * ⚠ MOVED HERE by WI-6545 / D-103, which retired P-011's contradiction detector
 * (`agent-facts/conflicts.ts`) and the `listAssumptionFacts` read that fed it.
 * This predicate OUTLIVED both because its surviving caller is a different
 * feature: `facts:assert` moves the P-009 assumption WATERMARK
 * (`noteAssumptionAsserted`) on an assumption and only on an assumption. The
 * detector is gone; "what counts as an assumption" is still a live question.
 *
 * ⚠ The legacy form is deliberately included. D-019's model defined an assumption
 * as `confidence:'suspected'` + `dependsOn` BEFORE its own DEFECT 1 added the
 * `kind` discriminator (migration 690), so a `kind`-only predicate would silently
 * miss every assumption filed in between — the violation `ASSUMPTION_KIND_FILTER`
 * (coord/holder-context.test.ts) exists to catch. `kind` when declared WINS: a row
 * explicitly filed as a conclusion or convention is not an assumption however
 * hedged its confidence.
 */
export function isAssumptionFact(
  f: Pick<AgentFact, 'kind' | 'confidence'>,
): boolean {
  if (f.kind != null) return f.kind === 'assumption';
  return f.confidence === 'suspected';
}

/**
 * Every VERSION of one fact identity, newest first — the read that makes
 * append-versioning (P-008 a) worth having. The current version is the row with
 * `supersededAt === null`; walk `supersedesId` to follow the chain back.
 *
 * LOCAL partition only (`source_hive IS NULL`), matching every other
 * identity-scoped path here: a foreign hive's observations are not versions of
 * yours, and interleaving them would make the chain unreadable.
 *
 * ⚠ HISTORY IS BOUNDED, NOT INFINITE — {@link sweepExpiredFacts} deletes
 * superseded versions 30d after they were replaced. A chain therefore truncates
 * at the tail, and a `supersedesId` older than that resolves to nothing. That is
 * deliberate (an unbounded audit tail on a hot table is its own defect); what
 * D-003 requires is that a pointer never resolves to DIFFERENT content, not
 * that it resolves forever.
 */
export async function factVersions(
  args: { scope: FactScope; scopeRef?: string | null; key: string; workspaceId?: string; limit?: number },
  inject?: Sql,
): Promise<AgentFact[]> {
  const err = validateFactScope(args.scope, args.scopeRef);
  if (err) throw new InvalidInputError(`facts:versions — ${err}`);
  const key = args.key.trim();
  if (!key) throw new InvalidInputError('facts:versions — key required');
  const sql = sqlOf(inject);
  const ws = args.workspaceId ?? activeWorkspaceId();
  const ref = args.scope === 'workspace' ? '' : (args.scopeRef ?? '').trim();
  const limit = args.limit && args.limit > 0 ? Math.floor(args.limit) : 20;
  const rows = await sql<AgentFactRow[]>`
    SELECT id, superseded_at::text, supersedes_id,
           scope, scope_ref, key, body, source_ref, audience_scope, source_provenance,
           confidence, measurement, recheck, kind, depends_on, claim, enforcement, settled_by,
           created_by, updated_at::text, expires_at::text, retracted_at::text,
           retracted_by, retraction_reason
      FROM harness_shared.agent_facts
     WHERE workspace_id = ${ws} AND scope = ${args.scope}
       AND coalesce(scope_ref,'') = ${ref} AND key = ${key}
       AND source_hive IS NULL
     ORDER BY superseded_at DESC NULLS FIRST, id DESC
     LIMIT ${limit}`;
  return rows.map(rowToFact);
}

/** One superseded version row, as {@link supersededVersionsForKeys} returns it. */
export interface SupersededVersionRow {
  scope: string;
  scopeRef: string | null;
  key: string;
  createdBy: string;
  body: string;
  kind: FactKind | null;
  settledBy: string | null;
  updatedAt: string;
}

/**
 * SUPERSEDED versions for MANY keys in ONE read, newest first — the batched sibling of
 * {@link factVersions} (agent-epistemics-2026-08-02 P-006 read side, WI-7236).
 *
 * `factVersions` answers for a single identity, which is right on the WRITE path where
 * exactly one key is being asserted. The coord:orient fold needs the same answer for every
 * folded fact at once, and a per-key loop there would put N queries on the wake path. This
 * takes the keys as one array and lets the caller group by identity.
 *
 * Returns SUPERSEDED rows only: the current version is the fact the caller already holds,
 * and including it would make every key look self-contested. LOCAL partition only
 * (`source_hive IS NULL`), matching every other identity-scoped read here.
 *
 * ⚠ Same bounded-history caveat as {@link factVersions}: {@link sweepExpiredFacts} deletes
 * superseded versions 30d after replacement, so an old chain truncates at the tail.
 */
export async function supersededVersionsForKeys(
  args: { keys: readonly string[]; workspaceId?: string; limit?: number },
  inject?: Sql,
): Promise<SupersededVersionRow[]> {
  const keys = [...new Set(args.keys.map((k) => k.trim()).filter(Boolean))];
  if (keys.length === 0) return [];
  const sql = sqlOf(inject);
  const ws = args.workspaceId ?? activeWorkspaceId();
  const limit = args.limit && args.limit > 0 ? Math.floor(args.limit) : 400;
  const rows = await sql<
    Array<{
      scope: string;
      scope_ref: string | null;
      key: string;
      created_by: string;
      body: string;
      kind: string | null;
      settled_by: string | null;
      updated_at: string;
    }>
  >`
    SELECT scope, scope_ref, key, created_by, body, kind, settled_by, updated_at::text
      FROM harness_shared.agent_facts
     WHERE workspace_id = ${ws}
       AND source_hive IS NULL
       AND superseded_at IS NOT NULL
       AND key = ANY(${keys as string[]})
     ORDER BY superseded_at DESC, id DESC
     LIMIT ${limit}`;
  return rows.map((r) => ({
    scope: r.scope,
    scopeRef: r.scope_ref,
    key: r.key,
    createdBy: r.created_by,
    body: r.body,
    kind: (r.kind ?? null) as FactKind | null,
    settledBy: r.settled_by,
    updatedAt: r.updated_at,
  }));
}

/** Expiry sweep (routines-tick reaper pattern): hard-delete rows expired or
 *  retracted > 30d ago — keeps the audit trail bounded. Fail-soft at call site. */
export async function sweepExpiredFacts(inject?: Sql): Promise<number> {
  const sql = sqlOf(inject);
  const rows = await sql<{ key: string }[]>`
    DELETE FROM harness_shared.agent_facts
     WHERE expires_at < now() - interval '30 days'
        OR retracted_at < now() - interval '30 days'
        -- P-008 (a): bound the version tail on the SUPERSEDE date, not on the
        -- version's own expiry. A long-TTL fact (a 90d wall) corrected on day
        -- one leaves a version whose expires_at is still months out; without
        -- this clause the tail would outlive the value it was corrected to.
        OR superseded_at < now() - interval '30 days'
    RETURNING key`;
  return rows.length;
}

/** F0-2 (federated-scout-gym): the ELITE eligibility rule — sender-side gate on
 *  what may federate. Outcome-verified or strongly-graded only; everything else
 *  is spam-by-design on an open network (D-005 H3: receiver-side signed-outcome
 *  verification + reputation weighting still apply on top of this). */
export function federatableElite(e: { outcome?: string | null; grade?: number | null }): boolean {
  return e.outcome === 'won' || (e.grade ?? 0) >= 4;
}

/** Render facts as the compact fold block briefs embed. Deterministic layout:
 *  one line per fact — `[scope:ref] body (src, expires in Nd)`; P-007 adds the
 *  audience tag (`⊸fleet:x`, only ever present when the reader matched it) and
 *  the provenance-hydrated src form (verified quote / loud ✗unverified). */
/**
 * P-018 / D-075 R1 — the ONE citable id for a fact, in the grammar
 * `classifyPremiseRef` already classifies as `kind:'fact'` (and therefore as
 * invalidatable): `fact:<scope>[:<scopeRef>]:<key>[@v<N>]`.
 *
 * Exported because the conventions read model and this fold MUST agree on what a
 * convention is CALLED. If discovery named one thing and the citation seam parsed
 * another, every citation would degrade to `opaque` — declarable but never
 * invalidatable — which is the near-synonym failure D-041 renamed to fix.
 *
 * The `@v<N>` suffix is omitted when the read did not select version identity;
 * the ref still classifies, which is D-026's degrade-gracefully rule applied to
 * our own grammar. PURE.
 */
export function factCitationRef(
  f: Pick<AgentFact, 'scope' | 'scopeRef' | 'key'> & { id?: number },
): string {
  const ref = f.scope === 'workspace' ? '' : `${(f.scopeRef ?? '').trim()}:`;
  return `fact:${f.scope}:${ref}${f.key}${f.id != null ? `@v${f.id}` : ''}`;
}

/**
 * P-018: render an enforcement tier compactly — `structural`, or
 * `gate ≥60% by 2026-09-01` for a measured tier (whose floor and review date are
 * guaranteed present by {@link validateConventionEnforcement}). PURE.
 */
export function renderEnforcement(e: ConventionEnforcement): string {
  if (e.floor == null && !e.reviewBy) return e.tier;
  const floor = e.floor != null ? ` ≥${Math.round(e.floor * 100)}%` : '';
  const by = e.reviewBy ? ` by ${e.reviewBy.slice(0, 10)}` : '';
  return `${e.tier}${floor}${by}`;
}

/** Compact age label for the deterministic fold. PURE and future-clock safe. */
export function renderFactAge(updatedAt: string, now: number = Date.now()): string {
  const updated = Date.parse(updatedAt);
  if (!Number.isFinite(updated)) return 'age unknown';
  const ageMs = Math.max(0, now - updated);
  if (ageMs < 60_000) return 'age <1m';
  if (ageMs < 3_600_000) return `age ~${Math.max(1, Math.floor(ageMs / 60_000))}m`;
  if (ageMs < 86_400_000) return `age ~${Math.max(1, Math.floor(ageMs / 3_600_000))}h`;
  return `age ~${Math.max(1, Math.floor(ageMs / 86_400_000))}d`;
}

/**
 * P-018: the modality badge. Rendered ONLY for a declared `kind`, so an unbadged
 * line still reads as "modality not declared" — mig 690's rule (absent means not
 * declared, never silently 'conclusion') carried through to the surface.
 */
const KIND_BADGE: Readonly<Record<FactKind, string>> = {
  conclusion: 'CONCLUSION',
  assumption: 'ASSUMPTION',
  convention: 'CONVENTION',
  // P-002. Reads as a STOP sign rather than a claim, because that is its whole
  // job: the reader's correct next action is to NOT re-derive this.
  undecidable: 'UNDECIDABLE',
};

export function renderFactsFold(
  facts: readonly AgentFact[],
  now: number = Date.now(),
  census: readonly FactFoldCensus[] = [],
): string {
  if (facts.length === 0) return '';
  const lines = facts.map((f) => {
    const scope = f.scopeRef ? `${f.scope}:${f.scopeRef}` : f.scope;
    const aud = f.audienceScope ? ` ⊸${f.audienceScope}` : '';
    const expiry = isPermanentFactExpiry(f.expiresAt)
      ? 'permanent'
      : `expires ~${Math.max(0, Math.round((Date.parse(f.expiresAt) - now) / 86_400_000))}d`;
    const age = renderFactAge(f.updatedAt, now);
    const rendered = renderFactSrc(f);
    const src = rendered ? `, src ${rendered}` : '';
    // P-018: the MODALITY, which this fold previously dropped entirely — so a
    // normative convention was byte-indistinguishable from a settled conclusion
    // at the one surface agents actually read. Same defect class as P-033 (e):
    // a field nobody can see cannot be judged by its values, and D-069 §3 leaves
    // those values as the only remaining check on this layer.
    const tier = f.kind === 'convention' && f.enforcement ? ` · ${renderEnforcement(f.enforcement)}` : '';
    const badge = f.kind ? `⟦${KIND_BADGE[f.kind]}${tier}⟧ ` : '';
    const snapshot = f.measurement?.subjectVolatile
      ? `⟦SNAPSHOT — subject may still be changing; measured at ${f.measurement.measuredAt}; re-measure before acting⟧ `
      : '';
    // A convention is the modality meant to be CITED at the point of action
    // (P-018), so it — and only it — carries its citable ref inline. Putting one
    // on every fact would inflate every orient to make the other modalities
    // citable in a fold that is not where they are cited from.
    const cite = f.kind === 'convention' ? `, cite ${factCitationRef(f)}` : '';
    // P-002: an undecidable's EXIT rides next to the body, not in the trailing
    // metadata parenthetical, because it is the actionable half of the record —
    // exactly the P-018 lesson one line above ("a field nobody can see cannot be
    // judged by its values"). Without it the fold says only "nobody could
    // determine this", which reads as an invitation to go determine it.
    const settles = f.kind === 'undecidable' && f.settledBy ? ` — SETTLED BY: ${f.settledBy}` : '';
    // P-004: an exec probe is enforced by harness preflights, so the fold names where it runs
    // (scope) rather than repeating the command the prose probe already describes.
    const exec = f.recheck?.exec ? ` — AUTO-CHECKED in preflight [${f.recheck.exec.scope.join(',')}]` : '';
    const recheck = f.recheck ? ` — RECHECK: ${f.recheck.probe} — FALSIFIED IF: ${f.recheck.falsifier}${exec}` : '';
    return `• [${scope}${aud}] ${badge}${snapshot}${f.body}${settles}${recheck} (${expiry}, ${age}${src}${cite})`;
  });
  // P-004 / D-006: the header above presents these as THE standing facts. When the
  // per-selector LIMIT dropped some, say so with the numbers and name the read that
  // returns the rest — otherwise a 2.4% sample is byte-indistinguishable from a
  // complete corpus, and an agent concludes a fact does not exist because it was
  // merely the 13th-newest. Same rule orient.ts applies to a mode-narrowed fold.
  const truncated = census.filter((c) => c.truncated);
  const note =
    truncated.length === 0
      ? ''
      : `\n⚠ TRUNCATED — this is the NEWEST ${FACTS_FOLD_LIMIT} per scope, not the whole corpus: ` +
        truncated
          .map((c) => `${c.scope}${c.scopeRef ? `:${c.scopeRef}` : ''} showed ${c.shown} of ${c.total}`)
          .join('; ') +
        `. A fact's ABSENCE here is not evidence it does not exist — it may simply not be among the ` +
        `most recently updated. Read the rest with facts:list { scope, scopeRef } (which reports its own total).`;
  return `### Standing facts (deterministic — assert via facts:assert, retract when stale)\n${lines.join('\n')}${note}`;
}

interface AgentFactRow {
  scope: FactScope;
  scope_ref: string | null;
  key: string;
  body: string;
  source_ref: string | null;
  audience_scope: string | null;
  source_provenance: unknown;
  confidence: string | null;
  /** EI-20191740437408337 — migration 795. */
  measurement?: unknown;
  /** P-010 — migration 940. */
  recheck?: unknown;
  /** P-008 (b) — migration 690. */
  kind?: string | null;
  depends_on?: unknown;
  claim?: unknown;
  /** P-018 — migration 692. */
  enforcement?: unknown;
  /** P-002 — migration 730. What would settle an `undecidable`. */
  settled_by?: string | null;
  created_by: string;
  updated_at: string;
  expires_at: string;
  retracted_at?: string | null;
  retracted_by?: string | null;
  retraction_reason?: string | null;
  /** P-008 (a) — selected only where the caller needs version identity. */
  id?: string | number | null;
  superseded_at?: string | null;
  supersedes_id?: string | number | null;
  /** P-008 (c) — migration 693. The HLC cell version; see AgentFact.cellVersion. */
  fed_hlc?: string | null;
}

/** Defensive validation of a raw `confidence` DB value against the 3-tier
 *  enum (mirrors parseFactSourceProvenance's defensive style, per WI-6052's
 *  fix step 3) — an out-of-band write (a raw psql INSERT, a future bad
 *  migration) that smuggles in an unrecognized value renders unbadged rather
 *  than propagating a bogus tier into the AgentFact contract. The DB CHECK
 *  constraint (mig 671) already rejects this at write time for ordinary
 *  callers; this is the read-side backstop. */
function parseFactConfidence(raw: string | null): FactConfidence | null {
  if (raw === null) return null;
  return (FACT_CONFIDENCE_LEVELS as readonly string[]).includes(raw) ? (raw as FactConfidence) : null;
}

/** P-008 (b): the same read-side backstop for `kind`. The mig-690 CHECK already
 *  rejects an unknown value at write time; this catches the case a CHECK cannot
 *  — a LATER migration widening the vocabulary, after which an old reader would
 *  otherwise map a new modality onto one it does not actually have. PURE. */
function parseFactKind(raw: string | null | undefined): FactKind | null {
  if (raw == null) return null;
  return (FACT_KINDS as readonly string[]).includes(raw) ? (raw as FactKind) : null;
}

/** P-008 (b): defensive read of the `claim` jsonb. Same dual text/object arrival
 *  handling as {@link parseFactDependencies}; anything that is not a JSON OBJECT
 *  (an array, a bare scalar) is null — P-011 compares typed FIELDS, and a scalar
 *  has none. PURE. */
export function parseFactClaim(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

function rowToFact(r: AgentFactRow): AgentFact {
  return {
    scope: r.scope,
    scopeRef: r.scope_ref,
    key: r.key,
    body: r.body,
    sourceRef: r.source_ref,
    audienceScope: r.audience_scope ?? null,
    sourceProvenance: parseFactSourceProvenance(r.source_provenance),
    // WI-6052: now persisted — mig 671 added the `confidence` column and the
    // INSERT/RETURNING/SELECT above all carry it round-trip.
    confidence: parseFactConfidence(r.confidence),
    // EI-20191740437408337: a malformed measurement is dropped rather than
    // allowing an unmarked timestamp to look like a safe snapshot.
    measurement: parseFactMeasurement(r.measurement),
    // P-010: malformed data fails closed to "no contract" instead of becoming
    // executable fold text. Ordinary writes are already protected by the store
    // validator and migration-940 CHECK; this is the read-side backstop.
    recheck: parseFactRecheck(r.recheck),
    // P-008 (b), migration 690. `dependsOn` normalizes to [] rather than null so
    // every consumer can iterate without a null guard — the absence of
    // dependencies and an empty set mean the same thing to a reader ("this fact
    // cannot go stale on declared terms"), unlike `kind`/`claim`, where absent
    // genuinely means "not declared" and must stay distinguishable.
    kind: parseFactKind(r.kind),
    dependsOn: parseFactDependencies(r.depends_on),
    claim: parseFactClaim(r.claim),
    // P-018, migration 692. Null-when-absent like `kind`/`claim` — an untiered
    // convention and a convention whose tier failed to parse must both read as
    // "no tier declared", never as a tier the row does not carry.
    enforcement: parseConventionEnforcement(r.enforcement),
    // P-002, migration 730. Spread-when-selected like `fed_hlc` below rather than
    // defaulted to null: a read that did not select the column must stay
    // distinguishable from an undecidable that genuinely carries no exit — the
    // latter is a defect worth seeing, the former is just a narrow projection.
    ...(r.settled_by === undefined ? {} : { settledBy: r.settled_by }),
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    expiresAt: r.expires_at,
    ...(r.retracted_at === undefined ? {} : { retractedAt: r.retracted_at }),
    ...(r.retracted_by === undefined ? {} : { retractedBy: r.retracted_by }),
    ...(r.retraction_reason === undefined ? {} : { retractionReason: r.retraction_reason }),
    // P-008 (c), migration 693. Absent when the read did not select it; null when
    // the row predates 693 — kept distinguishable from '' so a caller can tell
    // "not selected" from "carries no version".
    ...(r.fed_hlc === undefined ? {} : { cellVersion: r.fed_hlc }),
    // P-008 (a): version identity, emitted ONLY when the query selected it —
    // omitted rather than nulled, so a reader can tell "this read did not ask
    // for version identity" from "this row has no predecessor" (`supersedesId:
    // null`). `id` arrives as a bigint, which node-postgres hands back as a
    // string; coerce once here so every consumer sees a number.
    ...(r.id != null ? { id: Number(r.id) } : {}),
    ...(r.superseded_at !== undefined ? { supersededAt: r.superseded_at } : {}),
    ...(r.supersedes_id !== undefined
      ? { supersedesId: r.supersedes_id == null ? null : Number(r.supersedes_id) }
      : {}),
  };
}

/**
 * Resolve the FEDERATION identity slug a shareable fact should carry
 * (`agent_facts.harness_slug`, mig 461): a Hive MEMBER harness resolves to its
 * hive HOME slug (the registry `hive_slug` pointer — the slug the peer-side
 * projection is bound to, register-all A-003); a hive home / standalone
 * harness is itself. Returns null for an unresolvable / wildcard slug — the
 * fact then stays un-hived (local-only), matching mig 461's NULL semantics.
 * Fail-soft: a registry read error yields null, never throws (an assert must
 * not fail on federation-identity resolution).
 */
export async function resolveFactFederationSlug(
  harnessSlug: string | null | undefined,
): Promise<string | null> {
  const slug = harnessSlug?.trim();
  if (!slug || slug === '*') return null;
  try {
    const { loadHarnessRegistry } = await import('../harness-registry');
    const reg = await loadHarnessRegistry();
    const entry = reg.projects.find((p) => p.slug === slug);
    return entry?.hive_slug ?? slug;
  } catch {
    return null;
  }
}
