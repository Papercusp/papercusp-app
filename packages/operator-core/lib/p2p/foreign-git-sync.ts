/**
 * p2p/foreign-git-sync.ts — leg (ii) of P-109: the per-foreign-workspace
 * COMMIT lane (p2p-work-distribution-2026-07-02, design doc §3, ratified Q3:
 * a SEPARATE routine — `system:foreign-git-sync` — never a phase inside the
 * canonical git-sync tick, so a wedged foreign clone cannot stall canonical
 * sync and pausing p2p pauses exactly one routine).
 *
 * WHAT IT DOES, per tick, for each `active` p2p_foreign_workspaces row:
 *   1. Resolve the ORIGIN identity from the attestation map (hive_members):
 *      the member row for `origin_github_user_id` with ≥1 device attestation.
 *      Author email is the modern noreply form
 *      `<id>+<login>@users.noreply.github.com` (X9: the NUMERIC id is the key,
 *      the login is display-only), which `githubUserIdFromEmail` — and thus
 *      the landed P-110 gate — resolves back to the id.
 *   2. Stage + commit the foreign clone. BOTH author AND committer are stamped
 *      with the origin identity (C7): the P-110 gate judges both slots, so a
 *      host-attributed committer would be refused at merge — stamping both is
 *      what makes the lane's output admissible AND honest.
 *   3. Trailers (M21/H9): Papercusp-Offer, Papercusp-Origin-User,
 *      Papercusp-Executor-Device, Papercusp-Execution-Epoch.
 *   4. FAIL CLOSED on identity (C7 is absolute): attestation unresolvable →
 *      commit NOTHING, emit a loud P-004 refusal receipt, PARK the workspace.
 *      Never fall back to a host identity.
 *
 * REUSE (not fork): the git primitives are run-git-sync's exported seams —
 * `runGitBounded` (timeout discipline) + `findOversizedDirtyFiles` (the EI-18
 * oversized-blob exclusion; an excluded blob is REPORTED, the rest commits).
 * git-sync-attribution's multi-agent grouping deliberately does NOT apply:
 * one foreign workspace = one fixed identity = one commit group (§3).
 *
 * SCOPE DISJOINTNESS (the mandated C3/WI-1564-class regression): this lane
 * stages ONLY inside `ws.clonePath` (every git call runs `-C clonePath`); the
 * canonical git-sync sweep stages only inside the canonical tree, and the Q1
 * placement invariant (foreign-workspaces.ts) puts the foreign root OUTSIDE
 * every host tree — see foreign-git-sync.test.ts's disjoint-scope test.
 *
 * NO PUSH, EVER: results leave the clone via the leg-(iii) mirror lane
 * (host-side quarantine fetch → per-scope repo, D-018); the foreign clone
 * needs zero git network access (X1-friendly).
 */
import {
  DEFAULT_MAX_BLOB_BYTES,
  findOversizedDirtyFiles,
  gitTimeoutMsFor,
  runGitBounded,
  type OversizedFile,
  type RunGit,
} from '../harness/git-sync/run-git-sync';

/** runGitBounded as a plain RunGit (per-command timeout derived per args). */
const boundedRunGit: RunGit = (args, cwd) => runGitBounded(args, cwd, gitTimeoutMsFor(args));
import { listWorkspaceMembers } from '../hive-membership-store';
import type { OrgSql } from '../work-items';
import {
  listForeignWorkspaces,
  setForeignWorkspaceState,
  type ForeignWorkspace,
} from './foreign-workspaces';
import { emitP2pReceipt, type EmitP2pReceiptArgs, type EmitP2pReceiptResult } from './receipts';

/** The commit identity stamped on BOTH author and committer slots (C7). */
export interface OriginCommitIdentity {
  /** Display name — the member's display_name, else the login. */
  name: string;
  /** Modern GitHub noreply form: `<id>+<login>@users.noreply.github.com`. */
  email: string;
  githubUserId: number;
}

/** Compose the noreply email the P-110 gate resolves back to the numeric id. */
export function originNoreplyEmail(githubUserId: number, login: string): string {
  return `${githubUserId}+${login}@users.noreply.github.com`;
}

