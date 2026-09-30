/**
 * stat-proof-block.ts — the PURE renderer behind `npm run stats:proof`.
 *
 * WHY THIS EXISTS (WI-35490)
 * The pitch deck promises "every figure is measured from the repository and the
 * live database, and reproducible on request." Nothing delivered that promise, so
 * the figures were re-derived by hand each time — and one of them was published
 * wrong in the most damaging possible direction:
 *
 *   slide 11:  113,527 — COORDINATION EVENTS / ALL TIME
 *   re-measured 2026-08-08:  108,086
 *
 * `harness_shared.coord_event_log` is retention-swept, so a cumulative count over
 * it goes DOWN over time. A reader who takes the deck up on "reproducible on
 * request" gets a smaller number than the slide, under a label ("all time") that
 * implies it can only grow. The two readings available to them are "he inflated
 * it" or "he does not understand his own instrumentation". The truth is neither.
 *
 * Worse than mislabelled: that table is not swept on ONE horizon, it is swept on
 * four (notify 3d, federated messages 7d, escalations 14d, operator messages 30d
 * — see agent-tools/coordination/{notify,message-log,escalation-log}-gc.ts). A
 * single cumulative total across it is therefore not a badly-labelled quantity,
 * it is not a coherent quantity at all.
 *
 * THE GUARD IS THE POINT — not the corrected number.
 * A one-off fix leaves the trap armed for whoever assembles the next deck. So the
 * unsafe figure is made UNREPRESENTABLE rather than merely corrected:
 *
 *   1. There is no `all-time` member of `WindowKind`. A cumulative ledger total
 *      cannot be constructed, so it cannot be rendered. This is a type-level
 *      guarantee, not a lint.
 *   2. A `since-observed` window over a table with ANY known retention horizon is
 *      REFUSED at runtime (`UnqualifiedCumulativeError`) — that is the exact shape
 *      of the bad tile.
 *   3. A trailing window WIDER than the source table's shortest GC horizon is
 *      silently partial (rows in the tail are already swept), so it renders as a
 *      FLOOR: `≥ 25,711`. A floor cannot be contradicted downward by a later
 *      re-measurement, which is precisely the failure being designed out.
 *
 * Retention horizons are passed IN by the caller, which reads them from the GC
 * modules' exported constants — so if someone retunes retention, this module's
 * output follows automatically instead of quietly going stale.
 *
 * Pure by construction: no db, no fs, no clock. Everything is an argument, so the
 * guard is unit-testable (stat-proof-block.test.ts) without a live database.
 */

/** Milliseconds in a day. */
const MS_PER_DAY = 86_400_000;

/**
 * How a measured figure is bounded in time.
 *
 * DELIBERATELY MISSING: an `all-time` / `cumulative` variant. Its absence is the
 * primary guard in this module — see the header. Do not add one; if you need a
 * lifetime total, the source table must first be proven never-swept, and even then
 * `since-observed` with `reachesProjectStart: true` states it honestly.
 */
export type WindowKind =
  /** A trailing window: "the last N days". Always honest; may be a floor. */
  | { kind: 'trailing'; days: number }
  /**
   * "Since the oldest row we can still see." Honest ONLY when the table is not
   * swept — otherwise the oldest visible row is an artifact of the sweep, not of
   * when the data began.
   */
  | { kind: 'since-observed'; oldestRow: Date; reachesProjectStart: boolean }
  /** A point-in-time repository measurement (git). Not time-bounded; always exact. */
  | { kind: 'repo-snapshot' };

/** A figure measured from the live ledger (Postgres). */
export interface LedgerFigure {
  /** Stable id, for tests and for the CLI to address a specific tile. */
  id: string;
  /** Human label as it appears under the number. */
  label: string;
  value: number;
  window: WindowKind;
  /** Table the figure is measured from, named in the footnote for reproducibility. */
  sourceTable: string;
  /**
   * Retention horizons (in days) known to sweep `sourceTable`. Read from the GC
   * modules' exported constants by the caller so this cannot drift. Empty or
   * omitted asserts the table is never swept — which the guard takes at its word,
   * so only pass empty when that is actually true.
   */
  retentionHorizonsDays?: number[];
}

/** A figure measured from the repository (git). Always exact. */
export interface RepoFigure {
  id: string;
  label: string;
  value: number;
  /** Optional sub-label, e.g. "11,495 FILES". */
  detail?: string;
}

