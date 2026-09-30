/**
 * One accessibility-tree read, shared by `computer:observe` and by
 * `capability:computer`'s post-action observation (P-007 / P-008, D-010 + D-012).
 *
 * WHY THIS MODULE EXISTS. P-008 makes `capability:computer` return the a11y tree
 * instead of a screenshot when it can, which means two call sites now need the
 * SAME "resolve the bus → walk → build → compress → render" sequence. Forking it
 * would let the two drift — the compression options in particular, where a
 * difference is invisible until an agent gets a different tree from `observe` than
 * from the action it just took.
 *
 * WHY IT TAKES THE EXECUTOR AS AN ARGUMENT. `observe.ts` already imports
 * `computerExec` from `computer.ts`; if this module did the same, `computer.ts`
 * importing it would close a cycle. Passing the executor in keeps the dependency
 * pointing one way (both callers → here → the pure tree module) and is also what
 * lets the unit tests drive it with no live X.
 *
 * WHY A RESULT UNION AND NOT A THROW. `capability:computer` must be able to FALL
 * BACK to pixels when the tree cannot see the screen, and it can only do that if
 * "there is no bus" and "the walker crashed" arrive as values it can branch on.
 * A thrown error would force the caller to parse a message to decide whether the
 * fallback is legitimate — the classic shape that turns a degraded read into a
 * confident wrong answer. Every non-ok reason below is a real, distinct state:
 *
 *   no-bus        — the display advertises no AT-SPI bus at all.
 *   walker-failed — the bus is there but the walker produced no parseable result.
 *   no-apps       — the walk SUCCEEDED and found zero registered applications.
 *                   This is NOT "nothing is running": a toolkit only appears here
 *                   if it exports accessibility (GTK/Qt do; a plain X11 client
 *                   like xterm, a canvas app, or a video does not).
 */
import {
  a11yBusFromRootCommand,
  buildA11yTree,
  compressA11yTree,
  parseA11yBusAddress,
  parseWalkerOutput,
  renderA11yTree,
  screenBoundsAreTrustworthy,
  walkerCommand,
  type A11yNode,
  type CompressStats,
} from './accessibility-tree';
import type { DesktopTarget } from './desktop-driver';

/** The executor seam — structurally the same as `ComputerExec`, declared here so
 *  this module does not import `computer.ts` (see the header). */
export type SnapshotExec = (
  bin: string,
  args: string[],
  opts: { env?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ status: number | null; stdout: Buffer; stderr: string }>;

export interface A11ySnapshotOk {
  ok: true;
  /** The AT-SPI bus address this snapshot was read from — display-scoped (D-011). */
  bus: string;
  apps: number;
  roots: A11yNode[];
  stats: CompressStats;
  /** The rendered, compressed tree — what actually goes to the model. */
  tree: string;
  /** False when the toolkit reports unusable screen coordinates: click by #ref. */
  boundsTrustworthy: boolean;
}

export interface A11ySnapshotMiss {
  ok: false;
  reason: 'no-bus' | 'walker-failed' | 'no-apps';
  /** Human-readable detail, safe to put in a tool result. */
  detail: string;
  /** Present for `no-apps`, which is a SUCCESSFUL walk of an empty bus. */
  bus?: string;
}

export type A11ySnapshot = A11ySnapshotOk | A11ySnapshotMiss;

export interface SnapshotOptions {
  includeHidden?: boolean;
  includeBounds?: boolean;
  maxNodes?: number;
  signal?: AbortSignal;
}

/** Resolve the AT-SPI bus a display advertises on its root window, or null. */
export async function resolveA11yBus(
  display: string,
  exec: SnapshotExec,
  signal?: AbortSignal,
): Promise<string | null> {
  const probe = a11yBusFromRootCommand(display);
  const r = await exec(probe.bin, probe.args, { env: probe.env, ...(signal ? { signal } : {}) });
  return parseA11yBusAddress(r.stdout.toString());
}

/**
 * Read one compressed accessibility snapshot of `target`. Never throws for the
 * three expected "the tree cannot answer" states — those come back as
 * `{ ok: false, reason }` so a caller can fall back to pixels deliberately.
 */
export async function snapshotA11yTree(
  target: DesktopTarget,
  exec: SnapshotExec,
  opts: SnapshotOptions = {},
): Promise<A11ySnapshot> {
  const signal = opts.signal;
  const bus = await resolveA11yBus(target.display, exec, signal);
  if (!bus) {
    return {
      ok: false,
      reason: 'no-bus',
      detail: `${target.display} advertises no accessibility bus on its root window.`,
    };
  }

  const cmd = walkerCommand(target.display, bus);
  const r = await exec(cmd.bin, cmd.args, { env: cmd.env, ...(signal ? { signal } : {}) });
  const parsed = parseWalkerOutput(r.stdout.toString());
  if (!parsed) {
    return {
      ok: false,
      reason: 'walker-failed',
      bus,
      detail:
        `the accessibility walker produced no result on ${target.display} (exit ${r.status}). ` +
        r.stderr.slice(0, 300).trim(),
    };
  }

  if (parsed.apps === 0) {
    return {
      ok: false,
      reason: 'no-apps',
      bus,
      detail:
        'No applications are registered on this desktop\'s accessibility bus. That is NOT the same as ' +
        '"nothing is running": an app only appears here if its toolkit exports accessibility (GTK/Qt do; ' +
        'a plain X11 client like xterm, a canvas app, or a video does not).',
    };
  }

  const built = buildA11yTree(parsed.nodes);
  const { roots, stats } = compressA11yTree(built, {
    includeHidden: opts.includeHidden ?? false,
    ...(opts.maxNodes ? { maxNodes: opts.maxNodes } : {}),
  });
  const tree = renderA11yTree(roots, { includeBounds: opts.includeBounds ?? false });

  return {
    ok: true,
    bus,
    apps: parsed.apps,
    roots,
    stats,
    tree,
    boundsTrustworthy: screenBoundsAreTrustworthy(roots),
  };
}
