/**
 * The CLAUDE.md routing-table projection — pure rendering, no I/O (plan
 * `bash-to-tool-substitution-2026-07-26`, P-019).
 *
 * `scripts/gen-tool-routing.ts` is the thin CLI around this: it renders the
 * expected block, compares it with the canonical `claude-md` part through
 * `set-doc-part.ts`, and lets the doc-parts projector own the client files.
 * Everything decidable without touching the filesystem lives HERE so it is
 * unit-testable and so the dependency runs `scripts/ → packages/`, never the
 * reverse (a package must not import build tooling).
 *
 * WHY A GENERATED TABLE. The audit behind this plan found the bash→tool problem
 * is routing, not capability: `dev:pg_query` was the only shell-replacing tool
 * with a CLAUDE.md routing row, and the only one with real adoption (~85% against
 * ~1%). A hand-maintained table drifts from the gate that enforces it, which is
 * worse than no table — it teaches a routing the hook does not apply, to every
 * agent, since CLAUDE.md is spliced into every agent prompt. So the table is
 * generated and CI fails on drift.
 */
import { atomHead, normalizeAtom } from './atomize';
import { LAUNCH_SITE_ADVISORY_INTENTS } from './match';
import type { BashSubstitutionPair, SampledCommand, SubstitutionPair } from './types';

export const BEGIN_MARKER = '<!-- BEGIN GENERATED gen:tool-routing — do not edit by hand -->';
export const END_MARKER = '<!-- END GENERATED gen:tool-routing -->';

/** Generated-region markers in the two zero-import PreToolUse hooks. */
export const TS_PREFILTER_BEGIN_MARKER =
  '  // BEGIN GENERATED gen:tool-routing prefilter heads — do not edit by hand';
export const TS_PREFILTER_END_MARKER = '  // END GENERATED gen:tool-routing prefilter heads';
export const SHELL_PREFILTER_BEGIN_MARKER =
  '    # BEGIN GENERATED gen:tool-routing prefilter heads — do not edit by hand';
export const SHELL_PREFILTER_END_MARKER = '    # END GENERATED gen:tool-routing prefilter heads';

/**
 * Pairs whose common command head is deliberately routed by the narrower phrase
 * prefilter instead of the head set. Listing `npm` in the head set would send
 * every npm invocation through the operator just to reach two narrow shapes.
 *
 * This declaration lives beside the generator rather than in either hook, so a
 * future phrase-routed pair adds one source declaration and the two projections
 * still follow mechanically.
 */
export const PHRASE_PREFILTER_PAIR_IDS = new Set([
  'tests.router-files',
  'deps.unsafe-install',
]);

export interface PrefilterPairFixture {
  pair: BashSubstitutionPair;
  fixture: { sample: SampledCommand[] };
}

/** Test a pair's regex without letting a stateful `g`/`y` flag leak between atoms. */
function pairMatches(pair: BashSubstitutionPair, atom: string): boolean {
  pair.bashPattern.lastIndex = 0;
  return pair.bashPattern.test(atom);
}

