/**
 * p2p/foreign-clone.ts — leg (iv) of P-109: provision a foreign workspace's
 * git clone per the leader-ratified X4 resolution (Q5, 2026-07-03):
 * **`git clone --no-local`** — full clone, PRIVATE object database, no
 * alternates, no hardlinks. Blobless/partial clones are explicitly post-v1
 * (a promisor remote would need in-sandbox network — the X1 loopback hole).
 *
 * WHY --no-local IS THE INVARIANT (X4): a `git worktree` shares the ODB via
 * commondir, so any checkout-level quota is void and a foreign `git add` of a
 * huge blob poisons the SHARED, FEDERATED repo; a plain file:// local clone
 * hardlinks objects, tying the foreign ODB to the host ODB's gc lifetime and
 * undercounting quota. `--no-local` forces a real object copy.
 *
 * `assertPrivateOdb` re-verifies the invariant POST-clone (defense against a
 * future git changing local-clone defaults): no alternates file, a real
 * objects dir. Provision order: REGISTER first (the registry's root_path
 * uniqueness is the atomic claim on the quota subtree), then clone; a clone
 * failure parks the row loudly rather than deleting it (the breadcrumb is the
 * receipt trail, P-004 posture).
 *
 * Pure over pot-git's RunGit + an injectable `register` seam, so the git
 * mechanics test against temp repos with no PG.
 */
