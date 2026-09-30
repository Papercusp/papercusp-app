/**
 * release-cut-reclaim — find and remove stale release-cut worktrees
 * (EI-23968726111761920). Surfaced as `release:cut { op:'reclaim' }`.
 *
 * Every desktop cut materialises a 45–72 GB exact-SHA worktree of the canonical repo, and
 * nothing ever removed one: six were born in three days (2026-09-26..29) and pushed the root
 * disk under git-sync's fetch reserve. This module answers "which of those trees may go?"
 * and, only for trees a caller names from that answer, removes them.
 *
 * DESIGN — derived, never a roster:
 *  - Population = `git worktree list --porcelain` of the canonical repo. No path glob:
 *    cut trees live under at least five parent dirs, one of them a typo'd workspace dir.
 *  - A tree is IDENTIFIED as a cut only by the record its creator wrote: a retention
 *    lease (`~/.papercusp/release-retention/lease-<tag>.tsv`, written by release-local.sh)
 *    naming a path inside it. Identified + unprotected ⇒ `reclaimable`. A registered tree
 *    with no such record is `named-only`: never swept, eligible only when a caller names it.
 *  - Protected set is COMPUTED (and every protection is fail-closed):
 *      · a live retention lease (expires_ns 0 = never expires) — the same rule as
 *        release_artifacts_retention_path_is_leased, realpath'd on both sides so an
 *        offloaded (moved + symlinked) tree stays covered;
 *      · the tree backing the latest PUBLISHED release (harness_shared.releases), by
 *        HEAD sha or by that release's lease tag, whether or not the lease expired;
 *      · any tree created after the latest RECORDED release (the next cut, e.g. 0.0.26,
 *        before it has a lease) or whose desktop version is newer than the latest
 *        published one;
 *      · a process holding the tree (cwd/root/exe/fd) — one /proc walk with a positive
 *        control, refusing to trust a scan run inside a nested PID namespace;
 *      · a HEAD moved within `minIdleHours` (checkout/commit — the git admin dir, which the
 *        tree-wide asset sync that touches every checkout never writes);
 *      · AUTHORED work: any status entry — superproject or ANY submodule, recursively —
 *        outside the measured machine-written set, a submodule commit the canonical
 *        checkout does not have, or a superproject HEAD no ref contains;
 *      · locked worktrees, and a tree that contains another registered worktree.
 *
 * Removal (confirm path) archives the tracked diffs first, re-checks holders, renames the
 * tree aside on its own filesystem, deletes its worktree admin dir (exactly what
 * `git worktree prune` does for that one entry, without touching others), then deletes.
 * Each removal is appended to the shared deletion-audit.tsv the release scripts write.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const RETENTION_SCHEMA = 'papercusp-release-retention/v1';
export const RECLAIM_DELETER = 'release:cut-reclaim';
export const DEFAULT_MIN_IDLE_HOURS = 24;
const GIT_TIMEOUT_MS = 120_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

// ---------------------------------------------------------------- parsing (pure)

export interface ReclaimWorktree {
  path: string;
  head: string | null;
  detached: boolean;
  prunable: boolean;
  locked: boolean;
}

/** `git worktree list --porcelain` → entries. The main worktree is always first. */
export function parseWorktreePorcelain(stdout: string): ReclaimWorktree[] {
  const out: ReclaimWorktree[] = [];
  for (const block of stdout.split(/\n\n+/)) {
    let worktreePath = '';
    let head: string | null = null;
    let detached = false;
    let prunable = false;
    let locked = false;
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) worktreePath = line.slice('worktree '.length).trim();
      else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length).trim();
      else if (line === 'detached') detached = true;
      else if (line === 'prunable' || line.startsWith('prunable ')) prunable = true;
      else if (line === 'locked' || line.startsWith('locked ')) locked = true;
    }
    if (worktreePath) out.push({ path: worktreePath, head, detached, prunable, locked });
  }
  return out;
}

export interface RetentionLease {
  file: string;
  tag: string;
  version: string | null;
  expiresNs: bigint;
  paths: string[];
}

export type LeaseParse = { ok: true; lease: RetentionLease } | { ok: false; file: string; reason: string };

/** Mirrors release_artifacts_retention_lease_read_paths: any unknown line, a bad expiry,
 *  a wrong schema or an empty tag is MALFORMED — and a malformed lease fails closed. */
