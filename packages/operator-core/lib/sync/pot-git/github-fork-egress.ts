/**
 * pot-git/github-fork-egress.ts — the FORK-PR contribution leg of the GitHub
 * bridge (github-bridge-hive-egress-2026-07-02 P-004; design S-5c, D-001).
 *
 * A namespace-publishing joiner WITHOUT origin write (the fork-PR contributor
 * of the legacy flow) has their work reach the GitHub upstream the SAME way it
 * always has: fork → branch → human-reviewed PR. This module egresses a
 * RATIFIED integration-request head (integration-requests.ts G-5c — the owner
 * has already said "integrate this exact sha") from the pot-git bare store as
 * exactly that: push the head to the contributor's OWN fork, open a PR
 * fork→upstream. D-007/D-007b semantics unchanged — this NEVER pushes the
 * upstream directly.
 *
 * REUSE, NOT REBUILD:
 *   - the fork/PR orchestration is the EXISTING `openForkPr`
 *     (harness/open-fork-pr.ts: ensureFork → push → PR, token-redacting) — we
 *     supply only its `pushFn` seam, replacing the local-clone push with a
 *     bare-store push;
 *   - that bare-store push is `egressCanonicalRefs` (P-001) against the fork
 *     remote, so the fork leg inherits the SAME outward gates as canonical
 *     egress: FF-only, un-forced, per-commit-range SECRETS SCAN — a ratified
 *     sha that carries a credential still never leaves the machine.
 *
 * RATIFIED-ONLY (fail-closed): the input carries the request's `state`; anything
 * but 'ratified' is refused before any outward action. Ratification is per-sha
 * (G-5c), so the branch name is derived from (device, sha) — re-running the same
 * request is idempotent at the push (upToDate) and re-attempts only the PR.
 *
 * Fail-soft: never throws; every failure folds into the result (token-redacted
 * by openForkPr for the outward legs).
 */

import { buildCloneUrl } from '../../harness/clone-url';
import { openForkPr, type OpenForkPrOpts, type OpenForkPrResult } from '../../harness/open-fork-pr';
import { type RunGit, defaultRunGit, deviceNamespaceKey } from './storage';
import { egressCanonicalRefs } from './github-egress';
import { requireHiveEffectAuthority, type HiveEffectAuthority } from './hive-effect-authority';
import type { SignedProtocolScope } from './signed-context';
import type { IntegrationRequestState } from './integration-requests';

/** The deterministic fork branch for a ratified (device, sha) request. */
export function forkEgressBranch(potSlug: string, devicePubkeyBase64: string, headSha: string): string {
  const devHex8 = deviceNamespaceKey(devicePubkeyBase64).slice(0, 8);
  return `hive/${potSlug}/${devHex8}-${headSha.slice(0, 8)}`;
}

export interface ForkEgressRequest {
  devicePubkey: string;
  headSha: string;
  /** MUST be 'ratified' — anything else is refused (fail-closed). */
  state: IntegrationRequestState;
  authorGithubUserId?: number | null;
}

export interface ForkEgressInput {
  scope?: SignedProtocolScope;
  authority?: HiveEffectAuthority | null;
  /** The pot-git bare repo (storage.ts hiveGitRepoPath). */
  repoPath: string;
  potSlug: string;
  /** The ratified integration request to egress. */
  request: ForkEgressRequest;
  /** Upstream (PR target) coords — "github.com/owner/repo" + owner/repo/base. */
  upstreamRemote: string;
  upstreamOwner: string;
  upstreamRepo: string;
  baseBranch: string;
  /** gh token with write to the contributor's own fork. */
  token: string;
  /** PR title/body overrides (a derived default is used otherwise). */
  title?: string;
  body?: string;
  runGit?: RunGit;
  /** Injected seams (tests): forwarded to openForkPr / the fork push URL. */
  ensureForkFn?: OpenForkPrOpts['ensureForkFn'];
  openPrFn?: OpenForkPrOpts['openPrFn'];
  /** Build the authed push URL for the fork (default: buildCloneUrl). */
  forkPushUrl?: (forkFullName: string, token: string) => string;
}

