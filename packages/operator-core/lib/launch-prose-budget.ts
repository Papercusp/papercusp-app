/**
 * launch-prose-budget — the shrink-only ceiling on every PROSE surface an agent pays
 * for at launch (agent-launch-context-cost-2026-09-18 P-004).
 *
 * THE CLASS THIS KILLS, and why it is a sibling of `claude-seed-wire-budget` rather
 * than a second copy of it. That budget governs the TOOLS half of a launch payload —
 * the JSON schemas the MCP seed advertises. Measured 2026-09-18, a psu Claude launch
 * is roughly 50/50 tools and PROSE, and nothing at all governed the prose half: the
 * playbook render, the spliced project guide, and the compaction protocol each grew
 * one well-argued paragraph at a time, with no total. A per-paragraph justification
 * process with no aggregate is not a budget, and it drifts in one direction only.
 *
 * WHAT IS ALREADY CAPPED — and therefore deliberately NOT re-capped here. Two of the
 * four surfaces the plan item named as "uncapped" already carry an ENFORCED bound,
 * and adding a second ceiling over them would be the parallel-system smell, not a fix:
 *
 *   - THE CARRY DOC is bounded by `CARRY_DOC_BUDGET_FRACTION` (10% of the effective
 *     window) with a per-slot bound audit (`CARRY_DOC_SLOTS`) and an aging/shed ladder
 *     that drops sections to pointers when the assembly exceeds it. It is enforced at
 *     assembly time, derives from the actual window rather than a pinned constant, and
 *     is invariant in session length by construction. Nothing to add.
 *   - THE PROJECTED PROJECT GUIDE is bounded by `PROJECTION_BUDGET_CHARS` (160,000) in
 *     scripts/project-doc-parts.mjs, which physically cannot be exceeded — it degrades
 *     by dropping the lowest-priority parts and reports what it cut.
 *
 * So why does the guide appear below at all? Because that 160,000-char bound is a
 * CATASTROPHE FLOOR, not a ratchet: the guide measured 121,670 B on 2026-09-18, which
 * leaves ~38,000 chars of headroom a growing document can consume silently and legally.
 * The ceiling here fails LOUDLY at the current size, long before the projector's bound
 * would start silently deleting guidance. The two are complementary, not redundant —
 * one prevents growth, the other prevents catastrophe — and that division is the whole
 * reason this module does not simply ratchet PROJECTION_BUDGET_CHARS down instead.
 *
 * FIVE VERDICTS, and three of them are failures that a naive "bytes <= ceiling" check
 * would report as green. A budget guard is an UPPER bound, and an upper bound is
 * satisfied trivially by a measurement that collapsed:
 *
 *   ok           measured, under its ceiling.
 *   over         measured, over its ceiling — the regression this exists to catch.
 *   implausible  measured BELOW its floor. A render that threw, a path that moved, a
 *                guide that failed to resolve: all produce a tiny number that reads as
 *                a spectacular win. The floor is the vacuous-green trap.
 *   unmeasured   a ceiling exists and NOTHING measured it. This is how a guard dies
 *                quietly — the surface is renamed or the renderer is refactored, the
 *                measurement silently stops being produced, and the gate goes green
 *                forever while the thing it guards grows unobserved.
 *   unbaselined  a surface was measured with no declared ceiling. A new launch prose
 *                surface must be declared, not absorbed.
 *
 * Pure by construction (measurements in, verdicts out) so the falsifiability tests can
 * drive every branch without a filesystem; the IO shell is scripts/check-launch-prose-budget.ts.
 */

/** One surface measured from its live source. */
export interface ProseSurfaceMeasurement {
  /** Stable key, matched against a ceiling's `surface`. */
  surface: string;
  bytes: number;
  /** Where the bytes came from — a path, or a description of the render. */
  source: string;
}

/** The declared, shrink-only bound for one surface. */
export interface ProseSurfaceCeiling {
  surface: string;
  /** Upper bound in bytes. Lowered by `--ratchet`; NEVER raised by it. */
  ceilingBytes: number;
  /**
   * Lower plausibility bound. NOT a target and not a ratchet participant — it exists
   * solely so a collapsed measurement (empty render, missing file, failed splice)
   * fails instead of reading as a win. Set it far below any plausible reduction.
   */
  floorBytes: number;
  /** Why this surface is governed, and what a reader should do before raising it. */
  note: string;
  /**
   * Optional provenance for a surface that was found the hard way. Recorded because
   * "how did we learn this surface existed" is the part that decays first, and for
   * `project-guide:agents-md` the answer is the gate's own `unbaselined` branch — which
   * is the evidence that branch earns its keep.
   */
  surfaceDiscovered?: string;
}

