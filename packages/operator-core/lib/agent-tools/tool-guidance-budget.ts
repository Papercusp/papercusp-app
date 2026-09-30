/**
 * tool-guidance-budget — the per-tool prompt-weight budget (P-011), as a
 * PRODUCTION-SAFE module (no vitest import), so BOTH the gate test AND the live
 * operator's boot/hot-reload self-check share ONE source of truth for the
 * numbers, the weight formula, and the self-serve "how much to trim" message.
 *
 * WHY a live self-check exists (EI-10966): the ratchet's only reliable
 * enforcement point used to be the green checkpoint — a gate that blocks
 * deploys for the WHOLE fleet. So one agent EDITING a tool's guidance over
 * budget (never "adding a tool", so the CLAUDE.md quick-check never runs)
 * froze hive-wide deploys until someone triaged a stale gate log. Every
 * prompt-weight breach on record was an edit, not an add (verified over the
 * whole 655-tool catalog: only 3 tools were ever born over budget, all long
 * grandfathered/removed). The fix moves the signal to where the edit happens:
 * `tool-weight-selfcheck.ts` calls this at catalog-registration time, which the
 * live operator re-runs on every hot-reload — so an over-budget edit surfaces
 * in the operator's own logs the moment the file is saved, not at the gate.
 *
 * A STATIC (source-text) read cannot be TRUSTED for this job: a tool may build
 * its description/guidance non-literally (concatenating a shared constant, a
 * helper call, or per-role blocks), and a source scan then under-counts exactly
 * the tools nearest the ceiling. Only the RUNTIME-projected catalog
 * (listAllProjectedTools, after the agent-tools barrel has registered) is
 * ground truth — which is precisely what registration-time has and a file
 * scanner does not.
 *
 * ⚠ This paragraph used to cite "12 fleet:* tools compose their guidance from a
 * shared `ROUTING_LADDER` constant (+368 chars each)" as the worked example.
 * That constant NO LONGER EXISTS anywhere in the repo (2026-08-02: the only
 * remaining occurrence of the identifier was this comment). The stale example
 * actively misleads: chasing a ~+368/tool hidden surcharge makes a CORRECT
 * static measurement look wrong, which is how an agent triaging a breach ends
 * up trimming a tool that already fits. Measured that day, fleet:leader-brief
 * projected at runtime to exactly its static weight (1503, byRole: []).
 * The RULE above still stands — verify with the runtime catalog, not a grep —
 * but do NOT expect a fixed hidden surcharge; measure the tool in question.
 *
 *   - BUDGET (1,500 chars, description + all guidance fields): every tool must
 *     fit unless grandfathered in ALLOW_OVER_BUDGET.
 *   - HARD CAP (1,600 chars): nothing may exceed it, grandfathered or not.
 */
import { listAllProjectedTools, type ProjectedTool } from '@papercusp/tooldef';

// Raised 1200 → 1500 by owner decision (2026-06-14): a uniform budget is blunt — a
// load-bearing multi-mode coordination primitive legitimately earns more guidance than a
// trivial tool. HARD_CAP unchanged, so the soft-ratchet / hard-cap two-tier is preserved.
export const BUDGET = 1500;
export const HARD_CAP = 1600;

/**
 * Floor for a genuinely-registered live catalog (EI-19377066316560032). ~655
 * tools are live today; a barrel that only partially registered yields ~40 —
 * this sits well above that and well below the real count, mirroring the
 * `named.length > 500` floor the vitest gate suite already asserts
 * (tool-guidance-budget.shared.ts). `listAllProjectedTools()` returns `[]`
 * when called before the agent-tools barrel has side-effect-imported (e.g. a
 * standalone `npx tsx -e "...listAllProjectedTools()..."` probe run outside
 * the vitest bootstrap) — with NO error, so `budgetViolations()` over an empty
 * catalog silently reports "0 violations", indistinguishable from a genuinely
 * clean 655-tool catalog. This floor turns that vacuous green into a loud
 * throw at the one production call site (`namedToolWeights()` reading the
 * live registry) instead of leaving the gate suite's floor as the only guard.
 */
export const MIN_PLAUSIBLE_CATALOG_SIZE = 500;

/** Grandfathered over-budget tools. Shrink-only: an entry here still must stay
 *  ≤ HARD_CAP and may be removed the moment the tool fits the budget. Currently
 *  EMPTY — a clean ratchet worth defending. */
