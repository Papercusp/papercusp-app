/**
 * Package-declared orientation classes (portable-identity-packages-2026-09-26 P-010).
 *
 * The platform orientation registry (`ORIENTATION_CLASS_REGISTRY` in
 * turn-start-orientation.ts) declares one class per `OrientationState` field. An
 * identity package declares its own classes at a sink through `injection` on a
 * blueprint contribution. The sink evaluator (`sink-evaluator.ts`) runs every
 * such contribution under ONE aggregate token + wall-clock budget. This module
 * turns that evaluator's result into orientation classes and renders them into
 * the SAME orientation block, after every platform class.
 *
 * The contract, and why each part holds:
 *
 *   - DISJOINT ID SPACE. A package class id is `package:<identity>/<contribution>`.
 *     It can never equal a platform class id (those are `OrientationState` field
 *     names), so a package cannot shadow, replace or re-order a platform class.
 *   - PLATFORM ROWS ARE UNTOUCHED. The platform half is composed by the unchanged
 *     `composeOrientationBlockWithRows`, and package rows are appended with their
 *     OWN character budget. So adding packages can never evict a platform row or
 *     shift a byte of it. `baseBlock` is exactly the block without packages. A
 *     caller that fingerprints delivery (`fingerprintDeliveredOrientation` matches
 *     marker substrings in the block) must use `baseBlock`, so provider text
 *     cannot spoof a platform delivery receipt.
 *   - DETERMINISTIC ORDER. Classes emit in the evaluator's allocation order,
 *     which is its priority order, starting at {@link PACKAGE_ORIENTATION_ORDER_BASE}.
 *   - VISIBLE FAILURE. A contribution the evaluator did not deliver renders its
 *     omission marker. A row-ceiling or budget cut renders a `+N omitted`
 *     disclosure. Nothing is dropped silently.
 *   - GENERATION FENCE. {@link packageOrientationClasses} returns nothing for a
 *     sink result evaluated under another session, turn or attachment revision
 *     (`isSinkResultCurrent`), so a late or superseded result never renders.
 *   - SINK APPLICABILITY. A class applies only to the sink its invocation ran
 *     for (`turn-start` or `agent-orders`; the structured sinks refuse package
 *     classes at compile time, see `PACKAGE_RENDERABLE_SINKS`).
 */
import {
  composeOrientationBlockWithRows,
  type ComposeOrientationBlockInput,
  type OrientationRow,
  type OrientationSink,
} from '../turn-start-orientation';
import { isSinkResultCurrent, type SinkInvocationResult } from './sink-evaluator';

export type PackageOrientationClassId = `package:${string}`;

export function isPackageOrientationClassId(id: string): id is PackageOrientationClassId {
  return id.startsWith('package:');
}

export function packageOrientationClassId(identityId: string, contributionId: string): PackageOrientationClassId {
  return `package:${identityId}/${contributionId}`;
}

/** Package classes emit after every platform class (the platform registry orders below 10 000). */
export const PACKAGE_ORIENTATION_ORDER_BASE = 10_000;
/** Hard per-class row ceiling. It bounds a multi-line delivery, as a platform class's ceiling does. */
export const PACKAGE_ORIENTATION_MAX_ROWS = 12;
/**
 * The package half's character budget, separate from `ORIENTATION_BUDGET_CHARS`.
 * The evaluator already enforces the token budget; this is the rendering
 * backstop (the default sink budget of 400 tokens is ~1 600 chars, plus row prefixes).
 */
export const PACKAGE_ORIENTATION_BUDGET_CHARS = 2_000;

export interface PackageOrientationClass {
  readonly id: PackageOrientationClassId;
  readonly identityId: string;
  readonly contributionId: string;
  readonly applicableSinks: readonly OrientationSink[];
  readonly order: number;
  readonly rowCeiling: { readonly maxRows: number; readonly recoveryVerb: string };
  /** PURE: the lines this class contributes, bound from the sink result. */
  readonly render: () => string[];
}

export interface PackageOrientationRow {
  readonly classId: PackageOrientationClassId;
  readonly order: number;
  readonly text: string;
}

/** The session, turn and attachment revision the CONSUMER is rendering for. */
export interface PackageRenderFence {
  readonly sessionId: string;
  readonly turnId: string;
  readonly attachmentRevision: string;
}

function deliveryLines(identityId: string, contributionId: string, text: string): string[] {
  const lines = text.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];
  return [`- 📦 ${identityId}/${contributionId}: ${lines[0].trim()}`, ...lines.slice(1).map((line) => `  ${line.trim()}`)];
}

/**
 * PURE: the package classes for one sink result, fenced to the consumer's
 * session, turn and attachment revision. A stale result yields `[]`.
 */
