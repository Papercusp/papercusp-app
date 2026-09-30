/**
 * pot-git/github-ingress.ts — the INGRESS half of the GitHub bridge
 * (github-bridge-hive-egress-2026-07-02 P-002; design S-3/S-4, D-001).
 *
 * GITHUB-AS-A-MEMBER (S-3): fetches the GitHub origin branch(es) into a
 * dedicated SYNTHETIC device namespace — a "github-origin" device — so
 * GitHub-side commits (a human merging a PR, a legacy member's git-sync push,
 * an external contributor landing on the default branch) become ONE MORE
 * single-writer input the integrator merges. Origin divergence is thereby
 * "not merged yet" (visible, mergeable), never split-brain.
 *
 * THE SYNTHETIC DEVICE KEY: namespaces are keyed by hex-of-raw-32-pubkey
 * (storage.ts deviceNamespaceKey). The github-origin "device" has no keypair —
 * its 32 bytes are a domain-separated SHA-256 of the NORMALIZED remote identity
 * (`github.com/<owner>/<repo>`, lowercased, .git-stripped), so:
 *   - every peer derives the SAME namespace for the same origin (stores
 *     converge with no coordination);
 *   - it is 64-hex and flows through every existing namespace helper
 *     (listNamespaces, gc, bootstrap) unchanged;
 *   - it cannot collide with a real device (that would require inverting
 *     SHA-256 into an Ed25519 keypair).
 * There are NO SIGREFS for this namespace — GitHub can't sign. The bridge layer
 * feeds this head to the integrator EXPLICITLY, gated by the P-005 ingress
 * admission (author→hive identity, contribution-admission revocation), never
 * via the sigrefs-verified member reconcile.
 *
 * REWIND SAFETY (the G-4b/G-8 posture): the fetch lands in a PRIVATE quarantine
 * ref (`refs/ingress-quarantine/…`, ours to clobber — bootstrap.ts idiom), and
 * the namespace head only ADVANCES fast-forward, CAS-guarded (writeNamespaceRef
 * expectedOld) so a concurrent local writer can't be clobbered. A NON-FF origin
 * move (force-push / history rewrite on GitHub) does NOT move the namespace —
 * it is REPORTED in `nonFF` for the P-006 divergence policy to act on (S-4:
 * visible, not destructive). `allowNonFF: true` (owner-authorized, P-006's
 * lever) accepts the rewrite explicitly.
 *
 * Fail-soft: never throws; per-branch best-effort — one broken branch never
 * stops the others. Pure over storage.ts's RunGit seam — integration tests run
 * against local bare "origin" repos, no network.
 */

import { createHash } from 'node:crypto';
import { clearStaleHolderlessEmptyGitLock } from '../../harness/git-sync/run-git-sync';
import {
  type RunGit,
  NETWORK_RUN_GIT_TIMEOUT_MS,
  defaultRunGit,
  deviceNamespaceKey,
  readNamespaceRef,
  writeNamespaceRef,
} from './storage';

/** Domain-separation tag for the synthetic device derivation (pot-git idiom). */
export const GITHUB_ORIGIN_DEVICE_DOMAIN = 'papercusp-pot-git-github-origin-v1';

/** The private landing area for ingress fetches — never read by anything else,
 *  always safe to clobber (the bootstrap-quarantine posture). */
export const INGRESS_QUARANTINE_PREFIX = 'refs/ingress-quarantine';

/** update-ref's "the ref must NOT exist" old-value (create-only CAS). */
const ZERO_SHA = '0'.repeat(40);

/**
 * Normalize a GitHub remote to its stable identity: `github.com/<owner>/<repo>`
 * (lowercased, `.git` stripped) for https/ssh/scp-style URLs. A non-GitHub or
 * unparseable remote falls back to the trimmed URL itself — still deterministic,
 * just not cross-form-canonical (a file-path test remote lands here).
 */
