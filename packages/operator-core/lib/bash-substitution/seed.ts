/**
 * Seed `harness_shared.bash_tool_substitutions` from the audited pairs
 * (plan `bash-to-tool-substitution-2026-07-26`, P-018).
 *
 * D-002 makes the TABLE the single source of truth that both PreToolUse hooks
 * read at runtime. But the VERDICT is not a fact a human types — it is derived
 * by the P-004 harness from frozen samples of real commands. So this seeder is
 * the one place those two meet: it recomputes every verdict from the committed
 * fixtures and upserts the result.
 *
 * (The CLAUDE.md routing generator, P-019, therefore reads `ALL_PAIRS` rather
 * than the table: the pairs are UPSTREAM of both, so generating from them keeps
 * the prose, the seeded rows and the enforcement descended from one artifact —
 * and, unlike a DB read, it works with no Postgres, so its drift check can be a
 * hard build gate instead of an advisory one. See scripts/gen-tool-routing.ts.)
 *
 * That direction matters. Rows are DERIVED, never hand-authored, so the table
 * can never drift from the evidence: widen a tool, update its envelope, re-run
 * the seed, and the row follows. A hand-edited row would be a claim with no
 * sample behind it — exactly what D-001's enforcement gate must not rest on.
 *
 * Every row enters at `tier: 'observe'` regardless of verdict. Promotion to
 * `advise` is P-020's staged decision after a real observation window, never an
 * automatic consequence of a green verdict — the DB's `tier_requires_equivalence`
 * CHECK sets the ceiling, and this seeder deliberately stays under it.
 *
 * ── Why `failing_cases` is bound as `::text::jsonb` and not `::jsonb` ────────
 * The double cast is load-bearing; do not "simplify" it. postgres-js picks a
 * parameter serializer from the INFERRED type, and the jsonb serializer differs
 * between the two clients this seeder runs under:
 *
 *   - the canonical `getOrgPg()` client has been drizzle-mutated, so its jsonb
 *     serializer is a PASSTHROUGH — a pre-stringified JSON string survives
 *     intact (and a raw array throws `Buffer.byteLength(Array)`);
 *   - a hand-rolled `postgres(url, …)` client (what the integration test's
 *     `_org-test-db` builds) keeps the stock serializer, which JSON.stringifies
 *     AGAIN — storing the jsonb SCALAR `"[{…}]"` instead of an array.
 *
 * The two are exactly inverted, so no single JS-value form is correct under
 * both. Casting through `::text` sidesteps the question: the parameter binds as
 * TEXT, no jsonb serializer is consulted on either client, and Postgres parses
 * the JSON itself. Verified against both clients (2026-07-26, P-008).
 *
 * This was invisible until P-008 because every prior pair audited `equivalent`
 * and therefore carried an EMPTY `failing_cases`, and the
 * `verdict_evidence` CHECK short-circuits on the verdict before it ever calls
 * `jsonb_array_length` — so a double-encoded `"[]"` was never inspected. The
 * first non-equivalent verdict is what made the latent bug reachable.
 */

import { getOrgPg } from '@papercusp/db-org';
import { auditPair, matchingAtoms, maxTierFor, meetsAuditFloor } from './equivalence';
import { normalizeRegistryFlags } from './match';
import { ALL_PAIRS, BASH_GATE_PAIRS } from './pairs';
import { assertPolicyTier, patternFlagsOf, patternSourceOf } from './types';
import type { CorpusFixture } from './corpus';
import type { BashSubstitutionPair, PairAudit } from './types';

type OrgSql = ReturnType<typeof getOrgPg>['sql'];

/** A pair plus the frozen sample its verdict is derived from. */
export interface PairWithFixture {
  /**
   * SHELL pairs only. This seeder writes `harness_shared.bash_tool_substitutions`,
   * which the PreToolUse hooks match against raw shell commands — a SQL pair has
   * no shell pattern to match, so it is excluded at the TYPE level rather than
   * filtered at runtime. See `BASH_GATE_PAIRS` for the full argument (P-007).
   */
  pair: BashSubstitutionPair;
  fixture: CorpusFixture;
}