/**
 * Resolve the origin commit identity from the attestation map. FAIL CLOSED:
 * null when the member is absent OR has no device attestation (an
 * unattested id must never be stamped onto commits — it would launder an
 * arbitrary identity through the admissible-noreply form).
 */
export async function resolveOriginCommitIdentity(
  workspaceId: string,
  originGithubUserId: number,
  sql?: OrgSql,
): Promise<OriginCommitIdentity | null> {
  const members = await listWorkspaceMembers(workspaceId, sql);
  const member = members.find((m) => m.githubUserId === originGithubUserId);
  if (!member) return null;
  if (!member.deviceAttestations.length) return null;
  return {
    name: member.displayName ?? member.githubUsername,
    email: originNoreplyEmail(member.githubUserId, member.githubUsername),
    githubUserId: member.githubUserId,
  };
}

/** The four mandated trailers (§3 step 3), rendered as a commit-message block. */
export function foreignCommitTrailers(ws: ForeignWorkspace): string {
  return [
    `Papercusp-Offer: ${ws.offerId}`,
    `Papercusp-Origin-User: ${ws.originGithubUserId}`,
    `Papercusp-Executor-Device: ${ws.executorDevice}`,
    `Papercusp-Execution-Epoch: ${ws.executionEpoch}`,
  ].join('\n');
}

export type ForeignCommitOutcome =
  | { status: 'nothing'; oversized: OversizedFile[] }
  | { status: 'committed'; headSha: string; oversized: OversizedFile[] }
  | { status: 'error'; message: string; oversized: OversizedFile[] };

/**
 * One workspace's commit pass: stage everything (minus oversized), commit as
 * the ORIGIN identity with trailers. Never pushes. Idempotent — a clean tree
 * is 'nothing'.
 */
export async function commitForeignWorkspace(
  ws: ForeignWorkspace,
  identity: OriginCommitIdentity,
  opts: { runGit?: RunGit; maxBlobBytes?: number } = {},
): Promise<ForeignCommitOutcome> {
  const runGit = opts.runGit ?? boundedRunGit;
  const repo = ws.clonePath;
  const maxBlobBytes = opts.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES;

  const status = await runGit(['status', '--porcelain'], repo);
  if (status.code !== 0) {
    return { status: 'error', message: `git status failed: ${status.stderr || status.stdout}`, oversized: [] };
  }
  if (!status.stdout.trim()) return { status: 'nothing', oversized: [] };

  // EI-18 discipline (reused seam): oversized dirty files are EXCLUDED from the
  // commit and reported — they never wedge the lane, and (X4) never reach the
  // shared ODB via the mirror because they were never committed here.
  const oversized = await findOversizedDirtyFiles(runGit, repo, maxBlobBytes);

  const add = await runGit(['add', '-A'], repo);
  if (add.code !== 0) {
    return { status: 'error', message: `git add failed: ${add.stderr || add.stdout}`, oversized };
  }
  if (oversized.length) {
    const unstage = await runGit(['reset', '-q', 'HEAD', '--', ...oversized.map((o) => o.path)], repo);
    if (unstage.code !== 0) {
      // Fail CLOSED: committing an oversized blob is worse than skipping a tick.
      return {
        status: 'error',
        message: `oversized unstage failed: ${unstage.stderr || unstage.stdout}`,
        oversized,
      };
    }
  }

  const staged = await runGit(['diff', '--cached', '--quiet'], repo);
  if (staged.code === 0) return { status: 'nothing', oversized };

  const subject = `foreign-work(${ws.fleetSlug}): auto-commit for offer ${ws.offerId}`;
  const commit = await runGit(
    [
      '-c',
      `user.name=${identity.name}`,
      '-c',
      `user.email=${identity.email}`,
      'commit',
      '--author',
      `${identity.name} <${identity.email}>`,
      '-m',
      subject,
      '-m',
      foreignCommitTrailers(ws),
    ],
    repo,
  );
  if (commit.code !== 0) {
    return { status: 'error', message: `git commit failed: ${commit.stderr || commit.stdout}`, oversized };
  }
  const head = await runGit(['rev-parse', 'HEAD'], repo);
  return { status: 'committed', headSha: head.stdout.trim(), oversized };
}

