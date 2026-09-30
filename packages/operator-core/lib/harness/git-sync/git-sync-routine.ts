/**
 * Per-harness git-sync routine config (git-sync-auto-commit P-003). A harness's
 * git-sync schedule is a `harness_shared.routines` row with
 * target_role='system:git-sync' — these wrap db-org's routine primitives so the
 * schedule is editable as ordinary harness config (the routines:list/set tools +
 * the P-015 seed use these).
 *
 * Pass the owning `workspaceId` explicitly — `harness_shared.routines.workspace_id`
 * is NOT NULL with no column default and no fill trigger (there is no
 * `app.workspace_id` GUC trigger, despite earlier comments here that claimed one).
 */
import type { Sql } from 'postgres';
import { getOrgPg, upsertRoutine, setRoutineActive, deleteRoutine, type RoutineRow } from '@papercusp/db-org';
import type { ProjectEntry } from '../../harness-registry';
import { parseGithubUrl } from '../clone-github';
import { fetchRepoPushPermission } from '../github-repo-permissions';
import { computeNextFireAt } from '../routines/cron';
import { decideGitSyncPush, type PushDecision, type PushDecisionInput } from './decide-git-sync-push';
import { getPotGitMode, type PotGitMode } from './hive-git-mode';
import {
  gitSyncEligibility,
  gitSyncCronForKey,
  GIT_SYNC_SEED_ACTIVE_CREATOR,
  GIT_SYNC_SEED_ACTIVE_JOINER,
  type GitSyncEligibility,
  type IneligibleReason,
} from './git-sync-eligibility';

export const GIT_SYNC_ROUTINE_NAME = 'git-sync';
export const GIT_SYNC_TARGET = 'system:git-sync';
// Every 10 minutes — matches the live `papercup` cadence (trigger_config.cron); the
// superproject's branch is `staging` and lives in trigger_config, not here.
// Every 3 minutes (owner directive 2026-06-30, reverting an undocumented 3m→10m bump). Tighter
// cadence keeps staging fresh so a (force-)deploy ships current work, not a stale tree. The
// trade-off — more frequent commits = more index.lock contention across ~50 agents — is now
// safe because the stranding guard in run-git-sync.ts always runs the catch-all `git add -A`
// even when a per-agent commit loses an index.lock race, so a contended tick no longer orphans
// untracked files. (A manual `git-sync:run` lever exists for on-demand freshness too.)
export const DEFAULT_GIT_SYNC_CRON = '0 */3 * * * *';

export interface GitSyncRoutineInput {
  /** Owning workspace_id (routines.workspace_id is NOT NULL, no default). */
  workspaceId: string;
  installSlug: string;
  cron?: string;
  push?: boolean;
  pushSubmodules?: boolean;
  /**
   * Push SUBMODULE repos to THEIR OWN origins, independent of `push`
   * (EI-18689553108460319 / WI-6017). Omit ⇒ run-git-sync's own default
   * (follows `push`) applies — this is ONLY for the seed-time case where the
   * caller already knows the answer must be `true` despite `push:false`
   * (a bridged/p2p-only hive: the bridge writer owns the superproject's
   * canonical refs, never an independently-hosted submodule library — see
   * `seedGitSyncRoutineForMember`, which computes this from `hiveGitMode`).
   * Mirrors git-sync-action.ts's runtime override for a hive that flips
   * legacy→bridged mid-flight; this is the seed-time sibling for a member
   * whose hive is bridged/p2p-only from the very first seed.
   */
  pushSubmoduleOrigins?: boolean;
  /** Defaults INACTIVE when omitted; seed callers always pass it explicitly
   *  (D-008 ratified all-active, so seeded rows are active). */
  active?: boolean;
  /**
   * Superproject branch for the sync (git-sync-any-hive P-001) — written into
   * `trigger_config.branch`, which `configFromTrigger` (git-sync-action.ts)
   * already reads into the pipeline config. Omit ⇒ the pipeline's per-repo
   * default-branch resolution applies (cfg.branch ?? 'main' in the resolver
   * kickoff). Seed callers pass the member's `github_default_branch`.
   */
  branch?: string;
}