export function normalizeGithubRemote(remoteUrl: string): string {
  const u = remoteUrl.trim();
  const m = /^(?:(?:https?|ssh|git):\/\/)?(?:[^@/]+@)?github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(u);
  if (m) return `github.com/${m[1].toLowerCase()}/${m[2].toLowerCase()}`;
  return u;
}

/**
 * The synthetic "github-origin" device pubkey (raw-32 base64) for a remote —
 * a domain-separated SHA-256 of the normalized remote identity. Feed it to any
 * storage.ts helper exactly like a real device pubkey.
 */
export function githubOriginDevicePubkey(remoteUrl: string): string {
  return createHash('sha256')
    .update(`${GITHUB_ORIGIN_DEVICE_DOMAIN}:${normalizeGithubRemote(remoteUrl)}`)
    .digest('base64');
}

/** The synthetic device's namespace key (64-hex) for a remote. */
export function githubOriginNamespaceKey(remoteUrl: string): string {
  return deviceNamespaceKey(githubOriginDevicePubkey(remoteUrl));
}

export interface IngressInput {
  /** The pot-git bare repo (storage.ts hiveGitRepoPath). */
  repoPath: string;
  /** The GitHub remote to ingress from (a local path works — tests). */
  remoteUrl: string;
  /**
   * Registered full checkout for bounded shallow-history repair. Its current
   * origin/<branch> (or local branch in tests) can supply already-present
   * history without downloading the whole graph from GitHub again.
   */
  historySourcePath?: string;
  /** Branch names to ingress (WITHOUT refs/heads/), e.g. ['main']. */
  branches: string[];
  runGit?: RunGit;
  /**
   * Accept a NON-FF origin move (history rewrite) — default false. This is the
   * P-006 divergence-policy lever, owner-authorized; the default posture only
   * ever fast-forwards the synthetic namespace.
   */
  allowNonFF?: boolean;
}

export interface IngressUpdated {
  branch: string;
  /** The synthetic namespace head before (null = first ingress of this branch). */
  from: string | null;
  to: string;
  /** True when this update accepted a non-FF rewrite (allowNonFF only). */
  forced: boolean;
}

export interface IngressNonFF {
  branch: string;
  /** Where the synthetic namespace currently points. */
  local: string;
  /** Where origin now points (not an ancestor-descendant of local). */
  remote: string;
}

export interface IngressResult {
  ok: boolean;
  /** The synthetic device's namespace key (hex) — what the integrator keys on. */
  namespaceKey: string;
  updated: IngressUpdated[];
  upToDate: string[];
  /** Origin rewrote history — namespace NOT moved (unless allowNonFF). P-006 owns follow-up. */
  nonFF: IngressNonFF[];
  /** Branches absent on the remote (deleted / never existed). */
  absent: string[];
  errors: {
    branch?: string;
    message: string;
    /**
     * True when this error came from `defaultRunGit`'s `code === -1`
     * never-throw sentinel — the git PROCESS itself failed to spawn
     * (ENOENT/EACCES, typically right after an env/PATH change such as a
     * host restart) or was killed by the 60s watchdog, so the transport
     * never actually ran. Distinct from git running and returning a real
     * (>=0) exit code with a transport-level error (auth refused, repo not
     * found, network unreachable) — only the latter is genuinely a
     * "fix the remote URL or credential" situation (EI-18152354175913564).
     */
    transient?: boolean;
  }[];
}

/**
 * A shallow bare store cannot answer every ancestry question: git treats each
 * shallow boundary as a root, so `merge-base --is-ancestor` can return 1 for a
 * real fast-forward whose path crosses that boundary. Before escalating a
 * would-be history rewrite, deepen the fetched branch once and retry against
 * the complete graph. A failed/incomplete deepen is inconclusive and must not
 * be reported as a non-FF rewrite.
 */
