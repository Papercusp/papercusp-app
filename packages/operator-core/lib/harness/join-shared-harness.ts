/**
 * join-shared-harness — 6-step Model B orchestration (D-005).
 *
 * Steps per D-005 (papercusp-phase1b-bidirectional-federation-2026-06-01):
 *   1. oauth_attest          — device keypair + channel-1 OAuth + attestation gist
 *   2. clone_repo            — git-clone the shared GitHub repo
 *   3. publish_binding       — write-free: confirm the device attestation gist id (no repo write)
 *   4. boot_federate         — boot this harness's Model B substrate (joins swarm)
 *   5. await_admission_merge — bounded wait for a remote op (peer admitted + data flowing)
 *   6. route_insights        — signal completion (UI navigates to /harness/<slug>/insights)
 *
 * Deleted Autobase-era steps:
 *   join_hyperswarm       — dead stub (always phase_0_pending)
 *   seed_pg               — dead stub (always phase_0_pending)
 *   bootstrap_hyperbee    — replaced by boot_federate
 *   create_user_branch    — gone: write-free join (non-collaborator-join-fork-pr)
 *                           creates no user/<id> branch
 *   push_contributor_file — gone: write-free join publishes no shared-repo contributor
 *                           file; admission is the attestation gist + signed announce
 *   publish_binding (old) — was a Hyperbee-row step; Model B has no Hyperbee rows;
 *                           the binding IS the attestation gist + signed announce
 *   verify_binding        — rolled into the publish step + boot_federate admission
 *
 * Idempotent resume: the orchestrator persists `JoinState` to
 * `~/.papercusp/join-state/<slug>.json` after each step. On re-run, completed
 * steps are skipped. Delete the file to force a full re-join.
 *
 * Each step is exported individually for isolated unit testing.
 */

import { execFile as _execFile } from 'node:child_process';
import { workspacesRoot } from '../workspace-registry';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { HarnessLink } from './url-scheme';
import type { ChannelResult } from '../identity/binding-verifier-types';
import {
  loadOrGenerateDeviceKeypair,
  createAttestationGist,
} from '../identity/attest';
import type { DeviceKeypairId } from '../identity/attestation-types';
import {
  verifyChannel1,
} from '../identity/two-channel-verifier';
// Pure step vocabulary lives in the dependency-free leaf ./join-steps (so the
// client join UI imports it without this module's server fan-in). Imported for
// local use + re-exported below for existing server consumers.
import {
  ALL_STEP_IDS,
  JOIN_STEP_IDS,
  type JoinStepId,
  type JoinStepStatus,
  type JoinStepState,
} from './join-steps';
import { buildCloneUrl, cleanCloneUrl, redactToken } from './clone-url';

// Lazy promisify — import-safe in the operator-vite SPA bundle (node:util is
// browser-stubbed; a top-level promisify() call crashes at import → blank page).
// Deferred to first call; never invoked in the browser.
const execFile: (...a: unknown[]) => Promise<{ stdout: string; stderr: string }> = (...a) =>
  (promisify(_execFile) as (...x: unknown[]) => Promise<{ stdout: string; stderr: string }>)(...a);

// ─── error class ─────────────────────────────────────────────────────────────

export class JoinStepError extends Error {
  constructor(
    public readonly stepId: JoinStepId,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'JoinStepError';
  }
}

// ─── step id + status types (re-exported from the ./join-steps leaf) ──────────

export type { JoinStepId, JoinStepStatus, JoinStepState } from './join-steps';

// ─── persisted join state ─────────────────────────────────────────────────────

/** Mutable state persisted to disk after each step for idempotent resume. */
export interface JoinState {
  /** Harness slug being joined. */
  slug: string;
  /** Hyperswarm topic from the harness link. */
  linkTopic: string;
  steps: Record<JoinStepId, JoinStepState>;
  startedAt: number;
  completedAt?: number;
  /** Absolute path of the cloned repo dir (set after step 2). */
  cloneDir?: string;
  /** Base64 raw-bytes device public key (set after step 1). */
  pubkeyBase64?: string;
  /** Attestation gist id (set after step 1; carried on the announce). */
  attestationGistId?: string;
  /** GitHub user id (mirrors opts, for resume). */
  githubUserId?: number;
  /** GitHub login (mirrors opts, for resume). */
  githubLogin?: string;
}

