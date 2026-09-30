/**
 * coord-tier-gate.ts — the ADOPTION GATE for D-001's enforcement-tier ladder
 * (plan coordination-spec-adoption-2026-08-03, P-009).
 *
 * `enforcement-tier-census.ts` MEASURES the D-016/D-047 debt. This closes the
 * door: a coordination behaviour added tomorrow whose tier resolves to nothing
 * FAILS a test, instead of quietly becoming row 27 of a census nobody is
 * obliged to read.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * WHAT P-009 ASKED FOR, AND WHAT IS ACTUALLY BUILT HERE
 *
 * P-009's text: "a new agent-facing coordination behaviour cannot register
 * without NAMING its enforcement tier and its adoption floor." Taken literally
 * that is a required `tier:` field on `defineTool`. That mechanism is REFUSED
 * here, on three measured grounds — recorded so it is not re-proposed (D-099):
 *
 *   1. THE FIELD IS ARCHITECTURALLY UNAVAILABLE. `defineTool` lives in
 *      `libs/generic/tooldef`, a domain-free borrowable lib that must not
 *      depend on operator-core; an enforcement tier is a papercusp-domain
 *      concept. `check-no-bespoke-state-read.mjs` hit this exact wall for its
 *      own `cell:` field and settled on a marker inside the literal — the same
 *      answer this file reaches, for the same reason.
 *   2. A SELF-DECLARED TIER IS UNFALSIFIABLE. Tiers 1–2 are properties of a
 *      chokepoint in OTHER code ("the agent never has to remember", "the old
 *      shape is refused at the boundary"). A tool asserting `tier:'auto-stamp'`
 *      about itself states something nothing can check — and the census's own
 *      contract is that an unfalsifiable declaration is WORSE than none,
 *      because it reads as covered.
 *   3. TIER 3 IS DERIVED ON PURPOSE. `deriveSeeAlsoTiers` reads it off the
 *      registry so that deleting the pointer deletes the tier. A declared copy
 *      of a derived fact is a stamped snapshot of live state — the same trap
 *      D-097 rejected for `current_files`: it keeps asserting enforcement after
 *      the mechanism behind it is gone.
 *
 * So the gate checks that a tier RESOLVES, and never asks an author to assert
 * one. The author's three ways to satisfy it are all real mechanisms:
 *   • point a tool's `seeAlso` at the verb  → tier 3, DERIVED, cannot rot;
 *   • add an explicit evidence-carrying entry to `DECLARED_COORD_TIERS` → 1–2;
 *   • write `@no-coord-tier <reason>` in the literal → an exemption that costs
 *     a sentence and is visible forever.
 *
 * The ADOPTION-FLOOR half of P-009 is deliberately NOT built. A floor is a
 * number, and D-003 forbids publishing one without evidence; the evidence does
 * not exist yet, because D-092 ruled that the zero-call verbs get discoverability
 * first and a re-measure at +7d (from 2026-08-03). Asserting a floor today would
 * manufacture the exact unfounded number this plan exists to stop. It is a
 * follow-up gated on that re-measure, not a thing to invent now.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * THE POSTURE — deliberately the same three parts as `lint:no-bespoke-state-read`
 * and `lint:no-raw-setinterval`, because it is the shape this repo has already
 * proven: (1) a PURE unit-tested predicate, (2) a GATING failure on anything new,
 * (3) a SHRINK-ONLY baseline grandfathering what already exists.
 *
 * ⚠ IT RUNS AS A TEST, NOT ONLY AS A SCRIPT. WI-6683 measured the alternative:
 * `scripts/check-sql-comment-backtick.mjs` was GREEN the whole time the break it
 * exists to catch sat committed, because nothing ran it on the path where the
 * damage happens. A guard on no blocking path is not a guard. Living in
 * `operator-core/lib` means `test:affected` and the green checkpoint both run it.
 */
import { DECLARED_COORD_TIERS, COORD_TOOL_PREFIX, type TierDeclaration } from './enforcement-tier-census';

