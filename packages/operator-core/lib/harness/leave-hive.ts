/**
 * leave-hive — the durable inverse of `joinHiveAsView` (join-hive.ts), for a
 * JOINER leaving a shared hive (shared-hive-hardening-2026-06-13 P-012).
 *
 * Before this there was NO joiner-side leave path: `pot:dissolve` is the OWNER
 * teardown of a LOCAL hive (clears the Queen wake, cancels bees, deregisters the
 * home harness) and does nothing about a joiner's federation / clones / routines /
 * presence. A joiner who wanted out had to hand-edit the registry, kill routines
 * by SQL, and hope the swarm topic closed — leaving orphaned git-sync routines
 * still committing, a stale swarm join still replicating, and dead presence rows.
 *
 * `leaveHive` composes the four teardown legs the join created, in the safe order
 * (stop the moving parts BEFORE removing the registry coords they read):
 *
 *   1. STOP FEDERATING — `closeBootedHarness` per member: leaves the Hive swarm
 *      topic, stops the presence-announce loop (a close-hook), and closes the
 *      per-harness corestore. The `remote_hive` view never booted (it never
 *      announces), so closing it is a no-op — called for symmetry.
 *   2. DELETE GIT-SYNC ROUTINES — `removeGitSyncRoutine` per member: the row is
 *      gone, not merely disabled (the member is about to be deregistered).
 *   3. DROP PRESENCE — delete this peer's `shared_presence` rows for each member
 *      harness locally. Cross-machine, a leaver's rows on OTHER peers age out by
 *      TTL (last_seen_at stops advancing once the announce loop stops); a
 *      federated presence tombstone is the real-hardware-gated enhancement
 *      (plan D-003) — presence has no published del-op today.
 *   4. DEREGISTER — one atomic registry mutate removes the `remote_hive` view +
 *      every member entry. Clone dirs on disk are KEPT by default (re-joinable,
 *      data-safe — mirrors pot:dissolve's default-keep schema); `deleteClones`
 *      also removes them.
 *
 * Idempotent + best-effort: every leg tolerates already-done (close no-ops when
 * not booted, routine delete no-ops when absent, registry removal no-ops when
 * absent), each failure folds into the returned `steps` report rather than
 * throwing, and a partial leave is fully re-runnable.
 */

import { rm } from 'node:fs/promises';

import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import {
  loadHarnessRegistry,
  mutateHarnessRegistry,
  type HarnessRegistry,
  type ProjectEntry,
} from '../harness-registry';
import { closeBootedHarness, getBootedHarness } from '../sync/hyperbee/boot-all';
import { publishPresenceTombstoneForHarness } from '../sync/hyperbee/wire-presence';
import { removeGitSyncRoutine } from './git-sync/git-sync-routine';
import { removeHiveMember } from '../hive-membership-store';
import { resolveFederatedPotScope } from '../federated-pot-scope';
import { resolveLocalGithubIdentity } from '../identity/resolve-local-github-identity';

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface LeaveHiveOpts {
  workspaceId: string;
  /** The `remote_hive` view slug to leave, OR a joined member slug whose home is
   *  a remote_hive view (you joined the hive, so you leave the whole hive). */
  slug: string;
  /** Also `rm -rf` each member's clone dir + the view dir from disk. Default
   *  false — keep the clones (re-joinable, data-safe; mirrors dissolve's
   *  default-keep). */
  deleteClones?: boolean;
  /** EI-469: ms to keep the swarms live AFTER publishing presence tombstones and
   *  BEFORE teardown, so connected peers pull the del. Default
   *  DEFAULT_LEAVE_DRAIN_MS; 0 disables (skipped anyway when nothing tombstoned).
   *  Best-effort (pull-based replication, no ack). */
  drainMs?: number;
}

export interface LeaveHiveMember {
  slug: string;
  /** Did a presence tombstone get published before close (false = not booted /
   *  no swarm / gh-unauthed — peers then fall back to TTL aging, EI-469). */
  presenceTombstoned: boolean;
  /** Did the federation handle close (false = wasn't booted — fine). */
  federationClosed: boolean;
  /** Did a git-sync routine row get deleted (false = none existed — fine). */
  routineRemoved: boolean;
  /** Local shared_presence rows deleted for this member harness. */
  presenceRowsDropped: number;
  /** Clone dir removed (only when deleteClones; null otherwise). */
  cloneDeleted?: boolean;
}