// ALL_STEP_IDS / JOIN_STEP_IDS sourced from the ./join-steps leaf (imported
// above for local use) and re-exported here for existing callers.
export { ALL_STEP_IDS, JOIN_STEP_IDS };

function initialSteps(): Record<JoinStepId, JoinStepState> {
  const out = {} as Record<JoinStepId, JoinStepState>;
  for (const id of ALL_STEP_IDS) out[id] = { id, status: 'pending' };
  return out;
}

// ─── options ──────────────────────────────────────────────────────────────────

export interface JoinOptions {
  /** Parsed harness link to join. */
  link: HarnessLink;
  /** Slug for the new harness entry in the local registry. */
  slug: string;
  /** GitHub OAuth token (used for channel-1 + git operations). */
  token: string;
  /** Verified numeric GitHub user id for the current user. */
  githubUserId: number;
  /** Current GitHub login (used for branch + file naming). */
  githubLogin: string;
  /** Keychain id for the device Ed25519 keypair. */
  keychainId: string;
  /** If set, re-use a previously-existing attestation gist id (skips gist creation). */
  existingGistId?: string;
  /** Called after every step status change. */
  onProgress?: (steps: JoinStepState[]) => void;
  /** Injectable fetch (tests). */
  fetchFn?: typeof fetch;
  /** Injectable execFile (tests). */
  execFileFn?: (
    file: string,
    args: string[],
    opts?: { cwd?: string; timeout?: number },
  ) => Promise<{ stdout: string; stderr: string }>;
  /** Injectable FS write (tests). */
  writeFileFn?: (path: string, content: string) => Promise<void>;
  /** Injectable FS mkdir (tests). */
  mkdirFn?: (path: string, opts?: { recursive?: boolean }) => Promise<unknown>;
  /** Injectable state read (tests). */
  readStateFn?: (slug: string) => Promise<JoinState | null>;
  /** Injectable state write (tests). */
  writeStateFn?: (slug: string, state: JoinState) => Promise<void>;
  /**
   * Injectable substrate booter for boot_federate (tests).
   * Receives (workspaceId, harnessSlug). Defaults to `bootSingleHarness`.
   */
  bootFederateFn?: (workspaceId: string, harnessSlug: string) => Promise<unknown>;
  /**
   * Injectable pre-boot clone registration (tests). Defaults to an atomic
   * registry upsert via mutateHarnessRegistry. EI-339: this default hits the
   * LIVE registry — every test of the boot_federate path MUST inject a no-op
   * here, or each run leaks a `<slug>` row into the workspace registry (the
   * 6step/default-boot residue that fed the git-export-drain journal spam).
   * Enforced since 2026-06-12: under vitest the default refuses the live
   * write (console.warn + skip) instead of trusting this convention.
   */
  registerCloneFn?: (slug: string, path: string) => Promise<void>;
  /**
   * Injectable admitted-peer count reader for await_admission_merge (tests).
   * Returns the number of admitted REMOTE logs (0 = no peers yet).
   * Defaults to reading the booted handle's admitted map size - 1 (own log).
   */
  readAdmittedCountFn?: (workspaceId: string, harnessSlug: string) => number;
  /**
   * Injectable "is this harness's substrate booted" probe for
   * await_admission_merge (tests, WI-10004746). Defaults to the live
   * getBootedHarness registry when readAdmittedCountFn is not injected.
   */
  isBootedFn?: (workspaceId: string, harnessSlug: string) => boolean;
  /**
   * Timeout for await_admission_merge (ms). Default 30_000.
   */
  awaitAdmissionTimeoutMs?: number;
  /**
   * Poll interval for await_admission_merge (ms). Default 1_000.
   */
  awaitAdmissionPollMs?: number;
  /**
   * Injectable sleep for await_admission_merge (tests).
   */
  sleepFn?: (ms: number) => Promise<void>;
  /**
   * Injectable Octokit for publish_binding (tests).
   */
  octokit?: unknown;
}

// ─── step 1: oauth_attest ────────────────────────────────────────────────────

export interface OauthAttestResult {
  keypair: DeviceKeypairId;
  channel1: ChannelResult;
  attestationGistId: string;
}

