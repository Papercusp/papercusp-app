/**
 * git-sync-reconcile — boot-time reconcile/backfill of `system:git-sync`
 * routine rows for hive MEMBER checkouts (git-sync-any-hive-2026-06-12 P-004).
 *
 * Hives created BEFORE the seeding sites existed (B-01's creator-side
 * producers, B-03's join path) — and any member that slipped past them — have
 * registered member clones but no routine row, so they never sync. This sweep
 * walks one workspace's registry and seeds the MISSING rows only:
 *
 *   - Scope: hive MEMBERS only (`hive_slug || joined_via_link || (remote_hive &&
 *     self_repo)`). `papercup` itself carries none of these — its hand-tuned row
 *     is never even visited. Hive HOMES and repo-less joiner-side `remote_hive`
 *     VIEWS carry no `hive_slug` either. Bare invite-LINK joins (EI-1623) carry
 *     no `hive_slug` but DO carry `joined_via_link` (no local hive home exists)
 *     — they are included here and seeded joiner-side, so a failed best-effort
 *     join-time seed is backfilled. Release-install canonical clones (EI-8793)
 *     are `remote_hive` + `self_repo` (the self-admitted entry whose path IS the
 *     seeded checkout) — included and seeded joiner-side, so installs that
 *     self-admitted before the join-time seeding hook existed heal at next boot.
 *     Member-shaped entries that are still not syncable (vanished path, cloud
 *     deployment, non-repo) are excluded by the spine's eligibility gate.
 *   - ADD-only: an existing routine row — human-edited `active`/config
 *     included — is NEVER mutated (the spine's `routine_exists` skip, reported
 *     here as `already_seeded`). Flipping active/config is a human/tool
 *     action, not reconciliation.
 *   - Joiner detection: a member whose HOME entry (`projects.find(p =>
 *     p.slug === member.hive_slug)`) carries `remote_hive: true` is a
 *     joiner-side clone ⇒ the spine seeds it ACTIVE (D-008) with push:false
 *     (a local commit+fetch+merge mirror, no push — B-02 semantics); otherwise
 *     creator-side semantics apply.
 *
 * Per-member seeding COMPOSES `seedGitSyncRoutineForMember` (git-sync-routine.ts)
 * — eligibility gate, non-clobber idempotency, probe→decider push, jittered
 * cron, branch from registry coords all live there; this module only owns the
 * walk + the joiner detection. IO is seam-injected (registry load, sql, the
 * spine itself) so the sweep unit-tests without PG — the house pattern
 * (cf. lib/hive-member-repos.ts).
 *
 * The boot trigger (`ensureGitSyncRoutinesReconciledOnce`) follows the
 * `ensureRepoCoordsRevalidatedOnce` posture (harness/revalidate-repo-coords.ts):
 * module-level once-flag + detached fire-and-forget + never throws, called from
 * boot-all's post-boot hygiene block via lazy import — a reconcile failure must
 * never wedge boot, and it adds nothing to cold-start when there are no hives.
 */

import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { loadHarnessRegistry, type HarnessRegistry } from '../../harness-registry';
import { seedGitSyncRoutineForMember, getGitSyncRoutine } from './git-sync-routine';
import { gitSyncEligibility, type GitSyncEligibility } from './git-sync-eligibility';
import type { ProjectEntry } from '../../harness-registry';

export interface ReconcileGitSyncOpts {
  /** Owning workspace_id (routines.workspace_id is NOT NULL, no default). */
  workspaceId: string;
  /** Registry snapshot loader (default loadHarnessRegistry) — test seam. */
  loadRegistry?: (workspaceId?: string) => Promise<HarnessRegistry>;
  /** PG handle forwarded to the seeding spine + the P-014 detection read
   *  (default: the spine's getOrgPg). */
  sql?: Sql;
  /** The per-member seeding spine (default seedGitSyncRoutineForMember) — test seam. */
  seedMember?: typeof seedGitSyncRoutineForMember;
  /** P-014 detection seams: eligibility verdict (default gitSyncEligibility) +
   *  routine-row reader (default getGitSyncRoutine). */
  eligibility?: (p: ProjectEntry) => GitSyncEligibility;
  getRoutine?: typeof getGitSyncRoutine;
}

