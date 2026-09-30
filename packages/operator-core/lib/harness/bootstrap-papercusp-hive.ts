/**
 * Clone-on-first-boot of the Papercusp dogfood hive (owner decision 2026-06-23:
 * ship the desktop with `papercusp` as the single default hive — Papercusp
 * building itself).
 *
 * The repo is far too large to bundle (~5GB tree + 6.2GB .git + 27 submodules),
 * so a PACKAGED install CLONES github.com/Papercusp/papercup on first boot, using
 * the user's `gh` credential helper for the private repo (the established auth
 * path — see clone-github.ts), then hands the checkout to ensurePapercuspHive()
 * (the existing single-`papercusp`-entry creator). Finally it makes
 * `papercusp-workspace` the active/home workspace so the hive is VISIBLE:
 * ensurePapercuspWorkspace() deliberately never hijacks `registry.current`, so a
 * packaged install that already homed on `default` would otherwise create the
 * hive in a workspace the user never sees (host-bootstrap BUG-1: the baked home
 * slug `papercusp` "doesn't resolve in the default workspace until setup").
 *
 * Idempotent · best-effort · non-fatal. A missing gh auth (auth_required), no
 * network, or an already-present hive all no-op cleanly, and the NEXT boot retries
 * until it succeeds — so a user who signs into gh after first launch gets the hive
 * on the following operator boot. A local checkout (dev box) is used in place and
 * never cloned. Submodules (the bulk of the 5GB) are initialised best-effort in the
 * BACKGROUND after the hive is created, so the hive appears promptly and fills in.
 */

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { cloneGithubRepo, isCloneError, defaultClonesDir, parseGitProgressLine } from './clone-github';
import { ensurePapercuspHive, PAPERCUSP_HIVE_SLUG } from './ensure-papercusp-hive';
import { detectPapercupRoot } from './register-papercusp';
import { PAPERCUSP_WORKSPACE_ID, ensurePapercuspWorkspace } from './papercusp-workspace';
import { loadHarnessRegistry, type ProjectEntry } from '../harness-registry';
import { ensureCurrentWorkspace, workspacesRoot } from '../workspace-registry';
import { recordFromRepoStep } from './from-repo-progress';
import {
  adoptSharedHiveIdentity,
  goSharedHive,
  shareExistingHive,
  type SharedHiveState,
} from './papercusp-hive-share';
import {
  bakedCanonicalHiveInvite,
  joinCanonicalPapercuspHive,
  type CanonicalHiveInvite,
} from './papercusp-hive-join';
import { AWAITING_GH_SIGNIN_DETAIL } from './bootstrap-papercusp-hive-detail';
import { restoreHiveSeed, resolveSeedDir, type RestoreHiveSeedResult } from '../sync/hyperbee/restore-hive-seed';
import { triggerDeferredGitRestore, type TriggerDeferredGitRestoreResult } from '../sync/hyperbee/deferred-git-restore';
import { buildMemberEpochKeyProvider } from '../sync/hyperbee/hive-epoch-boot-deps';
import { createBundledEpochKeyProvider } from '../sync/hyperbee/bundled-epoch-key-provider';
import { chainEpochKeyProviders } from '../sync/hyperbee/epoch-key-provider-chain';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';

/**
 * P-011 kill-switch: the seed-bundle feature master gate (FLAGS.POT_SEED_BUNDLE,
 * DEFAULT ON — finished work never ships dark). OFF ⇒ both restore paths no-op and
 * the pure COLD join runs, byte-identical to a no-seed build (the runtime escape
 * hatch if a seed restore ever misbehaves). Fail-open to ON: getFlag already returns
 * the ON default when PostHog is unreachable, and the restore itself is
 * safe-by-construction (any restore failure falls back to the cold path — P-008), so
 * a flag-read hiccup must not silently force cold.
 */
export async function seedBundleEnabled(
  readFlag: () => Promise<boolean> = () => getFlag(FLAGS.POT_SEED_BUNDLE, 'system'),
): Promise<boolean> {
  try {
    return await readFlag();
  } catch {
    return true;
  }
}

async function seedSelfAdmitEnabled(
  readFlag: () => Promise<boolean> = () => getFlag(FLAGS.POT_SEED_SELF_ADMIT, 'system'),
): Promise<boolean> {
  try {
    return await readFlag();
  } catch {
    return true;
  }
}

/**
 * WI-1423 test-frame isolation: a hard, synchronous, flag-independent kill-switch
 * for the dogfood auto-join. Set `PAPERCUSP_DISABLE_DOGFOOD_HIVE=1` on any box that
 * must NEVER auto-wire into the production `papercusp`/`papercup` hive — CI, a
 * Hetzner/local-matrix test rig frame, an isolated release-testing VM, etc.
 *
 * Root cause this closes: TWO of the three trigger paths (the explicit boot call in
 * host-bootstrap.ts, and the setup-wizard's `/api/desktop/bootstrap-pot/start`)
 * already gate on the `DOGFOOD_PAPERCUSP_POT` flag before calling
 * `startBootstrapPapercuspHive()` — but the THIRD (hive-directory-boot.ts's
 * `maybeTriggerCanonicalJoinOnIngest`, fired the instant a box that has wired the
 * hive directory — which EVERY box does at boot, unconditionally, per boot-all.ts —
 * merely HEARS the canonical hive's announce on the global directory topic) called
 * `startBootstrapPapercuspHive()` directly with NO gate at all. A fresh .deb test-rig
 * install (PAPERCUSP_DESKTOP=1, only GH_TOKEN configured) that ever overhears the
 * real production announce on the shared global directory topic would silently
 * auto-join production through this ungated path, regardless of the flag or of
 * PAPERCUSP_DESKTOP even being set — entangling a disposable test identity into the
 * real hive's membership/roster.
 *
 * Checked here (bootstrapPapercuspHive is the ONE function every trigger path
 * ultimately calls) so it is impossible for a new call site to reintroduce the gap:
 * this is the single choke point, not a per-caller convention. Sync + env-only
 * (no PG/flag dependency) so it works even at the earliest boot tick, before the
 * flag store is necessarily reachable.
 */
export function dogfoodHiveDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PAPERCUSP_DISABLE_DOGFOOD_HIVE === '1';
}

/** The dogfood repo cloned on first boot when no local checkout is present. */
export const PAPERCUP_DOGFOOD_REPO_URL = 'https://github.com/Papercusp/papercup';

/**
 * Fixed, well-known progressId the boot-time bootstrap records under (it has no
 * UI to mint one), so the desktop banner + setup-finish gate can subscribe with
 * `useSyncQuery({ queryName: 'hiveFromRepo.progress', args: { progressId } })`
 * without the boot step handing them an id. Reuses the create-from-URL progress
 * channel (same `clone` phase; `submodules` is bootstrap-only).
 */
export const BOOTSTRAP_PROGRESS_ID = 'bootstrap-papercusp-hive';

/** The two phases the dogfood bootstrap reports. */
export type BootstrapProgressStep = 'clone' | 'submodules';
export type BootstrapProgressStatus = 'running' | 'done' | 'error' | 'skipped';

/** Re-exported from ./bootstrap-papercusp-hive-detail (shared with the join path,
 *  papercusp-hive-join.ts, without an import cycle). */
export { AWAITING_GH_SIGNIN_DETAIL };

/** Pin ref (branch OR tag) baked into a release build so the dogfood hive
 *  matches the desktop binary exactly. Unset (dev builds) ⇒ the remote default
 *  branch (main). See bin/release-local.sh (stage 3). */
function dogfoodRef(explicit?: string): string | undefined {
  return explicit ?? (process.env.PAPERCUP_DOGFOOD_REPO_REF || undefined);
}

export interface BootstrapPapercuspHiveResult {
  state: 'already-present' | 'newly-created' | 'cloned-and-created' | 'skipped';
  slug: string | null;
  /** The repo path used (detected local checkout or fresh clone). */
  path?: string;
  reason?: string;
  /** P-539: a skip the process retries itself (see startBootstrapPapercuspHive). */
  retryable?: boolean;
}

export interface SelfAdmitCanonicalResult {
  state: 'admitted' | 'skipped';
  slug: string | null;
  path?: string;
  reason?: string;
}