export async function step1_oauthAttest(opts: {
  token: string;
  claimedGithubUserId: number;
  githubLogin: string;
  keychainId: string;
  existingGistId?: string;
  fetchFn?: typeof fetch;
}): Promise<OauthAttestResult> {
  const keypair = await loadOrGenerateDeviceKeypair(opts.keychainId);
  const channel1 = await verifyChannel1({
    token: opts.token,
    claimedGithubUserId: opts.claimedGithubUserId,
    fetchFn: opts.fetchFn,
  });
  if (channel1.kind === 'fail') {
    throw new JoinStepError(
      'oauth_attest',
      channel1.reason,
      `Channel 1 OAuth check failed: ${channel1.reason}`,
    );
  }

  // Resolve or create the attestation gist (required for channel-2 contributor file).
  let attestationGistId = opts.existingGistId ?? '';
  if (!attestationGistId) {
    try {
      const gistResult = await createAttestationGist({
        keychainId: opts.keychainId,
        pubkeyBase64: keypair.pubkeyBase64,
        deviceLabel: 'unnamed-device',
        githubUserId: opts.claimedGithubUserId,
        githubLogin: opts.githubLogin,
        token: opts.token,
      });
      attestationGistId = gistResult.gistId;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new JoinStepError(
        'oauth_attest',
        'gist_creation_failed',
        `Attestation gist creation failed: ${msg.slice(0, 300)}`,
      );
    }
  }

  return { keypair, channel1, attestationGistId };
}

// ─── step 2: clone_repo ──────────────────────────────────────────────────────

export interface CloneRepoResult {
  cloneDir: string;
}

