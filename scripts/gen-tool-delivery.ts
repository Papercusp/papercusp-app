#!/usr/bin/env node
/**
 * gen-tool-delivery.ts — emit the resolved per-agent tool-delivery map.
 * (deterministic-tool-definition-delivery-2026-09-21 P-005; D-002, D-003, D-005.)
 *
 *   npm run gen:tool-delivery           # write the generated artifact
 *   npm run gen:tool-delivery:check     # fail (exit 1) if the artifact is stale
 *   npm run gen:tool-delivery -- --report   # print the resolution, write nothing
 *
 * ── WHAT IT GENERATES, AND WHY AS A PLAIN .mjs DATA MODULE ─────────────────
 *
 * `psu-launcher.mjs` is dependency-free by design — it runs from a bare node
 * with no build step and no TypeScript — so the artifact it consumes has to be
 * importable as-is. Hence a generated `.mjs` exporting frozen literals rather
 * than a `.ts` module or a JSON file needing a resolver.
 *
 * ── THE INPUTS ARE ALL FROZEN, WHICH IS WHAT MAKES --check MEAN ANYTHING ───
 *
 *   catalog  the live registry, measured here at both tiers (compactWireBytes)
 *   demand   the COMMITTED snapshot (D-003) — never the database
 *   floors   derived + declared (P-004)
 *   budget   a stated constant per agent kind
 *
 * Only the catalog can move between runs, and it moves only when someone edits
 * a tool. That is exactly the drift `--check` should catch: a tool whose schema
 * grew until it no longer fits the budget silently changes which OTHER tools
 * are advertised, and nothing else in the repo would notice.
 *
 * ⚠ The catalog read needs the agent-tools barrel REGISTERED first. A bare
 * import of the barrel outside the vitest bootstrap hangs, so this script
 * imports it dynamically and then asserts the catalog looks genuinely
 * registered — a partial registry would silently generate a truncated map that
 * looks like a deliberate trim.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT_PATH = 'packages/operator-core/lib/agent-tools/tool-demand-snapshot.json';
const OUT_PATH = 'apps/operator/scripts/tool-delivery.generated.mjs';

/**
 * The trimmed-mode wire budget, in bytes, per agent kind.
 *
 * Owner directive [owner 2026-09-21]: "lets make omp claude and codex use the same
 * tool list in trimmed mode" (D-005). The three entries are therefore EQUAL, and
 * they are spelled out per kind rather than collapsed to one constant so that a
 * future divergence is a visible data edit with a reason, not a code change.
 *
 * 100,000 B is the existing `CLAUDE_SEED_WIRE_BYTE_BUDGET` — the tightest of the
 * three live ceilings (OMP's D-001 ceiling is 262,144 B). Unifying DOWN rather
 * than up is the whole point of adding the COMPACT tier: the same byte budget
 * buys substantially more tools once schemas can ship without their prose, so
 * matching OMP to Claude's ceiling should cost OMP nothing. `--report` prints
 * the measured before/after that justifies this number.
 */
export const TRIMMED_BUDGET_BYTES: Readonly<Record<string, number>> = Object.freeze({
  claude: 100_000,
  codex: 100_000,
  omp: 100_000,
});

/** Below this the registry did not finish registering; generating would truncate the map. */
const MIN_PLAUSIBLE_CATALOG = 400;

export interface GeneratedRow {
  name: string;
  tier: string;
  fullBytes: number;
  compactBytes: number;
  callers: number;
  calls: number;
}

export interface GeneratedAgent {
  budgetBytes: number;
  spentBytes: number;
  budgetOverrun: number;
  counts: { full: number; compact: number; deferred: number };
  advertised: string[];
  /** The floor names this resolution was obliged to admit (P-004). Emitted so a consumer
   *  can check floor COVERAGE without re-deriving the registry — and so a floor silently
   *  disappearing from the registry shows up as an artifact diff rather than as a guard
   *  that quietly starts asserting over a shorter list. */
  floors: string[];
  rows: GeneratedRow[];
}

