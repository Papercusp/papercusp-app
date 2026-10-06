/**
 * Hold restricted writes at git-sync.
 * Plan personal-data-reader-set-labels-2026-10-01 P-014 (WI-10005571), D-006 point 3.
 *
 * Papercusp does not author an agent's file edits the way it authors a coord
 * message, so the seal-at-write rule (P-006 / P-012) cannot reach the working
 * tree. What it does own is the commit: git-sync sweeps the shared tree and
 * pushes it off the machine. So a file an agent wrote while it held an active
 * disclosure is HELD there instead:
 *
 *   A path an agent edited at time t is held when that agent has a disclosure
 *   with delivered_at <= t that is still unreleased. The hold lifts when every
 *   such disclosure is released (D-002 / D-005).
 *
 * The hold is fed to git-sync as extra rows of its live-lock census, the same
 * seam a peer's edit lock uses (git-sync-action.ts → runGitSync liveLockHoldings
 * / refreshLiveLockHoldings). It therefore inherits everything that seam already
 * does: coordinate translation across checkouts and submodules, exclusion from
 * the staging pathspecs, edit-cohort expansion, and the late-lock unstage at the
 * final commit seam. A held path is neither committed nor pushed.
 *
 * WHICH EDITS. The source is harness_shared.edit_attribution_ledger, which records
 * each native edit (Edit / Write / apply_patch …) with its editor and time. For an
 * owner holding an active disclosure, the row is written BEFORE the edit lock is
 * released (`recordRestrictedEditBeforeRelease`, called from locks:release), so
 * there is no instant where git-sync sees neither the lock nor the hold.
 *
 * FAIL CLOSED (D-006 point 6). Both reads throw `disclosure_ledger_unavailable`
 * rather than returning an empty set. git-sync skips the tick on a census read
 * failure, and locks:release refuses (keeping the lock) when the ledger row for a
 * restricted owner cannot be written.
 *
 * WRITES WITH NO LEDGER ROW (WI-10005576). A Bash redirect, `sed -i`, a script or
 * a background job writes without a native edit tool, so it leaves no ledger row
 * and the rule above cannot see it. The second half of the census therefore works
 * from the working tree, not the ledger: while ANY disclosure is unreleased, every
 * changed or untracked file (superproject and submodules) whose mtime falls at or
 * after the earliest unreleased delivery is held — unless a native edit by an
 * editor with no active disclosure, recorded at or after that mtime, accounts for
 * it (`readRestrictedWindowHoldings`). Unattributed writes by anyone in the window
 * are held too: which session made them cannot be known, so the hold fails closed
 * and lifts with the last release. Deletions are never held (they carry nothing
 * off the machine). With no unreleased disclosure this half costs one query.
 */

import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type postgres from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { liveLockHoldingsStrict, type LiveLockHolding } from '../agent-tools/locks/live-lock-paths';
import { DisclosureRefused } from './disclosure-ledger';

type Db = postgres.Sql | postgres.TransactionSql;

/** The intent every restricted hold carries. git-sync renders it in skipped-path diagnostics. */
export const RESTRICTED_HOLD_INTENT =
  'restricted-disclosure hold (D-006/P-014): edited while its editor held an active personal disclosure; held from commit until that disclosure is released';

const RESTRICTED_HOLD_PREFIX = 'restricted-disclosure hold (D-006';

/** True for a census row this module produced (not a real, releasable edit lock). */
export function isRestrictedHoldIntent(intent: string | null | undefined): boolean {
  return typeof intent === 'string' && intent.startsWith(RESTRICTED_HOLD_PREFIX);
}

/**
 * One held path. Structurally a `LiveLockHolding`, so it joins git-sync's census
 * unchanged; `coordinationDomain` is the ledger's `repo_root`, the domain the
 * edit lock was held in, which git-sync translates exactly as it does that lock.
 */
export interface RestrictedEditHolding {
  path: string;
  owner: string;
  intent: string;
  goalRef?: string;
  coordinationDomain?: string;
}

/** A ledger row as `readRestrictedEditHoldings` selects it. */
export interface RestrictedEditRow {
  repo_root: string | null;
  file: string | null;
  agent_id: string | null;
  work_item_id: string | null;
}