async function deepenShallowAncestry(input: {
  repoPath: string;
  remoteUrl: string;
  historySourcePath?: string;
  branch: string;
  quarantineRef: string;
  current: string;
  remoteSha: string;
  runGit: RunGit;
}): Promise<{ ancestor: boolean; conclusive: boolean; error?: string }> {
  const shallow = await input.runGit(['rev-parse', '--is-shallow-repository'], input.repoPath);
  if (shallow.code !== 0 || shallow.stdout.trim() !== 'true') {
    return { ancestor: false, conclusive: true };
  }

  const fetchCompleteHistory = async (source: string, sourceRef: string) => {
    const fetchArgs = ['fetch', '--unshallow', source, `+${sourceRef}:${input.quarantineRef}`];
    let result = await input.runGit(fetchArgs, input.repoPath, { timeoutMs: NETWORK_RUN_GIT_TIMEOUT_MS });
    if (
      result.code !== 0 &&
      /Unable to create '[^']*shallow\.lock': File exists/i.test(`${result.stdout}\n${result.stderr}`)
    ) {
      const cleared = await clearStaleHolderlessEmptyGitLock(input.runGit, input.repoPath, 'shallow.lock', () => {});
      if (cleared) {
        result = await input.runGit(fetchArgs, input.repoPath, { timeoutMs: NETWORK_RUN_GIT_TIMEOUT_MS });
      }
    }
    return result;
  };

  let deepen: Awaited<ReturnType<RunGit>> | undefined;
  if (input.historySourcePath) {
    for (const sourceRef of [`refs/remotes/origin/${input.branch}`, `refs/heads/${input.branch}`]) {
      const sourceHead = await input.runGit(
        ['rev-parse', '--verify', '--quiet', `${sourceRef}^{commit}`],
        input.historySourcePath,
      );
      if (sourceHead.code !== 0 || sourceHead.stdout.trim() !== input.remoteSha) continue;
      deepen = await fetchCompleteHistory(input.historySourcePath, sourceRef);
      break;
    }
  }
  if (!deepen || deepen.code !== 0) {
    deepen = await fetchCompleteHistory(input.remoteUrl, `refs/heads/${input.branch}`);
  }
  const retry = await input.runGit(['merge-base', '--is-ancestor', input.current, input.remoteSha], input.repoPath);
  if (retry.code === 0) return { ancestor: true, conclusive: true };

  // Another writer can finish the unshallow between our probe and fetch; in
  // that race the fetch may complain that the repo is already complete, while
  // the retried ancestry result is still authoritative. Only classify a real
  // non-FF once the repository now reports a complete graph.
  const after = await input.runGit(['rev-parse', '--is-shallow-repository'], input.repoPath);
  if (after.code === 0 && after.stdout.trim() === 'false') {
    return { ancestor: false, conclusive: true };
  }

  const detail = deepen.stderr.trim() || `fetch --unshallow exited ${deepen.code}`;
  return {
    ancestor: false,
    conclusive: false,
    error: `cannot verify ancestry across the shallow boundary: ${detail}`,
  };
}

/**
 * Ingress origin branches into the synthetic github-origin namespace.
 * FF-only + CAS by default; per-branch best-effort; never throws.
 */
