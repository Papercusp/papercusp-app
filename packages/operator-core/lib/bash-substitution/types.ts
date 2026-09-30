/**
 * Types for the bash→tool substitution registry and its equivalence harness
 * (plan `bash-to-tool-substitution-2026-07-26`, P-003/P-004).
 *
 * These mirror `harness_shared.bash_tool_substitutions` (migration 665) so an
 * audit result maps onto a registry row field-for-field with no translation
 * layer to drift.
 */

/**
 * How well the proposed tool covers the real commands matching a pattern.
 * Written by the P-004 harness; enforced as a DB invariant by migration 665's
 * `tier_requires_equivalence` constraint (plan D-001).
 */
export type EquivalenceVerdict =
  /** Every sampled command has a faithful tool expression. Promotable. */
  | 'equivalent'
  /** Some sampled commands have no tool expression. Names the failures. */
  | 'needs-widening'
  /** The tool answers a different question. Never gate this pattern. */
  | 'not-a-substitute'
  /** No audit has been run yet. */
  | 'unaudited';

/**
 * Enforcement strength, reusing the three tiers the PreToolUse gate already
 * implements (plan D-003 — add no fourth mechanism).
 */
export type SubstitutionTier =
  /** Log the match; change nothing the agent sees. */
  | 'observe'
  /** Ride out as `additionalContext` on an allow — teach, never block. */
  | 'advise'
  /** Hard block. Reserved for rules that already existed independently. */
  | 'deny';

/**
 * WHICH CORPUS a pair's evidence is drawn from, and therefore what an "atom"
 * means for it (plan `sql-escape-tool-routing-2026-08-12`, P-007 / D-003).
 *
 *  - `bash` — an atom is ONE normalised shell command (`sed -n '1,80p' file`),
 *    drawn from the session transcripts and matched by a regex over its text.
 *  - `sql`  — an atom is ONE normalised query, drawn from `dev:pg_query`'s own
 *    `tool_invocations` rows and matched by the RELATION it plainly reads.
 *
 * The registry is one registry with two corpora rather than two parallel
 * auditors: census, equivalence, replay, report and the CLAUDE.md routing
 * projection are all corpus-agnostic already, and duplicating them would
 * duplicate the drift they exist to prevent.
 */
export type SubstitutionCorpus = 'bash' | 'sql';

/**
 * A measured decision that a SQL relation should remain without a routing pair.
 *
 * This lives beside the pair registry rather than in the census action so the
 * decision is reviewed, tested and projected with the same source of truth as
 * positive routing claims. The census uses the independent-agent baseline to
 * re-raise the decision only when materially new demand appears.
 */
export interface DeliberateNoPairDecision {
  /** The relation key after the census qualifier-normalisation rule. */
  relation: string;
  /** Durable plan/decision reference that records why no pair is faithful. */
  decisionRef: string;
  /** Short operator-facing explanation of the settled decision. */
  rationale: string;
  /** The measured population against which future independent-agent demand is compared. */
  baseline: {
    windowDays: number;
    calls: number;
    atoms: number;
    distinctAgents: number;
  };
  /** Absolute independent-agent count at which the decision must be re-reviewed. */
  reRaiseAtDistinctAgents?: number;
}

/** One real command atom drawn from the audit corpus — the evidence unit. */
export interface SampledCommand {
  /** Session that issued it (`su-…`) — lets a verdict be traced to source. */
  sid: string;
  /** ISO timestamp of the call. */
  ts: string;
  /** The NORMALISED atom (post-`atomize`), which is what the pattern matches. */
  atom: string;
}

/**
 * Whether the tool can answer the same question as one specific command.
 *
 * `covered` is the whole judgement; `reason` is what makes a `needs-widening`
 * verdict actionable rather than a shrug — D-001 requires the specific failing
 * cases be named, and this is where that text comes from.
 */
export interface CoverageResult {
  covered: boolean;
  /** Required when covered: the tool call that reproduces this command. */
  expression?: string;
  /** Required when NOT covered: precisely what the tool cannot express. */
  reason?: string;
}

