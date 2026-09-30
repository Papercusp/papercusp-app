/**
 * join-state-reconcile — boot-time self-heal for soft-failed joins
 * (shared-hive-hardening-2026-06-13 P-013).
 *
 * The 6-step Model B join (join-shared-harness.ts) marks `boot_federate` /
 * `await_admission_merge` `phase_0_pending` when the substrate can't reach a
 * peer within the timeout, and persists `~/.papercusp/join-state/<slug>.json`.
 *
 * CONFIRMED (the investigation behind this module): for a join whose clone got
 * REGISTERED, federation self-heals WITHOUT any re-drive —
 * `bootAllHarnessesForActiveWorkspace` boots every registered harness on the
 * next session, re-running `defaultResolveSwarmBinding` → re-joining the swarm,
 * and `await_admission_merge`'s phase_0 just means "no peer yet, the read-merge
 * loop admits one when it comes online." So the join-state record is COSMETIC
 * once the harness is registered — boot-all is the heal. We do NOT re-drive that
 * case (it isn't broken).
 *
 * The ONE residual boot-all does NOT heal: a join where REGISTRATION itself also
 * failed (both the pre-boot `mutateHarnessRegistry` and the route's post-join
 * `saveRegistry` blew up) — the clone sits on disk with a pending join-state but
 * is absent from the registry, so boot-all never visits it and it stays a ghost.
 * This sweep closes exactly that gap: re-register any join-state slug whose clone
 * dir still exists on disk but is missing from the registry, so the NEXT boot
 * pass federates it. Everything else (registered → boot-all heals; no clone dir →
 * truly abandoned) is reported, never silently dropped.
 *
 * Posture mirrors `ensureGitSyncRoutinesReconciledOnce` (git-sync-reconcile.ts):
 * module once-flag + detached fire-and-forget + never throws — a reconcile
 * failure must never wedge boot, and it adds nothing to cold-start when there
 * are no join-state files.
 */

import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  healLinkJoinedEntries,
  loadHarnessRegistry,
  mutateHarnessRegistry,
  upsertLinkJoinedEntry,
  type HarnessRegistry,
} from '../harness-registry';
import type { JoinState } from './join-shared-harness';

/**
 * Complete the registered row of every join-state whose clone it IS (same slug,
 * same path) to the full link-joined shape. `healLinkJoinedEntries` only
 * recognizes a row that already carries `joined_via_link`, but the pre-WI-10003277
 * boot heal wrote a bare `{ slug, path }` row with no marker at all, so that row
 * stayed short on every later boot and its hive never ran git-sync or counted as
 * shared (WI-10003546: the rig VM's link-joined hello-world-3-pot, 2026-09-27).
 * The join-state record is the proof the row is a link join: join-shared-harness
 * is its only writer. A same-slug row at a DIFFERENT path is another checkout and
 * is left alone (upsertLinkJoinedEntry's own guard).
 */
function enrichJoinedClones(
  reg: HarnessRegistry,
  states: JoinState[],
): { registry: HarnessRegistry; enriched: string[] } {
  let cur = reg;
  const enriched: string[] = [];
  for (const js of states) {
    if (!js.cloneDir) continue;
    const existing = cur.projects.find((p) => p.slug === js.slug);
    if (!existing || existing.path !== js.cloneDir) continue;
    const next = upsertLinkJoinedEntry(cur, { slug: js.slug, path: js.cloneDir });
    if (next === cur) continue;
    cur = next;
    enriched.push(js.slug);
  }
  return { registry: cur, enriched };
}

function joinStateDir(): string {
  return resolve(homedir(), '.papercusp', 'join-state');
}

/** Read every persisted join-state file. Missing dir → []. Best-effort: a
 *  corrupt/unparseable file is skipped, never fatal. */