/**
 * Derive every command head that must clear the cheap substitution prefilter.
 *
 * Frozen pair fixtures are the evidence input already required by the registry.
 * For each matching atom, progressively remove a leading command token while the
 * SAME pair still matches. That second step is load-bearing: patterns such as
 * `(?:npx )?vitest` and `(?:npx )?tsc` admit both the wrapper and bare binary,
 * even when the frozen corpus happened to contain only the wrapped spelling.
 *
 * `not-a-substitute` pairs are never actionable and phrase-routed pairs are
 * handled by {@link PHRASE_PREFILTER_PAIR_IDS}. Every other pair must yield at
 * least one head; throwing prevents a novel pattern shape from making this
 * projection silently vacuous.
 *
 * ── WI-2145714: the LAUNCH-SITE exception, and why it belongs HERE ──────────
 * {@link LAUNCH_SITE_ADVISORY_INTENTS} rows are `not-a-substitute` too, but
 * WI-2145718 made their prose deliverable in the matcher. That fix alone
 * delivers NOTHING, because this projection sits UPSTREAM of it: the head set it
 * emits is what the hook's cheap local pre-filter tests, so a head absent here
 * means the hook short-circuits to allow() and never makes the
 * `locks:check_command` round-trip at all. The matcher is then never reached and
 * the row still cannot fire.
 *
 * MEASURED before the change (harness_shared.tool_invocations, workspace
 * papercusp-workspace, tool_name='locks:check_command', 24h to 2026-09-05,
 * commands whose FIRST atom is ps/pgrep/pidof): 10 reached the gate, and all 10
 * did so only because they ALSO contained a head already in this set (`grep`,
 * `head`) — 0 bare polls arrived. That is the whole population `process.ps-pgrep`
 * exists to advise.
 *
 * This does NOT put such a row in the CLAUDE.md routing table: that is
 * {@link renderRoutingBlock}, which emits `equivalent`/`policyTier` pairs only,
 * and a launch-site advisory is precisely NOT a "use tool X instead of bash Y"
 * row — its verdict is right, and its advice is about a DIFFERENT command one
 * step earlier. Delivery and routing are separate questions; only delivery
 * changes here.
 *
 * COST, stated because it lands on a hot path: every bare `ps`/`pgrep` now pays
 * the operator round-trip this pre-filter exists to avoid. D-069 measured 3,993
 * polling commands/7d (~570/day) against ~10,537 check_command calls/24h — about
 * +5% on that path, which is the price of the row working at all.
 */
export function deriveSubstitutionPrefilterHeads(entries: PrefilterPairFixture[]): string[] {
  const heads = new Set<string>();

  for (const { pair, fixture } of entries) {
    const launchSiteAdvisory = LAUNCH_SITE_ADVISORY_INTENTS.has(pair.intentLabel);
    if (
      (pair.expectedVerdict === 'not-a-substitute' && !launchSiteAdvisory) ||
      PHRASE_PREFILTER_PAIR_IDS.has(pair.id)
    ) {
      continue;
    }

    const pairHeads = new Set<string>();
    for (const sample of fixture.sample) {
      let candidate = normalizeAtom(sample.atom);
      while (candidate) {
        if (pairMatches(pair, candidate)) {
          const head = atomHead(candidate);
          if (head) pairHeads.add(head);
        }
        const suffix = candidate.replace(/^\S+\s+/, '');
        if (suffix === candidate) break;
        candidate = suffix;
      }
    }

    if (pairHeads.size === 0) {
      throw new Error(
        `gen-tool-routing: ${pair.id} produced no prefilter head from its frozen fixture. ` +
          'Add representative evidence or declare it phrase-routed.',
      );
    }
    for (const head of pairHeads) heads.add(head);
  }

  return [...heads].sort();
}

/** Render the generated TypeScript `Set` body, markers included. */
export function renderTsPrefilterHeads(heads: readonly string[]): string {
  return [
    TS_PREFILTER_BEGIN_MARKER,
    ...[...heads].sort().map((head) => `  '${head}',`),
    TS_PREFILTER_END_MARKER,
  ].join('\n');
}

/** Render the generated Python `frozenset` body, markers included. */
export function renderShellPrefilterHeads(heads: readonly string[]): string {
  return [
    SHELL_PREFILTER_BEGIN_MARKER,
    ...[...heads].sort().map((head) => `    '${head}',`),
    SHELL_PREFILTER_END_MARKER,
  ].join('\n');
}

/**
 * Replace one generated region, refusing missing/inverted markers instead of
 * reporting a vacuous green or appending a second block.
 */
export function spliceGeneratedRegion(
  content: string,
  beginMarker: string,
  endMarker: string,
  block: string,
  label: string,
): string {
  const start = content.indexOf(beginMarker);
  const end = content.indexOf(endMarker);
  if (start === -1 || end === -1) {
    throw new Error(`gen-tool-routing: ${label} generated markers not found`);
  }
  if (end < start) {
    throw new Error(`gen-tool-routing: ${label} END marker precedes BEGIN marker`);
  }
  return content.slice(0, start) + block + content.slice(end + endMarker.length);
}