export function parseRetentionLease(file: string, text: string): LeaseParse {
  let schema = '';
  let tag = '';
  let expires: bigint | null = null;
  const paths: string[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const eq = line.indexOf('=');
    const key = eq > 0 ? line.slice(0, eq) : '';
    const value = eq > 0 ? line.slice(eq + 1) : '';
    if (key === 'schema') schema = value;
    else if (key === 'tag') tag = value;
    else if (key === 'created_ns') continue;
    else if (key === 'expires_ns') {
      if (!/^\d+$/.test(value)) return { ok: false, file, reason: 'invalid expires_ns' };
      expires = BigInt(value);
    } else if (key === 'path') paths.push(value);
    else return { ok: false, file, reason: `unexpected line '${line.slice(0, 40)}'` };
  }
  if (schema !== RETENTION_SCHEMA) return { ok: false, file, reason: `schema '${schema}'` };
  if (!tag) return { ok: false, file, reason: 'missing tag' };
  if (expires === null) return { ok: false, file, reason: 'missing expires_ns' };
  return { ok: true, lease: { file, tag, version: versionFromTag(tag), expiresNs: expires, paths } };
}

export function isLeaseLive(lease: RetentionLease, nowMs: number): boolean {
  return lease.expiresNs === 0n || lease.expiresNs > BigInt(Math.floor(nowMs)) * 1_000_000n;
}

/** expires_ns=0 is what every lease gets while PAPERCUSP_RELEASE_RETENTION_TTL_SEC is unset, so
 *  "never expires" would pin every cut ever made. Reclaim honours such a lease only for the latest
 *  published release or a NEWER (in-flight / unreleased) cut; an older one is ignored. Unknowable
 *  (no published record, or an unparsable version) fails closed = honoured. Chosen over a finite
 *  default TTL, which would change the lease writer and could expire an in-flight cut mid-build. */
export function neverExpiringLeaseHonored(lease: RetentionLease, published: ReleaseRecord | null): boolean {
  if (lease.expiresNs !== 0n) return true;
  if (!published || !lease.version) return true;
  const cmp = compareVersions(lease.version, published.version);
  return cmp === null || cmp >= 0;
}

/** desktop-v0.0.25-alpha → 0.0.25 */
export function versionFromTag(tag: string): string | null {
  return /^desktop-v(\d+\.\d+\.\d+)(?:-|$)/.exec(tag)?.[1] ?? null;
}

/** Numeric x.y.z compare; a non-numeric version compares as null (callers fail closed). */
export function compareVersions(a: string, b: string): number | null {
  const pa = /^(\d+)\.(\d+)\.(\d+)/.exec(a);
  const pb = /^(\d+)\.(\d+)\.(\d+)/.exec(b);
  if (!pa || !pb) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d;
  }
  return 0;
}

/** Either side inside the other — the lease guard's own prefix rule. */
export function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export interface StatusEntry {
  path: string;
  /** a gitlink entry — its content is judged inside the submodule itself */
  submodule: boolean;
}

/** `git status --porcelain=v2 -z` → entries, each path prefixed with `prefix/` (the
 *  submodule's display path) so rules below match superproject-relative paths. */
export function parsePorcelainV2(stdout: string, prefix = ''): StatusEntry[] {
  const fields = stdout.split('\0');
  const out: StatusEntry[] = [];
  const join = (p: string) => (prefix ? `${prefix}/${p}` : p);
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i] ?? '';
    if (!f) continue;
    const kind = f[0];
    if (kind === '#') continue;
    if (kind === '?' || kind === '!') {
      if (kind === '?') out.push({ path: join(f.slice(2)), submodule: false });
      continue;
    }
    const parts = f.split(' ');
    const sub = parts[2] ?? '';
    const pathFieldIndex = kind === '1' ? 8 : kind === '2' ? 9 : kind === 'u' ? 10 : -1;
    if (pathFieldIndex < 0) continue;
    out.push({ path: join(parts.slice(pathFieldIndex).join(' ')), submodule: sub.startsWith('S') });
    if (kind === '2') i += 1; // the rename's original path is the next NUL field
  }
  return out;
}

/**
 * The machine-written residue a FINISHED cut leaves behind (measured 2026-09-30 on
 * relcut-0024 and desktop-release-0.0.19): the version bump, lockfile churn, and the
 * tracked sidecar bundle. Anything else in a tree's status is treated as authored work.
 */