export interface ForeignGitSyncTickResult {
  workspaces: Array<{
    offerId: string;
    outcome: ForeignCommitOutcome | { status: 'parked'; reason: string };
  }>;
}

export interface RunForeignGitSyncTickOpts {
  runGit?: RunGit;
  maxBlobBytes?: number;
  sql?: OrgSql;
  /** Injection seams (tests run against temp repos with no PG). */
  listWorkspaces?: typeof listForeignWorkspaces;
  resolveIdentity?: typeof resolveOriginCommitIdentity;
  setState?: typeof setForeignWorkspaceState;
  emitReceipt?: (args: EmitP2pReceiptArgs) => Promise<EmitP2pReceiptResult>;
  /** The receipt author (the enforcing host). 0 = unknown-host fallback. */
  hostGithubUserId?: number;
  potSlug?: string;
  log?: (m: string) => void;
}

/**
 * One `system:foreign-git-sync` tick over a workspace's ACTIVE foreign
 * workspaces. Identity-unresolvable rows are PARKED with a loud receipt and
 * commit NOTHING (§3 step 4); everything else gets an origin-stamped commit
 * pass. Errors on one workspace never stall the others (loud failure
 * separation is the whole reason this is a separate lane).
 */
export async function runForeignGitSyncTick(
  workspaceId: string,
  opts: RunForeignGitSyncTickOpts = {},
): Promise<ForeignGitSyncTickResult> {
  const log = opts.log ?? ((m: string) => console.log(`[foreign-git-sync] ${m}`));
  const listWs = opts.listWorkspaces ?? listForeignWorkspaces;
  const resolveIdentity = opts.resolveIdentity ?? resolveOriginCommitIdentity;
  const setState = opts.setState ?? setForeignWorkspaceState;
  const emitReceipt = opts.emitReceipt ?? emitP2pReceipt;

  const active = await listWs(workspaceId, { state: 'active' }, opts.sql);
  const result: ForeignGitSyncTickResult = { workspaces: [] };

  for (const ws of active) {
    const identity = await resolveIdentity(workspaceId, ws.originGithubUserId, opts.sql);
    if (!identity) {
      // FAIL CLOSED (C7): no attested origin identity → nothing commits, the
      // workspace parks, and the refusal is LOUD (receipt + audit + counter).
      const reason = `attestation-unresolvable: origin github user ${ws.originGithubUserId} has no attested hive membership in workspace ${workspaceId}`;
      await setState(workspaceId, ws.offerId, 'parked', { parkReason: 'attestation-unresolvable' }, opts.sql);
      await emitReceipt({
        workspaceId,
        potSlug: opts.potSlug ?? ws.fleetSlug,
        kind: 'refusal',
        offerId: ws.offerId,
        action: 'foreign-git-sync:commit',
        refusal: { code: 'attestation_unresolvable', detail: reason },
        requester: { kind: 'fleet', ref: ws.fleetSlug, githubUserId: ws.originGithubUserId },
        responderGithubUserId: opts.hostGithubUserId ?? 0,
      });
      log(`PARKED offer ${ws.offerId}: ${reason}`);
      result.workspaces.push({ offerId: ws.offerId, outcome: { status: 'parked', reason } });
      continue;
    }

    const outcome = await commitForeignWorkspace(ws, identity, {
      runGit: opts.runGit,
      maxBlobBytes: opts.maxBlobBytes,
    });
    if (outcome.status === 'committed') {
      log(`offer ${ws.offerId}: committed ${outcome.headSha.slice(0, 12)} as ${identity.email}`);
    } else if (outcome.status === 'error') {
      log(`offer ${ws.offerId}: ERROR ${outcome.message}`);
    }
    if (outcome.oversized.length) {
      log(
        `offer ${ws.offerId}: excluded ${outcome.oversized.length} oversized file(s): ` +
          outcome.oversized.map((o) => `${o.path} (${o.sizeBytes}B)`).join(', '),
      );
    }
    result.workspaces.push({ offerId: ws.offerId, outcome });
  }
  return result;
}