export const ALLOW_OVER_BUDGET = new Set<string>([]);

type GuidanceShape = ProjectedTool['guidance'];

/** The per-field split of a tool's prompt weight, so a trimmer sees WHICH field
 *  is heavy instead of only that the total is too big (EI-19418721410168539).
 *  `seeAlso` is deliberately ABSENT: it is not summed into the weight, and
 *  adding it here would make a correct green read as a breach. */
export interface PromptWeightBreakdown {
  description: number;
  when: number;
  notWhen: number;
  chaining: number;
  /** when+notWhen+chaining summed across EVERY role — one aggregated line. */
  byRole: number;
  /** The weight itself: exactly the sum of the fields above. */
  total: number;
}

/** description + every guidance field (incl. per-role) — the exact string weight
 *  a tool contributes to the assembled system prompt, split per field.
 *
 *  This is the ONE place the summed field list lives; `promptWeight()` returns
 *  `.total` rather than re-adding them, so the scalar and the breakdown cannot
 *  drift apart into a second copy of the formula. */
export function promptWeightBreakdown(tool: {
  description?: string;
  guidance?: GuidanceShape;
}): PromptWeightBreakdown {
  const g = tool.guidance ?? {};
  const byRole = Object.values(g.byRole ?? {}).reduce(
    (acc, r) => acc + (r.when?.length ?? 0) + (r.notWhen?.length ?? 0) + (r.chaining?.length ?? 0),
    0,
  );
  const description = tool.description?.length ?? 0;
  const when = g.when?.length ?? 0;
  const notWhen = g.notWhen?.length ?? 0;
  const chaining = g.chaining?.length ?? 0;
  return {
    description,
    when,
    notWhen,
    chaining,
    byRole,
    total: description + when + notWhen + chaining + byRole,
  };
}

/** description + every guidance field (incl. per-role) — the exact string weight
 *  a tool contributes to the assembled system prompt. Derived from
 *  `promptWeightBreakdown()` so the two can never disagree. */
export function promptWeight(tool: { description?: string; guidance?: GuidanceShape }): number {
  return promptWeightBreakdown(tool).total;
}

/**
 * Runtime tool calls carry each selected tool's JSON Schema separately from
 * the description/guidance text measured above. Keep this accounting separate:
 * promptWeight() describes the assembled prompt catalog, while this metric
 * describes the schema payload a selected tool load adds to the model context.
 *
 * This is intentionally a byte count of JSON.stringify(inputSchema), encoded
 * as UTF-8. String.length would count UTF-16 code units and under-count schemas
 * containing non-ASCII descriptions (the wire payload is UTF-8).
 */
export const MAX_SELECTED_INPUT_SCHEMA_BYTES = 128_000;

const UTF8_ENCODER = new TextEncoder();

export interface SelectedInputSchemaTool {
  name: string;
  inputSchema?: unknown;
}

export interface InputSchemaCost {
  name: string;
  bytes: number;
}

export interface SelectedInputSchemaBudget {
  budgetBytes: number;
  totalBytes: number;
  remainingBytes: number;
  overBudget: boolean;
  entries: InputSchemaCost[];
}

/** Count the exact UTF-8 bytes in a projected tool's serialized input schema. */
export function serializedInputSchemaBytes(inputSchema: unknown): number {
  const serialized = JSON.stringify(inputSchema);
  return serialized === undefined ? 0 : UTF8_ENCODER.encode(serialized).byteLength;
}

/** The same schema with every `description` string removed — its structural remainder. */
function stripSchemaDescriptions(node: unknown): unknown {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(stripSchemaDescriptions);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'description' && typeof value === 'string') continue;
    out[key] = stripSchemaDescriptions(value);
  }
  return out;
}