/** Create or update a harness's `system:git-sync` routine. */
export async function upsertGitSyncRoutine(sql: Sql, input: GitSyncRoutineInput): Promise<RoutineRow> {
  return upsertRoutine(
    sql,
    {
      workspaceId: input.workspaceId,
      installSlug: input.installSlug,
      name: GIT_SYNC_ROUTINE_NAME,
      triggerKind: 'cron',
      triggerConfig: {
        cron: input.cron ?? DEFAULT_GIT_SYNC_CRON,
        push: input.push ?? true,
        push_submodules: input.pushSubmodules ?? true,
        // WI-6017: only written when the caller has an explicit opinion — an
        // absent key lets run-git-sync's own default (follow `push`) apply,
        // same idiom as `branch` below.
        ...(input.pushSubmoduleOrigins !== undefined ? { pushSubmoduleOrigins: input.pushSubmoduleOrigins } : {}),
        ...(input.branch ? { branch: input.branch } : {}),
        // P-015: `merge_strategy` removed — it was read by nothing (configFromTrigger
        // never consumed it); the pipeline always merges (`git merge --no-edit`).
      },
      targetRole: GIT_SYNC_TARGET,
      active: input.active ?? false,
    },
    computeNextFireAt,
  );
}

/** Read a harness's git-sync routine, or null if none seeded. */
export async function getGitSyncRoutine(sql: Sql, installSlug: string): Promise<RoutineRow | null> {
  const rows = await sql<Array<Record<string, unknown>>>`
    SELECT * FROM harness_shared.routines
     WHERE install_slug = ${installSlug} AND target_role = ${GIT_SYNC_TARGET}
     LIMIT 1
  `;
  if (!rows.length) return null;
  const r = rows[0];
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id ?? ''),
    installSlug: String(r.install_slug),
    name: String(r.name),
    triggerKind: r.trigger_kind as RoutineRow['triggerKind'],
    triggerConfig: (r.trigger_config ?? {}) as RoutineRow['triggerConfig'],
    targetRole: String(r.target_role),
    payloadTemplate: (r.payload_template ?? null) as RoutineRow['payloadTemplate'],
    concurrency: r.concurrency as RoutineRow['concurrency'],
    catchup: r.catchup as RoutineRow['catchup'],
    tier: (r.tier as RoutineRow['tier']) ?? 'durable',
    active: Boolean(r.active),
    lastFiredAt: (r.last_fired_at ?? null) as Date | null,
    nextFireAt: (r.next_fire_at ?? null) as Date | null,
    // git-sync is a cron routine, never a loop — the loop fields are always null here.
    rescheduleIntervalSec: r.reschedule_interval_sec == null ? null : Number(r.reschedule_interval_sec),
    targetOwnerId: (r.target_owner_id ?? null) as string | null,
  };
}

/** Enable/disable a harness's git-sync routine (go-live = setGitSyncRoutineActive(sql, slug, true)). */
export async function setGitSyncRoutineActive(sql: Sql, installSlug: string, active: boolean): Promise<boolean> {
  return setRoutineActive(sql, installSlug, GIT_SYNC_ROUTINE_NAME, active);
}

/**
 * Delete a harness's `system:git-sync` routine row entirely — the durable inverse
 * of the seed (shared-hive-hardening-2026-06-13 P-012 leave path). Returns true
 * when a row was removed, false when none existed (idempotent: a re-run of a
 * partial leave no-ops). Distinct from `setGitSyncRoutineActive(false)`, which
 * keeps the row (disabled) — on LEAVE the member is deregistered, so the row
 * should be gone, not merely inactive.
 */
export async function removeGitSyncRoutine(sql: Sql, installSlug: string): Promise<boolean> {
  return deleteRoutine(sql, installSlug, GIT_SYNC_ROUTINE_NAME);
}

// ── Member seeding (git-sync-any-hive P-001/P-008, seed side) ──────────────────

export interface SeedGitSyncRoutineOpts {
  /** Owning workspace_id (routines.workspace_id is NOT NULL, no default). */
  workspaceId: string;
  installSlug: string;
  /** Registry snapshot of the member entry — eligibility + github coords input.
   *  Callers that just registered the member may synthesize it from the same
   *  fields they wrote (slug/path/hive_slug/github_* — cf. _create_from_repo). */
  entry: ProjectEntry;
  /** Joiner-side member clone? Creator-side producers pass false (the default).
   *  Drives both the P-005 active split and B-02's push decision. */
  joinerSide?: boolean;
  /**
   * Jitter key for `gitSyncCronForKey` (default: `installSlug`). On a SHARED
   * hive the same member slug exists on N peer boxes, so joiner-side callers
   * (B-03) salt per-install — `${installSlug}:${workspaceId}` — to keep peers
   * off the same minute offsets (D-004 origin-serialized multi-pusher).
   */
  cronKey?: string;
}