/**
 * A table-cell-safe rendering. Escapes ONLY the pipe — deliberately NOT the
 * backslash, unlike `scripts/lib/doc-projection.ts`'s `cell()`.
 *
 * That difference is load-bearing, not an oversight. These cells are mostly code
 * spans, and markdown does not process backslash escapes inside a code span: an
 * escaped `\\d` renders LITERALLY as `\\d`, so the psql-describe row would
 * advertise a command that does not exist. A pipe still must be escaped, and GFM
 * honours `\|` in a table cell even inside a code span, because cell splitting
 * happens before inline parsing.
 */
export function routingCell(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
}

/**
 * Render the generated block: the marker pair, a do-not-edit warning, and one row
 * per pair in the given order (`ALL_PAIRS` is registry order), so the output is a
 * pure function of the pairs and cannot reorder between runs.
 *
 * Only `equivalent` pairs are emitted. A `needs-widening` / `not-a-substitute` /
 * `unaudited` verdict must never appear as routing advice — D-001's point is that
 * a pattern whose replacement is unproven is not enforced, and advertising it in
 * every agent's prompt would be the same harm one layer up: it would send agents
 * to a tool that cannot do the job.
 *
 * ...with ONE exception, which is the mirror of that same principle: a pair
 * carrying a `policyTier` is ENFORCED, on authority granted elsewhere (D-003 —
 * a rule that already existed independently of this plan), not on a verdict
 * derived here. Filtering such a row out would leave agents blocked by a gate
 * with no documentation of what to do instead, which is a worse failure than the
 * one this filter prevents. The rule is real whether or not the corpus happens to
 * contain enough of it to audit.
 *
 * That case stopped being hypothetical at P-002: correcting the atomizer (D-047)
 * dropped `deps.unsafe-install`'s population from 28 atoms to 18 — below the
 * census floor — so its verdict became `unaudited` while its `deny` tier stood
 * untouched.
 *
 * `tier` is deliberately absent. It is promotion state (observe → advise → deny)
 * earned by P-020's observation window and lives only in the database. The table
 * states what the right tool IS — stable guidance; how hard the gate currently
 * enforces it is a separate, changing concern, and a doc that churned on every
 * promotion would be noise in every agent's prompt.
 */
export function renderRoutingBlock(pairs: SubstitutionPair[]): string {
  const rows = pairs
    .filter((p) => p.expectedVerdict === 'equivalent' || p.policyTier != null)
    .map(
      (p) =>
        `| ${routingCell(p.routing.want)} | ${routingCell(p.routing.use)} | ${routingCell(
          p.routing.insteadOf,
        )} |`,
    );

  return [
    BEGIN_MARKER,
    '',
    '> Generated — do not hand-edit: the source is `pairs/*.ts` + `npm run gen:tool-routing`,',
    '> and `gen:tool-routing:check` fails the build on drift. Adding a row, promoting one, or',
    '> arguing with a gate that blocked you:',
    '> [bash vs tool routing](/internal/docs/agent-insights/bash-vs-tool-routing).',
    '>',
    '> ⚠ ToolSearch finding NOTHING for a `use` tool does not mean it is unavailable to you — a',
    '> trimmed surface (su) exposes only a seed of the ~550-tool catalog, so `select:` and a',
    '> keyword search can both come back empty for a tool that exists. `tools:invoke { name:',
    '> "<server:verb>", args: {…} }` dispatches ANY catalog tool server-side, gated identically',
    '> to a direct call (verified for `testing:run`) — reach for that before falling back to the',
    '> `not` column.',
    '',
    '| you want | use | not |',
    '|---|---|---|',
    ...rows,
    '',
    END_MARKER,
  ].join('\n');
}

/**
 * Splice the rendered block between the markers in `content`.
 *
 * Throws rather than no-oping when the markers are missing: a generator that
 * silently wrote nothing would report success while the table went stale forever,
 * which is precisely the drift this projection exists to prevent.
 */