/**
 * Everything a substitution pair carries REGARDLESS of corpus — plus the
 * CAPABILITY ENVELOPE that decides coverage. The two corpus variants below add
 * only the matcher; see {@link SubstitutionPair}.
 *
 * `cover()` is the heart of the harness. It must model what the tool can
 * ACTUALLY express — its real args and real limits, read from the tool
 * definition — not whether the tool is nominally related to the command. A
 * `cover()` that returns `{covered:true}` for everything produces an
 * `equivalent` verdict that unlocks enforcement and then blocks agents with no
 * alternative, which is the exact failure D-001 exists to prevent.
 */
interface SubstitutionPairCommon {
  /** Stable registry id, e.g. `file-read.sed-range`. */
  id: string;
  /** The intent an advisory speaks about, e.g. `file-range-read`. */
  intentLabel: string;
  /** The tool that should have served it, e.g. `capability:read`. */
  toolName: string;
  /** Shown to the agent at tier `advise`/`deny`. */
  advisoryText: string;
  /**
   * How this pair renders as a CLAUDE.md routing row (P-019).
   *
   * The generator (`npm run gen:tool-routing`) is a PURE PROJECTION of these
   * three strings — it invents no prose and makes no judgement — so the table
   * every agent reads in its prompt and the registry the PreToolUse gate
   * enforces are the same statement of intent, and `--check` fails the build
   * when the committed file drifts from the pairs. That is the whole point of
   * P-019: prose that cannot drift from the gate.
   *
   * These are DISPLAY fields and deliberately NOT derived from the fields above:
   * a `bashPattern` source is unreadable in a table cell, and `advisoryText` is
   * a full sentence written to be read inside a hook refusal. Keep each one
   * short enough to sit in a markdown table cell.
   */
  routing: {
    /** Column 1 — the question in the agent's own words ("read a line range of one file"). */
    want: string;
    /** Column 2 — the tool call form (`capability:read { file_path, offset, limit }`). */
    use: string;
    /** Column 3 — the bash form it replaces (`sed -n '1,80p' FILE`), plus any caveat. */
    insteadOf: string;
  };
  /**
   * The verdict this pair is RECORDED as carrying. The harness recomputes the
   * verdict from the sample and asserts it still equals this — so widening the
   * tool (and its envelope) without re-recording the verdict fails the test
   * instead of silently leaving a stale row. This is the anti-rot latch.
   */
  expectedVerdict: EquivalenceVerdict;
  /**
   * OPT-IN: seed this row at a tier above `observe` instead of earning one
   * through P-020's observation window.
   *
   * Every ordinary row enters at `observe` and is promoted only by evidence —
   * that staging is the whole safety story of this registry, and this field is
   * the ONE documented way past it. It exists because D-003 recognises a second,
   * narrower class: a rule that ALREADY EXISTED INDEPENDENTLY of this plan, for
   * which the registry supplies a mechanism rather than a judgement. Such a rule
   * has nothing to observe — the decision was taken elsewhere, before the
   * pattern was ever measured.
   *
   * Guarded rather than trusted: {@link assertPolicyTier} refuses any pair whose
   * `intentLabel` does not carry the `policy-violation:` prefix, mirroring
   * migration 665's `tier_requires_equivalence` CHECK so the invariant is stated
   * in the same terms on both sides of the wire. A cost argument ("the tool is
   * cheaper") must never reach `deny` this way; only a correctness rule that
   * some human already wrote down somewhere else may.
   */
  policyTier?: SubstitutionTier;
  /**
   * OPT-OUT: this pair may NEVER be promoted past `observe`, whatever its
   * verdict, until the stated condition is met. The value IS the reason, and it
   * is required — a hold with no argument is indistinguishable from an oversight.
   *
   * The mirror of {@link SubstitutionPair.policyTier}: that field admits a row
   * ABOVE the staging tier, this one pins a row TO it. Both exist for the same
   * reason — `equivalent` records that a substitution is FAITHFUL, and that is
   * simply a different claim from "the agent should be nudged to use it".
   *
   * Why it must live HERE and not in a plan decision (learned the hard way,
   * D-011 / D-042): the git-read row carried exactly this hold, written down and
   * reasoned through in a decision body — and was then swept into `advise`
   * anyway by a promotion that selected on `equivalence_verdict` alone, because
   * no code reads decision prose. That fired the registry's single largest
   * advisory (~2,500 calls/week across 77 of 86 sessions) for a benefit D-011
   * had already argued was near-zero for the superuser role. A constraint that
   * only exists in prose is a constraint that will eventually be violated by
   * someone acting in good faith on the data. So it is carried in the DATA,
   * exactly as D-039 carries the opposite authorization.
   */
  holdAtObserve?: string;
  /** Model of what the tool can express. See the warning above. */
  cover(atom: string): CoverageResult;
  /**
   * OPTIONAL (P-021) — the EXECUTABLE form of what `cover()` describes, and the
   * thing the P-021 replay harness actually runs. Return `null` for an atom this
   * pair matches but cannot rewrite exactly.
   *
   * OPTIONAL is a decision, not laziness, in both directions:
   *
   *  - Making it required would strand all eleven pair modules at once — the
   *    `lint:required-field-strands` class the repo guide warns about, in the file
   *    that would trigger it most widely.
   *  - More importantly, ABSENT must be a meaningful state. A pair with no
   *    `rewrite` cannot be replayed, so it can never reach `replay-clean`, so
   *    P-022 can never auto-substitute it. That is the correct default: a pair
   *    earns automatic rewriting by demonstrating one, and silence means no.
   *
   * A rewrite is NOT authorization to auto-substitute. It is the input to the
   * replay that decides whether auto-substitution is safe, and a pair may
   * perfectly well declare one and then be found to differ.
   */
  rewrite?(atom: string): ReplayToolCall | null;
  /**
   * OPTIONAL (P-021) — how to strip THIS tool's framing when diffing answers.
   *
   * Declared per pair rather than inferred, because inferring it means guessing
   * which lines are framing and which are content, and a wrong guess deletes the
   * evidence. Omitting it compares the tool's raw output, which is honest: a pair
   * whose tool returns no framing needs none, and one that does will simply report
   * `differs` until an envelope is written.
   */
  replayEnvelope?: AnswerEnvelope;
}