/**
 * One tool's PROSE half, measured separately from its schema half (P-010/D-006).
 * `descFull` is what ships at FULL; `descPartial` is what the partial-guidance
 * projection keeps; `descSummary` is what the COMPACT tier actually ships.
 *
 * ⚠ COMPACT no longer ships zero prose. D-011 replaced `description:''` with a
 * capped SUMMARY after the partial projection measured only a 0.8% saving, so
 * `descSummary` — not zero — is the prose cost of the delivered tier. Anything
 * here that still prices COMPACT at zero is stale by exactly that decision.
 */
interface GuidanceHalf {
  name: string;
  descFull: number;
  descPartial: number;
  /** Bytes at the SUMMARY tier: one lead sentence + every hard rail. */
  descSummary: number;
  rails: number;
  reduced: string[];
  unlabelled: boolean;
}

/**
 * The catalog-wide prose/schema split, and what CHANGING the COMPACT tier's
 * prose depth would cost on the delivered seed.
 *
 * This exists to answer a specific owner question — "how verbose is the
 * guidance, can it be shortened without losing information?" — with a measured
 * LOSS SET rather than an assurance. It deliberately reports what partial
 * REMOVES (reduced sections, tools left with no prose at all) beside what it
 * saves, because a reduction reported only as a saving is a half-truth.
 */
function renderGuidanceReport(
  agent: GeneratedAgent,
  guidanceByName: Map<string, GuidanceHalf>,
  catalogByName: Map<string, { name: string; fullBytes: number; compactBytes: number }>,
): string {
  const all = [...guidanceByName.values()];
  const sum = (rows: GuidanceHalf[], f: (g: GuidanceHalf) => number) =>
    rows.reduce((a, g) => a + f(g), 0);

  const dFull = sum(all, (g) => g.descFull);
  const dPartial = sum(all, (g) => g.descPartial);
  const dSummary = sum(all, (g) => g.descSummary);
  const railsKept = sum(all, (g) => g.rails);
  const reducedNotWhen = all.filter((g) => g.reduced.includes('When NOT to use:')).length;
  const reducedChaining = all.filter((g) => g.reduced.includes('Chaining:')).length;
  const proseless = all.filter((g) => g.descPartial === 0 && g.descFull > 0).length;

  const schemaFull = [...catalogByName.values()].reduce((a, c) => a + c.fullBytes, 0);
  const schemaCompact = [...catalogByName.values()].reduce((a, c) => a + c.compactBytes, 0);

  // What it would cost to CHANGE the compact tier's prose DEPTH.
  //
  // ⚠ D-011 flipped COMPACT from `description:''` to a capped SUMMARY, so
  // `agent.spentBytes` ALREADY carries the summary prose of every compact tool.
  // An upgrade must therefore be priced as a DELTA against the prose already
  // delivered, never as an addition on top of the live spend: adding a full
  // prose total to a spend that already contains the summary double-counts it
  // and reports OVER for the very configuration shipping at overrun=0.
  const compactNames = agent.rows.filter((r) => r.tier === 'compact').map((r) => r.name);
  const proseOverCompact = (f: (g: GuidanceHalf) => number) =>
    compactNames.reduce((a, n) => {
      const g = guidanceByName.get(n);
      return a + (g ? f(g) : 0);
    }, 0);
  const restoreFull = proseOverCompact((g) => g.descFull);
  const restore = proseOverCompact((g) => g.descPartial);
  // What the SHIPPING tier already pays for prose — the baseline both deltas
  // below are measured against.
  const delivered = proseOverCompact((g) => g.descSummary);
  const wouldBe = agent.spentBytes + (restore - delivered);
  const wouldBeFull = agent.spentBytes + (restoreFull - delivered);

  const lines: string[] = [];
  lines.push('');
  lines.push('── GUIDANCE HALF vs SCHEMA HALF (catalog-wide, P-010/D-006) ──');
  // Catalog-wide prose totals at each DEPTH. There is deliberately no `compact=`
  // column: since D-011 the COMPACT tier ships the SUMMARY projection, so
  // `summary=` IS compact's prose cost. The literal `compact=0` that used to sit
  // here outlived the tier it described and read as "compact ships no prose".
  lines.push(
    `GUIDANCE_BYTES full=${dFull} partial=${dPartial} summary=${dSummary} savedByPartial=${dFull - dPartial} savedBySummary=${dFull - dSummary}`,
  );
  // NB these two are WIRE totals (name + description + schema), which is what
  // the budget is actually spent in — NOT a schema-only figure. Named WIRE_
  // so the number cannot be read as something narrower than it is.
  lines.push(
    `WIRE_BYTES full=${schemaFull} compact=${schemaCompact} savedByCompact=${schemaFull - schemaCompact}`,
  );
  lines.push('');
  lines.push('── LOSS SET (what partial REMOVES — stated, not assured) ──');
  lines.push(`GUIDANCE_LOSS reducedNotWhen=${reducedNotWhen} reducedChaining=${reducedChaining} railsRetained=${railsKept} toolsLeftProseless=${proseless}`);
  // WHY partial can be a near-no-op: a tool declaring an EXPLICIT description
  // never goes through describeFromGuidance, so its wire prose carries no
  // section labels to reduce. Printed because a 0.8% saving is otherwise
  // indistinguishable from a broken projection.
  const unlabelled = all.filter((g) => g.unlabelled).length;
  const composed = all.length - unlabelled;
  lines.push(
    `GUIDANCE_SHAPE tools=${all.length} explicitDescription=${unlabelled} composedFromGuidance=${composed} meanDescBytes=${Math.round(dFull / Math.max(1, all.length))}`,
  );
  lines.push('');
  lines.push('── PROSE DEPTH ON THE COMPACT TIER (claude seed) ──');
  // What the SHIPPING configuration already pays for prose. Stated FIRST so the
  // two deltas below are read against a measured number rather than an assumed
  // zero — the assumption that made the old RESTORE_* lines double-count.
  // `composedAmongCompact` explains an otherwise alarming reading: partial only
  // reduces prose for tools whose description was COMPOSED from guidance
  // sections, so when this is 0 the PARTIAL and FULL deltas below are EQUAL by
  // construction — not a copy-paste bug. Same reason GUIDANCE_SHAPE is printed.
  const composedAmongCompact = compactNames.filter(
    (n) => guidanceByName.get(n)?.unlabelled === false,
  ).length;
  lines.push(
    `GUIDANCE_DELIVERED compactTools=${compactNames.length} composedAmongCompact=${composedAmongCompact} tier=summary proseBytes=${delivered} ofSpend=${agent.spentBytes} meanBytesPerTool=${Math.round(delivered / Math.max(1, compactNames.length))}`,
  );
  lines.push(
    `GUIDANCE_UPGRADE_PARTIAL deltaBytes=${restore - delivered} wouldBe=${wouldBe} budget=${agent.budgetBytes} verdict=${wouldBe <= agent.budgetBytes ? 'FITS' : 'OVER'}`,
  );
  lines.push(
    `GUIDANCE_UPGRADE_FULL deltaBytes=${restoreFull - delivered} wouldBe=${wouldBeFull} budget=${agent.budgetBytes} verdict=${wouldBeFull <= agent.budgetBytes ? 'FITS' : 'OVER'}`,
  );
  lines.push('');
  return lines.join('\n');
}