/**
 * How many of a schema's bytes are DESCRIPTION PROSE — the half a `.describe()` edit can
 * actually reach (EI-23379068490085254).
 *
 * `serializedInputSchemaBytes()` above says HOW MUCH a tool costs; it cannot say WHICH
 * lever moves it, which is what made schema trims guesswork in exactly the way
 * `promptWeightBreakdown()` was added to fix for the prompt-weight tier. Measured across
 * the live catalog 2026-09-16: 697,522 B of prose in 1,214,058 B of argSchema (57.5%,
 * 889 tools) — and the distribution is what matters, because the outliers are the tools
 * an author is most likely to be editing (coord:send 80%, facts:assert 84%). A tool that
 * is 84% prose does not need a schema redesign; it needs its `.describe()` strings cut,
 * and that is a five-minute edit an author will make only if they can SEE it.
 *
 * This is the DELTA — total minus the structural remainder — not the sum of the raw
 * description strings, so it charges prose for its `"description":` key, quotes, comma and
 * JSON escaping too, and `prose + structural === total` exactly. That is what makes it
 * read ~6 points above the raw-string share quoted in EI-23379068490085254's body and in
 * `.papercusp/scratch/whale-composition.mts` (51.5% catalog-wide, coord:send 77%); both
 * are honest, but only this one answers "how many bytes would deleting the prose give me
 * back". Do not compare a number from one method against a pin or a figure from the other.
 */
export function serializedInputSchemaProseBytes(inputSchema: unknown): number {
  const total = serializedInputSchemaBytes(inputSchema);
  if (total === 0) return 0;
  return total - serializedInputSchemaBytes(stripSchemaDescriptions(inputSchema));
}

/**
 * Prose share at or above which `tool-weight` calls a schema PROSE-HEAVY.
 *
 * The catalog-wide share is 57.5%, so most of a schema being prose is NORMAL and flagging
 * it would be noise. This is set above the bulk of the distribution so it names
 * the tools where prose is not merely present but is essentially the whole bill — the
 * ones where "trim `.describe()`" is the complete answer. It is advisory only: nothing
 * fails on it, because a high share is not itself a defect (a small, well-documented
 * schema is exactly what good guidance looks like). `tool-weight` therefore only raises
 * it for a tool that is ALSO over SCHEMA_BYTE_BUDGET, i.e. one the ratchet already
 * governs and whose author is already being asked to cut something.
 *
 * Census at this value (2026-09-16, 889 exposed tools): 20 tools over the budget, 9 of
 * them flagged. It therefore SPLITS the heavy population rather than firing on all of it
 * or none — the two ways a threshold like this becomes furniture. The nine are
 * work_items:list 86%, fleet:launch-on-plan 84%, facts:assert 84%, coord:send 80%,
 * loop:arm 79%, capability:launch-agent 79%, work_items:checkpoint 76%, plans:set-status
 * 76%, loop:checkpoint 74%; the loudest correct SILENCE is scorecards:emit at 41% and
 * work_items:complete at 51% — both heavy, neither reachable by trimming prose. Re-run
 * the census before moving this number: `npm run tool-weight -- --json --all`.
 */
export const SCHEMA_PROSE_SHARE_ALERT = 0.7;

/** Calculate the aggregate schema load for one selected tool set. */
export function selectedInputSchemaBudget(
  tools: readonly SelectedInputSchemaTool[],
  budgetBytes = MAX_SELECTED_INPUT_SCHEMA_BYTES,
): SelectedInputSchemaBudget {
  const entries = tools.map(({ name, inputSchema }) => ({
    name,
    bytes: serializedInputSchemaBytes(inputSchema),
  }));
  const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  return {
    budgetBytes,
    totalBytes,
    remainingBytes: budgetBytes - totalBytes,
    overBudget: totalBytes > budgetBytes,
    entries,
  };
}

export interface SelectedInputSchemaBudgetOptions {
  budgetBytes?: number;
  label?: string;
}

/**
 * Fail closed before a selected schema set is mounted when its aggregate load
 * would exceed the runtime budget. The report is returned for callers that
 * want to emit telemetry or diagnostics on a successful check.
 */
export function assertSelectedInputSchemaBudget(
  tools: readonly SelectedInputSchemaTool[],
  options: SelectedInputSchemaBudgetOptions = {},
): SelectedInputSchemaBudget {
  const report = selectedInputSchemaBudget(tools, options.budgetBytes);
  if (!report.overBudget) return report;

  const label = options.label ?? 'selected tool set';
  const largest = [...report.entries]
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 3)
    .map((entry) => `${entry.name}=${entry.bytes}`)
    .join(', ');
  throw new Error(
    `${label} input schemas use ${report.totalBytes} UTF-8 bytes, exceeding the ` +
      `${report.budgetBytes}-byte aggregate budget; largest schemas: ${largest}`,
  );
}