export interface ProseBudgetBaseline {
  schemaVersion: 1;
  /** When the ceilings were last ratcheted, for the audit trail. */
  generatedAt: string;
  ceilings: ProseSurfaceCeiling[];
}

export type ProseBudgetStatus = 'ok' | 'over' | 'implausible' | 'unmeasured' | 'unbaselined';

export interface ProseSurfaceVerdict {
  surface: string;
  status: ProseBudgetStatus;
  /** null for `unmeasured` — there is no measurement to report. */
  bytes: number | null;
  /** null for `unbaselined` — there is no ceiling to report. */
  ceilingBytes: number | null;
  floorBytes: number | null;
  /** ceiling − bytes; null when either side is missing. Negative means over. */
  headroomBytes: number | null;
  source: string | null;
  message: string;
}

export interface ProseBudgetReport {
  ok: boolean;
  verdicts: ProseSurfaceVerdict[];
  /** Total measured bytes across every surface that produced a measurement. */
  totalMeasuredBytes: number;
  /** Total of every declared ceiling — the budget the launch path is allowed. */
  totalCeilingBytes: number;
  failures: ProseSurfaceVerdict[];
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * Compare live measurements against the declared ceilings.
 *
 * Every surface on EITHER side produces a verdict: a ceiling with no measurement is
 * `unmeasured` and a measurement with no ceiling is `unbaselined`, and both are
 * failures. That symmetry is the point — it makes the guard unable to go green by
 * measuring less than it declared, which is the failure mode a pure upper-bound check
 * cannot detect.
 */
export function compareProseBudget(
  measurements: readonly ProseSurfaceMeasurement[],
  baseline: ProseBudgetBaseline,
): ProseBudgetReport {
  const byCeiling = new Map<string, ProseSurfaceCeiling>();
  for (const c of baseline.ceilings) byCeiling.set(c.surface, c);
  const byMeasurement = new Map<string, ProseSurfaceMeasurement>();
  for (const m of measurements) byMeasurement.set(m.surface, m);

  const verdicts: ProseSurfaceVerdict[] = [];

  // Declared order first, so the report reads like the baseline file.
  for (const c of baseline.ceilings) {
    const m = byMeasurement.get(c.surface);
    if (!m) {
      verdicts.push({
        surface: c.surface,
        status: 'unmeasured',
        bytes: null,
        ceilingBytes: c.ceilingBytes,
        floorBytes: c.floorBytes,
        headroomBytes: null,
        source: null,
        message:
          `no measurement was produced for "${c.surface}", which has a declared ceiling of ` +
          `${fmt(c.ceilingBytes)} B. A guard that stops measuring a surface goes green forever — ` +
          `restore the measurement, or remove the ceiling deliberately.`,
      });
      continue;
    }
    if (!Number.isFinite(m.bytes) || m.bytes < c.floorBytes) {
      verdicts.push({
        surface: c.surface,
        status: 'implausible',
        bytes: m.bytes,
        ceilingBytes: c.ceilingBytes,
        floorBytes: c.floorBytes,
        headroomBytes: c.ceilingBytes - m.bytes,
        source: m.source,
        message:
          `"${c.surface}" measured ${fmt(m.bytes)} B, BELOW its plausibility floor of ` +
          `${fmt(c.floorBytes)} B (source: ${m.source}). This is far more likely to be a broken ` +
          `measurement — a render that threw, a path that moved, a splice that produced nothing — ` +
          `than a real reduction. Verify the surface actually renders before treating it as a win.`,
      });
      continue;
    }
    if (m.bytes > c.ceilingBytes) {
      verdicts.push({
        surface: c.surface,
        status: 'over',
        bytes: m.bytes,
        ceilingBytes: c.ceilingBytes,
        floorBytes: c.floorBytes,
        headroomBytes: c.ceilingBytes - m.bytes,
        source: m.source,
        message:
          `"${c.surface}" is ${fmt(m.bytes)} B, over its ceiling of ${fmt(c.ceilingBytes)} B by ` +
          `${fmt(m.bytes - c.ceilingBytes)} B (source: ${m.source}). Every agent pays this on every ` +
          `launch. Reduce the prose, or relocate it behind a pointer — raising the ceiling is a ` +
          `budget decision that needs a stated reason, not a chore.`,
      });
      continue;
    }
    verdicts.push({
      surface: c.surface,
      status: 'ok',
      bytes: m.bytes,
      ceilingBytes: c.ceilingBytes,
      floorBytes: c.floorBytes,
      headroomBytes: c.ceilingBytes - m.bytes,
      source: m.source,
      message: `${fmt(m.bytes)} B / ${fmt(c.ceilingBytes)} B (${fmt(c.ceilingBytes - m.bytes)} B headroom)`,
    });
  }

  for (const m of measurements) {
    if (byCeiling.has(m.surface)) continue;
    verdicts.push({
      surface: m.surface,
      status: 'unbaselined',
      bytes: m.bytes,
      ceilingBytes: null,
      floorBytes: null,
      headroomBytes: null,
      source: m.source,
      message:
        `"${m.surface}" measured ${fmt(m.bytes)} B but has no declared ceiling. A new launch prose ` +
        `surface must be declared in the baseline with a stated reason, not absorbed silently.`,
    });
  }

  const failures = verdicts.filter((v) => v.status !== 'ok');
  return {
    ok: failures.length === 0,
    verdicts,
    totalMeasuredBytes: measurements.reduce((a, m) => a + (Number.isFinite(m.bytes) ? m.bytes : 0), 0),
    totalCeilingBytes: baseline.ceilings.reduce((a, c) => a + c.ceilingBytes, 0),
    failures,
  };
}

export interface RatchetResult {
  baseline: ProseBudgetBaseline;
  lowered: Array<{ surface: string; from: number; to: number; savedBytes: number }>;
  /** Surfaces whose measurement was at or above the ceiling — left untouched. */
  unchanged: string[];
  /**
   * Surfaces skipped because the measurement is below the plausibility floor. Ratcheting
   * to a collapsed measurement would BAKE IN the broken reading as the new ceiling, and
   * every later run would then compare against it and pass.
   */
  skippedImplausible: string[];
}

/**
 * The allowance a ratcheted ceiling keeps above the measurement. The historical rule
 * rounded UP to the next whole kilobyte, but that can leave only a few bytes of slack
 * when the measurement is near a boundary. A shared prose gate needs a small, explicit
 * reserve for ordinary edits, so the ratchet now keeps at least one kilobyte above the
 * measurement while retaining the whole-kilobyte rounding rule where it gives more.
 *
 * WHY NOT ZERO. A zero-slack ceiling is the literal reading of "seeded at the current
 * measured size", and it is the wrong engineering call for a SHARED gate: a typo fix or
 * a three-word clarification that nets +8 B would red the tree for the whole fleet, and
 * `--ratchet` could not clear it (it only lowers), so the remedy would be a manual
 * ceiling raise — turning every prose touch-up into a budget negotiation. The growth
 * class this guard exists to catch is not measured in bytes: a new paragraph is ~1 KB and
 * a new section several, both of which still red at this granularity. The allowance buys
 * ordinary editing and gives up nothing real.
 *
 * The minimum is deliberately applied before the down-only comparison: re-running it on
 * an unchanged tree produces a byte-identical baseline instead of oscillating, while a
 * measurement near a granularity boundary can no longer collapse the reserve to a few
 * bytes.
 */
export const RATCHET_GRANULARITY_BYTES = 1_000;
export const RATCHET_MINIMUM_HEADROOM_BYTES = 1_000;

/**
 * The ceiling a measurement ratchets to: the next whole kilobyte at or above it, with a
 * minimum reserve for ordinary edits. The explicit maximum is important: rounding alone
 * gives less than the reserve for every non-multiple of the granularity.
 */
export function ceilingForMeasurement(bytes: number, granularity = RATCHET_GRANULARITY_BYTES): number {
  return Math.max(
    Math.ceil(bytes / granularity) * granularity,
    bytes + RATCHET_MINIMUM_HEADROOM_BYTES,
  );
}

/**
 * Lower each ceiling toward its current measurement. STRICTLY DOWN-ONLY: a proposed
 * ceiling at or above the current one leaves it untouched, so the ratchet can never be
 * used to absorb a regression. Raising a ceiling is a deliberate edit to the baseline
 * file with a stated reason — that asymmetry is what makes this a ratchet rather than a
 * rubber stamp.
 */
export function ratchetCeilings(
  baseline: ProseBudgetBaseline,
  measurements: readonly ProseSurfaceMeasurement[],
  now: Date = new Date(),
  granularity = RATCHET_GRANULARITY_BYTES,
): RatchetResult {
  const byMeasurement = new Map<string, ProseSurfaceMeasurement>();
  for (const m of measurements) byMeasurement.set(m.surface, m);

  const lowered: RatchetResult['lowered'] = [];
  const unchanged: string[] = [];
  const skippedImplausible: string[] = [];

  const ceilings = baseline.ceilings.map((c) => {
    const m = byMeasurement.get(c.surface);
    if (!m || !Number.isFinite(m.bytes)) {
      unchanged.push(c.surface);
      return c;
    }
    if (m.bytes < c.floorBytes) {
      skippedImplausible.push(c.surface);
      return c;
    }
    const proposed = ceilingForMeasurement(m.bytes, granularity);
    if (proposed >= c.ceilingBytes) {
      unchanged.push(c.surface);
      return c;
    }
    lowered.push({ surface: c.surface, from: c.ceilingBytes, to: proposed, savedBytes: c.ceilingBytes - proposed });
    return { ...c, ceilingBytes: proposed };
  });

  return {
    baseline:
      lowered.length > 0
        ? { ...baseline, generatedAt: now.toISOString(), ceilings }
        : baseline,
    lowered,
    unchanged,
    skippedImplausible,
  };
}

/**
 * A literal that MUST appear in a composed render, and what its absence means.
 *
 * WHY A CONTENT CHECK AND NOT JUST THE BYTE FLOOR. The floor catches a measurement that
 * COLLAPSED; it cannot catch one that merely lost a component. The su playbook render is
 * a chain of splices (base → client overlay → generated sections → compaction protocol →
 * project guide), and any one of them silently producing nothing leaves a render that is
 * still enormous — comfortably above any plausible floor — and simply missing a section.
 * That reads as a large, genuine reduction. A per-component literal turns "the guide
 * stopped splicing" from a celebrated win into a red.
 */
export interface CompositionProbe {
  /** A literal that the composed text must contain. */
  literal: string;
  /** The component it proves is present, named for the failure message. */
  component: string;
}

export interface CompositionVerdict {
  ok: boolean;
  missing: Array<{ component: string; literal: string }>;
  message: string;
}

/** Verify every declared component is actually present in a composed render. */
export function checkComposition(text: string, probes: readonly CompositionProbe[]): CompositionVerdict {
  const missing = probes
    .filter((p) => !text.includes(p.literal))
    .map((p) => ({ component: p.component, literal: p.literal }));
  return {
    ok: missing.length === 0,
    missing,
    message:
      missing.length === 0
        ? `all ${probes.length} component(s) present`
        : `render is MISSING ${missing.map((m) => m.component).join(', ')} — a splice produced nothing. ` +
          `The byte total will have DROPPED, which reads exactly like a successful reduction; it is not. ` +
          `Fix the splice before trusting any number from this run.`,
  };
}

/** Human-readable report body, shared by the CLI and any caller that wants to print it. */
export function renderProseBudgetReport(report: ProseBudgetReport): string {
  const lines: string[] = [];
  for (const v of report.verdicts) {
    const tag =
      v.status === 'ok' ? 'ok  ' : v.status === 'over' ? 'OVER' : v.status === 'implausible' ? 'LOW ' : 'MISS';
    lines.push(`  ${tag}  ${v.surface.padEnd(34)} ${v.message}`);
  }
  lines.push(
    `  ──── total measured ${fmt(report.totalMeasuredBytes)} B against ${fmt(report.totalCeilingBytes)} B of declared ceilings`,
  );
  return lines.join('\n');
}

// ── Edit-time headroom signal (WI-10004682) ─────────────────────────────────────────────
//
// WHY THIS EXISTS. A part edit (`set-doc-part` + `project-doc-parts --write`) can push the
// projected guide — and every su-playbook render that embeds it — over its ceiling, and the
// only thing that said so was `lint:launch-prose-budget` at the GATE: the guide re-breached
// three times in three days (EI-24511252962859723, WI-10004465, WI-10004675), the last one
// seven hours after a ratchet left ~100 B of headroom. `set-doc-part`'s own "projection
// impact" reports headroom against the PROJECTION CUT SET, a different budget from this
// lint ceiling, so its clean-looking number was no help. This reuses the lint's report and
// ceilings — it adds NO second measurement — and only reshapes them into the edit-time
// view: per-surface headroom, optionally after a predicted byte delta.

/**
 * Which budget surfaces a projected client FILE feeds. The su-playbook renders embed the
 * Claude project guide verbatim, so a CLAUDE.md delta moves them too — and they are the
 * TIGHTER surfaces (54 B vs the guide's 102 B at the 2026-10-01 measurement), which is
 * exactly why checking the guide file alone would miss the breach.
 */
export const GUIDE_FILE_SURFACES: Readonly<Record<string, readonly string[]>> = {
  'CLAUDE.md': [
    'project-guide:claude-md',
    'su-playbook-render:engineer:full:claude',
    'su-playbook-render:power:full:claude',
  ],
  'AGENTS.md': ['project-guide:agents-md'],
};

/** Every surface a projection can move — the only ones a projection write is gated on. */
export const PROJECTION_GOVERNED_SURFACES: ReadonlySet<string> = new Set(
  Object.values(GUIDE_FILE_SURFACES).flat(),
);

/** Fan a per-file byte delta (`{ 'CLAUDE.md': +120 }`) out to the surfaces that file feeds. */
export function surfaceDeltasFromFileDeltas(
  fileDeltaBytes: Readonly<Record<string, number>>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [file, delta] of Object.entries(fileDeltaBytes)) {
    for (const surface of GUIDE_FILE_SURFACES[file] ?? []) out[surface] = (out[surface] ?? 0) + delta;
  }
  return out;
}