/** Render the artifact. Pure given its inputs, so `--check` compares like with like. */
export function renderArtifact(input: {
  snapshotCapturedAt: string;
  catalogSize: number;
  agents: Record<string, GeneratedAgent>;
}): string {
  const kinds = Object.keys(input.agents).sort();
  const lines: string[] = [
    '// @generated by `npm run gen:tool-delivery` — DO NOT EDIT BY HAND.',
    '//',
    '// Regenerate:      npm run gen:tool-delivery',
    '// Verify in CI:    npm run gen:tool-delivery:check',
    '//',
    '// Derived from the COMMITTED demand snapshot',
    `// (${SNAPSHOT_PATH}, captured ${input.snapshotCapturedAt})`,
    '// plus the live tool catalog measured at both delivery tiers, and the floor',
    '// registry in apps/operator/lib/tool-delivery-floors.ts. Editing this file',
    '// changes nothing durable: the next generator run overwrites it.',
    '//',
    `// Catalog measured: ${input.catalogSize} tools.`,
    '',
  ];

  for (const kind of kinds) {
    const agent = input.agents[kind];
    lines.push(
      `/** ${kind}: ${agent.counts.full} full + ${agent.counts.compact} compact = ${agent.spentBytes} B of ${agent.budgetBytes} B` +
        `${agent.budgetOverrun > 0 ? ` (OVERRUN ${agent.budgetOverrun} B — floors alone exceed the budget)` : ''}. */`,
    );
    lines.push(`export const ${kind.toUpperCase()}_TOOL_DELIVERY = Object.freeze({`);
    lines.push(`  budgetBytes: ${agent.budgetBytes},`);
    lines.push(`  spentBytes: ${agent.spentBytes},`);
    lines.push(`  budgetOverrun: ${agent.budgetOverrun},`);
    lines.push(
      `  counts: Object.freeze({ full: ${agent.counts.full}, compact: ${agent.counts.compact}, deferred: ${agent.counts.deferred} }),`,
    );
    lines.push('  /** name -> "full" | "compact". A name absent here is DEFERRED. */');
    lines.push('  tiers: Object.freeze({');
    for (const r of agent.rows) {
      if (r.tier === 'deferred') continue;
      lines.push(`    ${JSON.stringify(r.name)}: ${JSON.stringify(r.tier)},`);
    }
    lines.push('  }),');
    lines.push('  /** Advertised names, sorted — what the launcher passes as `?tools=`. */');
    lines.push('  advertised: Object.freeze([');
    for (const name of agent.advertised) lines.push(`    ${JSON.stringify(name)},`);
    lines.push('  ]),');
    lines.push(
      '  /** Floors this resolution had to admit (>= COMPACT, never dropped) — P-004/D-004. */',
    );
    lines.push('  floors: Object.freeze([');
    for (const name of agent.floors) lines.push(`    ${JSON.stringify(name)},`);
    lines.push('  ]),');
    lines.push('});');
    lines.push('');
  }

  lines.push('/** Every agent kind, keyed — so a consumer can resolve one by name. */');
  lines.push('export const TOOL_DELIVERY_BY_AGENT_KIND = Object.freeze({');
  for (const kind of kinds) lines.push(`  ${JSON.stringify(kind)}: ${kind.toUpperCase()}_TOOL_DELIVERY,`);
  lines.push('});');
  lines.push('');
  return lines.join('\n');
}