/** Injectable seams (lib/ DI-for-tests pattern). Production defaults to real impls. */
export interface BootstrapPapercuspHiveDeps {
  detectRoot?: () => string | null;
  loadRegistry?: (
    ws: string,
    opts?: { fresh?: boolean },
  ) => Promise<{
    projects: Array<{
      slug: string;
      path?: string;
      self_repo?: boolean;
      remote_hive?: boolean;
      hive_pubkey?: string;
      owner_device_pubkey?: string;
    }>;
  }>;
  clone?: typeof cloneGithubRepo;
  ensureHive?: typeof ensurePapercuspHive;
  /** Make `ws` the active/home workspace (so the hive is visible). */
  setHomeWorkspace?: (ws: string) => void;
  /** WI-3288: ensure papercusp-workspace is LISTED in registry.json workspaces[]
   *  (not just set as `current`). The offline self-admit path homed the workspace
   *  via setHome but never listed it → `current` pointed at an UNLISTED workspace →
   *  /api/workspaces returned {workspaces:[]} → the dogfood pot was invisible despite
   *  being fully registered. Default: ensurePapercuspWorkspace (idempotent; lists +
   *  provisions the dir; never hijacks `current`) — what the online create path already does. */
  ensureWorkspaceListed?: () => void;
  /** Best-effort submodule init for a fresh clone; fired (not awaited) in prod.
   *  `onProgress(done, total)` streams completion; `onDone(ok)` fires once at the
   *  end (success/fail) so the bootstrap can record the terminal step. */
  initSubmodules?: (
    repoPath: string,
    opts?: {
      shallow?: boolean;
      onProgress?: (done: number, total: number) => void;
      onDone?: (ok: boolean) => void;
    },
  ) => void;
  /** Shallow superproject + submodule clone (--depth 1). Default TRUE — fast
   *  first boot; the bulk is submodules. (`git fetch --unshallow` backfills.) */
  cloneShallow?: boolean;
  /** Pin the clone to this branch/tag. Default: env PAPERCUP_DOGFOOD_REPO_REF
   *  (the release pin) else the remote default branch. */
  ref?: string;
  /** Record a progress step (default → from-repo-progress under BOOTSTRAP_PROGRESS_ID).
   *  Injectable so tests assert the recorded sequence without the store. */
  recordProgress?: (
    step: BootstrapProgressStep,
    status: BootstrapProgressStatus,
    extra?: { percent?: number; detail?: string },
  ) => void;
  /** Solution C (DOGFOOD_PAPERCUSP_POT_SHARE, default-on/reversible): adopt the owner's
   *  SHARED hive identity from their per-owner gist BEFORE the hive is created.
   *  Default: adoptSharedHiveIdentity (returns null — sharing skipped — when the
   *  flag is off / gh unauth). */
  adoptShare?: () => Promise<SharedHiveState | null>;
  /** Solution C: AFTER create, publish the identity gist (first device) + announce
   *  (invite) + set the owner-only allowlist policy. Default: goSharedHive (a no-op
   *  when adoptShare returned null). */
  goShare?: (state: SharedHiveState | null) => Promise<void>;
  /** Solution C: share an ALREADY-PRESENT hive (flag enabled after create, or a
   *  re-boot). Default: shareExistingHive (no-op when the flag is off). */
  shareExisting?: () => Promise<void>;
  /** JOIN-the-canonical pivot: the baked canonical hive invite (pubkey+secret). When
   *  present, JOIN the canonical hive instead of clone+create. Default:
   *  bakedCanonicalHiveInvite() (null on dev builds → per-owner create fallback). */
  canonicalInvite?: CanonicalHiveInvite | null;
  /** The join orchestration. Default: joinCanonicalPapercuspHive. */
  joinCanonical?: typeof joinCanonicalPapercuspHive;
  /** P-005 fire-once latch: resolve whether THIS box already joined the canonical hive
   *  (a hives row keyed on the canonical pubkey, written by joinHiveAsView on a prior
   *  boot). Default: getHiveByPubkey. Returns the joined view slug, or null. */
  findJoinedCanonical?: (pubkeyBase64: string) => Promise<{ slug: string } | null>;
  /** Inspect whether a repo's submodules still need init/update. */
  submodulesNeedUpdate?: (repoPath: string) => Promise<boolean>;
  /** P-007 restore-before-join: pre-position the installer-bundled seed (corestore
   *  federated state now; encrypted git deferred to post-admission) BEFORE the
   *  unchanged join runs, so the join transfers only the delta. Default:
   *  {@link defaultRestoreHiveSeed} — a SAFE no-op (ran:false) until a build ships a
   *  seed and sets PAPERCUSP_SEED_DIR. Best-effort: any failure degrades to the
   *  cold path and never breaks the join. */
  restoreSeed?: (record: BootstrapPapercuspHiveDeps['recordProgress']) => Promise<RestoreHiveSeedResult>;
  /** P-010 live-wire 2 post-admission git-restore trigger: once the join admits this
   *  device + delivers the epoch keys, restore the git seed that the pre-join restore
   *  DEFERRED (encrypted at rest; key = the hive epoch key at cutAtEpoch). Default:
   *  {@link defaultRestoreDeferredGitSeed} — best-effort, called only when the pre-join
   *  restore deferred a git store AND the join succeeded. */
  restoreDeferredGitSeed?: (
    record: BootstrapPapercuspHiveDeps['recordProgress'],
  ) => Promise<TriggerDeferredGitRestoreResult>;
  /** WI-3070: when the FIRST post-admission attempt still reports `stillDeferred:['git']`
   *  (this fresh member's epoch-key row has not yet federated down to it), retry in the
   *  BACKGROUND with bounded backoff rather than permanently falling back to a full cold
   *  clone. Default: {@link defaultScheduleGitSeedRetry}. Fired (not awaited) — must never
   *  slow down boot. */
  scheduleGitSeedRetry?: (
    record: BootstrapPapercuspHiveDeps['recordProgress'],
    retry: () => Promise<TriggerDeferredGitRestoreResult>,
  ) => void;
  /** WI-3232 v1 offline path: when the baked canonical join skips but an installer
   * seed was restored, materialize a local view of the canonical papercusp hive
   * instead of requiring GitHub/admission. Default writes the registry + hives
   * identity row using existing remote-view conventions. */
  selfAdmitCanonical?: (
    invite: CanonicalHiveInvite,
    record: BootstrapPapercuspHiveDeps['recordProgress'],
  ) => Promise<SelfAdmitCanonicalResult>;
  /** WI-3232 (offline FIRST-boot pot): after self-admit registers + `setHome`s the remote-hive
   *  view, RE-RUN the startup substrate boot so its corestore opens + epoch-decrypts on the
   *  FIRST boot. The startup `bootAllHarnessesForActiveWorkspace` already ran with the OLD active
   *  workspace (`default`, before papercusp was registered) so it booted NOTHING for this hive
   *  (attempted=0); only a restart otherwise heals it. MUST be the full boot-all — NOT the old
   *  single `rekeyHarness`→`bootSingleHarness`, which booted the handle OUTSIDE the startup
   *  factory-default flow (never queryable) AND cached it so a later boot-all short-circuited
   *  `alreadyBooted` and no-op'd (bf97d/b0fbf, 2026-07-06). Default:
   *  {@link bootAllHarnessesForActiveWorkspace} with NO overrides (inherits startup routing).
   *  Best-effort — never fails the bootstrap; a restart still heals it. */
  bootActiveWorkspace?: () => Promise<{
    attempted: number;
    booted: number;
    alreadyBooted: number;
    failed: number;
  } | void>;
  /** P-539: backoff (ms) for re-running a RETRYABLE skip in-process. Default:
   *  {@link BOOTSTRAP_RETRY_DELAYS_MS}. */
  retryDelaysMs?: readonly number[];
}

/** Set `registry.current` to `ws` (idempotent). The deliberate counterpart to
 *  ensurePapercuspWorkspace's "never hijack current" rule — used ONLY when we have
 *  actually created the home hive and want the user to land on it.
 *
 *  REGISTER the entry (idempotent + provisions the data dir) BEFORE making it
 *  current. Setting `current` to an UNLISTED id leaves the registry in a
 *  `current`-points-at-unknown state, so `isKnownWorkspace(current)` is false —
 *  and since the operator injects `current` as `__PAPERCUSP_WS__`, the webview
 *  then stamps `x-papercusp-workspace: <current>` on EVERY /api fetch, which the
 *  workspace-context middleware rejects `unknown_workspace` 400. The whole /api
 *  surface dead-ends and onboarding hangs forever on "Starting onboarding…"
 *  (verified live on the packaged Linux .deb, 2026-07-07 — the registry had
 *  `current: papercusp-workspace` absent from `workspaces[]`). This mirrors
 *  papercusp-hive-join's `defaultSetHome`, which already registers-then-sets;
 *  the fix there was never mirrored back here until now. */
export function defaultSetHomeWorkspace(ws: string): void {
  ensureCurrentWorkspace(ws, 'Papercusp');
}

/** P-005 default: has THIS box already joined the canonical hive? joinHiveAsView's
 *  identity upsert writes a hives row keyed on the hive pubkey; a row keyed on the
 *  baked canonical pubkey means a prior boot already joined. Best-effort → null. */
function isIncompleteRemoteHiveView(project: {
  remote_hive?: boolean;
  hive_pubkey?: string;
  owner_device_pubkey?: string;
}): boolean {
  return (
    project.remote_hive === true &&
    Boolean(project.hive_pubkey?.trim()) &&
    !project.owner_device_pubkey?.trim()
  );
}