/** Map ledger rows to census holdings: one per (domain, path), blanks dropped. Pure. */
export function restrictedHoldingsFromRows(rows: readonly RestrictedEditRow[]): RestrictedEditHolding[] {
  const out: RestrictedEditHolding[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const path = row.file?.trim() ?? '';
    const owner = row.agent_id?.trim() ?? '';
    if (!path || !owner) continue;
    const domain = row.repo_root?.trim() ?? '';
    const key = `${domain}\u0000${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const goalRef = row.work_item_id?.trim() ?? '';
    out.push({
      path,
      owner,
      intent: RESTRICTED_HOLD_INTENT,
      // A work-item seeds git-sync's edit-cohort expansion, so a restricted edit's
      // source+test siblings stay together instead of one reaching HEAD alone.
      ...(goalRef ? { goalRef } : {}),
      ...(domain ? { coordinationDomain: domain } : {}),
    });
  }
  return out;
}

function ledgerUnavailable(what: string, error: unknown): DisclosureRefused {
  return new DisclosureRefused(
    'disclosure_ledger_unavailable',
    `${what}: the disclosure ledger could not be read (${(error as Error)?.message ?? error})`,
  );
}

/**
 * Every path edited by an agent while it held a disclosure that is still active.
 * Driven from the (small) active-disclosure set, so the ledger is reached only
 * through its (agent_id, ts) index (migration 1345). Throws
 * `disclosure_ledger_unavailable` on any read failure: a census that silently
 * read as empty would commit the very files this exists to hold.
 */
export async function readRestrictedEditHoldings(sql: Db = getOrgPg().sql): Promise<RestrictedEditHolding[]> {
  let rows: RestrictedEditRow[];
  try {
    rows = await sql<RestrictedEditRow[]>`
      SELECT DISTINCT ON (l.repo_root, l.file)
             l.repo_root, l.file, l.agent_id, l.work_item_id
        FROM harness_shared.personal_disclosures d
        JOIN harness_shared.edit_attribution_ledger l
          ON l.agent_id = d.agent_owner_id
         AND l.ts >= d.delivered_at
       WHERE d.released_at IS NULL
       ORDER BY l.repo_root, l.file, l.ts DESC`;
  } catch (error) {
    throw ledgerUnavailable('git-sync restricted-write hold', error);
  }
  return restrictedHoldingsFromRows(rows);
}

// ── writes with no ledger row (WI-10005576) ───────────────────────────────

/** The intent of a window hold. Shares the restricted prefix, so git-sync treats it as a hold, not a lock. */
export const RESTRICTED_WINDOW_INTENT =
  'restricted-disclosure hold (D-006/P-014, unattributed write): changed while a personal disclosure was active and not accounted for by a native edit of an unrestricted editor; held until every active disclosure is released';

/** The census `owner` of a window hold: no single session can be named for an unattributed write. */
export const RESTRICTED_WINDOW_OWNER = 'personal-disclosure-window';

/** A native edit recorded this close to (or after) a file's mtime accounts for that write. */
export const RESTRICTED_WINDOW_ATTRIBUTION_SLACK_MS = 2_000;

export type HoldRunGit = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

/** A changed or untracked file: the absolute repository root and the root-relative path. */
export interface DirtyFile {
  root: string;
  path: string;
}

/**
 * Every changed or untracked file of `repoPath` and its initialised submodules
 * (`git submodule status --recursive`, the discovery git-sync itself uses).
 * Deleted paths are skipped. Throws when any git call fails: an unlisted tree
 * would read as "nothing to hold".
 */
export async function listDirtyFilesRecursive(runGit: HoldRunGit, repoPath: string): Promise<DirtyFile[]> {
  const subs = await runGit(['submodule', 'status', '--recursive'], repoPath);
  if (subs.code !== 0) throw new Error(`git submodule status failed in ${repoPath}: ${subs.stderr.trim()}`);
  const submoduleRoots = subs.stdout
    .split('\n')
    .filter((line) => line.length > 1 && line[0] !== '-') // '-' = not initialised
    .map((line) => line.slice(1).trim().split(/\s+/)[1])
    .filter((p): p is string => Boolean(p))
    .map((p) => path.join(repoPath, p));
  const out: DirtyFile[] = [];
  for (const root of [repoPath, ...submoduleRoots]) {
    const status = await runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'], root);
    if (status.code !== 0) throw new Error(`git status failed in ${root}: ${status.stderr.trim()}`);
    const fields = status.stdout.split('\0');
    for (let i = 0; i < fields.length; i += 1) {
      const entry = fields[i];
      if (entry.length < 4) continue;
      const xy = entry.slice(0, 2);
      // -z rename/copy: "XY <to>\0<from>\0" — the next field is the source path.
      if (xy[0] === 'R' || xy[0] === 'C') i += 1;
      if (xy.includes('D')) continue;
      out.push({ root, path: entry.slice(3) });
    }
  }
  return out;
}

export interface RestrictedWindowDeps {
  sql?: Db;
  /** The working tree's changed files (production: `listDirtyFilesRecursive`). */
  listDirtyFiles: () => Promise<DirtyFile[]>;
  /** A file's mtime in ms, or null when it no longer exists. */
  mtimeMs?: (absPath: string) => Promise<number | null>;
}

async function fileMtimeMs(absPath: string): Promise<number | null> {
  try {
    return (await stat(absPath)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Hold every changed file written inside an active disclosure window that no
 * unrestricted native edit accounts for (module header, WI-10005576). Throws
 * `disclosure_ledger_unavailable` when the ledger or the tree cannot be read
 * while a disclosure is active.
 */
export async function readRestrictedWindowHoldings(deps: RestrictedWindowDeps): Promise<RestrictedEditHolding[]> {
  const sql = deps.sql ?? getOrgPg().sql;
  let window: { since: Date | string | null; restricted: string[] | null } | undefined;
  try {
    [window] = await sql<Array<{ since: Date | string | null; restricted: string[] | null }>>`
      SELECT min(delivered_at) AS since, array_agg(DISTINCT agent_owner_id) AS restricted
        FROM harness_shared.personal_disclosures
       WHERE released_at IS NULL`;
  } catch (error) {
    throw ledgerUnavailable('git-sync unattributed-write hold', error);
  }
  if (!window?.since) return [];
  const sinceMs = new Date(window.since).getTime();
  const restricted = new Set(window.restricted ?? []);

  let dirty: DirtyFile[];
  try {
    dirty = await deps.listDirtyFiles();
  } catch (error) {
    throw new DisclosureRefused(
      'disclosure_ledger_unavailable',
      `git-sync unattributed-write hold: the working tree's changed files could not be listed while a personal disclosure is active (${(error as Error)?.message ?? error})`,
    );
  }
  const mtimeOf = deps.mtimeMs ?? fileMtimeMs;
  const candidates: Array<DirtyFile & { abs: string; mtimeMs: number }> = [];
  for (const file of dirty) {
    const abs = path.join(file.root, file.path);
    const mtimeMs = await mtimeOf(abs);
    if (mtimeMs !== null && mtimeMs >= sinceMs) candidates.push({ ...file, abs, mtimeMs });
  }
  if (!candidates.length) return [];

  // A ledger row's file is relative to the lock's domain, which may be the
  // superproject or the submodule, so query every root-relative spelling and
  // match on the absolute path.
  const roots = [...new Set(candidates.map((c) => c.root))];
  const spellings = new Set<string>();
  for (const c of candidates) {
    for (const root of roots) if (c.abs.startsWith(`${root}${path.sep}`)) spellings.add(path.relative(root, c.abs));
  }
  let rows: Array<{ repo_root: string; file: string; agent_id: string | null; ts: Date | string }>;
  try {
    rows = await sql<Array<{ repo_root: string; file: string; agent_id: string | null; ts: Date | string }>>`
      SELECT repo_root, file, agent_id, ts
        FROM harness_shared.edit_attribution_ledger
       WHERE repo_root = ANY(${roots}::text[])
         AND file = ANY(${[...spellings]}::text[])
         AND ts >= ${new Date(sinceMs - RESTRICTED_WINDOW_ATTRIBUTION_SLACK_MS)}`;
  } catch (error) {
    throw ledgerUnavailable('git-sync unattributed-write hold', error);
  }
  const latest = new Map<string, { agent: string; tsMs: number }>();
  for (const row of rows) {
    const abs = path.join(row.repo_root, row.file);
    const tsMs = new Date(row.ts).getTime();
    const prior = latest.get(abs);
    if (!prior || tsMs > prior.tsMs) latest.set(abs, { agent: row.agent_id?.trim() ?? '', tsMs });
  }

  const out: RestrictedEditHolding[] = [];
  for (const c of candidates) {
    const edit = latest.get(c.abs);
    const accounted =
      edit !== undefined &&
      edit.agent !== '' &&
      !restricted.has(edit.agent) &&
      edit.tsMs >= c.mtimeMs - RESTRICTED_WINDOW_ATTRIBUTION_SLACK_MS;
    if (!accounted) out.push({ path: c.path, owner: RESTRICTED_WINDOW_OWNER, intent: RESTRICTED_WINDOW_INTENT, coordinationDomain: c.root });
  }
  return out;
}