/** The measured Aug-20 advertised set, recovered from commit 84829ccc (D-007). */
export const BASELINE_PATH =
  'packages/operator-core/lib/agent-tools/tool-seed-baseline-2026-08-20.json';

export interface SeedBaseline {
  commit: string;
  commitDate: string;
  counts: { ompCore: number; claudeExtras: number; union: number };
  union: string[];
}

/**
 * The P-012 baseline diff: what the derivation KEPT, ADDED and DROPPED against the
 * measured Aug-20 set — with each addition's demand/byte justification, and each drop's
 * reason.
 *
 * ⚠ WHY THIS EXISTS AT ALL, and why it diffs against 61 rather than the 26 the owner was
 * told (D-007): the "19 OMP-core + 7 Claude extras = 26 tools" figure came from a prior
 * session's own ANSWER and was never checked against the code. The real Aug-20 set was 43
 * + 18 = 61 distinct names. A derivation that reports "we grew from 26 to 90" would carry
 * that error forward with the authority of a generated artifact — which is exactly how a
 * wrong number becomes load-bearing. So the baseline is a committed measurement, and this
 * report states the comparison it is actually making.
 */
export function renderBaselineDiff(
  agent: GeneratedAgent,
  baseline: SeedBaseline,
  catalog: Map<string, { name: string; fullBytes: number; compactBytes: number }>,
  demand: Map<string, { name: string; callers: number; calls: number }>,
): string {
  const byName = new Map(agent.rows.map((r) => [r.name, r]));
  const advertised = new Set(agent.advertised);
  const base = new Set(baseline.union);
  const floors = new Set(agent.floors);

  const kept = baseline.union.filter((n) => advertised.has(n)).sort();
  const added = agent.advertised.filter((n) => !base.has(n)).sort();
  const dropped = baseline.union.filter((n) => !advertised.has(n)).sort();

  const out: string[] = [];
  out.push(
    `TOOL_DELIVERY_BASELINE commit=${baseline.commit} date=${baseline.commitDate} ` +
      `baselineNames=${baseline.counts.union} kept=${kept.length} added=${added.length} dropped=${dropped.length}\n`,
  );
  const why = (n: string): string => {
    const r = byName.get(n);
    if (!r) return 'notInCatalog=1 (the tool no longer exists — nothing to advertise)';
    const dens = r.callers / Math.max(1, r.tier === 'compact' ? r.compactBytes : r.fullBytes);
    return (
      `tier=${r.tier} callers=${r.callers} calls=${r.calls} fullB=${r.fullBytes} ` +
      `compactB=${r.compactBytes} callersPerKB=${(dens * 1000).toFixed(1)}` +
      (floors.has(n) ? ' floor=1' : '')
    );
  };
  for (const n of kept) out.push(`TOOL_DELIVERY_KEPT ${n} ${why(n)}\n`);
  for (const n of added) out.push(`TOOL_DELIVERY_ADDED ${n} ${why(n)}\n`);
  for (const n of dropped) {
    // A dropped name has NO row (rows carry only admitted tools), so its cost has to come
    // from the catalog measurement rather than from a row. Emitting the numbers is the
    // point: "dropped with the reason" (P-012) means the reason has to be CHECKABLE, and
    // "ranked below the value line" is only checkable beside the density that ranked it.
    const c = catalog.get(n);
    const d = demand.get(n);
    if (!c) {
      out.push(`TOOL_DELIVERY_DROPPED ${n} reason=absent-from-catalog (the tool no longer exists)\n`);
      continue;
    }
    const callers = d?.callers ?? 0;
    out.push(
      `TOOL_DELIVERY_DROPPED ${n} reason=below-value-line callers=${callers} ` +
        `calls=${d?.calls ?? 0} fullB=${c.fullBytes} compactB=${c.compactBytes} ` +
        `callersPerKB=${((callers / Math.max(1, c.compactBytes)) * 1000).toFixed(1)}\n`,
    );
  }
  // The cost of restoring the whole baseline at COMPACT, stated once — the single number
  // someone reading this diff will otherwise compute by hand, and the one that decides
  // whether "keep every baseline name" is affordable or a real trade.
  const dropCost = dropped.reduce((s, n) => s + (catalog.get(n)?.compactBytes ?? 0), 0);
  out.push(
    `TOOL_DELIVERY_BASELINE_RESTORE_COST compactBytes=${dropCost} ` +
      `spentBytes=${agent.spentBytes} budgetBytes=${agent.budgetBytes} ` +
      `wouldSpend=${agent.spentBytes + dropCost}\n`,
  );
  return out.join('');
}