export function machineWrittenRule(relPath: string, releaseVersionPaths: readonly string[]): string | null {
  if (relPath.startsWith('papercusp-desktop/src-tauri/env-sidecars/')) return 'sidecar-build-output';
  if (releaseVersionPaths.some((p) => relPath === `papercusp-desktop/${p}`)) return 'release-version-bump';
  const base = path.posix.basename(relPath);
  if (base === 'package-lock.json' || base === 'Cargo.lock') return 'lockfile';
  if (/(^|\/)(coverage|__pycache__)(\/|$)/.test(relPath)) return 'build-cache';
  return null;
}

// ---------------------------------------------------------------- planning (pure)

export interface TreeProbe {
  realPath: string | null;
  /** the registered path is a symlink to the tree's real location (an offload) */
  offloaded: boolean;
  onRootFs: boolean | null;
  adminDir: string | null;
  createdAtMs: number | null;
  lastHeadMoveMs: number | null;
  desktopVersion: string | null;
}

export interface HolderScan {
  verified: boolean;
  reason?: string;
  /** keyed by registered worktree path */
  holders: Map<string, string[]>;
}

export type AuthoredWork =
  | { ok: true; authored: string[]; machineWritten: number }
  | { ok: false; reason: string };

export interface ReleaseRecord {
  version: string;
  gitSha: string | null;
  cutAtMs: number;
  publishedAtMs: number | null;
}

export type ReclaimDisposition = 'reclaimable' | 'named-only' | 'protected';

export interface ReclaimVerdict {
  path: string;
  realPath: string | null;
  onRootFs: boolean | null;
  head: string | null;
  version: string | null;
  leaseTags: string[];
  /** never-expiring leases on an older-than-published tree, ignored as protection (reported, not hidden) */
  ignoredLeases: string[];
  createdAt: string | null;
  lastHeadMoveAt: string | null;
  disposition: ReclaimDisposition;
  reasons: string[];
}

export interface ReclaimPlan {
  canonicalRoot: string | null;
  latestPublished: string | null;
  failClosed: string[];
  skipped: { autoManaged: string[]; prunable: number };
  verdicts: ReclaimVerdict[];
}

export interface ReclaimPlanInput {
  nowMs: number;
  minIdleHours: number;
  worktrees: ReclaimWorktree[];
  isAutoManaged: (worktreePath: string) => boolean;
  leases: RetentionLease[];
  leaseErrors: string[];
  releases: ReleaseRecord[] | { error: string };
  probes: Map<string, TreeProbe>;
  holders: HolderScan;
  /** only trees that survive every cheap check need this (it runs git in each tree) */
  authored: Map<string, AuthoredWork>;
}

export const AUTHORED_UNCHECKED = 'authored-work-unchecked';

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export function latestPublishedRelease(releases: ReleaseRecord[]): ReleaseRecord | null {
  let best: ReleaseRecord | null = null;
  for (const r of releases) {
    if (r.publishedAtMs === null) continue;
    if (!best || (compareVersions(r.version, best.version) ?? 0) > 0) best = r;
  }
  return best;
}