/**
 * A pair whose evidence is SHELL COMMANDS — the original and still the common
 * case. `corpus` is optional here and nowhere else, so every pair written before
 * P-007 keeps its exact declaration and the diff that introduced a second corpus
 * touched no evidence.
 */
export interface BashSubstitutionPair extends SubstitutionPairCommon {
  corpus?: 'bash';
  /** Matched against a single normalised shell atom. */
  bashPattern: RegExp;
  relation?: never;
  sqlShape?: never;
}

/**
 * A pair whose evidence is SQL — real `dev:pg_query` calls (P-007).
 *
 * WHY A RELATION RATHER THAN A REGEX. D-003 rules that the SQL atomizer must
 * reuse P-001's relation extraction rather than write a second one, and a
 * hand-written `/\bfrom\s+(?:harness_shared\.)?routines\b/i` on each pair would
 * be exactly that second extractor — twenty of them, each free to disagree with
 * the advisory the agent actually sees. So a SQL pair NAMES its relation and the
 * matcher resolves it through `plainSingleRelationRead`, the one shared answer to
 * "what does this query read".
 *
 * The ATOM is still the whole normalised query, not the relation string. That
 * distinction is load-bearing and is where this refines D-003's wording: `cover()`
 * receives the atom, and a pair must be able to judge whether the routed verb can
 * express THIS query's shape — its predicates, its ordering, its jsonb paths.
 * D-001 §3 requires precisely that judgement ("replay the corpus subset for that
 * relation and confirm the new verb covers the real shapes"), and a bare relation
 * name carries none of it: every query against a table would look identical, and
 * every verdict would be `equivalent` by construction.
 */