async function build(): Promise<{
  text: string;
  agents: Record<string, GeneratedAgent>;
  catalogSize: number;
  baseline: SeedBaseline;
  catalogByName: Map<string, { name: string; fullBytes: number; compactBytes: number }>;
  demandByName: Map<string, { name: string; callers: number; calls: number }>;
  guidanceByName: Map<string, GuidanceHalf>;
  sweepLines: string[];
}> {
  // Side-effect import FIRST: it registers the catalog that listAllProjectedTools reads.
  await import('../packages/operator-core/lib/agent-tools/index.ts');
  const {
    listAllProjectedTools,
    compactWireBytes,
    partialGuidanceLoss,
    summaryGuidanceDescription,
    compactInputSchema,
  } = await import('@papercusp/tooldef');
  const { explainToolDelivery } = await import(
    '../packages/operator-core/lib/agent-tools/tool-delivery-policy.ts'
  );
  const { deliveryFloorNames } = await import('../apps/operator/lib/tool-delivery-floors.ts');

  const projected = listAllProjectedTools();
  if (projected.length < MIN_PLAUSIBLE_CATALOG) {
    throw new Error(
      `gen-tool-delivery: the catalog returned only ${projected.length} tool(s), below the ${MIN_PLAUSIBLE_CATALOG} floor. ` +
        'The agent-tools barrel did not finish registering — generating now would emit a truncated delivery map ' +
        'that is indistinguishable from a deliberate trim.',
    );
  }

  const catalog = projected
    .map((t: { expose?: { mcp?: { name?: string } }; description?: string; inputSchema?: unknown }) => {
      const name = t.expose?.mcp?.name;
      if (!name) return null;
      const bytes = compactWireBytes(name, { description: t.description, inputSchema: t.inputSchema });
      return { name, fullBytes: bytes.full, compactBytes: bytes.compact };
    })
    .filter((t): t is { name: string; fullBytes: number; compactBytes: number } => t !== null);

  // P-010/D-006: the PROSE half, measured independently of the schema half so
  // the two can be traded against each other rather than moving as one lump.
  const guidanceByName = new Map<string, GuidanceHalf>();
  for (const t of projected as readonly {
    expose?: { mcp?: { name?: string } };
    description?: string;
  }[]) {
    const name = t.expose?.mcp?.name;
    if (!name) continue;
    const loss = partialGuidanceLoss(t.description);
    guidanceByName.set(name, {
      name,
      descFull: loss.fullBytes,
      descPartial: loss.partialBytes,
      rails: loss.retainedSafetyClauses,
      reduced: loss.reducedSections,
      unlabelled: loss.unlabelled,
      descSummary: loss.summaryBytes,
    });
  }

  const snapshot = JSON.parse(readFileSync(resolve(REPO_ROOT, SNAPSHOT_PATH), 'utf8')) as {
    capturedAt: string;
    tools: Array<{ name: string; callers: number; calls: number }>;
  };
  const floors = deliveryFloorNames();
  const byName = new Map(catalog.map((t) => [t.name, t]));
  const demandByName = new Map(snapshot.tools.map((r) => [r.name, r]));

  const agents: Record<string, GeneratedAgent> = {};
  for (const kind of Object.keys(TRIMMED_BUDGET_BYTES).sort()) {
    const r = explainToolDelivery({
      agentKind: kind as 'claude' | 'codex' | 'omp',
      catalog,
      demand: snapshot.tools,
      floors,
      budgetBytes: TRIMMED_BUDGET_BYTES[kind],
    });
    const rows: GeneratedRow[] = [...r.tiers.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, tier]) => ({
        name,
        tier,
        fullBytes: byName.get(name)?.fullBytes ?? 0,
        compactBytes: byName.get(name)?.compactBytes ?? 0,
        callers: demandByName.get(name)?.callers ?? 0,
        calls: demandByName.get(name)?.calls ?? 0,
      }));
    agents[kind] = {
      budgetBytes: r.budgetBytes,
      spentBytes: r.spentBytes,
      budgetOverrun: r.budgetOverrun,
      counts: r.counts,
      advertised: rows.filter((x) => x.tier !== 'deferred').map((x) => x.name),
      floors: [...floors].sort(),
      rows,
    };
  }

  // P-010 tuning instrument: the SUMMARY lead cap trades prose against seats,
  // and the right value is a measurement, not a guess. Re-price the catalog at
  // each candidate cap and re-resolve — both are pure, so this is cheap once
  // the catalog is loaded (the expensive part is the barrel import above).
  const sweepLines: string[] = [];
  for (const cap of [0, 60, 64, 70, 80, 100, 120, 140, 160, 200]) {
    const capped = projected
      .map((t: { expose?: { mcp?: { name?: string } }; description?: string; inputSchema?: unknown }) => {
        const name = t.expose?.mcp?.name;
        if (!name) return null;
        const full = compactWireBytes(name, {
          description: t.description,
          inputSchema: t.inputSchema,
        }).full;
        const compactBytes = new TextEncoder().encode(
          JSON.stringify({
            name,
            description: cap === 0 ? '' : summaryGuidanceDescription(t.description, cap),
            inputSchema: compactInputSchema(t.inputSchema ?? {}),
          }),
        ).byteLength;
        return { name, fullBytes: full, compactBytes };
      })
      .filter((t): t is { name: string; fullBytes: number; compactBytes: number } => t !== null);
    const r = explainToolDelivery({
      agentKind: 'claude',
      catalog: capped,
      demand: snapshot.tools,
      floors,
      budgetBytes: TRIMMED_BUDGET_BYTES.claude,
    });
    sweepLines.push(
      `SUMMARY_CAP_SWEEP cap=${cap} full=${r.counts.full} compact=${r.counts.compact} spent=${r.spentBytes} overrun=${r.budgetOverrun} fits=${r.budgetOverrun === 0 ? 'YES' : 'NO'}`,
    );
  }

  const baseline = JSON.parse(readFileSync(resolve(REPO_ROOT, BASELINE_PATH), 'utf8')) as SeedBaseline;
  if (!Array.isArray(baseline.union) || baseline.union.length !== baseline.counts.union) {
    throw new Error(
      `gen-tool-delivery: ${BASELINE_PATH} is internally inconsistent (counts.union=${baseline.counts.union}, ` +
        `union.length=${baseline.union?.length}). A baseline that disagrees with itself cannot anchor a diff.`,
    );
  }

  return {
    text: renderArtifact({ snapshotCapturedAt: snapshot.capturedAt, catalogSize: catalog.length, agents }),
    agents,
    catalogSize: catalog.length,
    baseline,
    catalogByName: byName,
    demandByName,
    guidanceByName,
    sweepLines,
  };
}