async function defaultFindJoinedCanonical(
  pubkeyBase64: string,
  loadRegistry: NonNullable<BootstrapPapercuspHiveDeps['loadRegistry']> = loadHarnessRegistry,
): Promise<{ slug: string } | null> {
  try {
    const { getHiveByPubkey } = await import('../hive-store');
    const row = await getHiveByPubkey(PAPERCUSP_WORKSPACE_ID, pubkeyBase64);
    if (!row) return null;

    // The hives row is the identity latch, but it can predate the registry's
    // owner-device binding. A partial remote view must fall through to the
    // idempotent join so the verified announce can backfill the missing field.
    const registry = await loadRegistry(PAPERCUSP_WORKSPACE_ID, { fresh: true }).catch(() => null);
    const view = registry?.projects.find((project) => project.slug === row.homeSlug);
    if (view && isIncompleteRemoteHiveView(view)) return null;
    return { slug: row.homeSlug };
  } catch {
    return null;
  }
}

/**
 * Best-effort re-run of the startup substrate boot-all (the WI-3232 bf97d fix — see the
 * rationale at the self-admit call site). Idempotent: an already-booted harness
 * short-circuits `alreadyBooted`, so calling it on a path where the substrate may
 * already be up costs one registry read. Never fails the bootstrap; a restart heals.
 */
async function bestEffortBootActiveWorkspace(
  deps: Pick<BootstrapPapercuspHiveDeps, 'bootActiveWorkspace'>,
  why: string,
): Promise<void> {
  try {
    const bootActive =
      deps.bootActiveWorkspace ??
      (async () =>
        (await import('../sync/hyperbee/boot-all')).bootAllHarnessesForActiveWorkspace());
    const r = await bootActive();
    console.warn(
      `[papercusp-hive] ${why} substrate boot: attempted=${r?.attempted ?? '?'} ` +
        `booted=${r?.booted ?? '?'} alreadyBooted=${r?.alreadyBooted ?? '?'} failed=${r?.failed ?? '?'}`,
    );
  } catch (e) {
    console.warn(
      `[papercusp-hive] ${why} substrate boot failed (non-fatal; retry next boot): ${(e as Error)?.message ?? e}`,
    );
  }
}

/**
 * D-006 cold-boot trust anchor. A self-admitted install has no directory
 * descriptor or admitted owner log to fall back to, so accepting a missing or
 * malformed key here would deterministically recreate the membership_miss
 * deadlock this stamp exists to break. Validate before any registry/filesystem
 * mutation so a bad baked invite fails closed without leaving a partial view.
 */
function requireCanonicalOwnerDevicePubkey(invite: CanonicalHiveInvite): string {
  const ownerDevicePubkey = invite.ownerDevicePubkey?.trim();
  if (!ownerDevicePubkey) {
    throw new Error('canonical self-admit requires a verified owner device public key');
  }
  const raw = Buffer.from(ownerDevicePubkey, 'base64');
  if (raw.length !== 32 || raw.toString('base64') !== ownerDevicePubkey) {
    throw new Error('canonical self-admit owner device public key must be raw-32 base64 Ed25519');
  }
  return ownerDevicePubkey;
}

export async function defaultSelfAdmitCanonical(
  invite: CanonicalHiveInvite,
  record?: BootstrapPapercuspHiveDeps['recordProgress'],
): Promise<SelfAdmitCanonicalResult> {
  const ownerDevicePubkey = requireCanonicalOwnerDevicePubkey(invite);
  const { mutateHarnessRegistry } = await import('../harness-registry');
  const { upsertRemoteHiveIdentity } = await import('../hive-store');
  const { targetRepoDir } = seedTargetDirs();

  try {
    await mkdir(targetRepoDir, { recursive: true });
  } catch {
    /* registry materialization can still proceed; the seed restore owns real contents */
  }

  await mutateHarnessRegistry(
    (cur) => {
      const nextEntry = {
        slug: PAPERCUSP_HIVE_SLUG,
        path: targetRepoDir,
        harness_kind: 'hive',
        remote_hive: true,
        // EI-8793: this entry's `path` IS the real seeded repo checkout (not a
        // repo-less view dir), so mark it `self_repo` — the flag git-sync
        // eligibility + the boot reconcile key on to seed the joiner-side
        // (push:false) git-sync routine that auto-commits agent edits. Without
        // it the release install's self-improvement loop is structurally dead:
        // agents edit the clone but nothing ever commits (confirmed live on the
        // 0.0.3 Mac install, 2026-07-09).
        self_repo: true,
        hive_pubkey: invite.pubkeyBase64,
        // D-006: the restored corestore's owner log cannot carry its own
        // admission prerequisite across a cold boundary. Stamp the verified
        // PUBLIC owner-device binding from the canonical invite so boot can
        // admit that log and only then ingest the full membership row.
        owner_device_pubkey: ownerDevicePubkey,
      };
      const projects = cur.projects.some((p) => p.slug === PAPERCUSP_HIVE_SLUG)
        ? cur.projects.map((p) => (p.slug === PAPERCUSP_HIVE_SLUG ? { ...p, ...nextEntry } : p))
        : [...cur.projects, nextEntry];
      // WI-2142873: a release seed is cut on the OWNER box, so its registry can
      // carry owner-only directory metadata for the canonical Papercusp hive.
      // This install is deliberately self-admitted as a remote_hive VIEW: it
      // must use the published hive identity and must never announce the hive
      // or require the owner's private key. Retaining the copied metadata made
      // hive-directory boot classify the VM as an owner on every restart,
      // repeatedly logging a missing `hive:<workspace>:papercusp` key and
      // publishing an identity-less directory frame. Remove only this hive's
      // owner metadata; unrelated locally-owned hive listings survive.
      const next = { ...cur, projects };
      if (next.hiveDirectoryMeta?.[PAPERCUSP_HIVE_SLUG]) {
        next.hiveDirectoryMeta = { ...next.hiveDirectoryMeta };
        delete next.hiveDirectoryMeta[PAPERCUSP_HIVE_SLUG];
      }
      return next;
    },
    PAPERCUSP_WORKSPACE_ID,
  );

  await upsertRemoteHiveIdentity({
    workspaceId: PAPERCUSP_WORKSPACE_ID,
    homeSlug: PAPERCUSP_HIVE_SLUG,
    pubkeyBase64: invite.pubkeyBase64,
    keychainId: `remote:${invite.pubkeyBase64}`,
    title: 'Papercusp',
  });
  record?.('clone', 'running', { detail: 'seed: self-admitted canonical Papercusp hive' });
  return { state: 'admitted', slug: PAPERCUSP_HIVE_SLUG, path: targetRepoDir };
}

/**
 * P-007 default restore-before-join. SAFE by construction: when no seed is shipped
 * (PAPERCUSP_SEED_DIR unset AND no bundled manifest) `restoreHiveSeed` returns
 * `ran:false`, so this is a pure no-op on dev boxes + current packaged builds — the
 * cold join is unchanged. A release that bundles a seed sets PAPERCUSP_SEED_DIR to
 * the Tauri resource dir. The corestore (federated hive state) restores now; the
 * ENCRYPTED git seed defers (its key arrives post-admission — see restore-hive-seed).
 */
async function defaultRestoreHiveSeed(
  record?: BootstrapPapercuspHiveDeps['recordProgress'],
): Promise<RestoreHiveSeedResult> {
  // P-011 master gate: the seed-bundle feature flag (DEFAULT ON). OFF ⇒ pure cold join.
  if (!(await seedBundleEnabled())) {
    record?.('clone', 'running', { detail: 'seed: disabled (flag off) — cold join' });
    return { ran: false, outcomes: [], deferred: [] };
  }
  // Resolve the bundled seed dir: --no-seed escape hatch, then PAPERCUSP_SEED_DIR
  // override, then Tauri bundled-resource autodetect (<resourceRoot>/seed). A
  // wrong/empty candidate resolves to null → the unchanged cold path.
  const resolved = resolveSeedDir();
  if (resolved.disabled) {
    record?.('clone', 'running', { detail: 'seed: disabled (PAPERCUSP_NO_SEED) — cold join' });
    return { ran: false, outcomes: [], deferred: [] };
  }
  const seedDir = resolved.seedDir;
  if (!seedDir) return { ran: false, outcomes: [], deferred: [] };
  record?.('clone', 'running', { detail: `seed: found (${resolved.source}) — restoring before join` });
  // Restore the corestore into the canonical hive's store dir; the git checkout into
  // the clones dir the join would otherwise populate (same dirs the post-admission
  // deferred-git restore targets — see seedTargetDirs).
  const { targetStoreDir, targetRepoDir } = seedTargetDirs();
  const res = await restoreHiveSeed({
    seedDir,
    targetStoreDir,
    targetRepoDir,
    // decryptionKey is intentionally absent pre-admission → the git seed defers.
    // WI-9413: an 'error' here means this install will boot EMPTY offline. It used to
    // render as ordinary 'clone/running' progress — indistinguishable from success in
    // the only place it surfaced at all.
    log: (msg, level) => {
      const detail = msg.replace(/^\[seed\]\s*/, 'seed: ');
      if (level === 'error') console.error(`[papercusp-hive] ${detail}`);
      // The STEP status deliberately stays 'running'. WI-9413 originally proposed
      // flipping it to 'error', but that would assert something false: the seed
      // restore is fail-soft by design, so the clone step genuinely continues and
      // succeeds via the cold path. The defect is "this install boots empty
      // offline", not "the clone step failed" — so it belongs in the log stream
      // (console.error, mirroring the WI-5179 precedent below), not in a step
      // state that other machinery reads as an aborted bootstrap.
      record?.('clone', 'running', { detail });
    },
  });
  return res;
}