export async function step2_cloneRepo(opts: {
  githubFullName: string;
  slug: string;
  /**
   * Optional gh token for an authenticated clone (B4). Required to clone a
   * PRIVATE upstream the joiner has read on; harmless for a public one. When
   * present the clone uses a token-embedded URL, then resets `origin` to the
   * token-free URL so the secret never persists in `.git/config`.
   */
  token?: string;
  execFileFn?: (
    file: string,
    args: string[],
    opts?: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv },
  ) => Promise<{ stdout: string; stderr: string }>;
  mkdirFn?: (path: string, opts?: { recursive?: boolean }) => Promise<unknown>;
}): Promise<CloneRepoResult> {
  const { githubFullName, slug, token } = opts;
  const exF = opts.execFileFn ?? defaultExecFile;
  const mkF = opts.mkdirFn ?? ((p, o) => mkdir(p, o ?? {}));

  const clonesBase = resolve(workspacesRoot(), 'clones');
  const cloneDir = join(clonesBase, slug);

  if (existsSync(cloneDir)) {
    // Adopt an existing clone ONLY when it is a real, resolvable git repo. A
    // PARTIAL dir (a clone killed mid-transfer — observed live on the Mac VM,
    // WI-1705: a QEMU user-net stall left a tmp_pack and no HEAD) must NOT be
    // adopted as "already cloned" — that strands every later join step on a
    // broken checkout. Validate cheaply; remove + re-clone on failure.
    try {
      await exF('git', ['-C', cloneDir, 'rev-parse', '--verify', 'HEAD'], { timeout: 15_000 });
      // WI-3057 follow-up: an adopted dir can silently carry a leaked token in
      // its `origin` remote from an EARLIER clone whose de-tokenize step
      // predated this fix, failed silently, or raced a kill — the fresh-clone
      // branch below is the ONLY place that ever ran `set-url`, so idempotent
      // adopt alone would perpetuate a plaintext token forever. Always check
      // (regardless of whether THIS call passed a token) and repair; treat a
      // repair failure the same as an invalid repo (fall through to re-clone).
      await ensureDetokenizedOrigin(exF, cloneDir, githubFullName);
      return { cloneDir }; // valid repo, origin clean — idempotent adopt
    } catch {
      await rm(cloneDir, { recursive: true, force: true });
    }
  }

  await mkF(clonesBase, { recursive: true });
  const cloneUrl = buildCloneUrl(githubFullName, token);
  try {
    // WI-1705: bound the clone. Without these a stalled TCP transfer (flaky
    // NAT / dead socket) hangs `git clone` FOREVER — which wedged the canonical
    // dogfood join at 40% AND held the bootstrap single-flight latch so no
    // retry could ever fire. Low-speed abort (<1KB/s for 60s → git exits) plus
    // a 30-min hard ceiling (a --depth 1 member clone is ~GBs at worst).
    await exF('git', ['clone', '--depth', '1', cloneUrl, cloneDir], {
      timeout: 30 * 60_000,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_HTTP_LOW_SPEED_LIMIT: '1000',
        GIT_HTTP_LOW_SPEED_TIME: '60',
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // A failed/aborted clone can leave a partial dir behind (git cleans up on
    // its own errors but NOT on an external kill/timeout) — remove it so the
    // NEXT attempt re-clones instead of adopting the wreck via existsSync.
    await rm(cloneDir, { recursive: true, force: true }).catch(() => {});
    // redactToken: never let an embedded x-access-token reach an error surface.
    throw new JoinStepError('clone_repo', 'clone_failed', redactToken(msg).slice(0, 300));
  }

  // De-tokenize origin so the gh token never persists in the cloned repo's
  // .git/config. This is a hard postcondition for authenticated clones: if the
  // reset fails, remove the clone and report a redacted failure rather than
  // leaving credentials on disk.
  if (token) {
    await ensureDetokenizedOrigin(exF, cloneDir, githubFullName);
  }

  return { cloneDir };
}

/**
 * WI-3057: verify `origin` carries no embedded GitHub token, repairing it via
 * `set-url` if it does — regardless of whether the CURRENT call passed a
 * token, since this also guards the "adopt an existing clone" idempotency
 * path (an earlier clone's de-tokenize could predate this fix, have failed
 * silently, or raced a kill, leaving a stale plaintext token on disk).
 *
 * Hard postcondition, not best-effort: read back the origin URL after
 * `set-url` and confirm it is actually clean (an ignored/racing git config
 * write could otherwise leave the token in place while looking successful).
 * On any failure to reach a clean origin, remove the clone dir and throw a
 * redacted error — never leave a directory with a known-tokenized origin.
 */
async function ensureDetokenizedOrigin(
  exF: (
    file: string,
    args: string[],
    opts?: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv },
  ) => Promise<{ stdout: string; stderr: string }>,
  cloneDir: string,
  githubFullName: string,
): Promise<void> {
  let currentUrl: string;
  try {
    const { stdout } = await exF('git', ['-C', cloneDir, 'remote', 'get-url', 'origin']);
    currentUrl = stdout.trim();
  } catch {
    // No readable `origin` remote — nothing to de-tokenize here; a missing
    // remote is a different failure class handled elsewhere (e.g. a later
    // fetch/push step), not this security invariant.
    return;
  }
  if (!/x-access-token:/.test(currentUrl)) return; // already clean

  try {
    await exF('git', ['-C', cloneDir, 'remote', 'set-url', 'origin', cleanCloneUrl(githubFullName)]);
    const { stdout: after } = await exF('git', ['-C', cloneDir, 'remote', 'get-url', 'origin']);
    if (/x-access-token:/.test(after.trim())) {
      throw new Error('origin still carries a token after set-url');
    }
  } catch (e: unknown) {
    await rm(cloneDir, { recursive: true, force: true }).catch(() => {});
    const msg = e instanceof Error ? e.message : String(e);
    throw new JoinStepError('clone_repo', 'origin_detokenize_failed', redactToken(msg).slice(0, 300));
  }
}

// ─── step 3: publish_binding ─────────────────────────────────────────────────
//
// Write-free join (non-collaborator-join-fork-pr-2026-06-02): the binding is the
// attestation GIST (created in step 1 oauth_attest) + the SIGNED announce (sent
// in step 4 boot_federate). There is NO shared-repo contributor file anymore, so
// this step performs NO repo write (a non-collaborator needs no write access to
// join). It confirms the attestation gist id resolved in step 1 is present — so
// peers can admit via `verifyAttestation` — and carries it forward. An empty
// gist id is a hard failure (a peer cannot verify an empty id).

export interface PublishBindingResult {
  attestationGistId: string;
}

export async function stepPublishBinding(opts: {
  attestationGistId: string;
}): Promise<PublishBindingResult> {
  if (!opts.attestationGistId) {
    throw new JoinStepError(
      'publish_binding',
      'attestation_gist_missing',
      'attestation gist id is empty — cannot publish a verifiable binding',
    );
  }
  return { attestationGistId: opts.attestationGistId };
}

// ─── step 4: boot_federate ───────────────────────────────────────────────────
//
// Boots this harness's Model B substrate via `bootSingleHarness`. The booter:
//   - opens / creates the per-harness corestore
//   - opens the peer's OWN writable log
//   - resolves the swarm binding from .papercusp/shared.json
//   - joins Hyperswarm + starts announce exchange
//   - starts the read-merge loop (admitted logs → PG)
//
// Soft-skip (phase_0_pending) on boot failure: clone + publish are done;
// federation completes on next online session.
//
// WI-10004746: `bootSingleHarness` does NOT throw when its race timeout fires —
// it RETURNS `{ state:'failed', error:'boot timeout after 30000ms' }` while the
// real boot keeps running (and is adopted later). Ignoring that result marked
// boot_federate `done` for a substrate that had not joined its swarm topic, and
// the admission wait then blamed "no peer" for what was a local boot still in
// flight. The outcome is now read, never assumed.

export interface BootFederateOutcome {
  /** True unless the booter explicitly reported `failed` or `deferred`. */
  booted: boolean;
  /** Why the substrate is not booted yet (only when `booted` is false). */
  detail?: string;
}

/** Map a booter's result to an outcome. Only an explicit failed/deferred state counts as not booted. */
export function bootFederateOutcome(result: unknown): BootFederateOutcome {
  const r = (result ?? {}) as { state?: unknown; error?: unknown; deferReason?: unknown };
  if (r.state === 'failed') {
    const err = typeof r.error === 'string' && r.error ? r.error : 'unknown error';
    return {
      booted: false,
      detail: /boot timeout/i.test(err)
        ? `substrate boot still in progress (${err}); the swarm topic is not joined yet — the late boot is adopted when it finishes`
        : `substrate boot failed: ${err} (will retry on next session)`,
    };
  }
  if (r.state === 'deferred') {
    const why = typeof r.deferReason === 'string' ? r.deferReason : 'activation policy';
    return { booted: false, detail: `substrate boot deferred (${why}); federation starts when the harness is activated` };
  }
  return { booted: true };
}

export async function stepBootFederate(opts: {
  workspaceId: string;
  harnessSlug: string;
  bootFn?: (workspaceId: string, harnessSlug: string) => Promise<unknown>;
}): Promise<BootFederateOutcome> {
  const boot =
    opts.bootFn ??
    (async (wsId: string, slug: string) => {
      const mod = await import('../sync/hyperbee/boot-all');
      return mod.bootSingleHarness(wsId, slug);
    });
  return bootFederateOutcome(await boot(opts.workspaceId, opts.harnessSlug));
}

// ─── step 5: await_admission_merge ───────────────────────────────────────────
//
// Bounded wait for at least one remote peer to be admitted and merged. This
// confirms federation is live. If the timeout elapses with no peer, the
// result is { remoteOpLanded: false } — the caller maps this to `phase_0_pending`
// (soft status, not an error). The substrate is already booted and will admit
// peers as they come online.

export interface AwaitAdmissionResult {
  remoteOpLanded: boolean;
  /**
   * WI-10004746: whether a local substrate handle existed at any poll. `false`
   * means the wait ended with this harness's OWN boot still in flight (topic not
   * joined), which is a different condition from "booted, but no peer yet".
   * `undefined` when it was not measured (an injected count reader with no
   * injected handle probe, or timeoutMs <= 0).
   */
  substrateBooted?: boolean;
}

/** The step detail for a soft (no remote op) admission result — names which condition held. */
export function admissionPendingDetail(r: AwaitAdmissionResult): string {
  if (r.substrateBooted === false) {
    return 'local substrate still booting when the admission wait ended (swarm topic not joined yet); federation will complete when the boot finishes and a peer comes online';
  }
  return 'no peer connected within timeout; federation will complete when a peer comes online';
}

export async function stepAwaitAdmissionMerge(opts: {
  workspaceId: string;
  harnessSlug: string;
  timeoutMs?: number;
  pollMs?: number;
  readAdmittedCountFn?: (workspaceId: string, harnessSlug: string) => number;
  /** Whether this harness has a registered (booted) substrate handle. */
  isBootedFn?: (workspaceId: string, harnessSlug: string) => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<AwaitAdmissionResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pollMs = opts.pollMs ?? 1_000;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  // Probe the live registry only when the count reader is live too; an injected
  // reader with no injected probe leaves the booted state unmeasured.
  const isBooted: ((wsId: string, slug: string) => boolean) | null =
    opts.isBootedFn ??
    (opts.readAdmittedCountFn
      ? null
      : (wsId: string, slug: string): boolean => {
          try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const mod = require('../sync/hyperbee/boot-all') as typeof import('../sync/hyperbee/boot-all');
            return mod.getBootedHarness(wsId, slug) != null;
          } catch {
            return false;
          }
        });

  const readAdmitted =
    opts.readAdmittedCountFn ??
    ((wsId: string, slug: string): number => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require('../sync/hyperbee/boot-all') as typeof import('../sync/hyperbee/boot-all');
        const handle = mod.getBootedHarness(wsId, slug);
        if (!handle) return 0;
        // admitted includes own log; peers = admitted.size - 1
        return Math.max(0, handle.admitted.size - 1);
      } catch {
        return 0;
      }
    });

  if (timeoutMs <= 0) {
    return { remoteOpLanded: false };
  }

  let sawHandle = false;
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (isBooted && !sawHandle) sawHandle = isBooted(opts.workspaceId, opts.harnessSlug);
    const count = readAdmitted(opts.workspaceId, opts.harnessSlug);
    if (count > 0) {
      return { remoteOpLanded: true, ...(isBooted ? { substrateBooted: true } : {}) };
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollMs, remaining));
  }

  return { remoteOpLanded: false, ...(isBooted ? { substrateBooted: sawHandle } : {}) };
}