export interface NamedToolWeight {
  name: string;
  weight: number;
  /** Per-field split of `weight`. Optional so every existing producer of a
   *  `{ name, weight }` literal (tests, fixtures) keeps compiling. */
  breakdown?: PromptWeightBreakdown;
  /** UTF-8 bytes of this tool's serialized argSchema — the OTHER half of its context
   *  cost, and typically the larger one (catalog median: 618 B of schema against a
   *  1,500-char prompt-weight budget; the heaviest tool carries 43 KB). Optional for
   *  the same reason as `breakdown`: a fixture may supply bare `{ name, weight }`. */
  schemaBytes?: number;
  /** Of `schemaBytes`, how many are `.describe()` prose — WHICH lever moves this tool's
   *  schema, the schema-tier counterpart to `breakdown` (EI-23379068490085254). Optional
   *  for the same reason, and always present when `schemaBytes` is. */
  schemaProseBytes?: number;
}

/**
 * Guards the LIVE-registry read only (never an explicitly-passed fixture
 * catalog — a unit test legitimately hands in a handful of synthetic tools).
 * Throws instead of letting a caller silently measure zero tools and read
 * "over-budget: NONE" as a real, clean verdict.
 */
function assertLiveCatalogSane(tools: readonly ProjectedTool[]): void {
  if (tools.length >= MIN_PLAUSIBLE_CATALOG_SIZE) return;
  throw new Error(
    `tool-guidance-budget: listAllProjectedTools() returned only ${tools.length} tool(s) — ` +
      `far below the ${MIN_PLAUSIBLE_CATALOG_SIZE}-tool floor for a genuinely-registered live catalog. ` +
      `This means the agent-tools barrel never registered (most likely: this ran standalone — e.g. a bare ` +
      `\`npx tsx -e "...listAllProjectedTools()..."\` script — outside the vitest bootstrap, which side-effect-` +
      `imports '../agent-tools/index' first), NOT that the catalog is genuinely empty. Run the focused ` +
      `suites with \`npm run test:file -- packages/operator-core/lib/__tests__/tool-guidance-budget.test.ts ` +
      `packages/operator-core/lib/agent-tools/tool-guidance-budget-live-guard.test.ts\` instead of measuring ` +
      `standalone, or ` +
      `side-effect-import '../agent-tools/index' before calling this. (EI-19377066316560032)`,
  );
}

/** The real projected catalog, one { name, weight } per MCP-exposed tool. Pass a
 *  catalog to measure (tests); omit to read the live registry — reading the
 *  live registry asserts it looks genuinely registered (see
 *  assertLiveCatalogSane) rather than silently measuring an empty/partial one. */
export function namedToolWeights(catalog?: readonly ProjectedTool[]): NamedToolWeight[] {
  const tools = catalog ?? listAllProjectedTools();
  if (catalog === undefined) assertLiveCatalogSane(tools);
  return tools
    .map((t) => {
      const breakdown = promptWeightBreakdown(t);
      return {
        name: t.expose?.mcp?.name ?? '(unexposed)',
        weight: breakdown.total,
        breakdown,
        schemaBytes: serializedInputSchemaBytes(t.inputSchema),
        schemaProseBytes: serializedInputSchemaProseBytes(t.inputSchema),
      };
    })
    .filter((t) => t.name !== '(unexposed)');
}

export interface BudgetViolation {
  name: string;
  weight: number;
  /** true iff over the HARD CAP (the absolute bound, grandfathered or not). */
  hardCap: boolean;
  /** true iff this tool is grandfathered in ALLOW_OVER_BUDGET. */
  grandfathered: boolean;
  /** chars to cut to clear the effective binding ceiling. */
  cutAtLeast: number;
}

/**
 * The ceiling a fixer must reach depends on the exemption: an ordinary tool
 * must fit the soft budget, while a grandfathered tool may use the hard cap.
 * Keep the hard cap as the upper bound even if the soft budget is configured
 * above it in the future.
 */
function bindingCeiling(grandfathered: boolean): number {
  return grandfathered ? HARD_CAP : Math.min(BUDGET, HARD_CAP);
}

/**
 * Every tool that would RED the gate: a non-grandfathered tool over BUDGET, or
 * ANY tool over HARD_CAP. Mirrors the two-tier gate test exactly, so the live
 * self-check and the gate agree on what counts as a breach.
 */