import { mkdir, stat, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { type RunGit, defaultRunGit } from '../sync/pot-git/storage';
import {
  type ForeignWorkspace,
  type RegisterResult,
  registerForeignWorkspace,
  setForeignWorkspaceBaseSha,
  setForeignWorkspaceState,
} from './foreign-workspaces';
import { registerEphemeralForeignHarness, type ProjectEntry } from '../harness-registry';
import { enforceForeignWorkspaceQuota } from './sandbox/quota-volume';

export interface ProvisionInput {
  /** The host repo to clone FROM (the canonical tree or a bare mirror). */
  sourceRepoPath: string;
  /** Registry identity (mig 467 row). */
  workspaceId: string;
  offerId: string;
  fleetSlug: string;
  originGithubUserId: number;
  executorDevice: string;
  /** The quota subtree root (Q1 invariant applies); clone lands at <root>/repo. */
  rootPath: string;
  /** Base branch to check out (omit = the source's default branch). */
  branch?: string;
  executionEpoch?: number;
  /** Q1 invariant scope passthrough (tests inject; prod defaults from env). */
  workspaceRoot?: string;
  canonicalTree?: string;
  runGit?: RunGit;
  /** Injectable registry seams (default: the PG store). */
  register?: (input: Parameters<typeof registerForeignWorkspace>[0]) => Promise<RegisterResult>;
  park?: (offerId: string, reason: string) => Promise<unknown>;
  recordBaseSha?: (workspaceId: string, offerId: string, baseSha: string) => Promise<void>;
  /**
   * WI-1937 D-001 option B (leader steer, msg mre5tvu2 2026-07-09): register an
   * EPHEMERAL harness_registry row for the clone so `resolveProject` /
   * `spawnAgentInHarness` can cwd the eventual `foreign-session` spawn into
   * this sandboxed clone via the SAME registry-resolution chokepoint every
   * other spawn uses — zero core-spawn-path changes. Default: the real
   * harness-registry write (harness-registry.ts); tests inject a stub.
   */
  registerHarness?: (offerId: string, clonePath: string, workspaceId: string) => Promise<ProjectEntry>;
}

export type ProvisionResult =
  | { ok: true; workspace: ForeignWorkspace; clonePath: string }
  | {
      ok: false;
      refusal: {
        code: 'invariant' | 'conflict' | 'clone-failed' | 'odb-not-private' | 'harness-register-failed' | 'quota-exceeded';
        detail: string;
      };
    };

/** X4 post-clone verification: the clone's ODB is PRIVATE — no alternates
 *  file, a real objects directory. Returns null when private, else why not. */
export async function privateOdbViolation(clonePath: string): Promise<string | null> {
  const gitDir = join(clonePath, '.git');
  try {
    const s = await stat(join(gitDir, 'objects'));
    if (!s.isDirectory()) return `${gitDir}/objects is not a directory`;
  } catch {
    return `${gitDir}/objects is missing — not a full clone`;
  }
  try {
    const alt = (await readFile(join(gitDir, 'objects', 'info', 'alternates'), 'utf8')).trim();
    if (alt.length > 0) return `clone ODB has alternates (${alt.split('\n')[0]}…) — objects are SHARED, X4 violated`;
  } catch {
    /* no alternates file = good */
  }
  return null;
}

/**
 * Provision one foreign workspace clone: register (atomic root claim) →
 * `git clone --no-local` → verify private ODB. Never throws on runtime data;
 * every failure is a typed refusal and the registry row is PARKED with the
 * reason (loud breadcrumb), never silently deleted.
 */
export async function provisionForeignClone(input: ProvisionInput): Promise<ProvisionResult> {
  const runGit = input.runGit ?? defaultRunGit;
  const clonePath = join(input.rootPath, 'repo');
  const register = input.register ?? ((i) => registerForeignWorkspace(i));
  const park =
    input.park ??
    ((offerId: string, reason: string) =>
      setForeignWorkspaceState(input.workspaceId, offerId, 'parked', { parkReason: reason }));

  const reg = await register({
    workspaceId: input.workspaceId,
    offerId: input.offerId,
    fleetSlug: input.fleetSlug,
    originGithubUserId: input.originGithubUserId,
    executorDevice: input.executorDevice,
    rootPath: input.rootPath,
    clonePath,
    executionEpoch: input.executionEpoch,
    workspaceRoot: input.workspaceRoot,
    canonicalTree: input.canonicalTree,
  });
  if (!reg.ok) return { ok: false, refusal: reg.refusal };

  await mkdir(dirname(clonePath), { recursive: true });
  const args = ['clone', '--no-local', '-q'];
  if (input.branch) args.push('-b', input.branch);
  args.push(input.sourceRepoPath, clonePath);
  const c = await runGit(args, dirname(clonePath));
  if (c.code !== 0) {
    const detail = `git clone --no-local failed for offer ${input.offerId}: ${c.stderr.trim() || `exited ${c.code}`}`;
    await park(input.offerId, detail);
    return { ok: false, refusal: { code: 'clone-failed', detail } };
  }

  const odb = await privateOdbViolation(clonePath);
  if (odb) {
    const detail = `offer ${input.offerId}: ${odb}`;
    await park(input.offerId, detail);
    return { ok: false, refusal: { code: 'odb-not-private', detail } };
  }

  // WI-1937 step 4: register the ephemeral harness_registry row NOW — the
  // clone is fully provisioned + ODB-verified, so this is the earliest safe
  // point. A registration failure means the eventual spawn leg could never
  // resolve this clone (resolveProject would 404 it), so this is a hard
  // refusal, not best-effort — park like the other provisioning failures.
  const registerHarness = input.registerHarness ?? registerEphemeralForeignHarness;
  try {
    await registerHarness(input.offerId, clonePath, input.workspaceId);
  } catch (e) {
    const detail = `offer ${input.offerId}: ephemeral harness_registry registration failed: ${e instanceof Error ? e.message : String(e)}`;
    await park(input.offerId, detail);
    return { ok: false, refusal: { code: 'harness-register-failed', detail } };
  }

  // P-105 §1: enforce disk quota on the provisioned foreign workspace.
  // Must happen after clone succeeds but before returning success.
  // This is a pure walk — no privilege needed.
  // Default quota cap: 10GB per foreign workspace.
  const quotaCapBytes = 10 * 1024 * 1024 * 1024; // 10GB default
  const quotaResult = await enforceForeignWorkspaceQuota(input.rootPath, quotaCapBytes);
  if (quotaResult.decision.exceeded) {
    const detail = `offer ${input.offerId}: foreign workspace already exceeds quota at provision ` +
      `(used ${quotaResult.usedBytes} bytes > cap ${quotaResult.capBytes} bytes)`;
    await park(input.offerId, detail);
    return { ok: false, refusal: { code: 'quota-exceeded', detail } };
  }

  // Leg iii range anchor (mig 470): record the canonical sha this clone
  // started from — the publish admission excludes what it reaches, so only
  // FOREIGN-introduced commits are judged. Best-effort: a missing base just
  // means full-history judgment later (fail-closed direction).
  let baseSha: string | null = null;
  const head = await runGit(['rev-parse', 'HEAD'], clonePath);
  if (head.code === 0 && head.stdout.trim()) {
    baseSha = head.stdout.trim();
    const record = input.recordBaseSha ?? setForeignWorkspaceBaseSha;
    await record(input.workspaceId, input.offerId, baseSha).catch(() => {});
  }

  return { ok: true, workspace: { ...reg.workspace, baseSha }, clonePath };
}