/**
 * Capability prefixes whose verbs are NOT agent-facing coordination behaviours,
 * however they are named. `coord:handoff_config` and `coord:session_reaper_config`
 * carry `operator:write`: they TUNE the coordination plane from the operator side
 * rather than being behaviours an agent performs, so D-001's ladder — which ranks
 * how reliably an AGENT is made to do something — has nothing to say about them.
 *
 * DERIVED from the capability the tool already declares, never a hand-kept list.
 * Same principle as tier 3: change the capability and the exemption follows,
 * because there is no second copy to forget.
 *
 * ⚠ MEASURED, and smaller than it looks. Exactly 2 of the 43 registered coord
 * verbs qualify (2026-08-03). Several verbs that READ like admin surfaces —
 * `coord:wake-mode`, `coord:watermark-set`, `coord:rebind-identity` — carry
 * ordinary `coord:write` and are NOT exempt. Widening this by eye was the first
 * thing tried and it was wrong: the capability is the discriminator, not the name.
 */
export const TIER_EXEMPT_CAPABILITY_PREFIXES: readonly string[] = Object.freeze(['operator:']);

/** Pure: is this capability outside the population D-001's ladder governs? */
export function isTierExemptCapability(capability: string | null | undefined): boolean {
  if (!capability) return false;
  return TIER_EXEMPT_CAPABILITY_PREFIXES.some((p) => capability.startsWith(p));
}

/**
 * The in-literal escape hatch, mirroring `@not-a-cell`. A coordination behaviour
 * that genuinely cannot carry any of D-001's tiers says so IN the `defineTool`
 * literal, with a reason a reader can weigh.
 *
 * It is deliberately not free: D-001's finding is that a behaviour which cannot
 * be given tier 1–3 is a candidate for RETIREMENT, not for more prompt text. An
 * exemption is therefore an admission worth writing down, and every run prints
 * the count so the set cannot grow unnoticed.
 */
export const NO_COORD_TIER_RE = /@no-coord-tier\s+([^\n]+)/;

/** An exemption reason shorter than this is not a reason. Same bar as MIN_EXEMPTION_REASON. */
export const MIN_TIER_EXEMPTION_REASON = 24;

/**
 * BASELINE — coordination verbs that carry no resolvable tier today. SHRINK-ONLY.
 *
 * Seeded 2026-08-03 from the live tree, so the ratchet property (a NEW untiered
 * verb fails) holds from day one even though the existing debt is real and
 * unpaid. Retiring or tiering a verb removes its entry; nothing is ever added.
 *
 * ⚠ This is NOT a list of verbs that are fine. It is P-002's 26-row debt block
 * minus the two `operator:*` surfaces and minus the two whose tier-3 pointers
 * this gate's scanner can now see (see {@link extractSeeAlsoRegion}). Every entry
 * is a behaviour whose only enforcement is prose — which D-016 says is not
 * enforcement at all.
 */
export const UNTIERED_BASELINE: ReadonlySet<string> = new Set([
  'coord:ack',
  'coord:ask',
  'coord:await-inbox',
  'coord:conditions',
  'coord:deliberate',
  'coord:emit',
  'coord:escalations',
  'coord:goal',
  'coord:handoffs',
  'coord:message-agent',
  'coord:read',
  'coord:rebind-identity',
  'coord:resolve',
  'coord:retract',
  'coord:supersede',
  'coord:thread-post',
  'coord:vote',
  'coord:wake',
  'coord:wake-mode',
  'coord:watermark',
  // 'coord:watermark-set' RETIRED (plan fleet-deltas-leader-primitives-2026-07-10,
  // D-014) — the verb no longer exists, so its baseline entry is a legitimate
  // SHRINK, not a suppression. Both cursors it wrote now settle server-side.
]);

/**
 * When the grandfather period stops being free. Past this date a non-empty
 * baseline is itself the failure — the mechanism that stops "temporary" debt from
 * becoming permanent, copied from BASELINE_REVIEW_BY / DARK_FLAGS_REVIEW_BY.
 */
export const UNTIERED_BASELINE_REVIEW_BY = '2026-11-03';

/** Pure (today -> boolean) so the expiry is testable without waiting for the calendar. */
export function untieredBaselineExpired(
  today: string = new Date().toISOString().slice(0, 10),
  baseline: ReadonlySet<string> = UNTIERED_BASELINE,
): boolean {
  return baseline.size > 0 && today > UNTIERED_BASELINE_REVIEW_BY;
}