export function budgetViolations(weights?: readonly NamedToolWeight[]): BudgetViolation[] {
  const named = weights ?? namedToolWeights();
  const out: BudgetViolation[] = [];
  for (const t of named) {
    const hardCap = t.weight > HARD_CAP;
    const grandfathered = ALLOW_OVER_BUDGET.has(t.name);
    const overBudget = t.weight > BUDGET && !grandfathered;
    if (!hardCap && !overBudget) continue;
    out.push({
      name: t.name,
      weight: t.weight,
      hardCap,
      grandfathered,
      cutAtLeast: t.weight - bindingCeiling(grandfathered),
    });
  }
  return out.sort((a, b) => b.weight - a.weight);
}

/** Self-serve failure text: the tool, its weight, and exactly how many chars to
 *  cut — so a fixer never has to reverse-engineer the number (EI-10966 #2). */
export function formatViolations(violations: readonly BudgetViolation[]): string {
  if (violations.length === 0) return '';
  const lines = violations.map((v) => {
    const ceiling = bindingCeiling(v.grandfathered);
    const hardCapBinding = ceiling === HARD_CAP;
    const limit = hardCapBinding ? `${HARD_CAP}-char HARD CAP` : `${BUDGET}-char budget`;
    const tail = hardCapBinding
      ? ''
      : ' (trim it — prefer a docs pointer over prose-in-place — or, only if genuinely irreducible, add an ALLOW_OVER_BUDGET entry)';
    return `  • ${v.name} is ${v.weight} — cut ≥${v.cutAtLeast} to clear the ${limit}${tail}`;
  });
  return lines.join('\n');
}

/* ------------------------------------------------------------------------- *
 * PER-TOOL argSchema WIRE BUDGET (EI-23345472964244980)
 * ------------------------------------------------------------------------- */

/**
 * The OTHER half of a tool's context cost, and until now the ungoverned one.
 *
 * `promptWeight()` above governs description + guidance (1,500 chars). That is the
 * assembled-prompt half. It does not look at `inputSchema` at all — and the schema is
 * what dominates the wire: measured 2026-09-15 against the live MCP tools/list (:3170,
 * ctx_tier=trimmed), `coord:send` carries ~1.2K of guidance and 39,254 B of schema. So a
 * tool sits comfortably inside the prompt-weight budget while costing 30-40 KB a turn,
 * and every prompt-weight check stays green the whole time.
 *
 * WHY THAT BECAME A BILL RATHER THAN A DETAIL. Claude Code's native schema DEFERRAL is
 * implemented BY ToolSearch; psu denies ToolSearch by owner directive (one call measured
 * +67,045 tokens bypassing applyResultDoor). With deferral gone, every ADVERTISED tool
 * ships its full schema on EVERY turn. That is EI-23319364088969722: a 64-name Claude
 * seed reached 432,714 B (~157K tokens), essentially the whole 151K->317K regression,
 * with no instrument watching.
 *
 * WHAT THIS IS NOT. `assertSelectedInputSchemaBudget()` above is an AGGREGATE bound on
 * one selected set, and it is wired into exactly two in-house agent-loop seams
 * (`capabilityToolset`, `operator:converse`). Neither is the MCP `tools/list` handler
 * that serves psu/Claude/OMP/codex — `packages/agent-mcp/src` imports no budget symbol
 * at all. An aggregate bound also cannot stop the slow creep that made the seed
 * expensive in the first place: it fires only once a set is assembled, blaming whoever
 * assembled it rather than whoever grew the schema. This budget is PER TOOL, at
 * registration time, so growth is attributed to the edit that caused it.
 *
 * THE SHAPE, and why it is a ratchet rather than a cap. Measured across the live
 * 923-tool catalog: median 1,305 B, p90 3,302 B, p99 12,541 B, max 44,060 B. The tail is
 * extreme — 19 tools over 10 KB are ~20% of the catalog's 1.89 MB. A flat cap low enough
 * to matter would red the gate fleet-wide on day one, which is the failure mode
 * CLAUDE.md warns about for prompt-weight breaches. So:
 *
 *   - a NEW tool must fit SCHEMA_BYTE_BUDGET;
 *   - an existing heavy tool is PINNED at its measured size in
 *     ALLOW_OVER_SCHEMA_BUDGET and may not exceed that pin.
 *
 * The pin is what makes this stronger than the boolean ALLOW_OVER_BUDGET the
 * prompt-weight tier uses: a grandfathered tool there may grow without limit, whereas a
 * pinned tool here is frozen at the size it was when it was measured. The set is
 * SHRINK-ONLY — lower a pin whenever a tool gets cheaper, and delete the entry once it
 * fits the budget. Raising one is a budget decision, not a chore: a seeded tool's schema
 * is paid on every turn of every session, forever, and the alternative that costs 0 B/turn
 * is to leave the tool unseeded and let tools:find/tools:invoke reach it in one hop.
 */