/** The seed's canonical restore target dirs (shared by the pre-join restore and the
 *  post-admission deferred-git restore so both point at the SAME checkout / store).
 *
 *  WI-3232 corestore-dir fix: `targetStoreDir` MUST equal the dir boot opens the corestore
 *  at — `join(workspaceRootForId(PAPERCUSP_WORKSPACE_ID), '.papercusp', slug, 'hyperbee')`
 *  (corestore.ts:32 with boot-all's `workspaceRootForId = join(workspacesRoot(), ws)`).
 *  It previously used `PAPERCUSP_WORKSPACE_ROOT ?? defaultClonesDir()` → `<root>/clones/…`,
 *  a dir boot NEVER reads (note the env NAME: boot's `workspacesRoot()` reads
 *  PAPERCUSP_WORKSPACE**S**_ROOT, plural). Online the join's network replication cold-filled
 *  boot's REAL dir, masking the dead restore; but the OFFLINE self-admit pot has no network,
 *  so its content (plans/work-items/code) only materializes when the restored corestore lands
 *  where boot reads it. `targetRepoDir` stays under clones — it is a real git checkout. */
export function seedTargetDirs(): { targetStoreDir: string; targetRepoDir: string } {
  return {
    targetStoreDir: join(workspacesRoot(), PAPERCUSP_WORKSPACE_ID, '.papercusp', PAPERCUSP_HIVE_SLUG, 'hyperbee'),
    targetRepoDir: join(defaultClonesDir(), PAPERCUSP_HIVE_SLUG),
  };
}

/**
 * P-010 live-wire 2 default: restore the git seed that {@link defaultRestoreHiveSeed}
 * DEFERRED (its bundles are encrypted at rest; the key = the hive epoch key at
 * cutAtEpoch). Resolves that key from a provider CHAIN and hands it to the trigger,
 * which unwraps + re-restores just the git store.
 *
 * WI-3232 (offline pot): the chain is the FEDERATED member provider FIRST (post-admission;
 * holds every granted epoch — Q-4) then the BUNDLED seed provider (epoch-keys.json —
 * OFFLINE, cutAtEpoch). The bundled provider is always available once a seed shipped, so a
 * fresh install with NO admission (no gh, owner offline) still decrypts the git seed
 * instead of cold-cloning — the crux of the offline pot. Online federated boots are
 * unchanged: the member provider resolves first and the fallback is never consulted.
 * Best-effort + safe: no seed / --no-seed ⇒ no-op; an unresolved key leaves the store
 * deferred and the join's normal cold clone fills the repo in — never a boot failure.
 */
async function defaultRestoreDeferredGitSeed(
  record?: BootstrapPapercuspHiveDeps['recordProgress'],
): Promise<TriggerDeferredGitRestoreResult> {
  // P-011 master gate (DEFAULT ON): OFF ⇒ nothing was restored pre-join, so nothing
  // is deferred — no-op (belt-and-suspenders; the pre-join restore already no-op'd).
  if (!(await seedBundleEnabled())) return { ran: false, restored: [], stillDeferred: [] };
  const resolved = resolveSeedDir();
  if (resolved.disabled || !resolved.seedDir) return { ran: false, restored: [], stillDeferred: [] };
  const { targetStoreDir, targetRepoDir } = seedTargetDirs();
  // Member provider (may be null offline — no device identity) FIRST, bundled seed
  // provider (always present when a seed shipped) as the offline fallback.
  const memberProvider = await buildMemberEpochKeyProvider({
    workspaceId: PAPERCUSP_WORKSPACE_ID,
    potHomeSlug: PAPERCUSP_HIVE_SLUG,
  });
  const epochKeyProvider = chainEpochKeyProviders([
    memberProvider,
    createBundledEpochKeyProvider(resolved.seedDir),
  ]);
  const res = await triggerDeferredGitRestore({
    seedDir: resolved.seedDir,
    targetStoreDir,
    targetRepoDir,
    epochKeyProvider,
    log: (msg, level) => {
      const detail = msg.replace(/^\[seed\]\s*/, 'seed: ');
      // WI-5179 (EI-12881 family): mirror to the console — recordProgress is the
      // only sink otherwise, so serve.log showed 'gave up after retries' with the
      // actual failure reason (e.g. the read-only seed-dir EACCES) invisible.
      // WI-9413: that mirror was one flat level, so "key not yet available" (a normal
      // pre-admission state that retries next boot) and "the key resolved and the
      // restore still failed" (unrecoverable — the code half is gone) were the same
      // warn. Only the latter is a defect; split them.
      if (level === 'error') console.error(`[papercusp-hive] ${detail}`);
      else console.warn(`[papercusp-hive] ${detail}`);
      record?.('clone', 'running', { detail });
    },
  });
  // EI-8793: the moment the git seed actually lands, seed the joiner-side
  // git-sync routine for the canonical clone — this activates the
  // self-improvement loop's commit leg on the FIRST boot instead of waiting for
  // the next restart's reconcile sweep. Placed HERE (not at the call sites) so
  // every path that restores git — the offline self-admit attempt, the
  // post-admission attempt, and each WI-3070 background retry — seeds through
  // one seam.
  if (res.restored.includes('git')) await seedCanonicalCloneGitSyncRoutine(record);
  return res;
}

/** Test seam for {@link seedCanonicalCloneGitSyncRoutine} (default: the real spine, lazy). */
export interface SeedCanonicalCloneGitSyncDeps {
  seedMember?: typeof import('./git-sync/git-sync-routine').seedGitSyncRoutineForMember;
}

/**
 * EI-8793: seed the joiner-side (push:false) `system:git-sync` routine for the
 * canonical papercusp clone a release install self-admits. Without this routine
 * the install's self-improvement loop is structurally dead: agents edit the
 * seeded checkout but nothing ever commits (confirmed live on the 0.0.3 Mac
 * install, 2026-07-09 — routines count 0, edits stranded uncommitted).
 *
 * Idempotent (the spine's routine_exists skip) + best-effort NEVER-throws: a
 * failure never breaks the caller, and the boot reconcile
 * (git-sync-reconcile.ts, which now walks `remote_hive && self_repo` entries)
 * remains the authoritative backfill for existing installs.
 */
export async function seedCanonicalCloneGitSyncRoutine(
  record?: BootstrapPapercuspHiveDeps['recordProgress'],
  deps: SeedCanonicalCloneGitSyncDeps = {},
): Promise<void> {
  try {
    const seed =
      deps.seedMember ??
      (await import('./git-sync/git-sync-routine')).seedGitSyncRoutineForMember;
    const { targetRepoDir } = seedTargetDirs();
    const outcome = await seed({
      workspaceId: PAPERCUSP_WORKSPACE_ID,
      installSlug: PAPERCUSP_HIVE_SLUG,
      // Synthesized snapshot of the entry defaultSelfAdmitCanonical registers
      // (the registry write may land just after the restore on the offline
      // path — the seeding spine only needs these fields).
      entry: {
        slug: PAPERCUSP_HIVE_SLUG,
        path: targetRepoDir,
        harness_kind: 'hive',
        remote_hive: true,
        self_repo: true,
      },
      joinerSide: true,
      // Same member slug exists on every install of the shared hive — salt
      // the cron jitter per box (D-004 multi-pusher).
      cronKey: `${PAPERCUSP_HIVE_SLUG}:${PAPERCUSP_WORKSPACE_ID}`,
    });
    if (outcome.seeded) {
      record?.('clone', 'running', {
        detail: 'seed: git-sync routine seeded (self-improvement loop active)',
      });
    } else if (outcome.reason !== 'routine_exists') {
      console.warn(
        `[papercusp-hive] git-sync routine seed skipped (${outcome.reason}${
          outcome.reason === 'ineligible' ? `:${outcome.ineligibleReason}` : ''
        }) — boot reconcile will retry`,
      );
    }
  } catch (e) {
    console.warn(
      `[papercusp-hive] git-sync routine seed failed (non-fatal; boot reconcile heals): ${(e as Error)?.message ?? e}`,
    );
  }
}

/** Test seams for {@link backfillCanonicalCloneGitSync} (defaults: the real verbs, lazy). */
export interface BackfillCanonicalCloneGitSyncDeps {
  mutate?: typeof import('../harness-registry').mutateHarnessRegistry;
  seedRoutine?: typeof seedCanonicalCloneGitSyncRoutine;
}