export interface SeedGitSyncRoutineDeps {
  sql?: Sql;
  eligibility?: (p: ProjectEntry) => GitSyncEligibility;
  /** B-02's permissions probe (default fetchRepoPushPermission — best-effort, never throws). */
  fetchPushPermission?: (owner: string, repo: string) => Promise<boolean | null>;
  /** B-02's push decider (default decideGitSyncPush — pure). */
  decidePush?: (i: PushDecisionInput) => PushDecision;
  /** github-bridge P-003: per-hive mode resolver (default getPotGitMode — reads
   *  the federated hive_settings; junk/absent/error all read as 'legacy'). */
  resolveHiveGitMode?: (workspaceId: string, potHomeSlug: string) => Promise<PotGitMode>;
  getRoutine?: typeof getGitSyncRoutine;
  upsert?: typeof upsertGitSyncRoutine;
}

export type SeedGitSyncRoutineOutcome =
  /** `upgraded` = an untouched machine-default coords-less row was re-seeded with coords (see below). */
  | { seeded: true; active: boolean; push: boolean; pushReason: string; cron: string; branch?: string; upgraded?: true }
  /** Not a syncable member checkout (hive home / remote view / cloud / no repo). */
  | { seeded: false; reason: 'ineligible'; ineligibleReason: IneligibleReason }
  /** A routine row already exists — NEVER clobbered (a human/peer may have edited it). */
  | { seeded: false; reason: 'routine_exists' }
  /** Anything threw (PG down, probe seam exploded, …) — reported, never rethrown. */
  | { seeded: false; reason: 'error'; message: string };

/**
 * Is this row EXACTLY what a coords-less creator-side seed would have written —
 * i.e. machine-default in every field a human (or a later coords-rich seed)
 * could have touched? Only such rows are safe to upgrade: any deviation means a
 * human/peer/migration wrote here and the non-clobber rule must win.
 */
function isUntouchedCoordslessCreatorSeed(row: RoutineRow, installSlug: string): boolean {
  const tc = (row.triggerConfig ?? {}) as Record<string, unknown>;
  return (
    row.active === GIT_SYNC_SEED_ACTIVE_CREATOR &&
    tc.push === false &&
    tc.push_submodules === true &&
    tc.branch === undefined &&
    tc.extra_lock_resources === undefined &&
    tc.cron === gitSyncCronForKey(installSlug)
  );
}

/**
 * Best-effort seed of one MEMBER checkout's `system:git-sync` routine — the one
 * composition behind the creator-side producers (pot:create_from_repo,
 * pot:add-member, harness:create { hive }) and B-03's joiner path. NEVER
 * throws and never fails the caller's create: every failure folds into the
 * returned outcome, which the calling tool reports in its result (the same
 * discipline as _create_from_repo's publish step).
 *
 * Behavior:
 *   - eligibility first (gitSyncEligibility, pure) — homes/views/cloud/non-repos
 *     are reported `ineligible` BEFORE any PG/network I/O is attempted;
 *   - idempotent — an existing routine row is never clobbered (getGitSyncRoutine
 *     first; a re-add/re-create reports `routine_exists` and leaves the row,
 *     including any human-edited `active`/config, intact) — with ONE carve-out:
 *     a creator-side re-seed that brings github coords UPGRADES a row that is
 *     still exactly the untouched machine-default coords-less shape (the
 *     from-repo double-seed ordering; see isUntouchedCoordslessCreatorSeed);
 *   - `push` from B-02: `hasUpstreamRemote` = the entry's registry-known
 *     `github_remote` (the seed-time signal; B-04's reconcile can revisit), with
 *     the GitHub permissions probe run only when it could change the answer
 *     (creator-side + upstream known — the decider short-circuits the rest);
 *   - `active` from the P-005 ratified default (D-008: all members seed active);
 *   - `cron` = gitSyncCronForKey(cronKey ?? installSlug) (deterministic jitter,
 *     D-004; joiner-side callers salt the key per-install — see `cronKey`);
 *   - `branch` = the entry's `github_default_branch` when present.
 */