export interface ReconcileGitSyncResult {
  /** Member slugs whose routine row this sweep CREATED. */
  seeded: string[];
  /** Members visited but not seeded: `already_seeded` (row exists — never
   *  clobbered), `ineligible:<reason>` (B-01's verdict), `error:<message>`
   *  (the spine's folded failure). Non-members never appear. */
  skipped: Array<{ slug: string; reason: string }>;
  /** P-014 blind-spot DETECTION: NON-member registered checkouts (no `hive_slug`)
   *  that ARE git-sync-eligible (a real local repo) yet carry NO routine row —
   *  i.e. an eligible-but-unseeded registered repo that would silently never
   *  sync. The reconcile does NOT auto-seed these (a non-member checkout is not
   *  assumed wanted-synced — that's a human/owner call); it SURFACES them so a
   *  NEW registered-checkout path that forgets to seed at creation is caught
   *  instead of vanishing. `papercup` (hand-tuned row) and any other repo with a
   *  routine are excluded; hive HOMES / `remote_hive` VIEWS / non-repos are
   *  ineligible and never appear. */
  unseeded: string[];
  /** Set when the sweep itself failed before walking members (registry load
   *  blew up). Reported, never thrown. */
  error?: string;
}

/**
 * Idempotent add-only sweep of one workspace's hive members. Never throws:
 * a registry-load failure folds into `result.error`, and per-member failures
 * fold into `skipped` (the spine never throws).
 */
export async function reconcileGitSyncRoutines(
  opts: ReconcileGitSyncOpts,
): Promise<ReconcileGitSyncResult> {
  const result: ReconcileGitSyncResult = { seeded: [], skipped: [], unseeded: [] };
  let projects: HarnessRegistry['projects'];
  try {
    const reg = await (opts.loadRegistry ?? loadHarnessRegistry)(opts.workspaceId);
    projects = reg.projects ?? [];
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    return result;
  }

  // Members = `hive_slug` entries (creator-side + joinHiveAsView joiners) PLUS
  // bare invite-LINK joins (EI-1623), which carry `joined_via_link` instead of a
  // `hive_slug` (they have no local hive home), PLUS release-install canonical
  // clones (EI-8793): a self-admitted `remote_hive` entry whose path IS the real
  // seeded checkout, marked `self_repo` (bootstrap-papercusp-hive
  // defaultSelfAdmitCanonical). All three must be (re)seeded — the third is what
  // backfills EXISTING release installs (self-admitted before the seeding hook
  // existed) on their next boot; without it the install's self-improvement loop
  // never commits (confirmed live on the 0.0.3 Mac install, 2026-07-09).
  const isGitSyncMember = (p: ProjectEntry): boolean =>
    Boolean(p.hive_slug || p.joined_via_link || (p.remote_hive && p.self_repo));
  const members = projects.filter(isGitSyncMember);
  const seed = opts.seedMember ?? seedGitSyncRoutineForMember;
  for (const member of members) {
    const home = projects.find((p) => p.slug === member.hive_slug);
    // A link-join (`joined_via_link`) is ALWAYS joiner-side: it cloned someone
    // else's repo with no local home, so it must seed push:false (D-002/D-007 —
    // fork-PR is the contribution path), never creator-side. A `remote_hive` home
    // marks the other (joinHiveAsView) joiner case; a `remote_hive` entry that is
    // ITSELF the member (the self_repo release-install clone) is likewise always
    // joiner-side — this box is a peer, never the origin pusher.
    const joinerSide =
      home?.remote_hive === true || member.joined_via_link === true || member.remote_hive === true;
    const outcome = await seed(
      {
        workspaceId: opts.workspaceId,
        installSlug: member.slug,
        entry: member,
        joinerSide,
        // Joiner-side: salt the cron jitter per install — the same member slug
        // exists on N peer boxes on a shared hive (B-03's cronKey, D-004).
        ...(joinerSide ? { cronKey: `${member.slug}:${opts.workspaceId}` } : {}),
      },
      opts.sql ? { sql: opts.sql } : undefined,
    );
    if (outcome.seeded) {
      result.seeded.push(member.slug);
    } else if (outcome.reason === 'routine_exists') {
      result.skipped.push({ slug: member.slug, reason: 'already_seeded' });
    } else if (outcome.reason === 'ineligible') {
      result.skipped.push({ slug: member.slug, reason: `ineligible:${outcome.ineligibleReason}` });
    } else {
      result.skipped.push({ slug: member.slug, reason: `error:${outcome.message}` });
    }
  }

  // ── P-014 blind-spot detection ───────────────────────────────────────────
  // The member loop above visits `hive_slug` members + `joined_via_link` link-joins
  // (the EI-382/EI-1623 classes — seeded at join AND backfilled here). A NEW
  // registered-checkout path that is NEITHER a hive member NOR a link-join AND
  // isn't seeded at creation would sit here forever,
  // silently un-synced, with nothing surfacing it. Detect it: any NON-member
  // checkout that IS git-sync-eligible (a real local repo) but carries NO
  // routine row is an eligible-but-unseeded registered repo — record it in
  // `unseeded` (the boot trigger logs it). We do NOT auto-seed (a non-member is
  // not assumed wanted-synced); this is an ALARM, not an action. `papercup`'s
  // hand-tuned row + any seeded repo are excluded (a routine exists); hive
  // homes / remote_hive views / non-repos are ineligible and never appear.
  const eligibility = opts.eligibility ?? gitSyncEligibility;
  const getRoutine = opts.getRoutine ?? getGitSyncRoutine;
  let detectSql: Sql | null = opts.sql ?? null;
  if (!detectSql && !opts.getRoutine) {
    // No injected sql/reader — resolve the live handle, but tolerate its
    // absence (unit tests that mock db-org to throw simply skip detection;
    // the member loop carries its own sql via the spine).
    try {
      detectSql = getOrgPg().sql;
    } catch {
      detectSql = null;
    }
  }
  if (detectSql != null || opts.getRoutine != null) {
    for (const p of projects) {
      if (isGitSyncMember(p)) continue; // members (incl. link-joins + self_repo remote-hive clones) are handled (+ seeded) above
      if (!eligibility(p).eligible) continue; // homes / views / non-repos / vanished paths
      try {
        const existing = await getRoutine(detectSql as Sql, p.slug);
        if (!existing) result.unseeded.push(p.slug);
      } catch {
        // best-effort — a per-row read blip never fails the sweep
      }
    }
  }

  return result;
}

