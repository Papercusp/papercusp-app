/**
 * pot-git/github-ingress-admission.ts — the CODE-PLANE admission gate for the
 * GitHub ingress leg (github-bridge-hive-egress-2026-07-02 P-005; design S-6).
 *
 * THE HOLE THIS CLOSES (the ingress twin of pr-host/contribution-admission):
 * substrate revocation denies a revoked contributor's DEVICES on every peer's
 * read-merge, and contribution-admission denies their fork→PRs — but the
 * BRIDGE'S ingress namespace (P-002 github-origin) is a third door: a revoked
 * contributor who still holds GitHub-side write (or lands commits via someone
 * else's merge) would ride into the integrator's staging THROUGH the synthetic
 * namespace. This gate runs between ingress and integration: the integrator
 * only consumes a github-origin head this module ADMITS.
 *
 * THE PREDICATE (mirrors contribution-admission exactly):
 *   - walk the NEWLY INGRESSED range (lastAdmitted..head), extract each
 *     commit's GitHub author identity (the `<id>+<login>@users.noreply.github.com`
 *     author/committer email pattern; an injectable resolver can widen this);
 *   - a commit by a REVOKED contributor (isHiveContributorRevoked — a bound
 *     member whose every device is revoked) BLOCKS the head;
 *   - an UNKNOWN author (unmappable email) is REPORTED, never blocked — same
 *     posture as contribution-admission: unknown ≠ revoked; unknown-author
 *     POLICY belongs to the trust gate at the integrator (the G-5c
 *     below-steer-tier queue), not to revocation.
 *
 * FAIL-CLOSED — this is a TRUST decision (the integration-requests gate
 * posture, NOT contribution-admission's fail-safe): a git failure, an
 * over-long range, or a revocation-check ERROR excludes the head from
 * integration and reports why. The head stays visible in the namespace
 * (ingress already landed it); it just doesn't integrate until re-checked.
 * BASELINE EXEMPTION: the FIRST ingress (lastAdmitted=null) is the repo's
 * pre-bridge GitHub history — the hive was typically CREATED from it — and
 * admits as baseline rather than walking years of history.
 *
 * Pure over storage.ts's RunGit + an injected isRevoked seam (default wraps
 * pr-host/contribution-admission.isHiveContributorRevoked), so it tests against
 * a temp repo with no PG.
 */

import { isHiveContributorRevoked } from '../../pr-host/contribution-admission';
import { type RunGit, defaultRunGit } from './storage';

/** Range cap — a single ingress advance bigger than this fails CLOSED (a legit
 *  giant push is rare; an owner re-baselines or raises the cap). */
export const DEFAULT_MAX_RANGE_COMMITS = 5_000;

/** GitHub noreply author emails: `<id>+<login>@users.noreply.github.com` (new)
 *  or `<login>@users.noreply.github.com` (legacy — no numeric id ⇒ unknown). */
const NOREPLY_RE = /^(?:(\d+)\+)?([A-Za-z0-9-]+)@users\.noreply\.github\.com$/i;