/**
 * EI-8793 EXISTING-install backfill: an install admitted BEFORE self-admit
 * stamped `self_repo` (≤0.0.3) carries a canonical-clone entry that reads as a
 * repo-less remote_hive VIEW — git-sync eligibility rejects it and the boot
 * reconcile's member walk (`remote_hive && self_repo`) never visits it, so the
 * self-improvement loop's commit leg is dead and agent edits strand
 * uncommitted. Self-admit itself can't heal this: the bootstrap's step-1
 * short-circuits `already-present` on the existing entry long before the
 * self-admit path runs. So the step-1 path calls THIS: stamp `self_repo:true`
 * on the existing canonical entry (it IS its own seeded checkout by
 * construction), then seed the routine directly — idempotent (`routine_exists`
 * no-ops), never-throws, and the seed only fires once the stamp landed (a
 * routine whose registry entry still reads as a view would just fail the
 * runtime eligibility gate every tick).
 */
export async function backfillCanonicalCloneGitSync(
  existing: ProjectEntry,
  record?: BootstrapPapercuspHiveDeps['recordProgress'],
  deps: BackfillCanonicalCloneGitSyncDeps = {},
): Promise<void> {
  if (existing.slug !== PAPERCUSP_HIVE_SLUG || !existing.remote_hive || existing.self_repo) return;
  try {
    const mutate = deps.mutate ?? (await import('../harness-registry')).mutateHarnessRegistry;
    await mutate(
      (cur) => ({
        ...cur,
        projects: cur.projects.map((p) =>
          p.slug === PAPERCUSP_HIVE_SLUG ? { ...p, self_repo: true } : p,
        ),
      }),
      PAPERCUSP_WORKSPACE_ID,
    );
    existing.self_repo = true; // keep the caller's snapshot honest
    record?.('clone', 'running', {
      detail: 'EI-8793: self_repo backfilled on the existing canonical entry',
    });
  } catch (e) {
    console.warn(
      `[papercusp-hive] self_repo backfill failed (non-fatal; next boot retries): ${(e as Error)?.message ?? e}`,
    );
    return; // don't seed against an un-stamped entry
  }
  await (deps.seedRoutine ?? seedCanonicalCloneGitSyncRoutine)(record);
}

/** WI-3070: bounded backoff schedule (ms) for the post-admission deferred-git retry —
 *  5 attempts over ~2 minutes. The epoch-key row for a fresh member's device federates
 *  ASYNCHRONOUSLY after admission (a separate hyperbee row from the join itself, replicated
 *  by the ordinary hive sync loop) with no hard delivery SLA, so the single immediate
 *  attempt {@link defaultRestoreDeferredGitSeed} makes right after `joinCanonical` returns
 *  has a real chance of racing ahead of it. */
export const GIT_SEED_RETRY_DELAYS_MS: readonly number[] = [5_000, 10_000, 20_000, 40_000, 45_000];

/**
 * WI-3070 default: bounded background retry of the deferred git-seed restore. Root cause
 * this fixes — `serve.log` on a fresh packaged install repeatedly showed
 * `post-admission seed restore: restored=[] stillDeferred=[git]` and the repo silently fell
 * back to a full cold network clone (~190M observed), because the ONE attempt fired right
 * after admission almost always beat the epoch-key row's federation to this device.
 *
 * Each retry reuses the SAME `retry` closure (which the caller binds to the exact
 * `restoreDeferredGitSeed(record)` call it already made) — that seam is idempotent BY
 * CONSTRUCTION (see deferred-git-restore.ts's docstring): re-attempting after the epoch key
 * has landed re-restores the git store; re-attempting after the join's ordinary cold clone
 * has ALREADY back-filled `targetRepoDir` just fails the `git clone` (destination not empty)
 * and reports `stillDeferred` again, harmlessly — so there is no separate "already restored"
 * guard to add here, only a cap on how many times we bother trying. Fired-not-awaited
 * (mirrors {@link defaultInitSubmodules}) — must never hold up boot. Never throws.
 */
function defaultScheduleGitSeedRetry(
  record: BootstrapPapercuspHiveDeps['recordProgress'] | undefined,
  retry: () => Promise<TriggerDeferredGitRestoreResult>,
): void {
  void (async () => {
    for (const delayMs of GIT_SEED_RETRY_DELAYS_MS) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      try {
        const res = await retry();
        if (res.restored.includes('git')) {
          console.log('[papercusp-hive] deferred git seed restore succeeded on retry (epoch key had landed)');
          record?.('clone', 'running', { detail: 'seed: git restored on retry (epoch key landed)' });
          return;
        }
        if (!res.stillDeferred.includes('git')) {
          // Nothing left to retry (e.g. the manifest/flag disappeared mid-boot) — stop quietly.
          return;
        }
      } catch (e) {
        console.warn(`[papercusp-hive] deferred git seed retry attempt failed (non-fatal): ${(e as Error)?.message ?? e}`);
      }
    }
    console.warn(
      '[papercusp-hive] deferred git seed restore gave up after retries — the ordinary cold clone has (or will) back-fill the repo instead',
    );
  })();
}

/** Count top-level submodules from `.gitmodules` (best-effort) — the progress
 *  total. `--recursive` can exceed this (nested submodules), so callers clamp. */
function countSubmodules(repoPath: string): Promise<number> {
  return new Promise((resolve) => {
    let out = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        'git',
        ['config', '-f', join(repoPath, '.gitmodules'), '--get-regexp', '^submodule\\..*\\.path$'],
        { cwd: repoPath },
      );
    } catch {
      resolve(0);
      return;
    }
    child.stdout?.on('data', (b: Buffer) => (out += b.toString()));
    child.on('error', () => resolve(0));
    child.on('close', () => resolve(out.split('\n').filter((l) => l.trim()).length));
  });
}

/** Matches git's per-submodule completion line: `Submodule path '…': checked out …`. */
const SUBMODULE_DONE_RE = /Submodule path .*: checked out/;

/**
 * Matches git's failure-shaped stderr so a non-zero exit can name the cause:
 * `fatal: …`, `error: …`, `Failed to clone '…'`, `remote: Repository not found`,
 * `Authentication failed`, `Could not read from remote`, `Permission denied`.
 */
const SUBMODULE_FAIL_RE =
  /^(fatal|error):|Failed to clone|Repository not found|Authentication failed|Could not read|Permission denied|remote: /i;

/** Best-effort `git submodule update --init --recursive --progress` (the 27
 *  submodules are the bulk of the ~5GB). Streams completion to `onProgress` and
 *  fires `onDone(ok)` once. Fired (not awaited) in prod; the hive is created
 *  before this so it appears promptly and fills in. */
function defaultInitSubmodules(
  repoPath: string,
  opts: {
    shallow?: boolean;
    onProgress?: (done: number, total: number) => void;
    onDone?: (ok: boolean) => void;
  } = {},
): void {
  void (async () => {
    const total = await countSubmodules(repoPath);
    const args = ['submodule', 'update', '--init', '--recursive', '--progress'];
    if (opts.shallow) args.push('--depth', '1');
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('git', args, { cwd: repoPath, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    } catch (e) {
      console.warn(`[papercusp-hive] submodule init spawn failed (non-fatal): ${(e as Error).message}`);
      opts.onDone?.(false);
      return;
    }
    // 2h ceiling — background, but never hang a wedged fetch forever.
    const kill = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* */ } }, 2 * 60 * 60 * 1000);
    kill.unref?.();
    let done = 0;
    // Keep a bounded tail of failure-shaped stderr so a non-zero exit can name
    // WHICH submodule failed and why (a bare "exited 128" cost a full live-debug
    // round to trace a stale .gitmodules URL → 404). See agent-insights/
    // setup-wizard-submodule-url-mismatch.
    const failTail: string[] = [];
    child.stderr?.on('data', (b: Buffer) => {
      for (const line of b.toString().split(/[\r\n]+/)) {
        if (SUBMODULE_DONE_RE.test(line)) {
          done += 1;
          opts.onProgress?.(done, total);
        } else if (SUBMODULE_FAIL_RE.test(line)) {
          failTail.push(line.trim());
          if (failTail.length > 12) failTail.shift();
        }
      }
    });
    child.on('error', (e) => {
      clearTimeout(kill);
      console.warn(`[papercusp-hive] submodule init failed (non-fatal): ${e.message}`);
      opts.onDone?.(false);
    });
    child.on('close', (code) => {
      clearTimeout(kill);
      if (code === 0) console.log('[papercusp-hive] submodules initialised');
      else {
        const detail = failTail.length ? ` — ${failTail.join(' | ')}` : '';
        console.warn(
          `[papercusp-hive] submodule init exited ${code} (${done}/${total} done, non-fatal)${detail}`,
        );
      }
      opts.onDone?.(code === 0);
    });
  })();
}

/** Percent for a submodule phase (clamped; total 0 ⇒ indeterminate 0). */
function submodulePercent(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.round((done / total) * 100));
}

