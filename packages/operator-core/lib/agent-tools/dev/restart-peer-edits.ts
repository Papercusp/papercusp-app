/**
 * EI-24790218658923698 — a restart is a deploy of the WHOLE working tree the unit boots
 * from, peers' uncommitted edits included.
 *
 * Measured 2026-10-01 15:04Z: restarting bg-host to load one agent's fix also booted a
 * peer's half-finished `z.custom` in `agent-tools/plans/rubric-template.ts`. The tool
 * catalog throws at import on an args schema that cannot be represented in JSON Schema
 * (deliberately — see `toArgsJsonSchema` in `@papercusp/tooldef`), so bg-host
 * crash-looped (NRestarts=5) while `dev:restart` had answered `restarted: true`.
 *
 * Why an ADVISORY and not a refusal: a dozen or more agents hold edit locks in the
 * canonical tree at any moment (19 live at 2026-10-02 04:50Z), so a block would fire on
 * nearly every restart and be overridden by reflex. What the restarting agent actually
 * lacked was the SUSPECT LIST — which files someone else is mid-edit on right now — so a
 * host that does not come back is diagnosed in one read instead of a journal hunt.
 *
 * Why not import-smoke the catalog before restarting: measured 2026-10-02 04:47Z,
 * importing `agent-tools/index.ts` under tsx had not finished after 8 minutes on the
 * loaded box. A preflight that costs more than the outage it prevents is not a guard.
 *
 * Source of truth is the lock plane (`live-lock-paths.ts`): the PreToolUse edit hook takes
 * a lock on every Edit/Write, so a live lock held by ANOTHER owner is the automatic signal
 * of an in-flight edit. Only locks whose coordination domain IS the booted tree (or a
 * submodule inside it) count. A lock recorded against another checkout is not loaded by
 * this unit, and that is also what keeps clean deploy checkouts (release, staging) empty.
 */
import { execFile } from 'node:child_process';
import { isAbsolute, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { liveLockHoldingsStrict, type LiveLockHolding } from '../locks/live-lock-paths';

/** How many files the result lists by name; `total` always carries the full count. */
export const PEER_IN_FLIGHT_EDITS_LIST_LIMIT = 10;

const SOURCE_FILE_RE = /\.(?:[cm]?[jt]sx?|json)$/i;
const TEST_FILE_RE = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$)|(?:^|\/)__tests__\//i;

export interface PeerInFlightEdit {
  /** Path relative to `tree`. */
  path: string;
  owner: string;
  intent: string;
}

export interface PeerInFlightEdits {
  /** false ⇒ no verdict (tree or lock plane unreadable). Never read as "no peer edits". */
  checked: boolean;
  /** The git root this unit boots from, when it could be resolved. */
  tree: string | null;
  /** Every matching file, before the list limit. */
  total: number;
  files: PeerInFlightEdit[];
  /** Why `checked` is false. */
  reason?: string;
}

function normalizeDir(dir: string): string {
  const trimmed = dir.trim();
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, '') : trimmed;
}

/** `child` relative to `parent` when it lies strictly inside it, else null. */
function relativeInside(parent: string, child: string): string | null {
  const rel = relative(parent, child).split(sep).join('/');
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return null;
  return rel;
}

/**
 * Pure selection: the source files under `tree` that another owner holds a live edit
 * lock on. A holding with no coordination domain is skipped, because its path cannot be
 * placed in any tree with confidence.
 */
export function selectPeerInFlightEdits(input: {
  holdings: readonly LiveLockHolding[];
  tree: string;
  selfOwner: string | null;
  limit?: number;
}): { total: number; files: PeerInFlightEdit[] } {
  const tree = normalizeDir(input.tree);
  const byPath = new Map<string, PeerInFlightEdit>();
  for (const holding of input.holdings) {
    if (input.selfOwner && holding.owner === input.selfOwner) continue;
    const domain = holding.coordinationDomain ? normalizeDir(holding.coordinationDomain) : '';
    if (!domain) continue;
    const path = holding.path.trim().replace(/^\.\/+|\/+$/g, '');
    if (!path) continue;
    let treePath: string;
    if (domain === tree) {
      treePath = path;
    } else {
      const prefix = relativeInside(tree, domain);
      if (!prefix) continue;
      treePath = `${prefix}/${path}`;
    }
    if (!SOURCE_FILE_RE.test(treePath) || TEST_FILE_RE.test(treePath)) continue;
    if (!byPath.has(treePath)) {
      byPath.set(treePath, { path: treePath, owner: holding.owner, intent: holding.intent });
    }
  }
  const all = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  return { total: all.length, files: all.slice(0, input.limit ?? PEER_IN_FLIGHT_EDITS_LIST_LIMIT) };
}

export interface PeerInFlightEditsDeps {
  readHoldings?: () => Promise<LiveLockHolding[]>;
  resolveTreeRoot?: (workingDirectory: string) => Promise<string | null>;
}

const defaultResolveTreeRoot = async (workingDirectory: string): Promise<string | null> => {
  const { stdout } = await promisify(execFile)('git', ['rev-parse', '--show-toplevel'], {
    cwd: workingDirectory,
    timeout: 3000,
  });
  const root = String(stdout).trim();
  return root && isAbsolute(root) ? root : null;
};

/**
 * Read the peer in-flight edits for the tree a unit boots from. Fails SOFT to
 * `checked:false` with a reason: this is advisory and must never block or break a restart.
 */
export async function readPeerInFlightEdits(
  workingDirectory: string | null,
  selfOwner: string | null,
  deps: PeerInFlightEditsDeps = {},
): Promise<PeerInFlightEdits> {
  if (!workingDirectory) {
    return { checked: false, tree: null, total: 0, files: [], reason: 'unit WorkingDirectory unknown' };
  }
  let tree: string | null;
  try {
    tree = await (deps.resolveTreeRoot ?? defaultResolveTreeRoot)(workingDirectory);
  } catch (e) {
    const msg = e instanceof Error ? e.message.split('\n')[0] : String(e);
    return { checked: false, tree: null, total: 0, files: [], reason: `git root unreadable: ${msg}` };
  }
  if (!tree) return { checked: false, tree: null, total: 0, files: [], reason: 'not inside a git checkout' };
  let holdings: LiveLockHolding[];
  try {
    holdings = await (deps.readHoldings ?? liveLockHoldingsStrict)();
  } catch (e) {
    const msg = e instanceof Error ? e.message.split('\n')[0] : String(e);
    return { checked: false, tree, total: 0, files: [], reason: `lock plane unreadable: ${msg}` };
  }
  return { checked: true, tree, ...selectPeerInFlightEdits({ holdings, tree, selfOwner }) };
}

/** One sentence for the restart note, or '' when there is nothing to say. */
export function peerInFlightEditsNote(edits: PeerInFlightEdits | null, unit: string): string {
  if (!edits || !edits.checked || edits.total === 0) return '';
  const named = edits.files
    .slice(0, 3)
    .map((f) => `${f.path} (${f.owner})`)
    .join(', ');
  const more = edits.total > 3 ? ` and ${edits.total - 3} more` : '';
  return (
    ` ⚠ ${edits.total} source file(s) in ${edits.tree} are mid-edit by other agents and boot as they stand: ` +
    `${named}${more}. If ${unit} does not stay up, check these first (peerInFlightEdits).`
  );
}