export type RestrictedSourceHoldState = 'held' | 'clear' | 'unknown';

export interface RestrictedSourceHoldDeps {
  /** Override the attributed edit census. */
  readAttributed?: () => Promise<RestrictedEditHolding[]>;
  /** Override the dirty-window census for a canonical integration root. */
  readWindow?: (realRoot: string) => Promise<RestrictedEditHolding[]>;
}

function pathIsUnder(root: string, target: string): boolean {
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(target);
  return absoluteTarget === absoluteRoot || absoluteTarget.startsWith(absoluteRoot + path.sep);
}

async function holdingTouchesRoot(realRoot: string, holding: RestrictedEditHolding): Promise<boolean> {
  let domain = realRoot;
  if (holding.coordinationDomain) {
    const candidate = holding.coordinationDomain.trim();
    if (!path.isAbsolute(candidate)) throw new Error('restricted hold coordination domain is not absolute');
    domain = await realpath(candidate).catch(() => path.resolve(candidate));
  }
  const absolute = path.resolve(path.isAbsolute(holding.path) ? holding.path : path.resolve(domain, holding.path));
  const real = await realpath(absolute).catch(() => absolute);
  return pathIsUnder(realRoot, absolute) || pathIsUnder(realRoot, real);
}

async function runRestrictedSourceGit(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  // Keep the source census on git-sync's bounded runner so its dirty-window view
  // has the same timeout, locale, and dispatch behavior as the writer's census.
  const { gitTimeoutMsFor, runGitBounded } = await import('../harness/git-sync/run-git-sync');
  return runGitBounded(args, cwd, gitTimeoutMsFor(args));
}