export async function seedGitSyncRoutineForMember(
  opts: SeedGitSyncRoutineOpts,
  deps: SeedGitSyncRoutineDeps = {},
): Promise<SeedGitSyncRoutineOutcome> {
  try {
    const eligibility = deps.eligibility ?? gitSyncEligibility;
    const verdict = eligibility(opts.entry);
    if (!verdict.eligible) {
      return { seeded: false, reason: 'ineligible', ineligibleReason: verdict.reason ?? 'no_path' };
    }

    const sql = deps.sql ?? getOrgPg().sql;
    const getRoutine = deps.getRoutine ?? getGitSyncRoutine;
    const joinerSide = opts.joinerSide === true;
    const hasUpstreamRemote = Boolean(opts.entry.github_remote);

    // Coords-aware upgrade (the from-repo double-seed ordering, B-07's pinned
    // gap): `harness:create { hive }` seeds BEFORE the composition stamps github
    // coords, so the coords-rich seed at _create_from_repo step 7.25 used to
    // lose to non-clobber and the member synced commit-only forever. A re-seed
    // may upgrade a row iff (a) it carries strictly more information (creator
    // side + upstream remote known) and (b) the row is still byte-for-byte the
    // machine-default coords-less shape — anything a human touched stays kept.
    let upgrading = false;
    const existing = await getRoutine(sql, opts.installSlug);
    if (existing != null) {
      upgrading =
        !joinerSide && hasUpstreamRemote && isUntouchedCoordslessCreatorSeed(existing, opts.installSlug);
      if (!upgrading) return { seeded: false, reason: 'routine_exists' };
    }
    // github-bridge P-003 (S-5): resolve the hive's git mode — 'bridged'/'p2p-only'
    // force commit-only via the decider. Hive membership comes from `hive_slug`
    // (member checkouts) or the entry's own slug on a self_repo hive home (the
    // Option-B merged shape); a non-hive member is 'legacy' without a lookup.
    const potHomeSlug = opts.entry.hive_slug ?? (opts.entry.self_repo ? opts.entry.slug : undefined);
    let hiveGitMode: PotGitMode = 'legacy';
    if (potHomeSlug) {
      const resolveMode = deps.resolveHiveGitMode ?? getPotGitMode;
      hiveGitMode = await resolveMode(opts.workspaceId, potHomeSlug);
    }

    // Probe only when the answer can matter: rules 1-3 of the decider win
    // outright for fetch-less repos, bridged/p2p-only hives, and joiner clones.
    let permissionsPush: boolean | null = null;
    if (hasUpstreamRemote && !joinerSide && hiveGitMode === 'legacy') {
      const parsed = parseGithubUrl(opts.entry.github_remote!);
      if (parsed) {
        const probe = deps.fetchPushPermission ?? fetchRepoPushPermission;
        permissionsPush = await probe(parsed.owner, parsed.repo);
      }
    }
    const decide = deps.decidePush ?? decideGitSyncPush;
    const decision = decide({ joinerSide, hasUpstreamRemote, permissionsPush, hiveGitMode });

    const cron = gitSyncCronForKey(opts.cronKey ?? opts.installSlug);
    const active = joinerSide ? GIT_SYNC_SEED_ACTIVE_JOINER : GIT_SYNC_SEED_ACTIVE_CREATOR;
    const branch = opts.entry.github_default_branch;
    // WI-6017 (seed-time sibling of git-sync-action.ts's runtime hive-mode override):
    // a member seeded WHILE its hive is already bridged/p2p-only gets `push:false`
    // straight from decideGitSyncPush's hiveGitMode rule (2/2b) — never a true→false
    // flip — so git-sync-action's runtime override (`if (cfg.push && gate.hiveGitMode)`)
    // never fires for it and pushSubmoduleOrigins would stay unset, stranding its
    // submodules exactly like the original EI-18689553108460319 bug. Opt it back in
    // here, at seed time. NOT for a joiner: decideGitSyncPush's precedence checks
    // hiveGitMode BEFORE joinerSide, so a joiner joining an already-bridged hive also
    // gets reason 'bridged_hive' — but AH-6 (S0 no-direct-push) requires a joiner to
    // push NOTHING, anywhere, so joinerSide must win here even though the decider's
    // own reason string doesn't surface it.
    const pushSubmoduleOrigins =
      !joinerSide && (hiveGitMode === 'bridged' || hiveGitMode === 'p2p-only') ? true : undefined;
    const upsert = deps.upsert ?? upsertGitSyncRoutine;
    await upsert(sql, {
      workspaceId: opts.workspaceId,
      installSlug: opts.installSlug,
      cron,
      push: decision.push,
      active,
      ...(branch ? { branch } : {}),
      ...(pushSubmoduleOrigins !== undefined ? { pushSubmoduleOrigins } : {}),
    });
    return {
      seeded: true,
      active,
      push: decision.push,
      pushReason: decision.reason,
      cron,
      ...(branch ? { branch } : {}),
      ...(upgrading ? { upgraded: true as const } : {}),
    };
  } catch (e) {
    return {
      seeded: false,
      reason: 'error',
      message: (e instanceof Error ? e.message : String(e)).slice(0, 300),
    };
  }
}