export interface SeedOutcome {
  intentLabel: string;
  toolName: string;
  verdict: PairAudit['verdict'];
  sampleSize: number;
  inserted: boolean;
}

/**
 * Upsert one audited pair. Keyed on (workspace_id, intent_label) — the intent is
 * the unit an advisory speaks about, so re-seeding updates in place rather than
 * accumulating duplicate rules that would fire twice on the same command.
 *
 * `tier`, `false_positive_count`, `observed_since`, `baseline_calls` and
 * `baseline_sessions` are deliberately NOT overwritten on conflict: the first
 * three are PROMOTION state earned by an observation window (P-020), and the
 * last two are the frozen before-measurement denominators for that window.
 * Re-running the seed must not silently demote a rule that has already been
 * promoted, erase the false-positive evidence that would argue against
 * promoting it, or replace the past with a fresh measurement of the present.
 *
 * The ONE exception is a POLICY tier (`assertPolicyTier` — D-003): that tier is
 * not earned by observation, it is DECLARED by the pair because a rule already
 * existed independently. It is therefore the pair, not the database, that owns
 * it, and it IS re-asserted on conflict — otherwise a row seeded before the
 * declaration would sit at `observe` forever and the policy would be enforced
 * nowhere, which is the exact silent-staleness this file's header is about.
 * Rows without a policy tier keep the old behaviour untouched.
 */
async function upsertPair(
  sql: OrgSql,
  workspaceId: string,
  audit: PairAudit,
  pair: BashSubstitutionPair,
  fixture: CorpusFixture,
): Promise<boolean> {
  const rows = (await sql`
    INSERT INTO harness_shared.bash_tool_substitutions (
      workspace_id, intent_label, bash_pattern, bash_pattern_flags, tool_name,
      equivalence_verdict, sample_size, failing_cases, evidence_ref,
      tier, advisory_text, enabled,
      baseline_calls, baseline_sessions, observed_since
    ) VALUES (
      ${workspaceId}, ${audit.intentLabel}, ${audit.bashPattern}, ${audit.bashPatternFlags}, ${audit.toolName},
      ${audit.verdict}, ${audit.sampleSize}, ${JSON.stringify(audit.failingCases)}::text::jsonb, ${fixture.evidenceRef},
      ${assertPolicyTier(pair)}, ${pair.advisoryText}, true,
      ${fixture.totalAtoms}, ${fixture.totalSessions}, now()
    )
    ON CONFLICT (workspace_id, intent_label) DO UPDATE SET
      bash_pattern        = EXCLUDED.bash_pattern,
      bash_pattern_flags  = EXCLUDED.bash_pattern_flags,
      tool_name           = EXCLUDED.tool_name,
      equivalence_verdict = EXCLUDED.equivalence_verdict,
      sample_size         = EXCLUDED.sample_size,
      failing_cases       = EXCLUDED.failing_cases,
      evidence_ref        = EXCLUDED.evidence_ref,
      advisory_text       = EXCLUDED.advisory_text,
      -- Policy tiers are pair-owned and re-asserted (see the header); an
      -- ordinary row's tier stays exactly where its observation window left it.
      tier                = CASE WHEN ${pair.policyTier ?? null}::text IS NULL
                                 THEN bash_tool_substitutions.tier
                                 ELSE EXCLUDED.tier END,
      updated_at          = now()
    RETURNING (xmax = 0) AS inserted
  `) as unknown as Array<{ inserted: boolean }>;

  return rows[0]?.inserted ?? false;
}

/**
 * Recompute every pair's verdict from its fixture and upsert the registry.
 *
 * @throws if a pair's recorded `expectedVerdict` disagrees with what the harness
 *   computes — that mismatch means the code and the evidence have diverged, and
 *   seeding a verdict nobody re-derived is precisely the drift D-002 exists to
 *   prevent. Fix the envelope or re-record the pair; never seed past it.
 */