/** One coordination verb as the source scan sees it. */
export interface CoordToolRow {
  readonly name: string;
  readonly capability: string | null;
  /** The `@no-coord-tier` reason written in the literal, if any. */
  readonly exemption: string | null;
  readonly file?: string;
}

export interface TierVerdict {
  readonly rule: 'untiered-coord-behaviour' | 'exemption-unreasoned';
  readonly detail: string;
}

/**
 * Judge ONE coordination verb. Pure (row + the resolved tier set -> verdict).
 *
 * `tiered` is the set of verbs whose tier RESOLVED — derived tier 3 plus the
 * explicit 1–2. It is passed in rather than recomputed so this stays pure and so
 * the caller cannot accidentally judge against a different tier source than the
 * census reports.
 */
export function judgeCoordBehaviour(row: CoordToolRow, tiered: ReadonlySet<string>): TierVerdict | null {
  if (!row.name.startsWith(COORD_TOOL_PREFIX)) return null;
  // A malformed exemption is ALWAYS an error, even for an exempt capability or a
  // grandfathered verb: the baseline forgives an absent decision, never a broken one.
  if (row.exemption !== null) {
    return row.exemption.trim().length >= MIN_TIER_EXEMPTION_REASON
      ? null
      : {
          rule: 'exemption-unreasoned',
          detail: `@no-coord-tier needs a real reason (>= ${MIN_TIER_EXEMPTION_REASON} chars); got ${row.exemption.trim().length}: "${row.exemption.trim()}".`,
        };
  }
  if (isTierExemptCapability(row.capability)) return null;
  if (tiered.has(row.name)) return null;
  return {
    rule: 'untiered-coord-behaviour',
    detail: "a NEW coordination behaviour must resolve to one of D-001's tiers 1-3, or say why it cannot.",
  };
}

export interface TierGateResult {
  /** Verbs that FAIL the gate — new untiered behaviours + malformed exemptions. */
  readonly offenders: readonly (CoordToolRow & TierVerdict)[];
  /** Baseline entries that no longer need grandfathering (tiered, exempted, or gone). Hygiene, not a failure. */
  readonly staleBaseline: readonly string[];
  /** Every `@no-coord-tier` in the tree, so the exemption count is visible on every run. */
  readonly exemptions: readonly { name: string; reason: string }[];
  /** Verbs skipped because their capability is outside D-001's population. */
  readonly capabilityExempt: readonly string[];
  readonly scanned: number;
  /**
   * COVERAGE — coord verbs the independent catalog knows about that this gate's
   * parser did NOT see. Non-empty means the SCANNER is broken, not that the tree
   * is clean, and it is the only failure here that a green result would otherwise
   * be indistinguishable from. Absent when no catalog was supplied to compare to.
   */
  readonly unparsed?: readonly string[];
}

/**
 * The whole gate, PURE over already-scanned rows. Separated from the filesystem
 * so the failure modes are unit-testable — the split
 * `buildEnforcementTierCensus` / `loadCoordBehaviourAdoption` already uses.
 */