export async function ingressOriginBranches(input: IngressInput): Promise<IngressResult> {
  const runGit = input.runGit ?? defaultRunGit;
  const devPubkey = githubOriginDevicePubkey(input.remoteUrl);
  const nsKey = deviceNamespaceKey(devPubkey);
  const res: IngressResult = {
    ok: true,
    namespaceKey: nsKey,
    updated: [],
    upToDate: [],
    nonFF: [],
    absent: [],
    errors: [],
  };

  for (const branch of input.branches) {
    if (!branch || branch.includes('..') || branch.startsWith('/') || branch.includes('\0')) {
      res.errors.push({ branch, message: 'unsafe branch name' });
      continue;
    }
    const quarantineRef = `${INGRESS_QUARANTINE_PREFIX}/${nsKey}/${branch}`;

    // 1. Fetch origin's head into the quarantine (forced — ours to clobber).
    //    A missing remote branch is "absent", not an error. A GENEROUS timeout
    //    (NETWORK_RUN_GIT_TIMEOUT_MS, not the 60s local-op default): this is a
    //    genuine bulk network transfer that can legitimately take minutes on a
    //    real connection, and a killed fetch discards its partial pack — a
    //    timeout tighter than the transfer needs makes the ingress permanently
    //    un-completable (github-bridge-ingress-timeout-too-short-2026-07-20,
    //    EI-18189246091367226).
    const fetch = await runGit(['fetch', input.remoteUrl, `+refs/heads/${branch}:${quarantineRef}`], input.repoPath, {
      timeoutMs: NETWORK_RUN_GIT_TIMEOUT_MS,
    });
    if (fetch.code !== 0) {
      if (/couldn't find remote ref|no such ref/i.test(fetch.stderr)) {
        res.absent.push(branch);
      } else {
        res.ok = false;
        // code === -1 is defaultRunGit's own sentinel for a process-level
        // fault (spawn error or timeout-kill) — never a real git exit code —
        // so tag it transient rather than let it read as a transport error.
        res.errors.push({
          branch,
          message: fetch.stderr.trim() || `fetch exited ${fetch.code}`,
          transient: fetch.code === -1,
        });
      }
      continue;
    }
    const rev = await runGit(['rev-parse', '--verify', '-q', `${quarantineRef}^{commit}`], input.repoPath);
    const remoteSha = rev.stdout.trim();
    if (rev.code !== 0 || !remoteSha) {
      res.ok = false;
      res.errors.push({ branch, message: 'fetched quarantine ref unreadable' });
      continue;
    }

    // 2. Compare with the synthetic namespace's current head.
    const ref = `refs/heads/${branch}`;
    const current = await readNamespaceRef(input.repoPath, devPubkey, ref, runGit);
    if (current === remoteSha) {
      res.upToDate.push(branch);
      continue;
    }

    try {
      if (current === null) {
        // First ingress — create-only CAS (must not exist).
        await writeNamespaceRef(input.repoPath, devPubkey, ref, remoteSha, runGit, ZERO_SHA);
        res.updated.push({ branch, from: null, to: remoteSha, forced: false });
        continue;
      }
      const ff = await runGit(['merge-base', '--is-ancestor', current, remoteSha], input.repoPath);
      let isFastForward = ff.code === 0;
      if (!isFastForward) {
        const repaired = await deepenShallowAncestry({
          repoPath: input.repoPath,
          remoteUrl: input.remoteUrl,
          historySourcePath: input.historySourcePath,
          branch,
          quarantineRef,
          current,
          remoteSha,
          runGit,
        });
        if (!repaired.conclusive) {
          res.ok = false;
          res.errors.push({ branch, message: repaired.error ?? 'shallow ancestry check was inconclusive' });
          continue;
        }
        isFastForward = repaired.ancestor;
      }
      if (isFastForward) {
        // Fast-forward — CAS on the head we just read.
        await writeNamespaceRef(input.repoPath, devPubkey, ref, remoteSha, runGit, current);
        res.updated.push({ branch, from: current, to: remoteSha, forced: false });
      } else if (input.allowNonFF) {
        // Owner-authorized rewrite acceptance (P-006's lever) — still CAS-guarded.
        await writeNamespaceRef(input.repoPath, devPubkey, ref, remoteSha, runGit, current);
        res.updated.push({ branch, from: current, to: remoteSha, forced: true });
      } else {
        res.nonFF.push({ branch, local: current, remote: remoteSha });
      }
    } catch (e) {
      // A lost CAS (concurrent local writer) or update-ref failure — report,
      // never wedge the other branches; the next tick reconciles.
      res.ok = false;
      res.errors.push({ branch, message: e instanceof Error ? e.message : String(e) });
    }
  }

  return res;
}