/** One row moved by {@link promoteEarnedRows}. */
export interface PromotionOutcome {
  intentLabel: string;
  toolName: string;
  from: string;
  to: string;
}

/**
 * Promote earned rows `observe` → `advise` (P-020).
 *
 * ── WHY THIS IS A FUNCTION AND NOT A HAND-WRITTEN UPDATE ────────────────────
 * D-002 says promotion is "a column update, so a bad rule is rolled back in
 * seconds". True, and that flexibility is the point — but it left promotion
 * with NO caller at all, exactly the hole this file's sibling CLI was written
 * to close for seeding ("a seed script with no caller is not dormant, it is
 * stale"). A promotion performed by whoever hand-writes an UPDATE that day is
 * unauditable, forgets `promoted_at`, and — the real hazard — relies on the
 * author remembering the eligibility rules. Encoding them here makes the rule
 * the code rather than the discipline.
 *
 * ELIGIBILITY, all four required:
 *  - `tier = 'observe'`      — never re-promote, never touch a policy `deny`.
 *  - `equivalence_verdict = 'equivalent'` — D-001: never enforce a pattern whose
 *    replacement is unproven. `maxTierFor()` agrees (`equivalent` → `advise` is
 *    its ceiling), and the DB's `tier_requires_equivalence` CHECK refuses the
 *    write independently, so this is the third of three guards, not the only one.
 *  - `enabled = true`        — a disabled row is not enforcement state.
 *  - `false_positive_count = 0` — P-020: "Any agent may file a false-positive
 *    against a row and that pauses its promotion." That sentence is the whole
 *    safety valve, and it is worth nothing if it lives only in prose; here a
 *    filed false positive mechanically withholds the row.
 *  - NOT held by `holdAtObserve` — a pair may pin itself to the staging tier
 *    with a stated reason (D-011's role-dependent git-read row). See below.
 *
 * It also DEMOTES a held row that is sitting above `observe`, rather than merely
 * declining to promote it. That is not tidiness: D-042 happened because a
 * verdict-only promotion swept the held git-read row into `advise`, and nothing
 * in the system would ever have pulled it back — the seeder deliberately never
 * demotes (a re-seed must not undo an earned promotion), so without this the
 * only repair path is a human noticing. A hold that self-heals is a hold; a hold
 * that needs someone to notice is a comment.
 *
 * Dry-run by default: `apply` must be passed explicitly, so the eligible set can
 * always be inspected before it is committed.
 */
export async function promoteEarnedRows(opts: {
  workspaceId: string;
  apply?: boolean;
  client?: OrgSql;
}): Promise<PromotionOutcome[]> {
  const sql = opts.client ?? getOrgPg().sql;
  const held = ALL_PAIRS.filter((p) => p.holdAtObserve !== undefined).map((p) => p.intentLabel);

  const eligible = (await sql`
    SELECT intent_label, tool_name, tier
      FROM harness_shared.bash_tool_substitutions
     WHERE workspace_id = ${opts.workspaceId}
       AND tier = 'observe'
       AND equivalence_verdict = 'equivalent'
       AND enabled = true
       AND false_positive_count = 0
       AND NOT (intent_label = ANY(${held}))
     ORDER BY intent_label
  `) as unknown as Array<{ intent_label: string; tool_name: string; tier: string }>;

  // A held row that has drifted above the staging tier — the D-042 regression.
  const drifted = (await sql`
    SELECT intent_label, tool_name, tier
      FROM harness_shared.bash_tool_substitutions
     WHERE workspace_id = ${opts.workspaceId}
       AND intent_label = ANY(${held})
       AND tier <> 'observe'
     ORDER BY intent_label
  `) as unknown as Array<{ intent_label: string; tool_name: string; tier: string }>;

  const outcomes: PromotionOutcome[] = [
    ...eligible.map((r) => ({ intentLabel: r.intent_label, toolName: r.tool_name, from: r.tier, to: 'advise' })),
    ...drifted.map((r) => ({ intentLabel: r.intent_label, toolName: r.tool_name, from: r.tier, to: 'observe' })),
  ];

  if (!opts.apply || outcomes.length === 0) return outcomes;

  if (eligible.length > 0) {
    await sql`
      UPDATE harness_shared.bash_tool_substitutions
         SET tier = 'advise', promoted_at = now(), updated_at = now()
       WHERE workspace_id = ${opts.workspaceId}
         AND tier = 'observe'
         AND equivalence_verdict = 'equivalent'
         AND enabled = true
         AND false_positive_count = 0
         AND NOT (intent_label = ANY(${held}))
    `;
  }

  if (drifted.length > 0) {
    await sql`
      UPDATE harness_shared.bash_tool_substitutions
         SET tier = 'observe', promoted_at = NULL, updated_at = now()
       WHERE workspace_id = ${opts.workspaceId}
         AND intent_label = ANY(${held})
         AND tier <> 'observe'
    `;
  }

  return outcomes;
}