// ─── step 6: route_insights ──────────────────────────────────────────────────

export interface RouteInsightsResult {
  insightsPath: string;
}

export function stepRouteInsights(slug: string): RouteInsightsResult {
  return { insightsPath: `/harness/${encodeURIComponent(slug)}/insights` };
}

// ─── orchestrator ─────────────────────────────────────────────────────────────

/**
 * Run the full 6-step Model B join flow (D-005).
 *
 * boot_federate failures are non-fatal (substrate may be unreachable).
 * await_admission_merge resolves soft (phase_0_pending) when no peer connects
 * within the timeout — the join still succeeds.
 *
 * Returns the final `JoinState`.
 */
export async function joinSharedHarness(opts: JoinOptions): Promise<JoinState> {
  const readState = opts.readStateFn ?? defaultReadState;
  const writeState = opts.writeStateFn ?? defaultWriteState;

  // Load or initialize persisted state.
  let state = await readState(opts.slug);
  if (!state) {
    state = {
      slug: opts.slug,
      linkTopic: opts.link.topic,
      steps: initialSteps(),
      startedAt: Date.now(),
      githubUserId: opts.githubUserId,
      githubLogin: opts.githubLogin,
    };
  }

  function emit() {
    opts.onProgress?.(Object.values(state!.steps));
  }

  function markRunning(id: JoinStepId) {
    state!.steps[id] = { id, status: 'running' };
    emit();
  }

  function markDone(id: JoinStepId, detail?: string) {
    state!.steps[id] = { id, status: 'done', ...(detail ? { detail } : {}) };
  }

  function markPhase0(id: JoinStepId, detail?: string) {
    state!.steps[id] = { id, status: 'phase_0_pending', detail };
  }

  function markError(id: JoinStepId, code: string, detail?: string) {
    state!.steps[id] = { id, status: 'error', errorCode: code, detail };
  }

  async function saveAndEmit() {
    await writeState(opts.slug, state!);
    emit();
  }

  // ── Step 1: oauth_attest ──
  if (state.steps.oauth_attest.status !== 'done') {
    markRunning('oauth_attest');
    try {
      const r = await step1_oauthAttest({
        token: opts.token,
        claimedGithubUserId: opts.githubUserId,
        githubLogin: opts.githubLogin,
        keychainId: opts.keychainId,
        existingGistId: opts.existingGistId,
        fetchFn: opts.fetchFn,
      });
      state.pubkeyBase64 = r.keypair.pubkeyBase64;
      state.attestationGistId = r.attestationGistId;
      markDone('oauth_attest');
    } catch (e: unknown) {
      const err = e instanceof JoinStepError ? e : null;
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      markError('oauth_attest', err?.code ?? 'unknown', msg);
      await saveAndEmit();
      throw e;
    }
    await saveAndEmit();
  }

  // ── Step 2: clone_repo ──
  if (state.steps.clone_repo.status !== 'done') {
    markRunning('clone_repo');
    try {
      const r = await step2_cloneRepo({
        githubFullName: opts.link.github,
        slug: opts.slug,
        // Authenticated clone (B4): pass the joiner's gh token so a PRIVATE
        // upstream they have read on can be cloned. step2 de-tokenizes origin
        // afterward so the token never persists in .git/config.
        token: opts.token,
        execFileFn: opts.execFileFn,
        mkdirFn: opts.mkdirFn,
      });
      state.cloneDir = r.cloneDir;
      markDone('clone_repo');
    } catch (e: unknown) {
      const err = e instanceof JoinStepError ? e : null;
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      markError('clone_repo', err?.code ?? 'unknown', msg);
      await saveAndEmit();
      throw e;
    }
    await saveAndEmit();
  }

  // ── Step 3: publish_binding (write-free: confirm the attestation gist id) ──
  if (state.steps.publish_binding.status !== 'done') {
    markRunning('publish_binding');
    const gistId = state.attestationGistId ?? opts.existingGistId ?? '';
    try {
      await stepPublishBinding({ attestationGistId: gistId });
      markDone('publish_binding');
    } catch (e: unknown) {
      const err = e instanceof JoinStepError ? e : null;
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      markError('publish_binding', err?.code ?? 'unknown', msg);
      await saveAndEmit();
      throw e;
    }
    await saveAndEmit();
  }

  // ── Step 4: boot_federate ──
  if (state.steps.boot_federate.status !== 'done' &&
      state.steps.boot_federate.status !== 'phase_0_pending') {
    markRunning('boot_federate');
    try {
      // The booter resolves the swarm binding from `.papercusp/shared.json` in
      // the clone — which only exists if the OWNER committed+pushed it. The
      // JOIN LINK carries everything the file holds (topic + github + repo_id),
      // so synthesize it when absent; otherwise a fresh joiner boots SILENTLY
      // local-only ("done" with no swarm join — found by the packaged
      // browse→join→federate smoke). The owner's committed copy always wins.
      if (state.cloneDir) {
        try {
          const { existsSync, mkdirSync, writeFileSync } = await import('node:fs');
          const { join: joinPath, dirname } = await import('node:path');
          const { HARNESS_SHARED_CONFIG_REL_PATH, HARNESS_SHARED_CONFIG_SCHEMA_VERSION } =
            await import('./harness-shared-config-types');
          const cfgPath = joinPath(state.cloneDir, HARNESS_SHARED_CONFIG_REL_PATH);
          // Only when the clone REALLY exists (unit tests mock the clone step).
          if (existsSync(state.cloneDir) && !existsSync(cfgPath)) {
            mkdirSync(dirname(cfgPath), { recursive: true });
            writeFileSync(
              cfgPath,
              `${JSON.stringify(
                {
                  claim_status: 'unclaimed',
                  created_at: Date.now(),
                  github_remote: `https://github.com/${opts.link.github}`,
                  github_repository_id: opts.link.repoId,
                  privacy: 'shared-private',
                  schema_version: HARNESS_SHARED_CONFIG_SCHEMA_VERSION,
                  topic: opts.link.topic,
                },
                null,
                2,
              )}\n`,
            );
          }
        } catch {
          // Best-effort — boot_federate's own soft-skip handles a bad clone dir.
        }
      }
      // The booter resolves the harness PATH through the workspace registry
      // (resolveHarnessPaths) — but the join-link route only registers the
      // clone AFTER the whole join returns, which is too late for THIS boot:
      // an unregistered slug resolves to /tmp/papercusp-unresolved/… and the
      // binding resolver silently boots the substrate LOCAL-ONLY (no swarm
      // join — found by the browse→join→federate smoke's federate leg).
      // Register the clone before booting; the route's later registration
      // skips an already-present slug.
      if (state.cloneDir) {
        try {
          if (opts.registerCloneFn) {
            await opts.registerCloneFn(opts.slug, state.cloneDir);
          } else if (process.env.VITEST) {
            // EI-339 enforcement: this default branch upserts the LIVE shared
            // registry. Relying on the "tests MUST inject registerCloneFn"
            // convention leaked 538 default-boot-* residue rows by 2026-06-12
            // (join-default-boot-wiring.test.ts ran sweep-driven ~1/min).
            // Refuse the live write under vitest instead of trusting the
            // convention; the warn keeps the missing injection visible.
            console.warn(
              `[join-shared-harness] refusing live registry write for '${opts.slug}' under vitest — inject registerCloneFn (EI-339)`,
            );
          } else {
            // Atomic upsert (P-006/EI-82): load→push→save races a concurrent
            // registry write and silently reverts it. SELF-DESCRIBING from the
            // start (2026-07-03, WI-971 adjacent): include the upstream coords +
            // joined_via_link here, not just { slug, path } — the minimal row
            // made the route's post-join EI-1623 enrichment dead code (its
            // slug-present check skipped an existing row) and left the clone
            // invisible to the hive_slug/joined_via_link-keyed git-sync
            // reconcile, and easy to mistake for registry debris.
            // The full link-joined shape, not a subset: a join that dies after
            // this write never reaches the route's enrichment, and a short row
            // was never counted as a shared hive (WI-10003277).
            const { mutateHarnessRegistry, upsertLinkJoinedEntry } = await import('../harness-registry');
            const cloneDir = state.cloneDir;
            await mutateHarnessRegistry((reg) =>
              upsertLinkJoinedEntry(reg, {
                slug: opts.slug,
                path: cloneDir,
                github: opts.link.github,
                repoId: opts.link.repoId,
              }),
            );
          }
        } catch {
          // Best-effort — an unregistered harness boots local-only, exactly
          // the pre-fix behavior; the route's post-join registration still runs.
        }
      }
      const { activeWorkspaceId } = await import('../workspace-registry');
      const boot = await stepBootFederate({
        workspaceId: activeWorkspaceId(),
        harnessSlug: opts.slug,
        bootFn: opts.bootFederateFn,
      });
      if (boot.booted) markDone('boot_federate');
      else markPhase0('boot_federate', (boot.detail ?? 'substrate not booted').slice(0, 300));
    } catch (e: unknown) {
      // Non-fatal: DHT unreachable, port blocked, etc.
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      markPhase0('boot_federate', `boot failed (will retry on next session): ${msg}`);
    }
    await saveAndEmit();
  }

  // ── Step 5: await_admission_merge ──
  if (state.steps.await_admission_merge.status !== 'done' &&
      state.steps.await_admission_merge.status !== 'phase_0_pending') {
    markRunning('await_admission_merge');
    try {
      const { activeWorkspaceId } = await import('../workspace-registry');
      const r = await stepAwaitAdmissionMerge({
        workspaceId: activeWorkspaceId(),
        harnessSlug: opts.slug,
        timeoutMs: opts.awaitAdmissionTimeoutMs ?? 30_000,
        pollMs: opts.awaitAdmissionPollMs ?? 1_000,
        readAdmittedCountFn: opts.readAdmittedCountFn,
        isBootedFn: opts.isBootedFn,
        sleep: opts.sleepFn,
      });
      if (r.remoteOpLanded) {
        markDone('await_admission_merge', 'remote peer admitted + merge landed');
      } else {
        // Soft: federation completes later. The detail names WHICH condition held —
        // our own boot still in flight vs booted with no peer (WI-10004746).
        markPhase0('await_admission_merge', admissionPendingDetail(r));
      }
    } catch (e: unknown) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      markPhase0('await_admission_merge', `admission wait failed: ${msg}`);
    }
    await saveAndEmit();
  }

  // ── Step 6: route_insights ──
  markDone('route_insights');
  state.completedAt = Date.now();
  await saveAndEmit();

  return state;
}

// ─── state persistence helpers ────────────────────────────────────────────────

function joinStateDir(): string {
  return resolve(homedir(), '.papercusp', 'join-state');
}

function joinStatePath(slug: string): string {
  return join(joinStateDir(), `${slug}.json`);
}

async function defaultReadState(slug: string): Promise<JoinState | null> {
  const p = joinStatePath(slug);
  try {
    const raw = await readFile(p, 'utf8');
    return JSON.parse(raw) as JoinState;
  } catch {
    return null;
  }
}

async function defaultWriteState(slug: string, state: JoinState): Promise<void> {
  const dir = joinStateDir();
  await mkdir(dir, { recursive: true });
  await writeFile(joinStatePath(slug), JSON.stringify(state, null, 2) + '\n', 'utf8');
}

// ─── execFile default ─────────────────────────────────────────────────────────

async function defaultExecFile(
  file: string,
  args: string[],
  opts?: { cwd?: string; timeout?: number },
): Promise<{ stdout: string; stderr: string }> {
  return execFile(file, args, { ...(opts ?? {}), encoding: 'utf8' });
}