export interface LeaveHiveResult {
  ok: boolean;
  /** The resolved view slug (the hive that was left). */
  viewSlug?: string;
  /** True when there was nothing to leave (already gone) — still ok:true. */
  alreadyLeft?: boolean;
  members: LeaveHiveMember[];
  /** Whether the registry view entry was removed. */
  viewRemoved?: boolean;
  /** The leaver's resolved github_user_id (null = gh unauthed → membership row
   *  left to the owner's revoke / TTL; G27). */
  leaverGithubUserId?: number | null;
  /** hive_members admission rows deleted for the leaver (G27). 0 = not a member /
   *  already gone / unresolved identity. The DELETE fires the mig-189 capture
   *  trigger → a federated `del` membership tombstone. */
  membershipRowsDropped?: number;
  error?: string;
}

export interface LeaveHiveDeps {
  loadRegistry?: typeof loadHarnessRegistry;
  mutateRegistry?: typeof mutateHarnessRegistry;
  /** PG handle for routine + presence deletes (default: getOrgPg().sql). */
  sql?: Sql;
  /** Publish a presence tombstone for one member BEFORE its handle closes, so
   *  peers drop the leaver's presence row at once instead of by TTL (EI-469).
   *  Default: getBootedHarness → publishPresenceTombstoneForHarness. Returns
   *  false when not booted / no swarm / gh-unauthed (best-effort). */
  tombstonePresence?: (workspaceId: string, slug: string) => Promise<boolean>;
  /** Stop federating one harness (default closeBootedHarness). */
  closeHandle?: (workspaceId: string, slug: string) => Promise<boolean>;
  /** Delete one harness's git-sync routine (default removeGitSyncRoutine). */
  removeRoutine?: (sql: Sql, installSlug: string) => Promise<boolean>;
  /** Delete a harness's local shared_presence rows; returns rows deleted
   *  (default: inline DELETE). */
  dropPresence?: (sql: Sql, workspaceId: string, harnessSlug: string) => Promise<number>;
  /** Resolve the LEAVING peer's own github_user_id, to delete their persistent
   *  hive_members admission row (G27). Default: resolveLocalGithubIdentity →
   *  githubUserId, or null when gh isn't authed (then membership cleanup is
   *  skipped — best-effort; the owner's revoke / TTL is the backstop). */
  resolveLeaverGithubUserId?: () => Promise<number | null>;
  /** Delete the leaver's hive_members admission row for the hive; returns rows
   *  deleted (default: removeHiveMember). The DELETE fires the mig-189 capture
   *  trigger → a federated `del` membership tombstone. */
  dropMembers?: (
    sql: Sql,
    workspaceId: string,
    potHomeSlug: string,
    githubUserId: number,
  ) => Promise<number>;
  /** rm -rf a clone dir (default fs.rm recursive force). */
  rmDir?: (path: string) => Promise<void>;
  /** Sleep for the EI-469 drain window (test seam; default setTimeout). */
  sleep?: (ms: number) => Promise<void>;
}

/** Default leave drain window (EI-469): keep swarms live this long after the
 *  tombstones so connected peers pull the del before teardown. A few seconds is
 *  ample on a LAN; a user-facing leave can absorb it. Override via opts.drainMs. */
export const DEFAULT_LEAVE_DRAIN_MS = 3000;

/** Default presence-tombstone: publish a `del` on the leaver's presence key via
 *  the still-live booted handle (EI-469). No-op (false) when not booted. */
async function defaultTombstonePresence(workspaceId: string, slug: string): Promise<boolean> {
  const handle = getBootedHarness(workspaceId, slug);
  if (!handle) return false;
  return publishPresenceTombstoneForHarness(handle);
}

async function defaultDropPresence(
  sql: Sql,
  workspaceId: string,
  harnessSlug: string,
): Promise<number> {
  const res = await sql`
    DELETE FROM harness_shared.shared_presence
     WHERE workspace_id = ${workspaceId}
       AND harness_slug = ${harnessSlug}
  `;
  return Number((res as unknown as { count?: number }).count ?? 0);
}

// ── The composition ──────────────────────────────────────────────────────────