/** Extract a numeric GitHub user id from a commit email, when derivable. */
export function githubUserIdFromEmail(email: string): number | null {
  const m = NOREPLY_RE.exec(email.trim());
  if (!m || !m[1]) return null;
  const id = Number(m[1]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export interface AdmissionInput {
  /** The pot-git bare repo. */
  repoPath: string;
  /** The last ADMITTED github-origin head (null = first ingress → baseline). */
  lastAdmitted: string | null;
  /** The newly ingressed github-origin head to judge. */
  head: string;
  /** Revocation scope (contribution-admission coords). */
  workspaceId: string;
  potHomeSlug: string;
  runGit?: RunGit;
  /** Injected revocation predicate (default: isHiveContributorRevoked). */
  isRevoked?: (githubUserId: number) => Promise<boolean>;
  /** Widen author→id resolution beyond the noreply pattern (e.g. an octokit
   *  email→user lookup). Consulted only when the pattern yields nothing. */
  resolveGithubUserId?: (email: string) => Promise<number | null>;
  maxRangeCommits?: number;
}

export interface AdmissionResult {
  /** May the integrator consume this head? */
  admit: boolean;
  /** 'baseline' = first-ingress exemption; 'clean' = walked and clear. */
  basis: 'baseline' | 'clean' | 'blocked' | 'error';
  /** Revoked authors found in the range, with their commits. */
  blockedAuthors: { githubUserId: number; commits: string[] }[];
  /** Emails we could not map to a GitHub id — visibility, never a block. */
  unknownAuthors: string[];
  /** GitHub ids checked against revocation. */
  checkedAuthorIds: number[];
  errors: string[];
}

/**
 * Judge one newly-ingressed github-origin head. Never throws; errors fail
 * CLOSED (admit:false, basis:'error').
 */
export async function admitGithubOriginHead(input: AdmissionInput): Promise<AdmissionResult> {
  const runGit = input.runGit ?? defaultRunGit;
  const maxRange = input.maxRangeCommits ?? DEFAULT_MAX_RANGE_COMMITS;
  const isRevoked =
    input.isRevoked ??
    ((githubUserId: number) =>
      isHiveContributorRevoked({
        workspaceId: input.workspaceId,
        potHomeSlug: input.potHomeSlug,
        githubUserId,
      }));

  const res: AdmissionResult = {
    admit: false,
    basis: 'error',
    blockedAuthors: [],
    unknownAuthors: [],
    checkedAuthorIds: [],
    errors: [],
  };

  // Baseline exemption: the first ingress is pre-bridge history, not a contribution.
  if (input.lastAdmitted === null) {
    res.admit = true;
    res.basis = 'baseline';
    return res;
  }

  // Walk the newly ingressed range: sha \0 author-email \0 committer-email.
  const log = await runGit(
    ['log', '--format=%H%x00%ae%x00%ce', `${input.lastAdmitted}..${input.head}`],
    input.repoPath,
  );
  if (log.code !== 0) {
    res.errors.push(`rev walk failed: ${log.stderr.trim() || `exited ${log.code}`}`);
    return res; // fail closed
  }
  const rows = log.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (rows.length > maxRange) {
    res.errors.push(`range ${input.lastAdmitted.slice(0, 8)}..${input.head.slice(0, 8)} has ${rows.length} commits (> ${maxRange}) — refusing to judge; re-baseline or raise the cap`);
    return res; // fail closed
  }

  // Collect each author identity's commits (author + committer both count —
  // a revoked contributor rebased in by someone else still authored the code).
  const byId = new Map<number, string[]>();
  const unknown = new Set<string>();
  for (const row of rows) {
    const [sha, authorEmail, committerEmail] = row.split('\0');
    if (!sha) continue;
    const emails = new Set([authorEmail, committerEmail].filter(Boolean) as string[]);
    for (const email of emails) {
      let id = githubUserIdFromEmail(email);
      if (id === null && input.resolveGithubUserId) {
        try {
          id = await input.resolveGithubUserId(email);
        } catch {
          id = null; // resolver failure → unknown (reported), not an admission error
        }
      }
      if (id === null) {
        unknown.add(email);
        continue;
      }
      const list = byId.get(id) ?? [];
      if (!list.includes(sha)) list.push(sha);
      byId.set(id, list);
    }
  }
  res.unknownAuthors = [...unknown].sort();

  // Revocation checks — an ERROR here fails closed (trust decision).
  for (const [id, commits] of byId) {
    res.checkedAuthorIds.push(id);
    try {
      if (await isRevoked(id)) res.blockedAuthors.push({ githubUserId: id, commits });
    } catch (e) {
      res.errors.push(`revocation check for github user ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  res.checkedAuthorIds.sort((a, b) => a - b);

  if (res.errors.length > 0) {
    res.basis = 'error';
    res.admit = false;
  } else if (res.blockedAuthors.length > 0) {
    res.basis = 'blocked';
    res.admit = false;
  } else {
    res.basis = 'clean';
    res.admit = true;
  }
  return res;
}