export function planCutReclaim(input: ReclaimPlanInput): ReclaimPlan {
  const [main, ...linked] = input.worktrees;
  const failClosed: string[] = input.leaseErrors.map((e) => `malformed-lease:${e}`);
  const releases = Array.isArray(input.releases) ? input.releases : null;
  if (!releases) failClosed.push(`release-records-unavailable:${(input.releases as { error: string }).error}`);
  const published = releases ? latestPublishedRelease(releases) : null;
  if (releases && !published) failClosed.push('no-published-release');
  const latestCutAtMs = releases && releases.length ? Math.max(...releases.map((r) => r.cutAtMs)) : null;
  if (!input.holders.verified) failClosed.push(`holder-scan-unverified:${input.holders.reason ?? 'unknown'}`);

  const autoManaged: string[] = [];
  let prunable = 0;
  const verdicts: ReclaimVerdict[] = [];
  const registered = input.worktrees.filter((w) => !w.prunable).map((w) => w.path);

  for (const wt of linked) {
    if (wt.prunable) {
      prunable++;
      continue;
    }
    if (input.isAutoManaged(wt.path)) {
      autoManaged.push(wt.path);
      continue;
    }
    const probe = input.probes.get(wt.path) ?? null;
    const reasons: string[] = [...failClosed];
    const sides = [wt.path, ...(probe?.realPath && probe.realPath !== wt.path ? [probe.realPath] : [])];
    const covering = input.leases.filter((l) =>
      l.paths.some((leased) => sides.some((side) => pathsOverlap(path.resolve(leased), side))),
    );
    const leaseTags = covering.map((l) => l.tag);

    if (!probe || !probe.realPath) reasons.push('path-unreadable');
    if (wt.locked) reasons.push('locked');
    for (const other of registered) {
      if (other !== wt.path && other.startsWith(`${wt.path}/`)) reasons.push(`contains-worktree:${other}`);
    }
    const ignoredLeases: string[] = [];
    for (const l of covering) {
      if (!isLeaseLive(l, input.nowMs)) continue;
      if (!neverExpiringLeaseHonored(l, published)) ignoredLeases.push(`${l.tag}:never-expires,older-than-${published?.version}`);
      else reasons.push(`lease:${l.tag}`);
    }
    if (published) {
      const backsHead = !!published.gitSha && !!wt.head && wt.head.startsWith(published.gitSha.slice(0, 12));
      const backsLease = covering.some((l) => l.version === published.version);
      if (backsHead || backsLease) reasons.push(`latest-published:${published.version}`);
      const v = probe?.desktopVersion ?? null;
      if (v) {
        const cmp = compareVersions(v, published.version);
        if (cmp === null || cmp > 0) reasons.push(`unreleased-version:${v}`);
      }
    }
    const created = probe?.createdAtMs ?? null;
    if (created === null) reasons.push('unknown-age');
    else if (latestCutAtMs !== null && created > latestCutAtMs) reasons.push('newer-than-latest-release');
    const moved = probe?.lastHeadMoveMs ?? null;
    if (moved !== null && input.nowMs - moved < input.minIdleHours * 3_600_000) {
      reasons.push(`recent-checkout:${Math.floor((input.nowMs - moved) / 3_600_000)}h`);
    }
    for (const h of input.holders.holders.get(wt.path) ?? []) reasons.push(`in-use:${h}`);

    if (reasons.length === 0) {
      const work = input.authored.get(wt.path);
      if (!work) reasons.push(AUTHORED_UNCHECKED);
      else if (!work.ok) reasons.push(`authored-work-unverified:${work.reason}`);
      else if (work.authored.length) reasons.push(`authored:${work.authored.slice(0, 5).join(',')}${work.authored.length > 5 ? `,+${work.authored.length - 5}` : ''}`);
    }

    verdicts.push({
      path: wt.path,
      realPath: probe?.realPath ?? null,
      onRootFs: probe?.onRootFs ?? null,
      head: wt.head,
      version: probe?.desktopVersion ?? null,
      leaseTags,
      ignoredLeases,
      createdAt: iso(created),
      lastHeadMoveAt: iso(moved),
      disposition: reasons.length ? 'protected' : leaseTags.length ? 'reclaimable' : 'named-only',
      reasons,
    });
  }
  return {
    canonicalRoot: main?.path ?? null,
    latestPublished: published?.version ?? null,
    failClosed,
    skipped: { autoManaged, prunable },
    verdicts,
  };
}

/** Validate the caller's named targets against a FRESH plan: all-or-nothing. */
export function resolveReclaimTargets(
  plan: ReclaimPlan,
  targets: readonly string[],
): { ok: true; verdicts: ReclaimVerdict[] } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const chosen = new Map<string, ReclaimVerdict>();
  for (const raw of targets) {
    const t = path.resolve(raw);
    const v = plan.verdicts.find((x) => x.path === t || x.realPath === t);
    if (!v) problems.push(`${raw}: not a registered, unmanaged cut worktree in this plan`);
    else if (v.disposition === 'protected') problems.push(`${raw}: protected (${v.reasons.join('; ')})`);
    else chosen.set(v.path, v);
  }
  if (!targets.length) problems.push('no targets named');
  return problems.length ? { ok: false, problems } : { ok: true, verdicts: [...chosen.values()] };
}

// ---------------------------------------------------------------- host probes (effectful)

function git(cwd: string, args: string[], timeout = GIT_TIMEOUT_MS): string {
  return String(
    execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      maxBuffer: GIT_MAX_BUFFER,
      timeout,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
}

const errText = (e: unknown) => (e instanceof Error ? e.message.split('\n')[0] ?? e.message : String(e)).slice(0, 160);

export function readRetentionLeases(dir: string): { leases: RetentionLease[]; errors: string[] } {
  const leases: RetentionLease[] = [];
  const errors: string[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^lease-.*\.tsv$/.test(n));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(`${dir}:${errText(e)}`);
    return { leases, errors };
  }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const parsed = parseRetentionLease(file, fs.readFileSync(file, 'utf8'));
      if (parsed.ok) leases.push(parsed.lease);
      else errors.push(`${name}:${parsed.reason}`);
    } catch (e) {
      errors.push(`${name}:${errText(e)}`);
    }
  }
  return { leases, errors };
}