/** True when `git submodule status --recursive` reports any uninitialized,
 *  wrong-SHA, or conflicted submodule. The already-present hive path must use
 *  this: the hive row can exist before the background submodule fill completed,
 *  and retries must resume that work instead of declaring setup done. */
function defaultSubmodulesNeedUpdate(repoPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    let out = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('git', ['submodule', 'status', '--recursive'], { cwd: repoPath });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      resolve(false);
    }, 20_000);
    timer.unref?.();
    child.stdout?.on('data', (b: Buffer) => (out += b.toString()));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out.split('\n').some((line) => /^[-+U]/.test(line.trimStart())));
    });
  });
}

/** Run a best-effort Solution-C share step, swallowing any error (EI-3548).
 *  These steps call the GitHub API (gist publish/read + announce); a transient
 *  api.github.com timeout there must never reject the bootstrap and turn an
 *  otherwise-complete workspace setup into a hard "failed". Warn and proceed —
 *  the next operator boot re-runs the share idempotently. */
async function bestEffortShare(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.warn(`[papercusp-hive] ${label} failed (non-fatal): ${(e as Error)?.message ?? e}`);
  }
}

/** Process single-flight for the dogfood bootstrap (see startBootstrapPapercuspHive). */
let bootstrapInFlight: Promise<BootstrapPapercuspHiveResult> | null = null;

/**
 * P-539: backoff (ms) for re-running a RETRYABLE skip in-process — 7 attempts over
 * ~15 minutes. A retryable skip means the box never joined the canonical invite topic
 * (directory wiring stalled or not ready), so the WI-1585 ingest re-trigger cannot fire
 * and, before this, nothing re-ran the join until the next app start. Measured on the
 * Mac VM rig (P-007 run #11): the DHT bootstrap alone took ~55 s against the join's
 * 30 s wiring bound, and the manual re-trigger paired the invite topic within 1 s.
 */
export const BOOTSTRAP_RETRY_DELAYS_MS: readonly number[] = [15_000, 30_000, 60_000, 120_000, 180_000, 240_000, 300_000];

/** Retries already scheduled since the last non-retryable outcome. */
let bootstrapRetryAttempt = 0;
let bootstrapRetryTimer: ReturnType<typeof setTimeout> | null = null;

/** Schedule the next in-process retry of a retryable skip, at most one pending at a time. */
function scheduleBootstrapRetry(deps: BootstrapPapercuspHiveDeps): void {
  if (bootstrapRetryTimer) return;
  const delays = deps.retryDelaysMs ?? BOOTSTRAP_RETRY_DELAYS_MS;
  const delayMs = delays[bootstrapRetryAttempt];
  if (delayMs === undefined) {
    console.warn(
      `[papercusp-hive] canonical join still not reachable after ${delays.length} in-process retries — the directory ingest re-trigger or the next boot retries`,
    );
    return;
  }
  bootstrapRetryAttempt++;
  const timer = setTimeout(() => {
    if (bootstrapRetryTimer === timer) bootstrapRetryTimer = null;
    void startBootstrapPapercuspHive(deps).done.catch(() => {});
  }, delayMs);
  timer.unref?.();
  bootstrapRetryTimer = timer;
}

/**
 * Single-flight trigger for "start the dogfood clone NOW" — used by BOTH the
 * boot path and the setup-wizard's post-gh-auth "start" endpoint, so they share
 * ONE run instead of racing two clones. Returns the `progressId` immediately (the
 * UI subscribes to it) and a `done` promise that resolves when the hive is created
 * (the clone finished; submodules keep filling in the background).
 *
 * A SUCCESS is cached for the process (idempotent; never re-run racing the
 * background submodule fill). A `skipped` result (e.g. auth_required because gh
 * isn't signed in yet at boot) RELEASES the latch so the next trigger — the
 * wizard, after the user completes the GitHub step — re-runs and actually clones.
 * A `retryable` skip (P-539) also schedules that next trigger itself, on
 * {@link BOOTSTRAP_RETRY_DELAYS_MS}, because no outside trigger can arrive for it.
 */
export function startBootstrapPapercuspHive(deps: BootstrapPapercuspHiveDeps = {}): {
  progressId: string;
  done: Promise<BootstrapPapercuspHiveResult>;
} {
  if (!bootstrapInFlight) {
    bootstrapInFlight = bootstrapPapercuspHive(deps).then(
      (res) => {
        if (res.state === 'skipped') {
          bootstrapInFlight = null; // allow a retry
          if (res.retryable) scheduleBootstrapRetry(deps);
          else bootstrapRetryAttempt = 0;
        } else {
          bootstrapRetryAttempt = 0;
        }
        return res;
      },
      (err) => {
        bootstrapInFlight = null;
        throw err;
      },
    );
  }
  return { progressId: BOOTSTRAP_PROGRESS_ID, done: bootstrapInFlight };
}

/** Test seam — clear the single-flight latch (and any pending P-539 retry) between cases. */
export function __resetBootstrapInFlight(): void {
  bootstrapInFlight = null;
  bootstrapRetryAttempt = 0;
  if (bootstrapRetryTimer) clearTimeout(bootstrapRetryTimer);
  bootstrapRetryTimer = null;
}

/**
 * Ensure the `papercusp` dogfood hive exists, cloning the repo first when there's
 * no local checkout (packaged install). Idempotent + best-effort + non-fatal.
 */