export interface SqlSubstitutionPair extends SubstitutionPairCommon {
  corpus: 'sql';
  /** The BARE relation this pair speaks about, e.g. `schema_migrations`. */
  relation: string;
  /**
   * OPTIONAL further narrowing on the normalised query text, for a relation whose
   * traffic splits into shapes with different answers (one verb covers the
   * migration-number lookups, another the drift check). Absent = the pair claims
   * every plain read of its relation.
   *
   * This is a NARROWING filter, never a relation test — writing the table name
   * into it would reintroduce the second extractor this design refuses.
   */
  sqlShape?: RegExp;
  bashPattern?: never;
}

/**
 * A candidate (pattern → tool) substitution from EITHER corpus.
 *
 * Discriminated on `corpus` so a corpus-blind read cannot compile: every consumer
 * that reaches for a pattern must say which corpus it means, which is what keeps
 * a SQL pair out of the shell gate and a bash pair out of the query advisory.
 */
export type SubstitutionPair = BashSubstitutionPair | SqlSubstitutionPair;

/** Which corpus this pair draws evidence from. `bash` is the default. */
export function corpusOf(pair: SubstitutionPair): SubstitutionCorpus {
  return pair.corpus ?? 'bash';
}

/** Narrow to the shell corpus. */
export function isBashPair(pair: SubstitutionPair): pair is BashSubstitutionPair {
  return corpusOf(pair) === 'bash';
}

/** Narrow to the SQL corpus. */
export function isSqlPair(pair: SubstitutionPair): pair is SqlSubstitutionPair {
  return corpusOf(pair) === 'sql';
}

/**
 * The pattern STRING a registry row / audit record stores for this pair.
 *
 * For a bash pair that is the regex source, exactly as before. For a SQL pair it
 * is a `relation:<name>` key (plus the narrowing shape when one is declared) —
 * readable, stable, and deliberately NOT a regex, because nothing may recompile
 * it and match it against a shell atom. SQL pairs are not written to
 * `harness_shared.bash_tool_substitutions` at all (see `seed.ts`); this exists so
 * an audit RECORD can name what it audited without inventing a fake pattern.
 */
export function patternSourceOf(pair: SubstitutionPair): string {
  if (isSqlPair(pair)) {
    return pair.sqlShape ? `relation:${pair.relation} shape:${pair.sqlShape.source}` : `relation:${pair.relation}`;
  }
  return pair.bashPattern.source;
}

/** The regex flags a bash pair was audited with; empty for a SQL pair. */
export function patternFlagsOf(pair: SubstitutionPair): string {
  return isSqlPair(pair) ? '' : pair.bashPattern.flags;
}

/** The prefix an `intentLabel` must carry to be allowed a {@link SubstitutionPair.policyTier}. */
export const POLICY_INTENT_PREFIX = 'policy-violation:';

/**
 * The tier a pair actually seeds at, refusing an unauthorized escalation.
 *
 * ── Why this stayed prefix-only (D-045) ──────────────────────────────────────
 * A second route was added here on 2026-08-18 — a cited `policyAuthority` over a
 * proven-`equivalent` verdict — to let an owner ruling put the file-read family
 * at `deny` without renaming its intents. The ruling was withdrawn the same hour
 * (the block was rolled back; see pairs/file-read.ts), which left that route with
 * ZERO callers, so it was removed rather than kept as speculative generality: an
 * unused way past a safety guard is a liability that reads as precedent.
 *
 * If a future rule needs it, the argument is on record in D-044 and the shape is
 * recoverable from git. Do not re-add it without a live caller.
 *
 * Note this guard is deliberately STRICTER than migration 665's
 * `tier_requires_equivalence` CHECK, which also admits any `equivalent` row. The
 * database bounds what is legal to STORE; this bounds what a pair may DECLARE,
 * and a stricter code-side policy over a permissive storage constraint is the
 * intended arrangement, not a mismatch to be "fixed".
 *
 * @throws if `policyTier` is set on a pair whose intent is not a
 *   `policy-violation:` — the check that keeps "the gate enforces policy, never
 *   invents it" (D-003) a property of the code rather than of reviewer memory.
 */