export function packageOrientationClasses(
  result: SinkInvocationResult | null | undefined,
  fence: PackageRenderFence,
): PackageOrientationClass[] {
  if (!result || !isSinkResultCurrent(result, fence)) return [];
  const key = (identityId: string, contributionId: string) => `${identityId}\u0000${contributionId}`;
  const rank = new Map(result.allocation.map((slot, index) => [key(slot.identityId, slot.contributionId), index] as const));
  type Entry = { identityId: string; contributionId: string; priority: number; lines: string[] };
  const entries: Entry[] = [
    ...result.deliveries.map((d) => ({
      identityId: d.identityId, contributionId: d.contributionId, priority: d.priority,
      lines: deliveryLines(d.identityId, d.contributionId, d.text),
    })),
    ...result.omissions.map((o) => ({
      identityId: o.identityId, contributionId: o.contributionId, priority: o.priority,
      lines: [`- ${o.marker}`],
    })),
  ];
  const position = (e: Entry) => rank.get(key(e.identityId, e.contributionId)) ?? Number.MAX_SAFE_INTEGER;
  entries.sort((a, b) =>
    position(a) - position(b) ||
    b.priority - a.priority ||
    a.identityId.localeCompare(b.identityId) ||
    a.contributionId.localeCompare(b.contributionId));
  const recoveryVerb =
    `the full output is in sink invocation ${result.invocation.invocationId}'s delivery receipt; ` +
    'raise the contribution\'s injection.tokenBudget or priority if it must fit';
  return entries.map((entry, index) => {
    const lines = entry.lines;
    return {
      id: packageOrientationClassId(entry.identityId, entry.contributionId),
      identityId: entry.identityId,
      contributionId: entry.contributionId,
      applicableSinks: [result.invocation.sink],
      order: PACKAGE_ORIENTATION_ORDER_BASE + index * 10,
      rowCeiling: { maxRows: PACKAGE_ORIENTATION_MAX_ROWS, recoveryVerb },
      render: () => [...lines],
    };
  });
}

/**
 * PURE: the rows a sink renders from package classes, in emission order, each
 * class bounded by its row ceiling with a visible disclosure for what it cut.
 */
export function projectPackageOrientationRows(
  classes: readonly PackageOrientationClass[],
  sink: OrientationSink,
): PackageOrientationRow[] {
  const rows: PackageOrientationRow[] = [];
  const applicable = classes.filter((c) => c.applicableSinks.includes(sink)).slice().sort((a, b) => a.order - b.order);
  for (const cls of applicable) {
    const lines = cls.render();
    const kept = lines.slice(0, cls.rowCeiling.maxRows);
    for (const text of kept) rows.push({ classId: cls.id, order: cls.order, text });
    const cut = lines.length - kept.length;
    if (cut > 0) {
      rows.push({ classId: cls.id, order: cls.order, text: `- ${cls.id}: +${cut} omitted — ${cls.rowCeiling.recoveryVerb}` });
    }
  }
  return rows;
}

/** PURE: fit package rows into their own budget, disclosing any cut instead of dropping it silently. */
export function fitPackageOrientationRows(
  rows: readonly PackageOrientationRow[],
  budgetChars: number,
): PackageOrientationRow[] {
  const cost = (row: PackageOrientationRow) => row.text.length + 1;
  const total = rows.reduce((sum, row) => sum + cost(row), 0);
  if (total <= budgetChars) return [...rows];
  const kept: PackageOrientationRow[] = [];
  let used = 0;
  for (const row of rows) {
    if (used + cost(row) > budgetChars) break;
    kept.push(row);
    used += cost(row);
  }
  const disclosureFor = (dropped: number): PackageOrientationRow => ({
    classId: rows[kept.length]?.classId ?? rows[rows.length - 1].classId,
    order: rows[kept.length]?.order ?? rows[rows.length - 1].order,
    text: `- 📦 +${dropped} package row(s) omitted — over the ${budgetChars}-char package budget`,
  });
  let disclosure = disclosureFor(rows.length - kept.length);
  while (kept.length > 0 && used + cost(disclosure) > budgetChars) {
    used -= cost(kept.pop()!);
    disclosure = disclosureFor(rows.length - kept.length);
  }
  return used + cost(disclosure) <= budgetChars ? [...kept, disclosure] : kept;
}

export interface ComposeWithPackagesInput extends ComposeOrientationBlockInput {
  readonly packages?: readonly PackageOrientationClass[];
  readonly packageBudgetChars?: number;
}

export interface ComposeWithPackagesResult {
  /** The block the agent receives: the platform block, then the package rows. */
  readonly block: string;
  /** The platform rows that survived the platform budget (unchanged semantics). */
  readonly rows: OrientationRow[];
  readonly packageRows: PackageOrientationRow[];
  /** Exactly the block without packages. Fingerprint delivery against THIS. */
  readonly baseBlock: string;
}

/** The heading `composeOrientationBlockWithRows` opens its block with. */
export const ORIENTATION_BLOCK_HEADER = '## Orientation';

/**
 * PURE: the turn-start block with package classes. The platform half is the
 * unchanged composer. Package rows follow it under their own budget, and are
 * rendered even when the platform half is silent (unchanged or empty), because
 * a package contribution is evaluated and fenced per turn.
 */
export function composeOrientationBlockWithPackages(input: ComposeWithPackagesInput): ComposeWithPackagesResult {
  const platform = composeOrientationBlockWithRows(input);
  return { ...appendPackageOrientationRows(platform.block, input.packages ?? [], input.packageBudgetChars), rows: platform.rows };
}

/**
 * PURE: append package rows to a platform block that was ALREADY composed and
 * staged (the turn-start endpoint composes the platform half inside
 * `buildTurnStartOrientationBlock`, before the package sink settles). The
 * platform bytes are returned unchanged as `baseBlock`.
 */
export function appendPackageOrientationRows(
  platformBlock: string,
  packages: readonly PackageOrientationClass[],
  budgetChars: number = PACKAGE_ORIENTATION_BUDGET_CHARS,
): Omit<ComposeWithPackagesResult, 'rows'> {
  const packageRows = fitPackageOrientationRows(projectPackageOrientationRows(packages, 'turn-start'), budgetChars);
  if (packageRows.length === 0) return { block: platformBlock, packageRows: [], baseBlock: platformBlock };
  const head = platformBlock || ORIENTATION_BLOCK_HEADER;
  return {
    block: [head, ...packageRows.map((row) => row.text)].join('\n'),
    packageRows,
    baseBlock: platformBlock,
  };
}