function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function mtimeOrNull(p: string): number | null {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

/** `.git` FILE of a linked worktree → its admin dir (`<common>/worktrees/<name>`). */
export function worktreeAdminDir(worktreePath: string): string | null {
  try {
    const text = fs.readFileSync(path.join(worktreePath, '.git'), 'utf8');
    const m = /^gitdir:\s*(.+)$/m.exec(text);
    return m?.[1] ? path.resolve(worktreePath, m[1].trim()) : null;
  } catch {
    return null;
  }
}

export function probeTree(worktreePath: string, rootDev: number | null): TreeProbe {
  const realPath = realpathOrNull(worktreePath);
  let offloaded = false;
  try {
    offloaded = fs.lstatSync(worktreePath).isSymbolicLink();
  } catch {
    offloaded = false;
  }
  let onRootFs: boolean | null = null;
  try {
    if (realPath && rootDev !== null) onRootFs = fs.statSync(realPath).dev === rootDev;
  } catch {
    onRootFs = null;
  }
  const adminDir = worktreeAdminDir(worktreePath);
  let createdAtMs: number | null = null;
  if (adminDir) {
    try {
      const b = fs.statSync(adminDir).birthtimeMs;
      createdAtMs = b > 0 ? b : null;
    } catch {
      createdAtMs = null;
    }
  }
  const moves = adminDir
    ? [mtimeOrNull(path.join(adminDir, 'HEAD')), mtimeOrNull(path.join(adminDir, 'logs', 'HEAD'))].filter(
        (x): x is number => x !== null,
      )
    : [];
  let desktopVersion: string | null = null;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(worktreePath, 'papercusp-desktop', 'package.json'), 'utf8'));
    desktopVersion = typeof pkg?.version === 'string' ? pkg.version : null;
  } catch {
    desktopVersion = null;
  }
  return {
    realPath,
    offloaded,
    onRootFs,
    adminDir,
    createdAtMs,
    lastHeadMoveMs: moves.length ? Math.max(...moves) : null,
    desktopVersion,
  };
}

export interface HolderTarget {
  key: string;
  prefixes: string[];
}

/**
 * ONE /proc walk: cwd, root, exe and every fd of every visible process, matched against
 * each target's prefixes (registered path and realpath). Positive controls, both required:
 * the walk must find THIS process holding its own cwd, and this process must sit in the
 * root PID namespace (a nested namespace sees only its own processes — a confident false
 * idle, the trap measured on this box, memory 41104d77).
 */
export function scanProcHolders(targets: HolderTarget[], procRoot = '/proc'): HolderScan {
  const holders = new Map<string, string[]>();
  let nsNote = '';
  try {
    const status = fs.readFileSync(path.join(procRoot, 'self', 'status'), 'utf8');
    const nspid = /^NSpid:\s*(.+)$/m.exec(status)?.[1]?.trim().split(/\s+/) ?? [];
    if (nspid.length > 1) nsNote = `nested-pid-namespace(${nspid.join('/')})`;
  } catch (e) {
    nsNote = `self-status-unreadable:${errText(e)}`;
  }
  const control = realpathOrNull(process.cwd()) ?? process.cwd();
  const all: HolderTarget[] = [...targets, { key: '\0control', prefixes: [control] }];
  let pids: string[] = [];
  try {
    pids = fs.readdirSync(procRoot).filter((n) => /^\d+$/.test(n));
  } catch (e) {
    return { verified: false, reason: `proc-unreadable:${errText(e)}`, holders };
  }
  let controlSeen = false;
  for (const pid of pids) {
    const base = path.join(procRoot, pid);
    const links = ['cwd', 'root', 'exe'].map((l) => path.join(base, l));
    try {
      for (const fd of fs.readdirSync(path.join(base, 'fd'))) links.push(path.join(base, 'fd', fd));
    } catch {
      // another user's process or one that just exited — its cwd/root/exe are still tried
    }
    for (const link of links) {
      let target: string;
      try {
        target = fs.readlinkSync(link);
      } catch {
        continue;
      }
      for (const t of all) {
        if (!t.prefixes.some((p) => target === p || target.startsWith(`${p}/`))) continue;
        if (t.key === '\0control') {
          if (pid === String(process.pid) && link.endsWith('/cwd')) controlSeen = true;
          continue;
        }
        const list = holders.get(t.key) ?? [];
        if (list.length < 3 && !list.some((h) => h.startsWith(`pid ${pid} `))) {
          list.push(`pid ${pid} ${path.basename(link) === 'cwd' ? 'cwd' : path.basename(path.dirname(link)) === 'fd' ? 'fd' : path.basename(link)}`);
          holders.set(t.key, list);
        }
      }
    }
  }
  if (nsNote) return { verified: false, reason: nsNote, holders };
  if (!controlSeen) return { verified: false, reason: 'positive-control-failed(own cwd not seen)', holders };
  return { verified: true, holders };
}