/**
 * Read the source hold for the explicitly configured canonical integration tree.
 * The answer is fail-closed: no configured/resolvable root or a failed attributed
 * or dirty-window census is unknown, never clear. The window half uses git-sync's
 * recursive superproject/submodule census, so shell writes stay visible too.
 */
export async function readRestrictedSourceHoldState(
  integrationRoot: string | null | undefined = process.env.PAPERCUSP_INTEGRATION_ROOT,
  deps: RestrictedSourceHoldDeps = {},
): Promise<RestrictedSourceHoldState> {
  const configuredRoot = integrationRoot?.trim();
  if (!configuredRoot) return 'unknown';

  let realRoot: string;
  try {
    realRoot = await realpath(configuredRoot);
  } catch {
    return 'unknown';
  }

  try {
    const readAttributed = deps.readAttributed ?? (() => readRestrictedEditHoldings());
    const readWindow =
      deps.readWindow ??
      ((root: string) =>
        readRestrictedWindowHoldings({
          listDirtyFiles: () => listDirtyFilesRecursive(runRestrictedSourceGit, root),
        }));
    const [attributed, window] = await Promise.all([readAttributed(), readWindow(realRoot)]);
    for (const holding of [...attributed, ...window]) {
      if (await holdingTouchesRoot(realRoot, holding)) return 'held';
    }
    return 'clear';
  } catch {
    return 'unknown';
  }
}

