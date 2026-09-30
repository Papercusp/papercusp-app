/**
 * addHarnessToPot — make a harness a MEMBER of a Pot
 * (shared-hive-federation-2026-06-08 P-004 follow-up / D-010 gap-closer).
 *
 * Sets `ProjectEntry.hive_slug` on a member harness so its substrate federates
 * over the POT topic (resolvePotSwarmBinding), with `harness_slug` staying the
 * within-Pot component scope (D-003). This is the missing PRODUCER for hive_slug
 * the P-004 work flagged: until something sets it, a Pot has only its home and no
 * members. Membership is the registry edit ONLY — it never moves the harness folder
 * or its run data (cf. harness:membership).
 *
 * Contributor/device admission to the Pot (hive_members, P-006) is a SEPARATE
 * concern — a person joins via the Pot swarm + admission gate; this adds a member
 * HARNESS whose work federates within the Pot.
 *
 * Idempotent (re-adding to the same Pot is a no-op success). Pure over injectable
 * registry seams so it unit-tests without PG.
 *
 * git-sync-any-pot B-01: a successful add ALSO seeds the member's
 * `system:git-sync` routine (best-effort, never fails the add) — the harness
 * pre-exists here and may lack github coords, so the seeder's eligibility check
 * decides; an existing routine row is never clobbered (the seeder checks
 * getGitSyncRoutine first), so a re-add can heal a missing routine without
 * touching a human-edited one.
 */
import {
  loadHarnessRegistry as realLoad,
  saveHarnessRegistry as realSave,
  type HarnessRegistry,
  type ProjectEntry,
} from '../../harness-registry';
import type {
  SeedGitSyncRoutineOpts,
  SeedGitSyncRoutineOutcome,
} from '../../harness/git-sync/git-sync-routine';
import { POT_KIND } from './_resolve';

export interface AddPotMemberOpts {
  workspaceId: string;
  /** The Pot's home_slug — a `kind:'hive'` harness that owns the Pot identity. */
  potHomeSlug: string;
  /** The member harness slug to add to the Pot. */
  memberHarnessSlug: string;
}

export interface AddPotMemberResult {
  ok: boolean;
  error?:
    | 'hive_not_found'
    | 'harness_not_found'
    | 'is_hive_home'
    | 'self'
    | 'already_member_elsewhere';
  message?: string;
  potHomeSlug?: string;
  memberHarnessSlug?: string;
  /** True when the membership was newly set; false when it already held (idempotent). */
  changed?: boolean;
  /** git-sync-any-pot B-01: outcome of seeding the member's `system:git-sync`
   *  routine (only on success paths). Best-effort — never fails the add. */
  gitSync?: SeedGitSyncRoutineOutcome;
}

export interface AddPotMemberSeams {
  loadRegistry?: (workspaceId: string) => Promise<HarnessRegistry>;
  saveRegistry?: (reg: HarnessRegistry, workspaceId: string) => Promise<void>;
  /** git-sync-any-pot B-01: seed the member's `system:git-sync` routine.
   *  Default: seedGitSyncRoutineForMember (lazy-imported — keeps this module
   *  PG-free for the registry-only unit tests). */
  seedGitSyncRoutine?: (opts: SeedGitSyncRoutineOpts) => Promise<SeedGitSyncRoutineOutcome>;
}

export async function addHarnessToPot(
  opts: AddPotMemberOpts,
  seams: AddPotMemberSeams = {},
): Promise<AddPotMemberResult> {
  const loadRegistry = seams.loadRegistry ?? realLoad;
  const saveRegistry = seams.saveRegistry ?? realSave;
  const ws = opts.workspaceId;

  if (opts.memberHarnessSlug === opts.potHomeSlug) {
    return { ok: false, error: 'self', message: 'a Pot home cannot be a member of itself' };
  }

  const reg = await loadRegistry(ws);

  const pot = reg.projects.find((p) => p.slug === opts.potHomeSlug && p.harness_kind === POT_KIND);
  if (!pot) {
    return { ok: false, error: 'hive_not_found', message: `no pot '${opts.potHomeSlug}' in this workspace` };
  }

  const member = reg.projects.find((p) => p.slug === opts.memberHarnessSlug);
  if (!member) {
    return { ok: false, error: 'harness_not_found', message: `no harness '${opts.memberHarnessSlug}' in this workspace` };
  }
  if (member.harness_kind === POT_KIND) {
    return {
      ok: false,
      error: 'is_hive_home',
      message: `'${opts.memberHarnessSlug}' is itself a Pot home — a Pot cannot be nested as another Pot's member`,
    };
  }
  if (member.hive_slug && member.hive_slug !== opts.potHomeSlug) {
    return {
      ok: false,
      error: 'already_member_elsewhere',
      message: `'${opts.memberHarnessSlug}' is already a member of pot '${member.hive_slug}' — remove it first`,
    };
  }
  // B-01: best-effort git-sync routine seeding for the (now-)member checkout.
  // Runs on BOTH success paths — a re-add heals a missing routine; an existing
  // row (possibly human-edited) is never clobbered (the seeder checks first).
  const seedGitSync = async (entry: ProjectEntry): Promise<SeedGitSyncRoutineOutcome> => {
    const seed =
      seams.seedGitSyncRoutine ??
      (async (o: SeedGitSyncRoutineOpts) =>
        (await import('../../harness/git-sync/git-sync-routine')).seedGitSyncRoutineForMember(o));
    try {
      return await seed({ workspaceId: ws, installSlug: entry.slug, entry, joinerSide: false });
    } catch (e) {
      return { seeded: false, reason: 'error', message: e instanceof Error ? e.message : String(e) };
    }
  };

  if (member.hive_slug === opts.potHomeSlug) {
    // Already a member — idempotent success (still consult the seeder: heal-only).
    return {
      ok: true,
      potHomeSlug: opts.potHomeSlug,
      memberHarnessSlug: opts.memberHarnessSlug,
      changed: false,
      gitSync: await seedGitSync(member),
    };
  }

  member.hive_slug = opts.potHomeSlug;
  await saveRegistry(reg, ws);
  return {
    ok: true,
    potHomeSlug: opts.potHomeSlug,
    memberHarnessSlug: opts.memberHarnessSlug,
    changed: true,
    gitSync: await seedGitSync(member),
  };
}

/**
 * Remove a harness from its Pot (clear `hive_slug`) — the inverse, so membership
 * is editable (and a harness can be re-pointed). Idempotent.
 */
export async function removeHarnessFromPot(
  opts: { workspaceId: string; memberHarnessSlug: string },
  seams: AddPotMemberSeams = {},
): Promise<{ ok: boolean; error?: 'harness_not_found'; changed?: boolean }> {
  const loadRegistry = seams.loadRegistry ?? realLoad;
  const saveRegistry = seams.saveRegistry ?? realSave;
  const reg = await loadRegistry(opts.workspaceId);
  const member = reg.projects.find((p) => p.slug === opts.memberHarnessSlug);
  if (!member) return { ok: false, error: 'harness_not_found' };
  if (!member.hive_slug) return { ok: true, changed: false };
  delete member.hive_slug;
  await saveRegistry(reg, opts.workspaceId);
  return { ok: true, changed: true };
}