/**
 * Authored work inside a tree, recursively through its submodules. Fails CLOSED: any git
 * error returns ok:false, which the planner turns into a protection.
 */
export function inspectAuthoredWork(
  tree: string,
  canonicalRoot: string,
  releaseVersionPaths: readonly string[],
): AuthoredWork {
  try {
    const authored: string[] = [];
    let machineWritten = 0;
    const judge = (entries: StatusEntry[]) => {
      for (const e of entries) {
        if (e.submodule) continue;
        if (machineWrittenRule(e.path, releaseVersionPaths)) machineWritten++;
        else authored.push(e.path);
      }
    };
    judge(parsePorcelainV2(git(tree, ['status', '--porcelain=v2', '-z', '--ignore-submodules=none'])));
    const head = git(tree, ['rev-parse', 'HEAD']).trim();
    const containing = git(canonicalRoot, ['for-each-ref', '--count=1', `--contains=${head}`, '--format=%(refname)']).trim();
    if (!containing) authored.push(`HEAD ${head.slice(0, 10)} (no ref contains it)`);
    const subs = git(tree, ['submodule', 'status', '--recursive']);
    for (const line of subs.split('\n')) {
      const m = /^([ +\-U])([0-9a-f]{40}) (.+?)(?: \(.*\))?$/.exec(line);
      if (!m || m[1] === '-') continue;
      const [, , sha, rel] = m as unknown as [string, string, string, string];
      judge(parsePorcelainV2(git(path.join(tree, rel), ['status', '--porcelain=v2', '-z', '--ignore-submodules=all']), rel));
      try {
        git(path.join(canonicalRoot, rel), ['cat-file', '-e', `${sha}^{commit}`], 30_000);
      } catch {
        authored.push(`${rel}@${sha.slice(0, 10)} (commit absent from canonical checkout)`);
      }
    }
    return { ok: true, authored, machineWritten };
  } catch (e) {
    return { ok: false, reason: errText(e) };
  }
}

export interface ReleaseRecordSource {
  (): Promise<ReleaseRecord[]>;
}

export interface GatherOptions {
  isAutoManaged: (worktreePath: string) => boolean;
  releaseVersionPaths: readonly string[];
  loadReleases: ReleaseRecordSource;
  /** any path inside the repo; the MAIN worktree is derived from its worktree list */
  repoPath: string;
  retentionDir?: string;
  minIdleHours?: number;
  nowMs?: number;
  /** test seams */
  listWorktrees?: (repoPath: string) => ReclaimWorktree[];
  probe?: (worktreePath: string) => TreeProbe;
  scanHolders?: (targets: HolderTarget[]) => HolderScan;
  authoredWork?: (tree: string, canonicalRoot: string) => AuthoredWork;
  readLeases?: (dir: string) => { leases: RetentionLease[]; errors: string[] };
}

export function defaultRetentionDir(): string {
  return process.env.PAPERCUSP_RELEASE_RETENTION_ROOT || path.join(os.homedir(), '.papercusp', 'release-retention');
}

/** Two-phase: every cheap protection first, then the git-heavy authored-work read only
 *  for the trees still standing. */
