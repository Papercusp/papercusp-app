/**
 * live-lock-coordinates: pure, dependency-free mapping of lock-plane paths into one git
 * repository's own coordinate space.
 *
 * Split out of run-git-sync.ts (P-009 / WI-10002596) so that consumers which mock
 * run-git-sync wholesale (git-sync-action.test.ts) still exercise the REAL mapping. A
 * mocked mapping is exactly how a coordinate mismatch passes every test while git-sync
 * commits a locked file.
 */
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** Structurally identical to run-git-sync's GitSyncLockHolding. */
export interface LockHoldingCoordinates {
  path: string;
  owner: string;
  intent: string;
  goalRef?: string;
}

/**
 * Map root-relative live-lock holdings into one repository's coordinate space.
 *
 * The lock plane speaks in superproject-root-relative paths, while `git add`
 * inside a submodule speaks from that submodule's own root. Keep the mapping
 * beside the exclusion logic so commit-time refreshes cannot accidentally
 * reintroduce the old root/submodule path mismatch.
 */
export function mapLiveLockHoldingsForRepo(
  holdings: readonly LockHoldingCoordinates[],
  repoRelPrefix: string,
  submodulePaths: readonly string[] = [],
): LockHoldingCoordinates[] {
  const normalizedPrefix = repoRelPrefix.trim().replace(/^\.\/+|\/+$/g, '');
  const prefix = normalizedPrefix ? `${normalizedPrefix}/` : '';
  const normalizedSubmodulePaths = submodulePaths
    .map((path) => path.trim().replace(/^\.\/+|\/+$/g, ''))
    .filter(Boolean);
  const normalized = holdings
    .map((holding) => ({
      path: holding.path.trim().replace(/^\.\/+|\/+$/g, ''),
      owner: holding.owner,
      intent: holding.intent,
      ...(holding.goalRef?.trim() ? { goalRef: holding.goalRef.trim() } : {}),
    }))
    .filter((holding) => holding.path.length > 0);

  if (prefix) {
    return normalized
      .filter((holding) => holding.path.startsWith(prefix))
      .map((holding) => ({ ...holding, path: holding.path.slice(prefix.length) }))
      .filter((holding) => holding.path.length > 0);
  }

  return normalized.filter(
    (holding) =>
      !normalizedSubmodulePaths.some(
        (submodulePath) => holding.path === submodulePath || holding.path.startsWith(`${submodulePath}/`),
      ),
  );
}

/** A lock-plane row plus the repo root its `path` is relative to. */
export interface DomainLockHolding extends LockHoldingCoordinates {
  /**
   * The lock's `coordination_domain`: the absolute (realpath) root of the repository whose
   * file `path` names. Absent on legacy rows, which are treated as already root-relative.
   */
  coordinationDomain?: string;
}

/** A lock row that names a file in a DIFFERENT repository from the one being synced. */
export interface ForeignLockHolding {
  path: string;
  owner: string;
  intent: string;
  coordinationDomain: string;
  /** `foreign-repo`: unrelated history. `outside-root`: same history, but not under the root. */
  reason: 'foreign-repo' | 'outside-root';
}

/**
 * Git identity lookups for {@link translateLiveLockHoldingsToRoot}. Both return null when the
 * answer cannot be determined; neither may throw.
 */
export interface LockDomainIdentity {
  /** Root commit shas of the repository checked out at `dir`. */
  rootCommits(dir: string): Promise<readonly string[] | null>;
  /** The superproject working tree that contains `dir` as a submodule, if any. */
  superproject(dir: string): Promise<string | null>;
}

type LockDomainRelation =
  | { kind: 'same' }
  | { kind: 'prefix'; prefix: string }
  | { kind: 'strip'; prefix: string }
  | { kind: 'foreign' }
  | { kind: 'unresolved' };

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

function sharesRoot(a: readonly string[], b: readonly string[]): boolean {
  return a.some((sha) => b.includes(sha));
}

/**
 * EI-24649116564770033: translate lock rows from their own coordination domain into the
 * coordinates of one git root.
 *
 * The lock plane keys every row by `(coordination_domain, path)`, and `path` is relative to
 * THAT domain. git-sync deliberately reads every domain at once (WI-5979: a domain-scoped
 * read misses real holders), and it used to discard the domain and match each path
 * directly against its own tree. That made two things go wrong:
 *
 *  - an unrelated repository's lock excluded a same-named file here. A portal-repo lock on
 *    `package.json` withheld papercusp's root `package.json`, so a dependency change landed
 *    without its root workspace entry or lockfile;
 *  - a submodule-root lock (`<root>/papercusp-desktop`, `bin/x.sh`) was read as the
 *    superproject path `bin/x.sh`, so the real file was left unprotected.
 *
 * `rootPath` must be the canonical (realpath) root of the TOP-LEVEL repository; nested
 * installs map the result further with {@link mapLiveLockHoldingsForRepo}. Domains that are
 * other checkouts of the same history (release, staging) keep their paths: a domain can be
 * recorded against the reader's checkout rather than the edited one (WI-5979), and a
 * shared root commit is what distinguishes those from an unrelated repository. A domain
 * whose identity cannot be read is kept unchanged, so failure over-excludes rather than
 * commits a held file.
 */