/**
 * git-sync's commit-gate census: every live edit lock, every restricted hold, and
 * (given the tree to read) every unattributed write inside an active disclosure
 * window. Every half is strict, so any read failing throws and git-sync fails the
 * tick closed rather than staging a held path. Used for the initial census AND the
 * final-commit-seam refresh (git-sync-action.ts).
 */
export async function readGitSyncCensusStrict(
  deps: {
    locks?: () => Promise<LiveLockHolding[]>;
    restricted?: () => Promise<RestrictedEditHolding[]>;
    /** The tree git-sync is about to sweep. Production always passes it (git-sync-action.ts). */
    window?: { repoPath: string; runGit: HoldRunGit } | (() => Promise<RestrictedEditHolding[]>);
  } = {},
): Promise<LiveLockHolding[]> {
  const tree = deps.window;
  const readWindow: () => Promise<RestrictedEditHolding[]> =
    typeof tree === 'function'
      ? tree
      : tree
        ? () => readRestrictedWindowHoldings({ listDirtyFiles: () => listDirtyFilesRecursive(tree.runGit, tree.repoPath) })
        : async () => [];
  const [locks, restricted, windowHolds] = await Promise.all([
    (deps.locks ?? liveLockHoldingsStrict)(),
    (deps.restricted ?? (() => readRestrictedEditHoldings()))(),
    readWindow(),
  ]);
  return [...locks, ...restricted, ...windowHolds];
}

/** Whether `ownerId` holds any unreleased disclosure. Throws `disclosure_ledger_unavailable`. */
export async function ownerHasActiveDisclosure(sql: Db, ownerId: string): Promise<boolean> {
  try {
    const [row] = await sql<Array<{ active: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM harness_shared.personal_disclosures
                      WHERE agent_owner_id = ${ownerId} AND released_at IS NULL) AS active`;
    return row?.active === true;
  } catch (error) {
    throw ledgerUnavailable('restricted-edit hold check', error);
  }
}

export interface RestrictedEditBeforeRelease {
  /** The lock's coordination domain: the root the paths are relative to. */
  repoRoot: string;
  /** The paths the native-edit proof says were written. */
  files: string[];
  ownerId: string;
  intent?: string;
  workspaceId?: string;
  contributor?: string;
}

export interface RestrictedEditBeforeReleaseDeps {
  hasActiveDisclosure?: (ownerId: string) => Promise<boolean>;
  /** Must THROW when the row is not written (the best-effort recorder swallows). */
  recordStrict?: (input: RestrictedEditBeforeRelease) => Promise<void>;
}

/**
 * Called by locks:release BEFORE it releases a native-edit lock. When the owner
 * holds an active disclosure, write the edit's ledger row first and return true,
 * so git-sync's census sees the hold before the lock disappears. Returns false
 * (and writes nothing) for an unrestricted owner. Throws
 * `disclosure_ledger_unavailable` when the check or the write fails; the caller
 * must then keep the lock rather than release it.
 */
export async function recordRestrictedEditBeforeRelease(
  input: RestrictedEditBeforeRelease,
  deps: RestrictedEditBeforeReleaseDeps = {},
): Promise<boolean> {
  const files = input.files.map((f) => f.trim()).filter(Boolean);
  if (files.length === 0 || !input.ownerId || !input.repoRoot) return false;
  const hasActive = deps.hasActiveDisclosure ?? ((owner: string) => ownerHasActiveDisclosure(getOrgPg().sql, owner));
  if (!(await hasActive(input.ownerId))) return false;
  const record =
    deps.recordStrict ??
    (async (i: RestrictedEditBeforeRelease) => {
      const { recordEditAttributionStrict } = await import('../edit-attribution');
      await recordEditAttributionStrict({
        repoRoot: i.repoRoot,
        files: i.files,
        agentId: i.ownerId,
        intent: i.intent,
        workspaceId: i.workspaceId,
        contributor: i.contributor,
      });
    });
  try {
    await record({ ...input, files });
  } catch (error) {
    throw new DisclosureRefused(
      'disclosure_ledger_unavailable',
      `restricted-edit hold: the edit could not be recorded, so the lock is kept (${(error as Error)?.message ?? error})`,
    );
  }
  return true;
}