export async function seedSubstitutionRegistry(opts: {
  workspaceId: string;
  fixtures: PairWithFixture[];
  client?: OrgSql;
}): Promise<SeedOutcome[]> {
  const sql = opts.client ?? getOrgPg().sql;
  const outcomes: SeedOutcome[] = [];

  for (const { pair, fixture } of opts.fixtures) {
    const audit = auditForSeed(pair, fixture);
    if (audit.verdict !== pair.expectedVerdict) {
      throw new Error(
        `[substitution-seed] pair "${pair.id}" computes "${audit.verdict}" but is recorded as ` +
          `"${pair.expectedVerdict}". The envelope and the evidence disagree — re-audit before seeding.`,
      );
    }
    const inserted = await upsertPair(sql, opts.workspaceId, audit, pair, fixture);
    outcomes.push({
      intentLabel: audit.intentLabel,
      toolName: audit.toolName,
      verdict: audit.verdict,
      sampleSize: audit.sampleSize,
      inserted,
    });
  }

  return outcomes;
}

/**
 * Produce the row for a pair whose evidence is intentionally unaudited.
 *
 * The only allowed case is a policy row: D-003 grants its `deny` tier from a
 * pre-existing rule, so the row must still be seeded even though its corpus is
 * too small to derive an equivalence verdict. Ordinary pairs continue through
 * `auditPair` and therefore still throw when they fall below the evidence floor.
 */
function auditForSeed(pair: BashSubstitutionPair, fixture: CorpusFixture): PairAudit {
  if (meetsAuditFloor(fixture.sample.length, fixture)) {
    return auditPair(pair, fixture.sample, fixture);
  }

  if (pair.expectedVerdict !== 'unaudited' || pair.policyTier === undefined) {
    // Keep the audit harness as the enforcement point for every non-policy
    // pair. Calling it here preserves its actionable floor error and prevents
    // a future pair from opting into an unaudited row accidentally.
    return auditPair(pair, fixture.sample, fixture);
  }

  const sample = matchingAtoms(pair, fixture.sample);
  return {
    pairId: pair.id,
    intentLabel: pair.intentLabel,
    corpus: 'bash',
    bashPattern: patternSourceOf(pair),
    bashPatternFlags: normalizeRegistryFlags(patternFlagsOf(pair)),
    toolName: pair.toolName,
    verdict: 'unaudited',
    sampleSize: sample.length,
    coveredCount: 0,
    failingCases: [],
    sessionCount: new Set(sample.map((entry) => entry.sid)).size,
    maxTier: maxTierFor('unaudited'),
  };
}

/**
 * The pairs this seeder knows about — re-exported so callers need one import.
 *
 * Seed FROM `BASH_GATE_PAIRS`: the registry table is the shell gate's.
 * `ALL_PAIRS` stays exported because `promoteEarnedRows` reads `holdAtObserve`
 * across every corpus.
 */
export { ALL_PAIRS, BASH_GATE_PAIRS };