/**
 * The verdict `--check` renders, extracted from main() so BOTH branches are unit-
 * testable without a subprocess and without mutating the shared tree.
 *
 * R-5 of deterministic-tool-definition-delivery-2026-09-21 claims the committed
 * artifact cannot diverge from its inputs without failing the build. That claim was
 * carried by an inline `current === built.text` comparison inside main(), which no
 * test could reach: proving it meant either spawning the CLI or mutating the real
 * artifact, and mutating a tracked file here races the git-sync sweep that commits
 * the whole tree every few minutes. So the guard had never been observed to FAIL,
 * and a guard that has only ever been seen to pass is not evidence of anything.
 *
 * Byte-exact by design: comparing trimmed or normalized text would let a generator
 * whose only change is trailing whitespace report `current`, which is precisely the
 * silent drift this guard exists to catch.
 */
export type ToolDeliveryDriftVerdict =
  | { ok: true; reason: 'current' }
  | { ok: false; reason: 'missing' | 'stale' };

export function toolDeliveryDriftVerdict(
  current: string | null,
  built: string,
): ToolDeliveryDriftVerdict {
  if (current === null) return { ok: false, reason: 'missing' };
  return current === built ? { ok: true, reason: 'current' } : { ok: false, reason: 'stale' };
}

async function main(): Promise<number> {
  const check = process.argv.includes('--check');
  const report = process.argv.includes('--report');
  const built = await build();
  const outPath = resolve(REPO_ROOT, OUT_PATH);

  if (report) {
    for (const [kind, a] of Object.entries(built.agents)) {
      process.stdout.write(
        `TOOL_DELIVERY_REPORT kind=${kind} full=${a.counts.full} compact=${a.counts.compact} deferred=${a.counts.deferred} spent=${a.spentBytes} budget=${a.budgetBytes} overrun=${a.budgetOverrun}\n`,
      );
    }
    process.stdout.write(`TOOL_DELIVERY_CATALOG tools=${built.catalogSize}\n`);
    process.stdout.write(
      renderBaselineDiff(built.agents.claude, built.baseline, built.catalogByName, built.demandByName),
    );
    process.stdout.write(
      renderGuidanceReport(built.agents.claude, built.guidanceByName, built.catalogByName),
    );
    process.stdout.write(`${built.sweepLines.join('\n')}\n`);
    return 0;
  }

  if (check) {
    let current: string | null = null;
    try {
      current = readFileSync(outPath, 'utf8');
    } catch {
      current = null;
    }
    const verdict = toolDeliveryDriftVerdict(current, built.text);
    if (verdict.ok) {
      process.stdout.write(`GEN_TOOL_DELIVERY_CHECK ok ${OUT_PATH}\n`);
      return 0;
    }
    process.stderr.write(
      `✖ gen:tool-delivery:check — ${OUT_PATH} is ${verdict.reason === 'missing' ? 'MISSING' : 'STALE'}.\n` +
        '  The resolved delivery map no longer matches its inputs. Most often a tool’s schema or\n' +
        '  guidance grew, which silently changes which OTHER tools fit the budget.\n' +
        '  Regenerate and review the diff:  npm run gen:tool-delivery\n',
    );
    return 1;
  }

  writeFileSync(outPath, built.text, 'utf8');
  process.stdout.write(`GEN_TOOL_DELIVERY_WROTE ${OUT_PATH} catalog=${built.catalogSize}\n`);
  return 0;
}

if (isCliEntry(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`gen-tool-delivery: ${err?.stack ?? err}\n`);
      process.exit(2);
    },
  );
}