export async function leaveHive(
  opts: LeaveHiveOpts,
  deps: LeaveHiveDeps = {},
): Promise<LeaveHiveResult> {
  const loadRegistry = deps.loadRegistry ?? loadHarnessRegistry;
  const mutateRegistry = deps.mutateRegistry ?? mutateHarnessRegistry;
  const tombstone = deps.tombstonePresence ?? defaultTombstonePresence;
  const closeHandle = deps.closeHandle ?? closeBootedHarness;
  const removeRoutine = deps.removeRoutine ?? removeGitSyncRoutine;
  const dropPresence = deps.dropPresence ?? defaultDropPresence;
  const rmDir = deps.rmDir ?? ((p: string) => rm(p, { recursive: true, force: true }));
  // G27 membership-teardown seams: resolve the leaver's own github id (default: the
  // local gh identity, null when gh-unauthed) and delete their hive_members admission
  // row (default: removeHiveMember, which fires the mig-189 capture trigger → a
  // federated `del` tombstone).
  const resolveLeaverId =
    deps.resolveLeaverGithubUserId ??
    (async () => {
      const ident = await resolveLocalGithubIdentity();
      return ident.kind === 'ok' ? ident.githubUserId : null;
    });
  const dropMembers =
    deps.dropMembers ??
    // ⚠ SCOPE (WI-6312): `home` is derived from the LOCAL registry, but pot_members rows are
    // written under the FEDERATED scope. Under the local handle this deletes 0 rows and
    // returns 0 — which is indistinguishable from the idempotent "already gone", so a leave
    // that never actually happened reads as a clean one. Fails open to `home` on the owner.
    (async (s: Sql, ws: string, home: string, uid: number) =>
      removeHiveMember(ws, await resolveFederatedPotScope(ws, home), uid, s));

  let reg: HarnessRegistry;
  try {
    reg = await loadRegistry(opts.workspaceId);
  } catch (e) {
    return { ok: false, members: [], error: e instanceof Error ? e.message : String(e) };
  }
  const projects = reg.projects ?? [];

  // Resolve the view slug we're leaving. Either the slug IS a remote_hive view,
  // or it's a joined member whose home is one (leave the whole hive). A partial
  // prior leave may have removed the view but left orphaned members — so also
  // resolve when the slug only matches members' hive_slug.
  const directView = projects.find((p) => p.slug === opts.slug && p.remote_hive === true);
  const asMember = projects.find((p) => p.slug === opts.slug && p.hive_slug);
  let viewSlug: string | null = null;
  if (directView) {
    viewSlug = directView.slug;
  } else if (asMember?.hive_slug) {
    const home = projects.find((p) => p.slug === asMember.hive_slug);
    // Accept when the home is a remote_hive view (the joiner case) OR the home
    // entry is already gone (orphaned member from a partial leave).
    if (!home || home.remote_hive === true) viewSlug = asMember.hive_slug;
  } else if (projects.some((p) => p.hive_slug === opts.slug)) {
    // The slug names a (now view-less) hive_slug carried by orphaned members.
    viewSlug = opts.slug;
  }

  if (!viewSlug) {
    // Nothing here matches a joined hive. Distinguish "already left" (truly
    // nothing) from "wrong target" (a local-owned harness — use pot:dissolve).
    const localOwned = projects.find((p) => p.slug === opts.slug);
    if (localOwned) {
      return {
        ok: false,
        members: [],
        error:
          `'${opts.slug}' is not a joined hive (no remote_hive view / member). ` +
          'If it is a LOCAL hive you own, use pot:dissolve instead.',
      };
    }
    return { ok: true, alreadyLeft: true, members: [], viewRemoved: false };
  }

  const memberEntries = projects.filter((p) => p.hive_slug === viewSlug);
  const viewEntry = projects.find((p) => p.slug === viewSlug);
  if (memberEntries.length === 0 && !viewEntry) {
    return { ok: true, viewSlug, alreadyLeft: true, members: [], viewRemoved: false };
  }

  const sql = deps.sql ?? getOrgPg().sql;
  const memberPathBySlug = new Map<string, string | undefined>(
    memberEntries.map((m) => [m.slug, m.path]),
  );
  const members: LeaveHiveMember[] = memberEntries.map((m) => ({
    slug: m.slug,
    presenceTombstoned: false,
    federationClosed: false,
    routineRemoved: false,
    presenceRowsDropped: 0,
  }));

  // PASS 1 (EI-469) — publish presence tombstones for EVERY member while their
  // swarms are still live, BEFORE any teardown. Best-effort.
  for (const out of members) {
    try {
      out.presenceTombstoned = await tombstone(opts.workspaceId, out.slug);
    } catch {
      /* best-effort — not booted / no swarm / gh-unauthed; TTL is the backstop */
    }
  }

  // PASS 1.5 (G27) — delete the LEAVER's persistent hive_members admission row so a
  // departure cleans MEMBERSHIP, not just presence. The DELETE fires the mig-189
  // capture trigger → a `del` op into substrate_outbox, enqueued NOW (before the
  // drain) so the SAME EI-469 window below flushes the membership tombstone alongside
  // the presence ones. Identity-gated + best-effort: gh-unauthed → skip (the owner's
  // revoke / TTL is the backstop); 0 rows when not a member / already gone (idempotent).
  let leaverGithubUserId: number | null = null;
  let membershipRowsDropped = 0;
  try {
    leaverGithubUserId = await resolveLeaverId();
    if (leaverGithubUserId != null) {
      membershipRowsDropped = await dropMembers(sql, opts.workspaceId, viewSlug, leaverGithubUserId);
    }
  } catch (e) {
    console.warn(
      `[leaveHive] hive_members teardown for ${viewSlug} failed (leave unaffected): ${
        e instanceof Error ? e.message : e
      }`,
    );
  }

  // DRAIN (EI-469) — a single bounded window keeping the swarms live so connected
  // peers' pull-based read-merge fetches the tombstones before we tear down.
  // Skipped when nothing was tombstoned (no peers to wait for) or drainMs<=0.
  // Replication here is PULL-based with no delivery ack, so this is a best-effort
  // window, NOT a guarantee — a peer that hasn't pulled falls back to the TTL
  // (today's behavior). Tuning this window under real latency is the only part
  // that needs two real machines (plan D-003); the federation path itself is
  // proven in-process (leave-hive-tombstone-federation.integration.test.ts).
  const drainMs = opts.drainMs ?? DEFAULT_LEAVE_DRAIN_MS;
  if (drainMs > 0 && members.some((m) => m.presenceTombstoned)) {
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    await sleep(drainMs);
  }

  // PASS 2 — per member: stop federating, delete routine, drop local presence.
  for (const out of members) {
    try {
      out.federationClosed = await closeHandle(opts.workspaceId, out.slug);
    } catch {
      /* best-effort — not booted / already closed */
    }
    try {
      out.routineRemoved = await removeRoutine(sql, out.slug);
    } catch {
      /* best-effort — no row / PG blip; re-runnable */
    }
    try {
      out.presenceRowsDropped = await dropPresence(sql, opts.workspaceId, out.slug);
    } catch {
      /* best-effort — re-runnable */
    }
  }
  // The view itself never booted/announced, but close for symmetry (no-op).
  try {
    await closeHandle(opts.workspaceId, viewSlug);
  } catch {
    /* no-op */
  }

  // 4 — deregister the view + every member in ONE atomic mutate (load→push→save
  // per-slug would race a concurrent registry write — EI-82).
  const toRemove = new Set<string>([viewSlug, ...memberEntries.map((m) => m.slug)]);
  let viewRemoved = false;
  try {
    await mutateRegistry((cur: HarnessRegistry) => {
      const next = cur.projects.filter((p: ProjectEntry) => !toRemove.has(p.slug));
      viewRemoved = next.length !== cur.projects.length && !next.some((p) => p.slug === viewSlug);
      return { ...cur, projects: next };
    }, opts.workspaceId);
  } catch (e) {
    return {
      ok: false,
      viewSlug,
      members,
      error: `deregister failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // 5 — optional clone-dir removal (default keep — re-joinable, data-safe).
  if (opts.deleteClones) {
    for (const m of members) {
      const path = memberPathBySlug.get(m.slug);
      if (!path) {
        m.cloneDeleted = false;
        continue;
      }
      try {
        await rmDir(path);
        m.cloneDeleted = true;
      } catch {
        m.cloneDeleted = false;
      }
    }
    if (viewEntry?.path) {
      try {
        await rmDir(viewEntry.path);
      } catch {
        /* best-effort */
      }
    }
  }

  return { ok: true, viewSlug, members, viewRemoved, leaverGithubUserId, membershipRowsDropped };
}