export async function gatherCutReclaimPlan(opts: GatherOptions): Promise<ReclaimPlan> {
  const nowMs = opts.nowMs ?? Date.now();
  const worktrees = (opts.listWorktrees ?? ((r) => parseWorktreePorcelain(git(r, ['worktree', 'list', '--porcelain'], 10_000))))(
    opts.repoPath,
  );
  let rootDev: number | null = null;
  try {
    rootDev = fs.statSync('/').dev;
  } catch {
    rootDev = null;
  }
  const probe = opts.probe ?? ((p: string) => probeTree(p, rootDev));
  const probes = new Map<string, TreeProbe>();
  for (const w of worktrees.slice(1)) if (!w.prunable) probes.set(w.path, probe(w.path));
  const { leases, errors } = (opts.readLeases ?? readRetentionLeases)(opts.retentionDir ?? defaultRetentionDir());
  let releases: ReleaseRecord[] | { error: string };
  try {
    releases = await opts.loadReleases();
  } catch (e) {
    releases = { error: errText(e) };
  }
  const holderTargets: HolderTarget[] = [...probes.entries()].map(([key, p]) => ({
    key,
    prefixes: [key, ...(p.realPath && p.realPath !== key ? [p.realPath] : [])],
  }));
  const holders = (opts.scanHolders ?? scanProcHolders)(holderTargets);
  const base = {
    nowMs,
    minIdleHours: opts.minIdleHours ?? DEFAULT_MIN_IDLE_HOURS,
    worktrees,
    isAutoManaged: opts.isAutoManaged,
    leases,
    leaseErrors: errors,
    releases,
    probes,
    holders,
  };
  const cheap = planCutReclaim({ ...base, authored: new Map() });
  const canonicalRoot = cheap.canonicalRoot;
  const authored = new Map<string, AuthoredWork>();
  if (canonicalRoot) {
    const inspect =
      opts.authoredWork ?? ((tree: string, canon: string) => inspectAuthoredWork(tree, canon, opts.releaseVersionPaths));
    for (const v of cheap.verdicts) {
      if (v.reasons.length === 1 && v.reasons[0] === AUTHORED_UNCHECKED) authored.set(v.path, inspect(v.path, canonicalRoot));
    }
  }
  return planCutReclaim({ ...base, authored });
}

// ---------------------------------------------------------------- removal (effectful)

export interface ReclaimExecDeps {
  nowMs?: () => number;
  scanHolders?: (targets: HolderTarget[]) => HolderScan;
  archive?: (tree: string, outFile: string) => void;
  gitCommonDir?: (canonicalRoot: string) => string;
  rename?: (from: string, to: string) => void;
  unlink?: (p: string) => void;
  rmrf?: (p: string) => Promise<void>;
  appendAudit?: (line: string) => void;
  archiveDir?: string;
  auditFile?: string;
}

export interface ReclaimExecResult {
  path: string;
  removed: boolean;
  archive?: string;
  reason?: string;
  ms: number;
}

/** Tracked diffs of the superproject and every initialized submodule, so a removal is
 *  recoverable at the patch level. Throws on any failure — the caller refuses removal. */
export function archiveTreeDiffs(tree: string, outFile: string): void {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const parts: string[] = [`# reclaim archive of ${tree} at ${new Date().toISOString()}\n`];
  parts.push(`## HEAD ${git(tree, ['rev-parse', 'HEAD']).trim()}\n`, git(tree, ['diff', '--binary', 'HEAD']));
  for (const line of git(tree, ['submodule', 'status', '--recursive']).split('\n')) {
    const m = /^([ +\-U])([0-9a-f]{40}) (.+?)(?: \(.*\))?$/.exec(line);
    if (!m || m[1] === '-') continue;
    const rel = m[3] as string;
    parts.push(`\n## submodule ${rel} ${m[2]}\n`, git(path.join(tree, rel), ['diff', '--binary', 'HEAD']));
  }
  fs.writeFileSync(outFile, parts.join(''));
}

