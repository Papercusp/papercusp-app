/**
 * seed-mandate-coverage — P-004 of `psu-seed-prompt-mandate-alignment-2026-08-09`.
 *
 * THE CLASS THIS KILLS. Two lists have to agree and nothing cross-checked them:
 *
 *   - the PROMPTS tell an agent which tool to use (root CLAUDE.md's bash-routing
 *     table, the two-port model, the storage-policy table, ...);
 *   - the SEED (`claudeSeedToolNames()` in `apps/operator/scripts/psu-launcher.mjs`)
 *     decides which tools are ADVERTISED to a psu Claude session.
 *
 * Claude's native ToolSearch indexes only the advertised subset, so a
 * mandated-but-unseeded tool answers "No matching deferred tools found" — which
 * reads as *this tool does not exist*, not *this tool is not advertised to you*.
 * The agent therefore does not perceive a configuration gap; it perceives a
 * missing capability, and quietly falls back to the very bash form the doc was
 * steering it away from.
 *
 * That failure was reported THREE times independently before anyone saw the
 * shared cause — EI-19500729376783421 (`capability:bash`), EI-19321552629556165
 * (`testing:run`), and the owner on 2026-08-09 (`state:read`) — because each
 * instance looks like a one-off and the cause is only visible in aggregate.
 *
 * WHAT THIS GUARD ASSERTS: every tool the routing table promotes is EITHER
 * seeded OR carries an explicit, evidence-bearing exemption below. It does not
 * demand that everything be seeded — the seed is a budget (plan D-001: cost is
 * the tools/list WIRE payload, dominated by argSchema), so blanket seeding
 * would trade one defect for a fatter one. It demands that every gap be a
 * DECISION on record rather than an accident.
 *
 * ⚠ SCOPE — read this before trusting a green. This checks the MACHINE-READABLE
 * mandate source only: the bash→tool substitution registry, which is what
 * `npm run gen:tool-routing` projects into root CLAUDE.md's routing table. Other
 * mandates are PROSE and are not covered — the compaction strategy's
 * `sessions:search`, the su persona's `mode:set`, the storage-policy table's
 * `work_items:claimable`, the two-port model's `dev:restart`. Those were seeded
 * by hand under P-002/P-003. So a green here means "no promoted ROUTING-TABLE
 * mandate is silently unreachable", NOT "no mandate anywhere is unreachable".
 * Widening the mandate source is the natural next increment; claiming this
 * already covers prose would be the same over-broad universal this plan exists
 * to stop.
 */
import type { SubstitutionPair } from '@papercusp/operator-core/lib/bash-substitution/types';

/**
 * A real MCP catalog name is `server:verb`. The registry's `toolName` field also
 * carries entries that are NOT callable MCP tools, and demanding they be seeded
 * would be incoherent:
 *   - `gitnexus.context` — a DOT-namespaced plugin tool, not in the papercusp
 *     MCP catalog, so it is not seedable through `?tools=` at all.
 *   - `npm run install:safe` — a bash command; the row's whole point is that the
 *     safe replacement is another shell command, not a tool.
 * Anchored to the PROPERTY (is this a colon-form MCP name?) rather than to a
 * blocklist of the two spellings that happen to exist today.
 */
export function isMcpToolName(name: string): boolean {
  return /^[a-z][a-z0-9_]*:[a-z][a-z0-9_-]*$/.test(name);
}

/**
 * Promoted mandates that are deliberately NOT seeded, each with the measurement
 * that justifies it. SHRINK-ONLY in spirit: an entry may be removed the moment
 * the tool is seeded, and a new one needs its own evidence line.
 *
 * Measured 2026-08-09 — `tools:invoke` fallback reaches / distinct callers over
 * 14d, and wire bytes from a real `tools/list` call. For scale: the admit
 * precedent is `search:fulltext` at 22 reaches/11 callers, and the LOWEST tool
 * admitted under P-002 was `coord:presence` at 36.0 reach/KB. Every entry here
 * scores below that floor.
 */
export const MANDATE_SEED_EXEMPT: ReadonlyMap<string, string> = new Map([
  [
    'capability:read',
    '17 reaches/5 callers, 902 B, 19.3 reach/KB. Claude sessions have a NATIVE Read tool that ' +
      'covers the same question, so the routing-table row is already satisfied without seeding. ' +
      'The low caller count (5) is the tell: agents are not blocked, they are using Read.',
  ],
  [
    'capability:git',
    '0 reaches, 547 B. Zero measured demand. The row itself says bash is not WRONG here — the ' +
      'gain is argv-safety — and native Bash git covers it.',
  ],
  [
    'logs:read',
    '53 reaches/23 callers, 2,590 B, 21.0 reach/KB. Real demand, but below the P-002 admission ' +
      'floor (36.0). The strongest candidate for the NEXT tranche if the budget allows.',
  ],
  [
    'dev:service_health',
    '23 reaches/19 callers, 1,859 B, 12.7 reach/KB. Notable BREADTH (19 callers) on low volume — ' +
      'consistent with an occasional check rather than a hot path. Revisit if volume rises.',
  ],
  [
    'dev:listening_ports',
    '9 reaches/8 callers, 924 B, 10.0 reach/KB. Below the 22/11 admit precedent.',
  ],
  // NOTE: `dev:processes` is deliberately ABSENT. It appears in the registry's
  // toolName field but the routing table never PROMOTES it, so exempting it was dead
  // weight — caught by staleExemptions() on this guard's very first run, because the
  // list above was first derived from a raw `grep toolName:` over every pair rather
  // than from the promoted set. Same "matched the spelling, not the property" error
  // this repo keeps paying for; the guard now owns that distinction so a hand-grep
  // cannot reintroduce it.
]);

/** The promoted set — exactly the rows `renderRoutingBlock` emits into CLAUDE.md. */
export function promotedMandateToolNames(pairs: readonly SubstitutionPair[]): string[] {
  const names = pairs
    .filter((p) => p.expectedVerdict === 'equivalent' || p.policyTier != null)
    .map((p) => p.toolName)
    .filter(isMcpToolName);
  return [...new Set(names)].sort();
}

export interface MandateGap {
  tool: string;
  /** Why an agent is told to reach for it — for the failure message. */
  hint: string;
}

/**
 * Promoted mandates that are neither seeded nor exempt. Empty = the invariant holds.
 */
export function seedMandateGaps(
  seed: readonly string[],
  pairs: readonly SubstitutionPair[],
): MandateGap[] {
  const advertised = new Set(seed);
  return promotedMandateToolNames(pairs)
    .filter((t) => !advertised.has(t) && !MANDATE_SEED_EXEMPT.has(t))
    .map((tool) => ({
      tool,
      hint:
        `root CLAUDE.md's generated bash-routing table tells agents to use \`${tool}\`, but a psu ` +
        `Claude session is never shown it — ToolSearch will answer "no matching deferred tools ` +
        `found", which reads as "this tool does not exist".`,
    }));
}

/** Exemptions for tools that are no longer promoted mandates — dead weight to prune. */
export function staleExemptions(pairs: readonly SubstitutionPair[]): string[] {
  const promoted = new Set(promotedMandateToolNames(pairs));
  return [...MANDATE_SEED_EXEMPT.keys()].filter((t) => !promoted.has(t)).sort();
}