async function defaultListJoinStates(): Promise<JoinState[]> {
  const dir = joinStateDir();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return []; // no join-state dir → nothing to reconcile
  }
  const out: JoinState[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = await readFile(join(dir, name), 'utf8');
      const js = JSON.parse(raw) as JoinState;
      if (js && typeof js.slug === 'string' && js.slug) out.push(js);
    } catch {
      // skip a corrupt/partial file — never fatal
    }
  }
  return out;
}

export interface ReconcileJoinStatesOpts {
  /** Active workspace to register heals into / check registration against
   *  (joins use activeWorkspaceId()). */
  workspaceId: string;
  /** Join-state lister (test seam; default reads ~/.papercusp/join-state). */
  listJoinStates?: () => Promise<JoinState[]>;
  loadRegistry?: (workspaceId?: string) => Promise<HarnessRegistry>;
  mutateRegistry?: typeof mutateHarnessRegistry;
  /** Clone-dir existence check (test seam; default fs.existsSync). */
  pathExists?: (p: string) => boolean;
  /** Boot trigger only: re-run git-sync routine seeding after this sweep
   *  changed the registry (test seam; default reconcileGitSyncRoutines). */
  reseedGitSync?: (workspaceId: string) => Promise<unknown>;
}

export interface ReconcileJoinStatesResult {
  /** Slugs RE-REGISTERED this sweep (clone on disk, was missing from registry)
   *  — the residual heal boot-all couldn't do. */
  reregistered: string[];
  /** Slugs already registered — boot-all heals federation; the record is cosmetic. */
  healedByBoot: string[];
  /** Slugs with a pending join-state, no registry entry, AND no clone dir on
   *  disk — truly abandoned; reported (logged), nothing to re-drive. */
  abandoned: string[];
  /** Link-joined entries an older build left short, completed to the full
   *  link-joined shape this sweep (WI-10003277). */
  enriched: string[];
  /** Set when the sweep itself failed before walking (reported, never thrown). */
  error?: string;
}

/**
 * Idempotent boot-time sweep. Never throws — a load failure folds into
 * `result.error`, per-file failures are skipped. Re-registers exactly the joins
 * boot-all cannot heal (unregistered clone on disk).
 */
export async function reconcileJoinStates(
  opts: ReconcileJoinStatesOpts,
): Promise<ReconcileJoinStatesResult> {
  const result: ReconcileJoinStatesResult = {
    reregistered: [],
    healedByBoot: [],
    abandoned: [],
    enriched: [],
  };
  const listJoinStates = opts.listJoinStates ?? defaultListJoinStates;
  const loadRegistry = opts.loadRegistry ?? loadHarnessRegistry;
  const mutate = opts.mutateRegistry ?? mutateHarnessRegistry;
  const pathExists = opts.pathExists ?? existsSync;

  let states: JoinState[];
  let registered: Set<string>;
  let needsHeal: boolean;
  try {
    states = await listJoinStates();
    const reg = await loadRegistry(opts.workspaceId);
    const current = { ...reg, projects: reg.projects ?? [] };
    registered = new Set(current.projects.map((p) => p.slug));
    needsHeal =
      healLinkJoinedEntries(current).healed.length > 0 ||
      enrichJoinedClones(current, states).enriched.length > 0;
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    return result;
  }

  // A registered link-joined clone that an older build left short never counted
  // its hive as shared. Complete it here; boot-all cannot, it only federates.
  if (needsHeal) {
    try {
      await mutate((cur: HarnessRegistry) => {
        // Marked rows first, then bare rows proven link-joined by their record;
        // a row the first pass completed is a no-op for the second.
        const marked = healLinkJoinedEntries(cur);
        const bare = enrichJoinedClones(marked.registry, states);
        result.enriched = [...marked.healed, ...bare.enriched];
        return bare.registry;
      }, opts.workspaceId);
    } catch {
      // best-effort — a registry write blip; next boot retries.
      result.enriched = [];
    }
  }

  for (const js of states) {
    if (registered.has(js.slug)) {
      // boot-all already federates this on its registered path — cosmetic record.
      result.healedByBoot.push(js.slug);
      continue;
    }
    // Not registered. Re-register iff the clone dir is still on disk (the
    // residual heal); otherwise it's an abandoned ghost (no tree to federate).
    const cloneDir = js.cloneDir;
    if (cloneDir && pathExists(cloneDir)) {
      try {
        await mutate(
          // Every join-state is a link join (join-shared-harness writes them),
          // so it re-registers in the full link-joined shape.
          (cur: HarnessRegistry) =>
            cur.projects.some((p) => p.slug === js.slug)
              ? cur
              : upsertLinkJoinedEntry(cur, { slug: js.slug, path: cloneDir }),
          opts.workspaceId,
        );
        registered.add(js.slug);
        result.reregistered.push(js.slug);
      } catch {
        // best-effort — a registry write blip; next boot retries.
        result.abandoned.push(js.slug);
      }
    } else {
      result.abandoned.push(js.slug);
    }
  }
  return result;
}