export const SCHEMA_BYTE_BUDGET = 8_000;

/**
 * Pinned ceilings for tools that already exceed SCHEMA_BYTE_BUDGET. SHRINK-ONLY.
 *
 * Each value is that tool's measured in-repo projected size at the time it was pinned,
 * rounded UP to a small round number so ordinary schema churn does not red the gate.
 * ⚠ These are IN-REPO projection bytes, which read ~20% BELOW the wire: the in-repo
 * catalog skips the server's late entity-enum/sanitize passes
 * (packages/agent-mcp/src/server.ts:758). Compare in-repo to in-repo; do NOT read a pin
 * as the context cost, and do NOT re-seed these from a live tools/list measurement.
 */
export const ALLOW_OVER_SCHEMA_BUDGET: ReadonlyMap<string, number> = new Map([
  // Seeded 2026-09-15 from the projected catalog (889 exposed tools, 1,216,782 B total,
  // median 618 B). These 20 tools are 3.6% of the catalog by count and 27% by bytes.
  // Lowered 2026-09-16 (EI-23379068490085254): 43,283 -> 40,501 after completionSpec's
  // `.describe()` dropped its duplicated field enumeration, second object example, and
  // the rules each field's own describe already owns. Paid twice (completion + items[]).
  ['work_items:complete', 26_000], // measured 23,984
  ['coord:send', 34_000], // measured 32,095
  ['rubrics:propose', 39_000], // measured 36,402
  ['rubrics:amend', 30_000], // measured 27,927
  ['work_items:checkpoint', 25_000], // measured 23,358
  ['fleet:launch-on-plan', 24_000], // measured 21,940
  ['loop:checkpoint', 22_000], // measured 20,174
  ['improvements:capture', 20_000], // measured 19,033
  ['scorecards:emit', 19_000], // measured 17,743
  ['facts:assert', 15_500], // measured 14,452
  ['capability:launch-agent', 12_000], // measured 11,262
  ['work_items:create', 11_500], // measured 10,778
  ['plans:audit', 11_500], // measured 10,497
  ['loop:arm', 10_500], // measured 9,782
  ['goals:start', 10_500], // measured 9,669
  ['plans:set-status', 10_000], // measured 9,381
  ['watch:create', 10_000], // measured 9,302
  ['work_items:list', 10_000], // measured 9,271
  ['goals:update', 9_500], // measured 8,758
  ['events:await', 8_500], // measured 8,024
]);

export interface NamedToolSchemaBytes {
  name: string;
  bytes: number;
}

/** The projected catalog's per-tool argSchema size in UTF-8 bytes. Pass a catalog to
 *  measure (tests); omit to read the live registry, which asserts the barrel actually
 *  registered rather than silently measuring an empty one. */
export function namedToolSchemaBytes(catalog?: readonly ProjectedTool[]): NamedToolSchemaBytes[] {
  const tools = catalog ?? listAllProjectedTools();
  if (catalog === undefined) assertLiveCatalogSane(tools);
  return tools
    .map((t) => ({
      name: t.expose?.mcp?.name ?? '(unexposed)',
      bytes: serializedInputSchemaBytes(t.inputSchema),
    }))
    .filter((t) => t.name !== '(unexposed)');
}

export interface SchemaBudgetViolation {
  name: string;
  bytes: number;
  /** The ceiling this tool actually had to clear (its pin, or the budget). */
  ceiling: number;
  /** true iff this tool is pinned in ALLOW_OVER_SCHEMA_BUDGET. */
  pinned: boolean;
  /** bytes to cut to clear `ceiling`. */
  cutAtLeast: number;
}

/**
 * Every tool over its binding ceiling: a pinned tool over ITS PIN, or any other tool
 * over SCHEMA_BYTE_BUDGET. Mirrors `budgetViolations()` so the schema tier and the
 * prompt-weight tier report breaches the same way.
 */