export function judgeCoordTierGate(input: {
  readonly rows: readonly CoordToolRow[];
  readonly tiered: ReadonlySet<string>;
  readonly baseline?: ReadonlySet<string>;
  /**
   * The independently-scanned coord verb list to cross-check parser coverage
   * against (`selectCoordBehaviours(buildBuiltinToolCatalog(root))`). Omit and
   * `unparsed` is simply absent — never silently reported as empty, because
   * "nothing missing" and "never checked" must not look the same.
   */
  readonly catalogue?: Iterable<string>;
}): TierGateResult {
  const baseline = input.baseline ?? UNTIERED_BASELINE;
  const offenders: (CoordToolRow & TierVerdict)[] = [];
  const exemptions: { name: string; reason: string }[] = [];
  const capabilityExempt: string[] = [];
  const seen = new Set<string>();

  for (const row of input.rows) {
    if (!row.name.startsWith(COORD_TOOL_PREFIX)) continue;
    seen.add(row.name);
    if (row.exemption) exemptions.push({ name: row.name, reason: row.exemption.trim() });
    if (isTierExemptCapability(row.capability) && !row.exemption) capabilityExempt.push(row.name);

    const verdict = judgeCoordBehaviour(row, input.tiered);
    if (!verdict) continue;
    // Grandfathering forgives ONLY the absent-tier case, never a broken exemption.
    if (verdict.rule === 'untiered-coord-behaviour' && baseline.has(row.name)) continue;
    offenders.push({ ...row, ...verdict });
  }

  // A baseline entry that has since earned a tier, gained an exemption, or been
  // retired is dead weight. Reported, never fatal: a stale entry cannot produce a
  // wrong answer, and a red gate blocks the whole fleet for a bookkeeping nit.
  const exempted = new Set(exemptions.map((e) => e.name));
  const unparsed = input.catalogue
    ? [...input.catalogue].filter((n) => n.startsWith(COORD_TOOL_PREFIX) && !seen.has(n)).sort()
    : undefined;
  // A verb the parser never saw must not be read as "retired" — that would turn a
  // broken scanner into a quiet baseline cleanup. Only verbs the scan actually
  // covered can be judged stale, so coverage failures surface as `unparsed` alone.
  const covered = (n: string) => seen.has(n) || (unparsed ? !unparsed.includes(n) : true);
  const staleBaseline = [...baseline]
    .filter((n) => covered(n) && (!seen.has(n) || input.tiered.has(n) || exempted.has(n)))
    .sort();

  return {
    offenders,
    staleBaseline,
    exemptions,
    capabilityExempt: capabilityExempt.sort(),
    scanned: seen.size,
    ...(unparsed ? { unparsed } : {}),
  };
}

/** How far into a `defineTool({` literal to look. Clamped to the next call site. */
const HEAD_WINDOW = 8000;

/**
 * Parse a source file into its coordination-tool rows. Pure (text -> rows).
 *
 * Region attribution mirrors `parseToolDefs` in check-no-bespoke-state-read.mjs:
 * a tool owns from its `defineTool({` to whichever comes first, the next
 * `defineTool` or HEAD_WINDOW chars. That is what makes a marker in a multi-tool
 * file unambiguously OWNED by the literal containing it.
 */
export function parseCoordToolDefs(text: string): CoordToolRow[] {
  const out: CoordToolRow[] = [];
  const re = /defineTool\s*\(\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const next = text.indexOf('defineTool', m.index + 1);
    const end = next === -1 ? Math.min(text.length, m.index + HEAD_WINDOW) : Math.min(next, m.index + HEAD_WINDOW);
    const region = text.slice(m.index, end);
    const name = /\bname:\s*['"]([^'"]+)['"]/.exec(region)?.[1] ?? null;
    if (!name || !name.startsWith(COORD_TOOL_PREFIX)) continue;
    out.push({
      name,
      capability: /\bcapability:\s*['"]([^'"]+)['"]/.exec(region)?.[1] ?? null,
      exemption: NO_COORD_TIER_RE.exec(region)?.[1]?.trim() ?? null,
    });
  }
  return out;
}

/**
 * Slice out the VALUE of a `seeAlso:` property, in either of its two shapes.
 *
 * WHY THIS EXISTS — it closes a gap the census documents as a known undercount.
 * `deriveSeeAlsoTiers` reads the LIVE registry, where a function-form `seeAlso`
 * is an uninvoked closure whose targets are unknowable; it therefore reports
 * `coord:dispatch` and `coord:glance` as debt they do not owe. In SOURCE the
 * pointers are plain string literals inside the closure body, so a text scan CAN
 * see them. That is the whole reason this gate scans source rather than calling
 * the census's runtime seam.
 *
 * ⚠ IT MUST BE BOUNDED, and that is the load-bearing part. Reading "from
 * `seeAlso:` to the end of the tool" would sweep up every `coord:` verb merely
 * NAMED in a neighbouring `description` or `guidance` string, crediting tier 3 to
 * verbs nothing points at — over-crediting HIDES debt, the one direction this
 * census refuses to be wrong in. So the region ends at the matching bracket.
 *
 * Returns null when the shape is not recognised, which fails SAFE: an unreadable
 * `seeAlso` credits nothing, so the verb stays visible as debt.
 */