export async function bootstrapPapercuspHive(
  deps: BootstrapPapercuspHiveDeps = {},
): Promise<BootstrapPapercuspHiveResult> {
  const detectRoot = deps.detectRoot ?? detectPapercupRoot;
  const loadRegistry = deps.loadRegistry ?? loadHarnessRegistry;
  const clone = deps.clone ?? cloneGithubRepo;
  const ensureHive = deps.ensureHive ?? ensurePapercuspHive;
  const setHome = deps.setHomeWorkspace ?? defaultSetHomeWorkspace;
  const ensureWorkspaceListed = deps.ensureWorkspaceListed ?? ensurePapercuspWorkspace;
  const initSubmodules = deps.initSubmodules ?? defaultInitSubmodules;
  const record =
    deps.recordProgress ??
    ((step, status, extra) => recordFromRepoStep(BOOTSTRAP_PROGRESS_ID, step, status, extra));
  const shallow = deps.cloneShallow ?? true;
  const ref = dogfoodRef(deps.ref);
  const adoptShare = deps.adoptShare ?? adoptSharedHiveIdentity;
  const goShare = deps.goShare ?? goSharedHive;
  const shareExisting = deps.shareExisting ?? shareExistingHive;
  const submodulesNeedUpdate = deps.submodulesNeedUpdate ?? defaultSubmodulesNeedUpdate;

  // WI-1423: hard test-frame kill-switch, checked BEFORE any network/GitHub/directory
  // call — see dogfoodHiveDisabled() for the full rationale. This is the single choke
  // point every trigger path (boot, wizard, directory-ingest retrigger) funnels through.
  if (dogfoodHiveDisabled()) {
    return { state: 'skipped', slug: null, reason: 'dogfood hive disabled (PAPERCUSP_DISABLE_DOGFOOD_HIVE=1)' };
  }

  const startSubmodulePhase = (repoPath: string): void => {
    record('submodules', 'running', { percent: 0 });
    initSubmodules(repoPath, {
      shallow,
      onProgress: (d, total) =>
        record('submodules', 'running', {
          percent: submodulePercent(d, total),
          detail: total > 0 ? `${Math.min(d, total)}/${total} submodules` : `${d} submodules`,
        }),
      onDone: (ok) => {
        record('submodules', ok ? 'done' : 'error');
        if (!ok) bootstrapInFlight = null;
      },
    });
  };

  // 1. Idempotent: the `papercusp` hive already exists → home it, then verify the
  //    repo's submodules. The hive row can be created before the background
  //    submodule fill finishes; retries must resume that fill instead of treating
  //    existence as setup-complete.
  try {
    const reg = await loadRegistry(PAPERCUSP_WORKSPACE_ID);
    const existing = reg.projects.find((p) => p.slug === PAPERCUSP_HIVE_SLUG);
    if (existing && !isIncompleteRemoteHiveView(existing)) {
      // WI-3288: self-heal — ensure papercusp-workspace is LISTED in registry.json
      // workspaces[] on every boot (an install self-admitted before this fix homed it
      // without listing it → the pot stayed invisible). ensurePapercuspWorkspace is idempotent.
      ensureWorkspaceListed();
      setHome(PAPERCUSP_WORKSPACE_ID);
      // EI-8793 EXISTING-install heal: a ≤0.0.3 release install's canonical entry
      // lacks `self_repo`, so git-sync reads it as a repo-less view and the
      // self-improvement loop's commit leg is dead. This step-1 short-circuit is
      // the ONE boot path an already-admitted install always takes (self-admit
      // below never re-runs), so the backfill lives here: stamp the flag + seed
      // the routine. Idempotent + never-throws.
      await backfillCanonicalCloneGitSync(existing, record);
      record('clone', 'done', { detail: 'already present' });
      if (existing.path && (await submodulesNeedUpdate(existing.path))) {
        startSubmodulePhase(existing.path);
      } else {
        record('submodules', 'done');
      }
      // Solution C: share an already-present hive (flag enabled after create / re-boot).
      // BEST-EFFORT (EI-3548): this calls the GitHub API (per-owner gist publish +
      // announce). A transient api.github.com timeout here must NOT fail an
      // otherwise-complete workspace setup — warn and proceed; the next boot re-shares.
      await bestEffortShare('shareExisting', shareExisting);
      // WI-5165: "already present" does NOT imply "already booted". On a packaged
      // install this entry can pre-exist from a PEER process's self-admit (several
      // desktop-flagged operators race this bootstrap, and a request-only env sidecar
      // can register the pot while being forbidden from booting the substrate) — and
      // THIS process's startup boot-all ran before the registration existed, so nothing
      // ever opened the restored corestore and the pot rendered as an empty shell.
      // Scoped to the remote_hive (self-admitted / joined) shape; an owner dev
      // checkout's substrate is the startup boot-all's job.
      if (existing.remote_hive) await bestEffortBootActiveWorkspace(deps, 'already-present');
      return { state: 'already-present', slug: PAPERCUSP_HIVE_SLUG, path: existing.path };
    }
  } catch {
    /* registry not ready yet — fall through; ensureHive re-checks idempotently */
  }

  // 1b. JOIN-the-canonical pivot: when the build baked the canonical hive invite
  //     (pubkey+secret, no private key), JOIN the ONE canonical `papercusp` hive
  //     (clones the member repos + federates the owner's plans/work-items) INSTEAD of
  //     the clone+create+Solution-C path below. Per-owner create is the no-invite
  //     fallback. Best-effort: a skip (gh unauth / owner offline) retries next boot.
  const canonicalInvite = bakedCanonicalHiveInvite(deps.canonicalInvite);
  if (canonicalInvite) {
    // P-005 fire-once latch: if this box ALREADY joined the canonical hive on a prior
    // boot (a hives row keyed on the canonical pubkey exists from joinHiveAsView's
    // identity upsert), short-circuit. Re-running the join would re-pay the ~25s
    // confirmInviteAnnounce wait AND then spuriously SKIP — confirmInviteAnnounce only
    // fires on a FRESH appearance, but on a reboot the canonical hive is already in the
    // discovered set, so the join would report "not announcing yet" every boot forever.
    // (The OWNER box never reaches here: step 1 finds its own slug:'papercusp' hive.)
    const findJoinedCanonical =
      deps.findJoinedCanonical ?? ((pubkeyBase64: string) => defaultFindJoinedCanonical(pubkeyBase64, loadRegistry));
    const alreadyJoined = await findJoinedCanonical(canonicalInvite.pubkeyBase64).catch(() => null);
    if (alreadyJoined) {
      setHome(PAPERCUSP_WORKSPACE_ID);
      record('clone', 'done', { detail: 'already joined the Papercusp hive' });
      record('submodules', 'done');
      return { state: 'already-present', slug: alreadyJoined.slug };
    }
    // P-007: RESTORE-BEFORE-JOIN. Pre-position the installer-bundled seed so the
    // join's clone + federation delta-replication transfer only the delta on top.
    // The join below is UNCHANGED. Best-effort: any failure degrades to the cold
    // path and never breaks the join (a seed is untrusted cache).
    let seedRan = false;
    let gitDeferred = false; // P-010 live-wire 2: the encrypted git seed awaits its post-admission key.
    try {
      const restore = deps.restoreSeed ?? defaultRestoreHiveSeed;
      const seedRes = await restore(record);
      seedRan = seedRes.ran;
      if (seedRes.deferred.includes('git')) gitDeferred = true;
      if (seedRes.ran) {
        const restored = seedRes.outcomes.filter((o) => o.ok).map((o) => o.kind);
        console.warn(
          `[papercusp-hive] seed restore: restored=[${restored.join(',')}] deferred=[${seedRes.deferred.join(',')}]`,
        );
        // EI-12881: a store that fails its verify gate degrades to the cold path —
        // i.e. an EMPTY hive offline. The per-store reason otherwise only reaches the
        // progress recorder, so the packaged install's LOG showed `restored=[]` with no
        // cause and the broken restore looked like a slow one. Never fail this quietly.
        for (const o of seedRes.outcomes.filter((x) => !x.ok)) {
          console.warn(
            `[papercusp-hive] seed restore FAILED for ${o.kind} — cold-pathing (this hive will be EMPTY until it can join): ${o.reason ?? 'unknown'}`,
          );
        }
      }
    } catch (e) {
      console.warn(`[papercusp-hive] seed restore failed (non-fatal; cold path): ${(e as Error)?.message ?? e}`);
    }

    const joinCanonical = deps.joinCanonical ?? joinCanonicalPapercuspHive;
    const joinRes = await joinCanonical(canonicalInvite, { record });
    if (joinRes.state !== 'joined' && seedRan && (await seedSelfAdmitEnabled())) {
      // GUARD (WI-3232 regression 2026-07-06): a box that already owns the papercusp checkout
      // (self_repo) must NEVER self-admit as a remote_hive VIEW. Doing so clobbers the
      // git-sync-eligible source-of-truth registry entry into "ineligible (remote_hive_view)"
      // (git-sync-eligibility.ts) and FREEZES git-sync FLEET-WIDE — the whole shared tree stops
      // committing. Step-1 above normally short-circuits an existing entry, but a 2s
      // registry-cache-miss race can still reach here; a FRESH read closes that window and homes
      // the owner checkout instead of self-admitting a remote view over it.
      const ownEntry = (
        await loadRegistry(PAPERCUSP_WORKSPACE_ID, { fresh: true }).catch(() => null)
      )?.projects.find((p) => p.slug === PAPERCUSP_HIVE_SLUG);
      // WI-5165: `self_repo` ALONE is not "owner checkout" — a SELF-ADMITTED canonical
      // entry also carries self_repo (EI-8793 stamps it for git-sync eligibility) but is
      // remote_hive:true. On a packaged install, a PEER process (a request-only env
      // sidecar racing this same bootstrap) can win the self-admit and register that
      // entry while being FORBIDDEN from booting the substrate itself — skipping here on
      // its debris left the pot a permanent empty shell. Only a self_repo entry that is
      // NOT a remote hive is the owner dev checkout this guard exists for; re-admitting
      // a remote_hive entry is an idempotent upsert and MUST proceed so THIS process
      // runs the substrate boot below.
      if (ownEntry?.self_repo && !ownEntry.remote_hive) {
        setHome(PAPERCUSP_WORKSPACE_ID);
        record('clone', 'done', { detail: 'self-admit skipped: owner self_repo checkout present' });
        record('submodules', 'done');
        return { state: 'already-present', slug: PAPERCUSP_HIVE_SLUG, path: ownEntry.path };
      }
      try {
        if (gitDeferred) {
          const restoreDeferred = deps.restoreDeferredGitSeed ?? defaultRestoreDeferredGitSeed;
          const gitRes = await restoreDeferred(record);
          if (gitRes.restored.length || gitRes.stillDeferred.length) {
            console.warn(
              `[papercusp-hive] offline seed git restore: restored=[${gitRes.restored.join(',')}] stillDeferred=[${gitRes.stillDeferred.join(',')}]`,
            );
          }
          // WI-3232 (bf97d offline verify 2026-07-06): the git (CODE) half may still be
          // undecryptable offline, but the pot's DATA lives in the ALREADY-restored corestore.
          // Do NOT gate self-admit on the git half — self-admit ANYWAY so the pot APPEARS offline
          // with its plans/work-items; the code checkout back-fills via a bounded background retry
          // (and the ordinary fetch once online). This block previously `return`ed 'skipped' here,
          // so a fresh OFFLINE install showed NO pot at all (boot fell through to the gh-gated join).
          if (gitRes.stillDeferred.includes('git')) {
            console.warn(
              '[papercusp-hive] offline git seed still deferred — self-admitting DATA-only; git code back-fills via retry/online',
            );
            const scheduleRetry = deps.scheduleGitSeedRetry ?? defaultScheduleGitSeedRetry;
            scheduleRetry(record, () => restoreDeferred(record));
          }
        }
        const selfAdmit = deps.selfAdmitCanonical ?? defaultSelfAdmitCanonical;
        const selfRes = await selfAdmit(canonicalInvite, record);
        if (selfRes.state === 'admitted') {
          // WI-3288: LIST the workspace before homing it. self-admit registered the pot
          // (harness_registry + hives) and set `current`, but never listed papercusp-workspace
          // → `current` pointed at an unlisted workspace → /api/workspaces empty → the dogfood
          // pot was INVISIBLE despite being fully on disk. ensurePapercuspWorkspace lists + provisions.
          ensureWorkspaceListed();
          setHome(PAPERCUSP_WORKSPACE_ID);
          // WI-3232 (offline FIRST-boot fix, bf97d 2026-07-06): the startup substrate boot
          // (bootAllHarnessesForActiveWorkspace) already ran with the OLD active workspace
          // (`default`, before self-admit registered papercusp) → it booted NOTHING for this hive
          // (attempted=0). Now that self-admit has registered papercusp under PAPERCUSP_WORKSPACE_ID
          // AND `setHome`'d the active workspace to it, RE-RUN the SAME startup boot-all so the
          // corestore opens + epoch-decrypts on THIS (first) boot — exactly what a restart does
          // (boot-2's boot-all, with the pot already registered, yields a queryable offline pot;
          // its content is readable via the sync resolver, e.g. plans.list, with no network).
          // This REPLACES the earlier single `rekeyHarness`→`bootSingleHarness` call: that booted
          // the handle OUTSIDE the startup factory-default flow (in-process vs sidecar routing the
          // query layer expects) so it never became queryable, AND it CACHED a handle for
          // `papercusp-workspace::papercusp` that made any subsequent boot-all short-circuit
          // `alreadyBooted` and no-op — the fix looked landed but the pot stayed dark (b0fbf
          // boot-all review). Call the PUBLIC boot-all with NO per-call overrides so it inherits
          // the startup module bootHarness/skipSendSideWiring routing. Best-effort: never fails the
          // bootstrap; a restart still heals it.
          await bestEffortBootActiveWorkspace(deps, 'self-admit');
          record('clone', 'done', { detail: 'offline seed self-admit' });
          record('submodules', 'skipped', { detail: 'seed restore' });
          return { state: 'cloned-and-created', slug: selfRes.slug, path: selfRes.path };
        }
      } catch (e) {
        console.warn(
          `[papercusp-hive] offline seed self-admit failed (non-fatal; retry join): ${(e as Error)?.message ?? e}`,
        );
      }
    }

    // P-010 live-wire 2: POST-ADMISSION git-restore. The join above admitted this
    // device + delivered the hive epoch keys, so the deferred (encrypted) git seed is
    // now decryptable — restore it so the repo is pre-positioned and its later fetch
    // carries only the delta. Best-effort: only when the join succeeded AND the git
    // store was deferred; a failure degrades to the join's normal cold clone.
    if (joinRes.state === 'joined' && gitDeferred) {
      try {
        const restoreDeferred = deps.restoreDeferredGitSeed ?? defaultRestoreDeferredGitSeed;
        const gitRes = await restoreDeferred(record);
        if (gitRes.restored.length || gitRes.stillDeferred.length) {
          console.warn(
            `[papercusp-hive] post-admission seed restore: restored=[${gitRes.restored.join(',')}] stillDeferred=[${gitRes.stillDeferred.join(',')}]`,
          );
        }
        // WI-3070: the FIRST attempt (right above) fires the instant `joinCanonical` returns
        // 'joined' — but this device's epoch-key row federates as a SEPARATE, asynchronous
        // hive-sync event, so it commonly hasn't landed yet at this exact instant. Rather than
        // permanently accepting the cold-clone fallback, retry in the BACKGROUND with bounded
        // backoff (never awaited — must not slow down boot).
        if (gitRes.stillDeferred.includes('git')) {
          const scheduleRetry = deps.scheduleGitSeedRetry ?? defaultScheduleGitSeedRetry;
          scheduleRetry(record, () => restoreDeferred(record));
        }
      } catch (e) {
        console.warn(
          `[papercusp-hive] post-admission git seed restore failed (non-fatal; cold clone): ${(e as Error)?.message ?? e}`,
        );
      }
    }

    return joinRes.state === 'joined'
      ? { state: 'cloned-and-created', slug: joinRes.slug }
      : {
          state: 'skipped',
          slug: joinRes.slug,
          reason: joinRes.reason,
          ...(joinRes.retryable ? { retryable: true } : {}),
        };
  }

  // 2. Resolve the repo: a local checkout (dev box / a prior clone on PATH) wins;
  //    otherwise CLONE the dogfood repo (packaged install). auth_required just means
  //    "gh isn't signed in yet" — no-op and let the next boot retry.
  let root = detectRoot();
  let cloned = false;
  if (root) {
    // Local checkout → nothing to download; the hive is ready immediately.
    record('clone', 'done', { detail: 'local checkout' });
  } else {
    record('clone', 'running', { percent: 0 });
    // Throttle the percent stream — forward only on a >=2pt move or phase change.
    let lastPct = -1;
    let lastPhase = '';
    const res = await clone(PAPERCUP_DOGFOOD_REPO_URL, {
      destName: PAPERCUSP_HIVE_SLUG,
      shallow,
      ...(ref ? { ref } : {}),
      timeoutMs: 60 * 60 * 1000, // 1h — a multi-GB private clone is slow.
      onProgress: ({ phase, percent }) => {
        if (phase === lastPhase && Math.abs(percent - lastPct) < 2) return;
        lastPhase = phase;
        lastPct = percent;
        record('clone', 'running', {
          percent,
          detail: phase === 'receiving' ? 'downloading' : 'resolving',
        });
      },
    });
    if (isCloneError(res)) {
      // A prior (complete) clone is already on disk → adopt it rather than refusing.
      if (res.code === 'dest_exists') {
        root = join(defaultClonesDir(), PAPERCUSP_HIVE_SLUG);
        cloned = true;
        record('clone', 'done', { detail: 'adopted existing clone' });
      } else if (res.code === 'auth_required') {
        // Not a failure — GitHub just isn't signed in yet. Keep the clone step at
        // 0% `running` with the sign-in prompt (banner stays visible, no error),
        // and skip; the wizard's GitHub step re-triggers the bootstrap after sign-in.
        record('clone', 'running', { percent: 0, detail: AWAITING_GH_SIGNIN_DETAIL });
        return { state: 'skipped', slug: null, reason: 'clone auth_required: awaiting GitHub sign-in' };
      } else {
        // Log the REAL failure (code + git's message) — the progress row only
        // carries the short code, so without this the operator log had no record
        // of WHY a fresh-machine clone failed (cost a full live debugging round
        // on the owner's Mac VM, 2026-06-25). `git_missing` on macOS is the
        // CLT-stub case (no bundled git); its message carries the install hint.
        console.warn(`[papercusp-hive] clone failed: ${res.code} — ${res.message}`);
        record('clone', 'error', { detail: res.code });
        return { state: 'skipped', slug: null, reason: `clone ${res.code}: ${res.message}`.slice(0, 200) };
      }
    } else {
      root = res.path;
      cloned = true;
      record('clone', 'done');
    }
  }

  // 2b. Solution C (flag-gated, default-on/reversible): adopt the owner's SHARED hive identity
  //     from their per-owner private gist BEFORE create, so the hive is created
  //     under the OWNER's identity (one federation topic across their devices)
  //     rather than a fresh per-device one. No-op when the flag is off / gh unauth /
  //     no gist yet (then this device is the creator and publishes it in step 4b).
  // BEST-EFFORT (EI-3548): adopting the owner's shared identity hits the GitHub
  // API (per-owner gist read). A transient timeout here must degrade to "this
  // device is the creator" (null), never reject the whole bootstrap.
  let sharedState: SharedHiveState | null = null;
  try {
    sharedState = await adoptShare();
  } catch (e) {
    console.warn(
      `[papercusp-hive] adoptShare failed (non-fatal; creating per-device): ${(e as Error)?.message ?? e}`,
    );
  }

  // 3. Create the single `papercusp` hive linked to the repo in place.
  const hiveRes = await ensureHive({ pathOverride: root });
  if (hiveRes.state === 'skipped') {
    record('clone', 'error', { detail: hiveRes.reason ?? 'hive create failed' });
    return { state: 'skipped', slug: null, path: root, reason: hiveRes.reason };
  }

  // 4. Make papercusp-workspace the home so the hive is VISIBLE (see header).
  setHome(PAPERCUSP_WORKSPACE_ID);

  // 4b. Solution C (flag-gated): go shared — publish the per-owner identity gist
  //     (first device only), announce on the invite topic (go-live on the
  //     federation topic), and set the owner-only allowlist policy. No-op when
  //     sharedState is null (sharing skipped this boot).
  // BEST-EFFORT (EI-3548): a GitHub-API timeout publishing the gist / announcing
  // must not fail a setup whose hive + workspace already landed — warn, proceed.
  await bestEffortShare('goShare', () => goShare(sharedState));

  // 5. Submodules. A fresh clone fills them in the BACKGROUND (non-blocking) and
  //    records the terminal `submodules` step when done — that (plus the hive
  //    existing) is what the setup-finish gate waits on. A local checkout has no
  //    submodule phase, so mark it skipped → the gate is already satisfied.
  if (cloned) {
    startSubmodulePhase(root);
  } else {
    record('submodules', 'skipped', { detail: 'local checkout' });
  }

  return {
    state: cloned
      ? 'cloned-and-created'
      : hiveRes.state === 'already-present'
        ? 'already-present'
        : 'newly-created',
    slug: PAPERCUSP_HIVE_SLUG,
    path: root,
  };
}