export function assertPolicyTier(pair: SubstitutionPair): SubstitutionTier {
  if (pair.policyTier === undefined) return 'observe';
  if (pair.holdAtObserve !== undefined) {
    throw new Error(
      `pair ${pair.id} sets BOTH policyTier='${pair.policyTier}' and holdAtObserve — a row cannot be ` +
        'both authorized above the staging tier and pinned to it. Drop one.',
    );
  }
  if (!pair.intentLabel.startsWith(POLICY_INTENT_PREFIX)) {
    throw new Error(
      `pair ${pair.id} sets policyTier='${pair.policyTier}' but its intentLabel ` +
        `'${pair.intentLabel}' is not a '${POLICY_INTENT_PREFIX}…'. A tier above 'observe' is ` +
        'earned by P-020 observation, or authorized by a pre-existing rule (D-003) — never asserted.',
    );
  }
  return pair.policyTier;
}

/**
 * An EXECUTABLE tool call — what a `rewrite()` produces (P-021).
 *
 * Deliberately not `CoverageResult.expression`, which is a DISPLAY string
 * (`capability:read { file_path: "x", limit: 40 } // paged at 2000 lines`) written
 * to be read inside a hook advisory. Parsing that back into arguments would make a
 * hand-formatted, comment-bearing, occasionally-concatenated string the input to
 * the machinery that decides whether a rewrite is safe to perform automatically.
 * The two are kept separate so the advisory can stay readable and the rewrite can
 * stay exact.
 */
export interface ReplayToolCall {
  toolName: string;
  args: Record<string, unknown>;
}

/**
 * How to strip a tool's FRAMING to reach the answer underneath (P-021).
 *
 * Every field is optional and every field is a strip — there is no operation here
 * that can reorder, merge, or rewrite content, and that is the design rather than
 * an omission. See `replay.ts` for why the set is closed, and
 * `assertReplayEnvelope` for the two rules the harness enforces on the patterns
 * themselves (anchored prefixes, no stateful flags).
 */
export interface AnswerEnvelope {
  /** Drop leading lines while they match — the tool's header. */
  stripLeadingLines?: RegExp;
  /** Drop a trailing block — the tool's footer/pagination notice. Anchor it with `$`. */
  stripTrailing?: RegExp;
  /** Drop a per-line prefix — the tool's line numbers. MUST be anchored at `^`. */
  stripLinePrefix?: RegExp;
}

/** A sampled command the tool could not express, with the reason why. */
export interface FailingCase {
  atom: string;
  reason: string;
  sid: string;
}

/** The audit result for one pair — maps directly onto a registry row. */
export interface PairAudit {
  pairId: string;
  intentLabel: string;
  /**
   * Which corpus this verdict was earned against (P-007).
   *
   * Carried on the RECORD rather than looked up from the pair, because a report
   * or a drift check reads audits long after the pair is out of scope — and a
   * bash verdict and a SQL verdict are not comparable quantities. Defaulted
   * nowhere: an audit that cannot say which corpus it measured is the ambiguity
   * this field exists to remove.
   */
  corpus: SubstitutionCorpus;
  /** {@link patternSourceOf} — the string the registry stores. */
  bashPattern: string;
  /**
   * `bashPattern.flags`, minus the stateful ones — the registry's companion
   * column (migration 667). Stored SEPARATELY from the source because a
   * consumer recompiling `new RegExp(source)` without them gets a DIFFERENT
   * regex from the one the verdict was earned under, which silently divorces
   * enforcement from its evidence (WI-5998).
   */
  bashPatternFlags: string;
  toolName: string;
  verdict: EquivalenceVerdict;
  /** How many real commands were tested (`sample_size`). */
  sampleSize: number;
  coveredCount: number;
  /** Deduplicated, capped — the `failing_cases` jsonb payload. */
  failingCases: FailingCase[];
  /** Distinct sessions represented in the sample. */
  sessionCount: number;
  /**
   * The highest tier this verdict permits, per D-001. `deny` is never derived:
   * it is a separate policy call reserved for rules that already exist (D-003).
   */
  maxTier: SubstitutionTier;
}