// ── Once-per-process boot trigger (git-sync-reconcile.ts posture) ─────────────

let _reconciledOnce = false;

/**
 * Fire the join-state self-heal sweep once per process, detached. Synchronous +
 * void: the caller never awaits, and `reconcileJoinStates` never throws, so this
 * can NEVER block or fail boot. Quiet at steady state — logs only when a slug
 * was re-registered or abandoned. `seams` is the test seam; the boot site passes
 * only the workspace id.
 */
export function ensureJoinStatesReconciledOnce(
  workspaceId: string,
  seams?: Omit<ReconcileJoinStatesOpts, 'workspaceId'>,
): void {
  if (_reconciledOnce) return;
  // The default lister reads the REAL ~/.papercusp/join-state dir and the heal
  // does a live registry write — neither belongs in an unrelated booting unit
  // test (it couples the test to the box's on-disk join-state + the registry
  // mock's exports). Mirror join-shared-harness's EI-339 vitest guard: tests of
  // THIS sweep inject seams and run; the boot wiring no-ops under vitest.
  if (process.env.VITEST && !seams) return;
  _reconciledOnce = true;
  void (async () => {
    const r = await reconcileJoinStates({ workspaceId, ...seams });
    if (r.error) {
       
      console.warn(`[join-state-reconcile] sweep failed for workspace '${workspaceId}': ${r.error}`);
    } else if (r.reregistered.length || r.abandoned.length || r.enriched.length) {
       
      console.log(
        `[join-state-reconcile] boot sweep (${workspaceId}): reregistered=[${r.reregistered.join(', ')}]` +
          (r.abandoned.length ? ` abandoned=[${r.abandoned.join(', ')}]` : '') +
          (r.enriched.length ? ` enriched=[${r.enriched.join(', ')}]` : ''),
      );
    }
    // boot-all fires git-sync reconcile BEFORE this sweep, both detached, so it
    // judged the pre-heal registry: a bare link-joined row read as
    // eligible-but-UNSEEDED and stayed without a git-sync routine until the next
    // boot (rig VM hello-world-3-pot, 2026-09-27T21:34:39Z, WI-10003546). Seed
    // again against the healed registry; the reconcile is idempotent.
    if (!r.error && (r.enriched.length || r.reregistered.length)) {
      const reseed =
        seams?.reseedGitSync ??
        (async (ws: string) => {
          const { reconcileGitSyncRoutines } = await import('./git-sync/git-sync-reconcile');
          const g = await reconcileGitSyncRoutines({ workspaceId: ws });
          console.log(
            `[join-state-reconcile] git-sync re-seed after heal (${ws}): seeded=[${g.seeded.join(', ')}]`,
          );
        });
      await reseed(workspaceId);
    }
  })().catch((e) => {
    // unreachable (reconcileJoinStates never throws) — belt and braces
     
    console.warn(
      `[join-state-reconcile] boot sweep crashed: ${e instanceof Error ? e.message : String(e)}`,
    );
  });
}

/** Test seam: drop the once-flag so the next ensure call re-runs. */
export function __resetJoinStateReconcileForTests(): void {
  _reconciledOnce = false;
}