export async function translateLiveLockHoldingsToRoot(
  holdings: readonly DomainLockHolding[],
  rootPath: string,
  identity: LockDomainIdentity,
): Promise<{ holdings: LockHoldingCoordinates[]; dropped: ForeignLockHolding[] }> {
  const root = normalizeDir(rootPath);
  let rootCommits: Promise<readonly string[] | null> | null = null;
  const relations = new Map<string, Promise<LockDomainRelation>>();

  const relate = async (domain: string): Promise<LockDomainRelation> => {
    if (domain === root) return { kind: 'same' };
    const inside = relativeInside(root, domain);
    if (inside) return { kind: 'prefix', prefix: inside };
    const containing = relativeInside(domain, root);
    if (containing) return { kind: 'strip', prefix: containing };
    rootCommits ??= identity.rootCommits(root);
    const ours = await rootCommits;
    if (!ours || ours.length === 0) return { kind: 'unresolved' };
    const theirs = await identity.rootCommits(domain);
    if (!theirs || theirs.length === 0) return { kind: 'unresolved' };
    if (sharesRoot(ours, theirs)) return { kind: 'same' };
    // A submodule of ANOTHER checkout of this repository (e.g. papercup-release/libs/x).
    const superproject = await identity.superproject(domain);
    if (superproject) {
      const superRoots = await identity.rootCommits(normalizeDir(superproject));
      const rel = relativeInside(normalizeDir(superproject), domain);
      if (superRoots && rel && sharesRoot(ours, superRoots)) return { kind: 'prefix', prefix: rel };
    }
    return { kind: 'foreign' };
  };

  const out: LockHoldingCoordinates[] = [];
  const dropped: ForeignLockHolding[] = [];
  for (const holding of holdings) {
    const path = holding.path.trim().replace(/^\.\/+|\/+$/g, '');
    if (!path) continue;
    const base: LockHoldingCoordinates = {
      path,
      owner: holding.owner,
      intent: holding.intent,
      ...(holding.goalRef?.trim() ? { goalRef: holding.goalRef.trim() } : {}),
    };
    const domain = holding.coordinationDomain ? normalizeDir(holding.coordinationDomain) : '';
    if (!domain) {
      out.push(base);
      continue;
    }
    let relation = relations.get(domain);
    if (!relation) {
      relation = relate(domain);
      relations.set(domain, relation);
    }
    const r = await relation;
    if (r.kind === 'same' || r.kind === 'unresolved') {
      out.push(base);
    } else if (r.kind === 'prefix') {
      out.push({ ...base, path: `${r.prefix}/${path}` });
    } else if (r.kind === 'strip') {
      if (path.startsWith(`${r.prefix}/`)) out.push({ ...base, path: path.slice(r.prefix.length + 1) });
      else if (path !== r.prefix) {
        dropped.push({ path, owner: holding.owner, intent: holding.intent, coordinationDomain: domain, reason: 'outside-root' });
      }
    } else {
      dropped.push({ path, owner: holding.owner, intent: holding.intent, coordinationDomain: domain, reason: 'foreign-repo' });
    }
  }
  return { holdings: out, dropped };
}

/**
 * The production {@link LockDomainIdentity}, over an injected git runner. Answers are
 * memoized per instance: create one per git-sync tick, so nothing outlives the tick.
 */
export function createLockDomainIdentity(
  runGit: (args: string[], cwd: string) => Promise<{ code: number; stdout: string }>,
): LockDomainIdentity {
  const roots = new Map<string, Promise<readonly string[] | null>>();
  const supers = new Map<string, Promise<string | null>>();
  const run = async (args: string[], cwd: string): Promise<string | null> => {
    try {
      const result = await runGit(args, cwd);
      return result.code === 0 ? result.stdout.trim() : null;
    } catch {
      return null;
    }
  };
  return {
    rootCommits(dir) {
      let hit = roots.get(dir);
      if (!hit) {
        hit = run(['rev-list', '--max-parents=0', 'HEAD'], dir).then((stdout) => {
          const shas = stdout?.split('\n').map((line) => line.trim()).filter(Boolean) ?? [];
          return shas.length > 0 ? shas : null;
        });
        roots.set(dir, hit);
      }
      return hit;
    },
    superproject(dir) {
      let hit = supers.get(dir);
      if (!hit) {
        hit = run(['rev-parse', '--show-superproject-working-tree'], dir).then((stdout) => stdout || null);
        supers.set(dir, hit);
      }
      return hit;
    },
  };
}

/**
 * P-009 / WI-10002596: the repo-relative prefix of a NESTED git-sync install inside its
 * parent's tree ('' when the install is not nested).
 *
 * Nested installs (slug `<parent>/<rel>`, e.g. `papercusp/libs/agent-chat`) sync a
 * submodule as their own repo root. The lock plane still speaks in the PARENT's root
 * coordinates (`libs/agent-chat/src/x.ts`), so an unmapped holding never matches a path
 * inside the nested repo. Exclusion then silently becomes a no-op, and git-sync can commit
 * a peer's locked, mid-edit file (observed: a mutation-probe mutant, libs/papercusp
 * 1e553ccd). Derived from the filesystem (`parentRoot` is the parent install's project
 * dir) rather than trusted from the slug. The slug tail is only a fallback when the
 * parent root is unknown, and only when the repo path actually ends with it.
 */
export function nestedInstallRepoPrefix(
  slug: string,
  repoPath: string | null | undefined,
  parentRoot?: string | null,
): string {
  const slash = slug.indexOf('/');
  if (slash <= 0 || !repoPath) return '';
  const repo = resolve(repoPath);
  if (parentRoot) {
    const rel = relative(resolve(parentRoot), repo).split(sep).join('/');
    return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : '';
  }
  const tail = slug.slice(slash + 1).replace(/^\/+|\/+$/g, '');
  return tail && repo.split(sep).join('/').endsWith(`/${tail}`) ? tail : '';
}