/** Thrown when a caller tries to publish a cumulative total over a swept table. */
export class UnqualifiedCumulativeError extends Error {
  constructor(figure: LedgerFigure, horizons: number[]) {
    super(
      `Refusing to publish "${figure.label}" (${figure.id}) as a total since ` +
        `${describeDate(
          (figure.window as { kind: 'since-observed'; oldestRow: Date }).oldestRow,
        )}: ${figure.sourceTable} is retention-swept ` +
        `(horizon${horizons.length === 1 ? '' : 's'} ${horizons.join('d, ')}d), so the ` +
        `oldest visible row reflects the sweep, not when the data began — the count ` +
        `will DECREASE on re-measurement. Use a trailing window instead: ` +
        `{ kind: 'trailing', days: ${Math.min(...horizons)} } is exact; wider is a floor.`,
    );
    this.name = 'UnqualifiedCumulativeError';
  }
}

/** A figure that has passed the guard and carries its own qualifier. */
export interface PublishableFigure {
  id: string;
  label: string;
  /** The number as rendered, e.g. "25,711" or "≥ 25,711". */
  rendered: string;
  /** The time qualifier that MUST accompany it, e.g. "LAST 7 DAYS (FLOOR)". */
  qualifier: string;
  /** True when retention makes the figure a lower bound rather than exact. */
  isFloor: boolean;
  /** Longer explanation for the footnote, when the figure needs one. */
  note?: string;
}

function describeDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Group digits: 1234567 → "1,234,567". */
export function groupDigits(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** Abbreviate a large count for a stat tile: 2405004 → "2.41 M". */
export function abbreviate(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)} M`;
  if (n >= 10_000) return `${Math.round(n / 1000)} K`;
  return groupDigits(n);
}

/**
 * Whole weeks between two instants, floored — so "eighteen weeks" is derived from
 * the first-commit date and cannot go stale the way a hand-typed number does.
 */
export function weeksSince(start: Date, now: Date): number {
  return Math.floor((now.getTime() - start.getTime()) / (7 * MS_PER_DAY));
}

/** Whole days between two instants, floored. */
export function daysSince(start: Date, now: Date): number {
  return Math.floor((now.getTime() - start.getTime()) / MS_PER_DAY);
}

/**
 * Test-to-source ratio, rendered as "0.90:1".
 *
 * `sourceLines` is total lines MINUS test lines, matching how the deck's original
 * 0.72:1 was computed — kept identical so the trend line stays comparable across
 * measurements rather than silently changing basis.
 */
export function formatRatio(testLines: number, nonTestLines: number): string {
  if (nonTestLines <= 0) return 'n/a';
  return `${(testLines / nonTestLines).toFixed(2)}:1`;
}

/**
 * Apply the guard to one ledger figure and render it with a mandatory qualifier.
 *
 * @throws UnqualifiedCumulativeError when the figure is a total over a swept table.
 */
export function toPublishable(figure: LedgerFigure): PublishableFigure {
  const horizons = (figure.retentionHorizonsDays ?? []).filter((d) => d > 0);
  const { window } = figure;

  if (window.kind === 'repo-snapshot') {
    return {
      id: figure.id,
      label: figure.label,
      rendered: groupDigits(figure.value),
      qualifier: 'MEASURED NOW',
      isFloor: false,
    };
  }

  if (window.kind === 'since-observed') {
    // GUARD 2: a total over a swept table is the exact shape of the bad tile.
    if (horizons.length > 0) throw new UnqualifiedCumulativeError(figure, horizons);
    // Honest only because the table is never swept AND reaches project start.
    return {
      id: figure.id,
      label: figure.label,
      rendered: groupDigits(figure.value),
      qualifier: window.reachesProjectStart
        ? 'ALL TIME (TABLE REACHES FIRST COMMIT)'
        : `SINCE ${describeDate(window.oldestRow)}`,
      isFloor: false,
      note: window.reachesProjectStart
        ? undefined
        : `${figure.sourceTable} begins ${describeDate(
            window.oldestRow,
          )}, after the first commit — stated as "since", not as a lifetime total.`,
    };
  }

  // GUARD 3: a trailing window wider than the shortest sweep horizon is partial,
  // so it is a lower bound. "≥ N" cannot be contradicted by a later re-measure.
  const shortest = horizons.length > 0 ? Math.min(...horizons) : Infinity;
  const isFloor = window.days > shortest;

  return {
    id: figure.id,
    label: figure.label,
    rendered: isFloor ? `≥ ${groupDigits(figure.value)}` : groupDigits(figure.value),
    qualifier: isFloor
      ? `LAST ${window.days} DAYS (FLOOR)`
      : `LAST ${window.days} DAY${window.days === 1 ? '' : 'S'}`,
    isFloor,
    note: isFloor
      ? `${figure.sourceTable} is swept at ${horizons
          .slice()
          .sort((a, b) => a - b)
          .join('d / ')}d, so a ${window.days}-day count omits already-swept rows — ` +
        `reported as a floor, which re-measurement can only exceed.`
      : undefined,
  };
}

/** Everything the renderer needs. All measured by the caller; nothing inferred here. */
export interface StatBlockInput {
  measuredAt: Date;
  firstCommit: Date;
  /**
   * How to DISPLAY the first-commit date. Supply the date as it reads in the
   * commit's own timezone (the `%aI` prefix), because a UTC render silently shifts
   * it: the root commit here is 2026-04-06T21:58-04:00, which `toISOString()`
   * prints as 2026-04-07 — contradicting every deck and bio that says 6 April over
   * a four-minute timezone difference. Arithmetic still uses `firstCommit`.
   */
  firstCommitLabel?: string;
  repo: {
    totalLines: number;
    totalFiles: number;
    testLines: number;
    testFiles: number;
    rustLines: number;
    migrations: number;
    tools: number;
    toolGroups: number;
    blueprints: number;
    /** How the line/file counts were obtained — printed verbatim in the footnote. */
    basis: string;
  };
  ledger: LedgerFigure[];
}

export interface StatBlockOutput {
  text: string;
  figures: PublishableFigure[];
  /** Non-fatal warnings (e.g. figures that had to be reported as floors). */
  warnings: string[];
}

/**
 * Render the full stat block. Throws if any ledger figure fails the guard, so a
 * bad figure fails the COMMAND rather than reaching a slide.
 */
export function renderStatBlock(input: StatBlockInput): StatBlockOutput {
  const { repo, measuredAt, firstCommit } = input;
  const nonTestLines = repo.totalLines - repo.testLines;
  const figures = input.ledger.map(toPublishable);
  const warnings: string[] = [];

  for (const f of figures) {
    if (f.isFloor) warnings.push(`${f.id}: reported as a FLOOR — ${f.note}`);
  }

  const weeks = weeksSince(firstCommit, measuredAt);
  const days = daysSince(firstCommit, measuredAt);

  const lines: string[] = [];
  lines.push('PAPERCUSP — MEASURED STAT BLOCK');
  lines.push('='.repeat(72));
  lines.push('');
  lines.push(
    `Built since ${input.firstCommitLabel ?? describeDate(firstCommit)} — ${weeks} weeks ` +
      `(${days} days) as of ${describeDate(measuredAt)}.`,
  );
  lines.push('');
  lines.push('REPOSITORY');
  lines.push('-'.repeat(72));
  lines.push(
    `  ${abbreviate(repo.totalLines).padEnd(12)} LINES TS/TSX          ${groupDigits(repo.totalFiles)} files`,
  );
  lines.push(
    `  ${abbreviate(repo.testLines).padEnd(12)} LINES OF TESTS        ${groupDigits(repo.testFiles)} test files`,
  );
  lines.push(
    `  ${formatRatio(repo.testLines, nonTestLines).padEnd(12)} TEST-TO-SOURCE RATIO  against ${groupDigits(nonTestLines)} non-test lines`,
  );
  lines.push(`  ${groupDigits(repo.rustLines).padEnd(12)} LINES RUST            desktop shell`);
  lines.push(`  ${groupDigits(repo.migrations).padEnd(12)} SCHEMA MIGRATIONS`);
  lines.push(
    `  ${groupDigits(repo.tools).padEnd(12)} AGENT TOOLS           across ${repo.toolGroups} groups`,
  );
  lines.push(`  ${groupDigits(repo.blueprints).padEnd(12)} BLUEPRINTS`);
  lines.push('');
  lines.push('LIVE LEDGER');
  lines.push('-'.repeat(72));
  for (const f of figures) {
    lines.push(`  ${f.rendered.padEnd(12)} ${f.label}`);
    lines.push(`  ${' '.repeat(12)} ${f.qualifier}`);
  }
  lines.push('');
  lines.push('BASIS');
  lines.push('-'.repeat(72));
  lines.push(`  Measured ${measuredAt.toISOString()}.`);
  lines.push(`  Lines/files: ${repo.basis}`);
  lines.push('  Ledger figures: read-only SQL against the operator Postgres.');
  for (const f of figures) {
    if (f.note) lines.push(`  ${f.id}: ${f.note}`);
  }
  lines.push('  Reproduce: npm run stats:proof');
  lines.push('');

  return { text: lines.join('\n'), figures, warnings };
}