export function schemaBudgetViolations(
  measured?: readonly NamedToolSchemaBytes[],
): SchemaBudgetViolation[] {
  const named = measured ?? namedToolSchemaBytes();
  const out: SchemaBudgetViolation[] = [];
  for (const t of named) {
    const pin = ALLOW_OVER_SCHEMA_BUDGET.get(t.name);
    const pinned = pin !== undefined;
    const ceiling = pinned ? pin : SCHEMA_BYTE_BUDGET;
    if (t.bytes <= ceiling) continue;
    out.push({ name: t.name, bytes: t.bytes, ceiling, pinned, cutAtLeast: t.bytes - ceiling });
  }
  return out.sort((a, b) => b.cutAtLeast - a.cutAtLeast);
}

/**
 * Pins that are now ABOVE what the tool actually costs — the shrink-only ratchet's
 * downward half. Reported (never failed on) so a tool that got cheaper hands back the
 * headroom instead of quietly banking it for future growth.
 */
export function slackSchemaPins(
  measured?: readonly NamedToolSchemaBytes[],
): { name: string; pin: number; bytes: number; lowerTo: number }[] {
  const named = measured ?? namedToolSchemaBytes();
  const bySize = new Map(named.map((t) => [t.name, t.bytes]));
  const out: { name: string; pin: number; bytes: number; lowerTo: number }[] = [];
  for (const [name, pin] of ALLOW_OVER_SCHEMA_BUDGET) {
    const bytes = bySize.get(name);
    if (bytes === undefined) continue;
    const lowerTo = bytes <= SCHEMA_BYTE_BUDGET ? SCHEMA_BYTE_BUDGET : roundPin(bytes);
    if (lowerTo < pin) out.push({ name, pin, bytes, lowerTo });
  }
  return out.sort((a, b) => b.pin - b.bytes - (a.pin - a.bytes));
}

/** Round a measured size UP to a tidy pin, so ordinary churn does not red the gate. */
export function roundPin(bytes: number): number {
  const step = bytes >= 20_000 ? 1_000 : 500;
  return Math.ceil((bytes * 1.05) / step) * step;
}

/** Self-serve failure text: the tool, its size, and exactly how many bytes to cut. */
export function formatSchemaViolations(violations: readonly SchemaBudgetViolation[]): string {
  if (violations.length === 0) return '';
  return violations
    .map((v) => {
      const limit = v.pinned
        ? `${v.ceiling}-byte PIN (ALLOW_OVER_SCHEMA_BUDGET)`
        : `${SCHEMA_BYTE_BUDGET}-byte schema budget`;
      const tail = v.pinned
        ? ' — a pin is SHRINK-ONLY; raising it is a budget decision paid on every turn of every session'
        : ' (trim the schema — shorten per-field `.describe()` prose, prefer a docs pointer, collapse a wide enum — or, only if genuinely irreducible, add a pinned ALLOW_OVER_SCHEMA_BUDGET entry)';
      return `  • ${v.name} is ${v.bytes} B — cut ≥${v.cutAtLeast} B to clear the ${limit}${tail}`;
    })
    .join('\n');
}

/**
 * UTF-8 bytes of ONE advertised `tools/list` entry — the per-turn context bill a SEEDED
 * tool charges every session that lists it.
 *
 * This is deliberately NOT `serializedInputSchemaBytes`: that measures the schema alone,
 * while the server advertises `{ name, description, inputSchema }` together
 * (packages/agent-mcp/src/server.ts, the tools/list handler). The seed budgets are
 * compared against real tools/list measurements, so they must count what is actually put
 * on the wire.
 *
 * ⚠ IT READS ~20% LOW vs the live endpoint. This projection is the same catalog the
 * server renders from, but skips the server's late entity-enum/sanitize passes — measured
 * 2026-09-15, 90,869 B here for the 31 names the live endpoint served as 113,588 B. That
 * makes it a faithful REGRESSION signal, not a byte-exact replica: compare in-repo
 * readings to in-repo readings, and never quote one as the context cost.
 *
 * Shared by the seed guards (claude-seed-wire-budget / omp-seed-wire-budget) so their two
 * budgets cannot drift onto different measurements — the numbers are only comparable to
 * each other, and to their own recorded history, while one function produces them.
 */
export function advertisedWireBytes(
  name: string,
  tool: { description?: string; inputSchema?: unknown },
): number {
  return UTF8_ENCODER.encode(
    JSON.stringify({
      name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema ?? {},
    }),
  ).byteLength;
}