// ── Once-per-process boot trigger ───────────────────────────────────────────
// The `ensureRepoCoordsRevalidatedOnce` posture (revalidate-repo-coords.ts):
// module-level flag + fire-and-forget; a repeat bootAllHarnessesForActiveWorkspace()
// pass (the retry path) no-ops.

let _reconciledOnce = false;

/**
 * Fire the reconcile sweep once per process for the given workspaces,
 * detached. Synchronous + void: the caller never awaits it, and
 * `reconcileGitSyncRoutines` never throws, so this can NEVER block or fail
 * boot. Quiet at steady state — logs only when rows were seeded or something
 * failed. `seams` is the test seam; the boot site passes nothing.
 */
export function ensureGitSyncRoutinesReconciledOnce(
  workspaceIds: string[],
  seams?: Pick<ReconcileGitSyncOpts, 'loadRegistry' | 'sql' | 'seedMember' | 'eligibility' | 'getRoutine'>,
): void {
  if (_reconciledOnce) return;
  _reconciledOnce = true;
  void (async () => {
    for (const workspaceId of workspaceIds) {
      const r = await reconcileGitSyncRoutines({ workspaceId, ...seams });
      if (r.error) {
         
        console.warn(`[git-sync-reconcile] sweep failed for workspace '${workspaceId}': ${r.error}`);
      } else if (r.seeded.length || r.unseeded.length || r.skipped.some((s) => s.reason.startsWith('error:'))) {
         
        console.log(
          `[git-sync-reconcile] boot sweep (${workspaceId}): seeded=[${r.seeded.join(', ')}]` +
            // P-014: an eligible-but-unseeded registered repo is a blind-spot
            // ALARM — a registered checkout that would silently never sync.
            (r.unseeded.length ? ` ⚠ eligible-but-UNSEEDED=[${r.unseeded.join(', ')}]` : '') +
            (r.skipped.length
              ? ` skipped=${r.skipped.map((s) => `${s.slug}:${s.reason}`).join(', ')}`
              : ''),
        );
      }
    }
  })().catch((e) => {
    // unreachable (reconcileGitSyncRoutines never throws) — belt and braces
     
    console.warn(
      `[git-sync-reconcile] boot sweep crashed: ${e instanceof Error ? e.message : String(e)}`,
    );
  });
}

/** Test seam: drop the once-flag so the next ensure call re-runs. */
export function __resetGitSyncReconcileForTests(): void {
  _reconciledOnce = false;
}