export function extractSeeAlsoRegion(region: string, from = 0): string | null {
  const at = region.indexOf('seeAlso:', from);
  if (at === -1) return null;
  let i = at + 'seeAlso:'.length;
  while (i < region.length && /\s/.test(region[i]!)) i++;
  if (i >= region.length) return null;

  // Array form: seeAlso: [ ... ]
  if (region[i] === '[') return balancedSlice(region, i, '[', ']');

  // Function form: seeAlso: (result) => { ... } — take the BODY, not the params.
  const arrow = region.indexOf('=>', i);
  if (arrow === -1) return null;
  let j = arrow + 2;
  while (j < region.length && /\s/.test(region[j]!)) j++;
  if (region[j] === '{') return balancedSlice(region, j, '{', '}');
  // Expression-bodied arrow: bounded window rather than an unbounded tail.
  return region.slice(j, Math.min(region.length, j + 2000));
}

/** Slice from `start` through the matching close, or null if it never closes. */
function balancedSlice(text: string, start: number, open: string, close: string): string | null {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/**
 * Every coordination verb some tool's `seeAlso` points AT, from source text.
 *
 * Credits the LEADING token of an entry only, exactly as the census's
 * `pointerTarget` does: an entry reads `'coord:roster { view:"live" } (the door…)'`
 * and its prose can name other verbs incidentally. Anchoring the match to the
 * opening quote is what makes "leading token" mechanical here.
 */
export function collectSeeAlsoPointers(text: string): Set<string> {
  const out = new Set<string>();
  const re = /defineTool\s*\(\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const next = text.indexOf('defineTool', m.index + 1);
    const end = next === -1 ? Math.min(text.length, m.index + HEAD_WINDOW) : Math.min(next, m.index + HEAD_WINDOW);
    const region = text.slice(m.index, end);
    // A tool may declare seeAlso once; scan from each occurrence to be safe.
    let cursor = 0;
    for (;;) {
      const at = region.indexOf('seeAlso:', cursor);
      if (at === -1) break;
      const value = extractSeeAlsoRegion(region, at);
      cursor = at + 'seeAlso:'.length;
      if (!value) continue;
      for (const hit of value.matchAll(/['"`]\s*(coord:[a-zA-Z0-9_-]+)/g)) out.add(hit[1]!);
    }
  }
  return out;
}

/**
 * The tier set the gate judges against: derived tier 3 (from source pointers)
 * merged UNDER the explicit 1–2, matching `resolveTierDeclarations`' rule that
 * an explicit declaration always wins.
 */
export function resolveTieredSet(
  pointers: ReadonlySet<string>,
  explicit: ReadonlyMap<string, TierDeclaration> = DECLARED_COORD_TIERS,
): Set<string> {
  const out = new Set(pointers);
  for (const [id] of explicit) out.add(id);
  return out;
}

/**
 * IO seam: read the tool sources and run the gate over them.
 *
 * Kept apart from every pure function above so the judging logic is unit-testable
 * with no filesystem, and so a caller cannot accidentally judge a hand-built row
 * set against a different tier source than the scan produced.
 *
 * Pointers are collected across BOTH roots before judging, because a coord verb
 * is most often surfaced by a tool in another group — narrowing the sources first
 * would drop exactly those cross-group pointers (the census makes the same point
 * about deriving over the whole registry rather than the coord slice).
 */
export async function scanCoordTierGate(repoRoot: string): Promise<TierGateResult> {
  const { readFile } = await import('node:fs/promises');
  const { buildBuiltinToolCatalog, buildBuiltinToolSourceFiles } = await import('../static-tool-catalog');
  const { selectCoordBehaviours } = await import('./enforcement-tier-census');
  const files = buildBuiltinToolSourceFiles(repoRoot);

  const rows: CoordToolRow[] = [];
  const pointers = new Set<string>();
  for (const f of files) {
    const text = await readFile(f, 'utf8').catch(() => null);
    if (text === null) continue;
    for (const row of parseCoordToolDefs(text)) rows.push({ ...row, file: f });
    for (const p of collectSeeAlsoPointers(text)) pointers.add(p);
  }

  return judgeCoordTierGate({
    rows,
    tiered: resolveTieredSet(pointers),
    catalogue: selectCoordBehaviours(buildBuiltinToolCatalog(repoRoot)),
  });
}