export interface LaunchProseHeadroomRow {
  surface: string;
  /** Measured bytes plus the predicted delta (0 when none was supplied). */
  afterBytes: number;
  ceilingBytes: number;
  /** ceiling − afterBytes. Negative means over. */
  headroomBytes: number;
  over: boolean;
}

export interface LaunchProseHeadroom {
  rows: LaunchProseHeadroomRow[];
  /** The rows that are over — what a write gate refuses on. */
  over: LaunchProseHeadroomRow[];
  /** Printable lines; every row's line carries the literal `launch-prose headroom: N B`. */
  lines: string[];
}

/**
 * Per-surface headroom after an optional predicted byte delta.
 *
 * A surface with no measurement or no ceiling yields NO row: this is a headroom VIEW, not
 * the gate — `compareProseBudget` already fails `unmeasured`/`unbaselined` loudly, and
 * inventing a number for one here would be exactly the false reading that gate exists to
 * prevent. Restricted to `PROJECTION_GOVERNED_SURFACES` by default so a peer's unrelated
 * prompt growth cannot block a projection write.
 */
export function launchProseHeadroom(
  report: ProseBudgetReport,
  opts: {
    surfaceDeltaBytes?: Readonly<Record<string, number>>;
    surfaces?: ReadonlySet<string>;
  } = {},
): LaunchProseHeadroom {
  const surfaces = opts.surfaces ?? PROJECTION_GOVERNED_SURFACES;
  const rows: LaunchProseHeadroomRow[] = [];
  for (const v of report.verdicts) {
    if (!surfaces.has(v.surface)) continue;
    if (v.bytes === null || v.ceilingBytes === null) continue;
    const afterBytes = v.bytes + (opts.surfaceDeltaBytes?.[v.surface] ?? 0);
    const headroomBytes = v.ceilingBytes - afterBytes;
    rows.push({
      surface: v.surface,
      afterBytes,
      ceilingBytes: v.ceilingBytes,
      headroomBytes,
      over: headroomBytes < 0,
    });
  }
  const lines = rows.map(
    (r) =>
      `  launch-prose headroom: ${fmt(r.headroomBytes)} B  ${r.surface.padEnd(42)} ` +
      `(${fmt(r.afterBytes)} / ${fmt(r.ceilingBytes)} B)${r.over ? `  ← OVER by ${fmt(-r.headroomBytes)} B` : ''}`,
  );
  return { rows, over: rows.filter((r) => r.over), lines };
}