export function spliceRoutingBlock(content: string, block: string): string {
  const start = content.indexOf(BEGIN_MARKER);
  const end = content.indexOf(END_MARKER);
  if (start === -1 || end === -1) {
    throw new Error(
      `gen-tool-routing: markers not found in CLAUDE.md. Expected:\n  ${BEGIN_MARKER}\n  ${END_MARKER}`,
    );
  }
  if (end < start) {
    throw new Error('gen-tool-routing: END marker precedes BEGIN marker in CLAUDE.md');
  }
  return content.slice(0, start) + block + content.slice(end + END_MARKER.length);
}

/* ── The THIRD routing surface: CLAUDE.md's hand-written storage-policy table ──
 *
 * WI-38337 / D-010. An agent reads three surfaces that each name a verb for a
 * relation: the live in-query advisory (`TOOL_ROUTING_BY_TABLE`), the GENERATED
 * block above, and a HAND-WRITTEN table under "## Storage policy". Only the first
 * two were machine-checked against the audited pairs, so a hand-written row could
 * say "use `issues:list` for work_items" while an audited pair routes the same
 * relation to `work_items:list`, and the whole suite would stay green. The two
 * tables are read by the same agent minutes apart.
 *
 * WHY PARSE INSTEAD OF GENERATE (D-010). The hand-written table is INTENT-level
 * guidance and legitimately names verbs no audited pair claims (`plans:items`,
 * `search:semantic`, `gitnexus.query`); the generated one is COMMAND-level
 * substitution earned at 100% coverage. Folding either into the other would
 * delete honest guidance or manufacture pairs to justify prose. They may differ
 * in COVERAGE — they must never CONTRADICT, and only the second is checkable.
 *
 * WHY A HEADING ANCHOR AND NOT MARKERS. The obvious fix is to wrap the region in
 * BEGIN/END markers like the generated block. It is not available: CLAUDE.md is
 * itself PROJECTED from `harness_shared.harness_doc_parts`, so markers would have
 * to be added to the part in Postgres, and a hand-edit of the file is exactly what
 * that projection exists to refuse. Anchoring on the heading needs no write at
 * all — at the cost that a reworded heading silently un-anchors the parser, which
 * is why both failure modes below THROW rather than return an empty list.
 */

/** The heading the hand-written routing table lives under. */
export const STORAGE_POLICY_HEADING = '## Storage policy: Postgres by default';

/** One parsed row of the hand-written table. */
export interface HandWrittenRoutingRow {
  /** The intent cell — what the agent wants. */
  want: string;
  /** The recommendation cell. */
  use: string;
  /** The cell naming the shape being replaced. */
  not: string;
  /** `server:verb` tokens named in {@link use}. */
  verbs: string[];
  /** Known relation names appearing in {@link not}, word-boundary matched. */
  relations: string[];
}

/**
 * Verbs that answer from a DIFFERENT PLANE than a direct relation read, and so
 * cannot contradict a pair that routes reads OF that relation.
 *
 * WI-1812795. The agreement rule one level up joins a hand-written row to an
 * audited pair whenever the row's `not` cell NAMES a relation the pair covers,
 * then demands the row's verb be one of the pair's. That is right for two rows
 * answering the SAME question, and wrong the moment two DIFFERENT questions read
 * one table — which is not hypothetical:
 *
 *   row  "how many tests fail on the FROZEN CANDIDATE we are promoting"
 *        -> state:read { cell:'gate.greenCheckpoint.candidateFailures' }
 *   pair "a test file's run history / which tests are failing"
 *        -> testing:runs
 *
 * Both are correct for their own question, and — the part that matters — both
 * say the SAME thing about the relation: do not hand-write `test_runs` SQL. Read
 * as a contradiction, that pairing kept the guard red on every recorded run for
 * 4.5h+, which is strictly worse than no guard: a check that cries wolf on a
 * correct row trains its readers to discount the next genuine contradiction.
 *
 * `state:read` never reads a relation. It reads a REGISTERED CELL computed by a
 * resolver, so a row recommending it is not offering a competing way to read the
 * table; it is saying "do not read the table at all — read the cell." Excluding
 * it narrows the join to verbs that genuinely compete, and leaves every other
 * disagreement firing exactly as before.
 *
 * ⚠ KEEP THIS LIST TINY, AND EARN EACH ENTRY. It is not an allowlist for rows
 * that fail the check — it is a statement that a verb reads from somewhere else
 * entirely. A verb that DOES read the relation must never be added here: that
 * would silence the guard rather than sharpen it. The narrowness is pinned by a
 * CONTROL in routing-table.test.ts (a row naming one of these verbs ALONGSIDE a
 * competing relation verb still contradicts).
 *
 * This is the same family as the `work_items_claimable` word-boundary subtlety
 * documented on the parser below: a relation MENTIONED by a row is not the same
 * as a relation the row claims to be the general replacement for reading.
 */