export type ForkEgressResult =
  | {
      ok: true;
      branch: string;
      forkFullName: string;
      prNumber: number;
      prUrl: string;
    }
  | { ok: false; refused?: 'not_ratified' | 'sha_missing'; error: string };

/**
 * Egress one ratified integration-request head as a fork→PR. Never throws;
 * never touches the upstream remote except to open the PR.
 */
export async function egressRatifiedRequestAsForkPr(input: ForkEgressInput): Promise<ForkEgressResult> {
  const runGit = input.runGit ?? defaultRunGit;
  const req = input.request;

  // Fail-closed gates BEFORE any outward action.
  if (req.state !== 'ratified') {
    return { ok: false, refused: 'not_ratified', error: `request state is '${req.state}', only ratified heads egress` };
  }
  try {
    await requireHiveEffectAuthority(input.authority, input.scope ?? { hive_id: '', repo_key: '' },
      ['fork-pr', input.upstreamOwner, input.upstreamRepo, req.headSha]);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const have = await runGit(['cat-file', '-e', `${req.headSha}^{commit}`], input.repoPath);
  if (have.code !== 0) {
    return { ok: false, refused: 'sha_missing', error: `head ${req.headSha} not present in the pot-git store` };
  }

  const branch = forkEgressBranch(input.potSlug, req.devicePubkey, req.headSha);
  const devHex8 = deviceNamespaceKey(req.devicePubkey).slice(0, 8);
  const forkPushUrl = input.forkPushUrl ?? ((full: string, token: string) => buildCloneUrl(full, token));

  const res: OpenForkPrResult = await openForkPr({
    upstreamRemote: input.upstreamRemote,
    upstreamOwner: input.upstreamOwner,
    upstreamRepo: input.upstreamRepo,
    baseBranch: input.baseBranch,
    featureBranch: branch,
    // The push source is the BARE STORE, not a local clone — our pushFn below
    // is the only thing that reads this, via egressCanonicalRefs.
    localRepoPath: input.repoPath,
    title: input.title ?? `hive ${input.potSlug}: integrate ${req.headSha.slice(0, 8)} (device ${devHex8})`,
    body:
      input.body ??
      `Ratified hive integration request (github-bridge fork egress).\n\n` +
        `- hive: \`${input.potSlug}\`\n- device: \`${devHex8}\`\n- head: \`${req.headSha}\`\n` +
        (req.authorGithubUserId ? `- author github id: ${req.authorGithubUserId}\n` : ''),
    token: input.token,
    beforeEffect: effect => requireHiveEffectAuthority(input.authority, input.scope ?? { hive_id: '', repo_key: '' },
      [effect, input.upstreamOwner, input.upstreamRepo, branch, req.headSha]),
    ensureForkFn: input.ensureForkFn,
    openPrFn: input.openPrFn,
    pushFn: async (args) => {
      // The P-001 egress path IS the push: FF-only, un-forced, secrets-gated.
      const egress = await egressCanonicalRefs({
        scope: input.scope,
        authority: input.authority,
        repoPath: args.repoPath,
        remoteUrl: forkPushUrl(args.forkFullName, args.token),
        refs: [{ sha: req.headSha, remoteRef: `refs/heads/${args.branch}` }],
        runGit,
        // This branch NAMES one ratified head, so the WI-5738 drain semantic
        // (publish the verified prefix when the scan stops early) is wrong
        // here: it would leave a branch on the fork misrepresenting what was
        // ratified, right after refusing with "nothing left the machine".
        // All-or-nothing — the message below is then literally true.
        requireExactTarget: true,
      });
      if (egress.blockedSecrets.length > 0) {
        const b = egress.blockedSecrets[0];
        throw new Error(
          `secrets gate blocked the fork push (${b.findings.length} finding(s)${b.overflow ? ', scan overflow' : ''}) — nothing left the machine`,
        );
      }
      if (egress.rejectedNonFF.length > 0) {
        throw new Error(`fork branch ${args.branch} diverged on the fork — refusing to force (${egress.rejectedNonFF[0].reason})`);
      }
      if (egress.errors.length > 0) throw new Error(egress.errors.join('; '));
      // pushed or upToDate (idempotent re-run) both proceed to the PR step.
    },
  });

  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, branch, forkFullName: res.forkFullName, prNumber: res.prNumber, prUrl: res.prUrl };
}
