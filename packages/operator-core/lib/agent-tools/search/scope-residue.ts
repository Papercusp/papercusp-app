/**
 * The residue disclosure a ZERO-HIT prose search owes its caller.
 *
 * THE CLASS THIS CLOSES. A scoped search that finds nothing returns
 * `total_hits: 0` — a result BYTE-IDENTICAL to "this content does not exist
 * anywhere". An agent that reached for the wrong corpus reads its own miss as
 * an absence and reports it as one. This is the repo's standing "AN ABSENCE
 * CLAIM NEEDS A POSITIVE CONTROL" rule, delivered as a tool result instead of
 * left as a discipline the caller has to remember.
 *
 * It is neither hypothetical nor cheap. EI-20838436704308881 was filed as a
 * MAJOR bug against `scope:['turns']` on exactly this reading: the reporter ran
 * a positive control proving their phrase existed, got a clean zero from
 * `turns`, and concluded the scope matched nothing — proposing to alias it to
 * `session_turn` or strike it from the enum. `turns` was working correctly the
 * whole time over 25,774 live rows; the phrase simply lived in the OTHER
 * transcript corpus. Their control proved the QUERY was findable. The control
 * nobody ran was for the SCOPE — and no control anyone runs by hand is a fix
 * for the next caller.
 *
 * ⚠ WHY THIS IS DERIVED FROM THE REGISTRY, NOT A SECOND HAND-TYPED NAME. The
 * previous fix for this same class — `work_item_scope_hint` in ./fulltext
 * (EI-18685793913963409) — hard-codes ONE source name, so it protected
 * `work_item` and nothing else, and the next instance duly landed on
 * `session_turn`. A per-source fix here would guarantee a third instance on
 * whichever source is added next. So the unsearched set is computed FROM
 * `SEARCH_SOURCES` itself and cannot fall behind it.
 *
 * `SOURCE_CORPUS` is the one half that cannot be derived — it is prose a human
 * writes — so ./scope-residue.test.ts asserts it is exactly BIJECTIVE with the
 * registry. Adding a source without describing it FAILS the suite rather than
 * silently degrading to a name-only row, which is the failure mode that lets a
 * naming trap like `turns` vs `session_turn` go undocumented for months.
 */

import { SEARCH_SOURCES } from './sources';

/**
 * What each scope token actually HOLDS, in the caller's terms.
 *
 * These exist to answer one question — "is the thing I am looking for even in
 * this corpus?" — so each names the real backing population, and the two
 * confusable transcript surfaces point at each other explicitly. `turns` and
 * `session_turn` are the pair that has now cost two filings: `turns` reads as
 * the generic "search the turns" choice and is in the historic DEFAULT_SCOPE,
 * while the transcript corpus an agent almost always wants is `session_turn`.
 */
export const SOURCE_CORPUS: Readonly<Record<string, string | undefined>> = {
  escalations: 'filed escalations (harness_escalations)',
  brainstorm: 'brainstorm / ideation notes (harness_brainstorm)',
  turns:
    'the OPERATOR CHAT surface (operator_turns) — what was said in operator conversations. ' +
    "NOT agent session transcripts: those are 'session_turn'",
  decisions: 'recorded decision-ledger lines (harness_decisions)',
  work_item: 'bug / change / task issue titles + bodies (engineer_issues)',
  session_turn:
    'AGENT SESSION TRANSCRIPTS (session_turns) — what a claude/omp/codex session actually said, ' +
    "owner turns included. NOT the operator chat: that is 'turns'",
  coord_message: 'coord:* inter-agent traffic (coord_event_log)',
};

export interface ScopeResidue {
  /** Canonical source names this search actually queried. */
  searched: string[];
  /** Every registered corpus the search did NOT query, with what it holds. */
  not_searched: Array<{ scope: string; holds: string }>;
  /** The operative caveat, front-loaded. */
  caveat: string;
}

/** Every registered scope token, in registry order. */
function allSourceNames(): string[] {
  return SEARCH_SOURCES.map((s) => s.name);
}

/**
 * The residue for a search that ran over `scope`, or `null` when the search
 * covered every registered corpus (nothing was left out, so a zero there really
 * is an absence across the indexed prose and needs no caveat).
 */
export function scopeResidue(scope: readonly string[]): ScopeResidue | null {
  const names = allSourceNames();
  const searched = names.filter((n) => scope.includes(n));
  const unsearched = names.filter((n) => !scope.includes(n));
  if (unsearched.length === 0) return null;

  return {
    searched,
    not_searched: unsearched.map((name) => ({
      scope: name,
      // Unreachable while the bijection test holds; kept so a registry addition
      // degrades to a visibly-missing description rather than `undefined`.
      holds: SOURCE_CORPUS[name] ?? `(no corpus description registered for '${name}')`,
    })),
    caveat:
      `THIS ZERO IS NOT AN ABSENCE CLAIM — the search covered ${searched.length} of ` +
      `${names.length} corpora, and the ${unsearched.length} listed above were never queried. ` +
      'Content you are looking for may sit in one of them. Before reporting that something ' +
      "does not exist, re-run with scope:['all'], or with the specific corpus named above.",
  };
}