export const NON_RELATION_READ_VERBS: readonly string[] = ['state:read'];

/**
 * The subset of a row's verbs that actually COMPETE to read the relation — i.e.
 * the ones the agreement rule may legitimately score. An empty result means the
 * row routes nothing that reads this relation, which is not a contradiction.
 */
export function relationRoutingVerbs(row: HandWrittenRoutingRow): string[] {
  return row.verbs.filter((v) => !NON_RELATION_READ_VERBS.includes(v));
}

/** Split one markdown table row into cells, honouring `\|` inside a cell. */
function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.replace(/\\\|/g, '|').trim());
}

/**
 * Parse the hand-written storage-policy routing table.
 *
 * `knownRelations` is matched with a WORD BOUNDARY on purpose, and it is the one
 * subtlety here: the table's claimable row names the VIEW `work_items_claimable`,
 * and a substring match would read that as the `work_items` relation and then
 * report a contradiction because the row routes to `work_items:claimable` rather
 * than to a pair's verb. `\b` does not match between `work_items` and `_claimable`
 * (both sides are word characters), so the view stays a distinct relation.
 *
 * THROWS on a missing heading or a heading with no table rows. Returning `[]`
 * would make every downstream assertion pass vacuously — the failure mode this
 * whole guard exists to end, one level up.
 */
export function parseStoragePolicyRoutingTable(
  doc: string,
  knownRelations: readonly string[],
): HandWrittenRoutingRow[] {
  const start = doc.indexOf(STORAGE_POLICY_HEADING);
  if (start === -1) {
    throw new Error(
      `routing-table: "${STORAGE_POLICY_HEADING}" not found in CLAUDE.md — the hand-written ` +
        'routing table is anchored on that heading; if it was reworded, update STORAGE_POLICY_HEADING.',
    );
  }
  const rest = doc.slice(start + STORAGE_POLICY_HEADING.length);
  const nextHeading = rest.search(/\n##\s/);
  const region = nextHeading === -1 ? rest : rest.slice(0, nextHeading);

  const rows: HandWrittenRoutingRow[] = [];
  for (const line of region.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = tableCells(trimmed);
    if (cells.length < 3) continue;
    // The header row and the `|---|` separator are structure, not data.
    if (/^-{2,}$/.test(cells[0]!.replace(/[:\s]/g, ''))) continue;
    if (cells[0]!.toLowerCase() === 'you want') continue;
    const [want, use, not] = cells as [string, string, string];
    rows.push({
      want,
      use,
      not,
      verbs: [...use.matchAll(/\b([a-z][\w-]*:[a-z][\w-]*)\b/g)].map((m) => m[1]!),
      relations: knownRelations.filter((r) =>
        new RegExp(String.raw`\b${r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\b`).test(not),
      ),
    });
  }

  if (rows.length === 0) {
    throw new Error(
      `routing-table: found "${STORAGE_POLICY_HEADING}" but no table rows under it — the parser ` +
        'is anchored but blind, which would make every routing-agreement assertion pass vacuously.',
    );
  }
  return rows;
}