export async function executeCutReclaim(
  plan: ReclaimPlan,
  targets: readonly string[],
  deps: ReclaimExecDeps = {},
): Promise<{ ok: false; refused: true; problems: string[] } | { ok: true; results: ReclaimExecResult[] }> {
  const resolved = resolveReclaimTargets(plan, targets);
  if (!resolved.ok) return { ok: false, refused: true, problems: resolved.problems };
  const canonicalRoot = plan.canonicalRoot;
  if (!canonicalRoot) return { ok: false, refused: true, problems: ['canonical worktree unknown'] };
  const now = deps.nowMs ?? Date.now;
  const commonDir = path.resolve(
    canonicalRoot,
    (deps.gitCommonDir ?? ((r: string) => git(r, ['rev-parse', '--git-common-dir'], 10_000).trim()))(canonicalRoot),
  );
  const archiveDir = deps.archiveDir ?? path.join(defaultRetentionDir(), 'reclaim-archive');
  const auditFile = deps.auditFile ?? path.join(defaultRetentionDir(), 'deletion-audit.tsv');
  const results: ReclaimExecResult[] = [];
  for (const v of resolved.verdicts) {
    const started = now();
    const done = (r: Omit<ReclaimExecResult, 'path' | 'ms'>) => results.push({ path: v.path, ms: now() - started, ...r });
    const real = v.realPath ?? v.path;
    const offloaded = real !== v.path;
    // Safety rails independent of the plan: a linked worktree only (a `.git` FILE), whose
    // admin dir sits under this repo's worktrees/, never the canonical tree or an ancestor.
    let adminDir: string | null = null;
    try {
      if (!fs.lstatSync(path.join(real, '.git')).isFile()) throw new Error('.git is not a file');
      adminDir = worktreeAdminDir(real);
    } catch (e) {
      done({ removed: false, reason: `not a linked worktree: ${errText(e)}` });
      continue;
    }
    if (!adminDir || !adminDir.startsWith(`${path.join(commonDir, 'worktrees')}/`)) {
      done({ removed: false, reason: `admin dir ${adminDir ?? '?'} is not under ${commonDir}/worktrees` });
      continue;
    }
    if (pathsOverlap(real, canonicalRoot) || real === '/' || real === os.homedir()) {
      done({ removed: false, reason: 'refusing a path that overlaps the canonical tree or home' });
      continue;
    }
    const fresh = (deps.scanHolders ?? scanProcHolders)([
      { key: v.path, prefixes: offloaded ? [v.path, real] : [v.path] },
    ]);
    if (!fresh.verified || (fresh.holders.get(v.path) ?? []).length) {
      done({
        removed: false,
        reason: fresh.verified ? `in use: ${(fresh.holders.get(v.path) ?? []).join(', ')}` : `holder scan unverified: ${fresh.reason}`,
      });
      continue;
    }
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
    const archive = path.join(archiveDir, `${stamp}-${path.basename(v.path)}.patch`);
    try {
      (deps.archive ?? archiveTreeDiffs)(real, archive);
    } catch (e) {
      done({ removed: false, reason: `archive failed: ${errText(e)}` });
      continue;
    }
    const trash = path.join(path.dirname(real), `.reclaim-trash-${path.basename(real)}-${stamp}`);
    try {
      (deps.rename ?? fs.renameSync)(real, trash);
    } catch (e) {
      done({ removed: false, archive, reason: `rename aside failed: ${errText(e)}` });
      continue;
    }
    const rmrf = deps.rmrf ?? ((p: string) => fs.promises.rm(p, { recursive: true, force: true }));
    try {
      if (offloaded) (deps.unlink ?? fs.unlinkSync)(v.path);
      await rmrf(adminDir);
      await rmrf(trash);
    } catch (e) {
      done({ removed: false, archive, reason: `partial removal (tree moved to ${trash}): ${errText(e)}` });
      continue;
    }
    try {
      const line = [
        new Date(now()).toISOString(),
        `pid=${process.pid}`,
        `deleter=${RECLAIM_DELETER}`,
        'decision=allow',
        `path=${v.path}${offloaded ? ` (real ${real})` : ''}`,
        'lease=none',
        `reason=${v.disposition} worktree reclaimed; archive ${archive}`,
      ].join('\t');
      (deps.appendAudit ?? ((l: string) => fs.appendFileSync(auditFile, `${l}\n`)))(line);
    } catch {
      // the tool-level audit_log row still records the removal
    }
    done({ removed: true, archive });
  }
  return { ok: true, results };
}

/** Compact, tool-result-sized rendering (a full verdict list overruns the result cap). */
export function renderReclaimPlan(plan: ReclaimPlan) {
  const pick = (d: ReclaimDisposition) => plan.verdicts.filter((v) => v.disposition === d);
  const row = (v: ReclaimVerdict) => ({
    path: v.path,
    ...(v.realPath && v.realPath !== v.path ? { real: v.realPath } : {}),
    rootFs: v.onRootFs,
    version: v.version,
    ...(v.leaseTags.length ? { leases: v.leaseTags } : {}),
    ...(v.ignoredLeases.length ? { leasesIgnored: v.ignoredLeases } : {}),
  });
  return {
    latestPublished: plan.latestPublished,
    failClosed: plan.failClosed,
    counts: {
      reclaimable: pick('reclaimable').length,
      namedOnly: pick('named-only').length,
      protected: pick('protected').length,
      autoManagedSkipped: plan.skipped.autoManaged.length,
      prunableSkipped: plan.skipped.prunable,
    },
    reclaimable: pick('reclaimable').map(row),
    namedOnly: pick('named-only').map(row),
    protected: pick('protected').map((v) => ({ path: v.path, reasons: v.reasons })),
  };
}
