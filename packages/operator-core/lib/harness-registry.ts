/**
 * Single source of truth for the operator's harness-project registry.
 *
 * Persisted in `harness_shared.harness_registry` (PG, migration 025).
 * Was previously `<workspace-root>/registry.json`; the new home keeps
 * the same per-workspace scoping via the workspace_id PK column.
 *
 * Operator never reads any home-directory JSON registry. PG is the
 * single source of truth; merging in legacy files re-introduces a
 * workspace-leak bug we've already fixed.
 *
 * API converted to async as part of the migration. Callers in async
 * route handlers / page components add `await`; the few sync wrappers
 * become async functions of their own.
 */

import type { DeploymentConfig, Frame } from '@papercusp/deployment-driver';
// LAZY on purpose — see the `await import('@papercusp/db-org')` call site below
// and plan harden-shared-hive-to-256-peers-2026-06-29 / D-024. This module is
// reached from the substrate boot path via pot-git/serve-wiring; a static edge
// here charges every peer process ~125MB of drizzle module graph it never uses.
import { PLATFORM_POT_SLUG } from './platform-pot-slug';
import { readOperatorState, updateOperatorState, writeOperatorState } from './operator-state-pg';
import { activeWorkspaceId } from './workspace-registry';

export interface ProjectEntry {
  slug: string;
  path: string;
  harness_kind?: string;
  /**
   * A `harness_kind:'hive'` entry that IS its OWN repo checkout, not a repo-less state dir
   * (Option-B merge, papercup→papercusp 2026-06-20: the home hive and its dogfood repo are ONE
   * entry). git-sync-eligibility treats such a hive as a real checkout (eligible) while a normal
   * repo-less hive home stays `hive_home`-ineligible. Flag-based so the verdict stays IO-free.
   */
  self_repo?: boolean;
  /** Department slug for harness_kind='department' projects (e.g. "business"). */
  department_slug?: string;
  /**
   * The home Hive this harness belongs to, for shared-Hive federation
   * (shared-hive-federation-2026-06-08 P-004). A MEMBER harness sets this to its
   * Hive's home slug so its substrate federates over the HIVE topic (the Hive
   * pubkey), with `harness_slug` staying the within-Hive component scope (D-003:
   * change only the topic key). A `harness_kind:'hive'` harness is its own Hive's
   * home and needs no `hive_slug`. Absent ⇒ not a Hive member (federates via
   * gh/local, or stays local-only).
   */
  hive_slug?: string;
  /**
   * Joiner-side hive VIEW (hive-from-repo-hardening-2026-06-11 P-007/D-007):
   * a `harness_kind:'hive'` entry materialized when this peer JOINED someone
   * else's hive — grouping/rail/strip UX only. NO identity mint, NO owned
   * directory meta, NEVER announces; ownership stays with the creator. The
   * federation gate already returns null for it (no hives row/identity).
   */
  remote_hive?: boolean;
  // ── Verified hive identity coords on a `remote_hive` VIEW (2026-07-01 Brief-3
  // live finding). Stamped at JOIN time from the VERIFIED discovery descriptor
  // (verifyHiveAnnounce-gated), so the substrate's owner-bootstrap admit can
  // resolve (hivePubkey → ownerDevicePubkey) from the REGISTRY — the one store
  // that demonstrably resolves in EVERY process — instead of depending on the
  // joiner's directory instance having (re-)heard the owner's announce (a
  // multi-minute race that live-blocked owner→joiner federation).
  /** The joined Hive's raw-32 base64 Ed25519 pubkey (the federation topic key). */
  hive_pubkey?: string;
  /** The joined Hive's OWNER device pubkey (base64) from the verified announce. */
  owner_device_pubkey?: string;
  /**
   * Set when this checkout was registered by the bare invite-LINK join path
   * (`join-link.ts`), which clones someone else's shared repo WITHOUT a local
   * hive home — so it carries no `hive_slug` and no `remote_hive` home entry the
   * git-sync reconcile can key on (EI-1623). It marks a JOINER-side member: the
   * boot reconcile treats it as a member and (re)seeds its git-sync routine
   * `push:false` (a local commit+fetch+merge mirror; fork-PR is the contribution
   * path) — so a failed best-effort join-time seed is still backfilled instead of
   * the clone silently never syncing. NEVER set on the creator/add-member paths.
   */
  joined_via_link?: boolean;
  // ── Upstream GitHub coordinates (hive-from-github-url-2026-06-11 P-002) ──
  // Written at registration time by the projects-route githubUrl path and
  // pot:create_from_repo. Consumed by the hive directory announce derivation
  // (member_repos) and the fork-PR repo-context fallback (orchestrator-runner
  // resolveRepoContext). Absent ⇒ repo origin unknown (registered from a local
  // path) — consumers fall back to .papercusp/shared.json / git remote parsing.
  /** Normalized HTTPS clone URL of the upstream repo. */
  github_remote?: string;
  /** GitHub's immutable numeric repository id (needs API auth at registration —
   *  best-effort; the binding layer keys on this when present). */
  github_repository_id?: number;
  /**
   * The PINNED pot-git federated repoKey (EI-18788176839043286, 2026-07-27).
   * Names both this repo's bare store on disk (`hiveGitRepoPath`) and the repo
   * on the wire, so it MUST stay stable for the life of the repo.
   *
   * Minted once — `pinRepoKey` (pot-git/repo-identity.ts) — and thereafter
   * authoritative over the derivation ladder, INCLUDING over a
   * `github_repository_id` that only shows up later. Without the pin the key was
   * a function of the mutable fields above, so a pot created local-only and
   * bound to GitHub afterwards silently re-keyed itself, abandoned its store and
   * orphaned every peer (live: the P-302 rig sat 7 days on an abandoned store
   * reporting success). Absent ⇒ predates pinning; backfilled on boot.
   */
  pot_repo_key?: string;
  /**
   * Provenance of `pot_repo_key` (A3, EI-18788176839043286) — `'peer'` when this
   * device ADOPTED the key the pot owner announced on the member join link,
   * `'local'` when it merely derived the key itself. Absent ⇒ `'local'`.
   *
   * This is what lets an announced key correct a wrong pin: a locally-derived
   * pin is a GUESS at the federated identity, and pinning alone would otherwise
   * cement an already-diverged install forever. See `adoptRepoKey`.
   */
  pot_repo_key_source?: 'local' | 'peer';
  /** Upstream default branch (API-authoritative when available, else the fresh
   *  clone's HEAD). Fork-PRs target this instead of assuming 'main'. */
  github_default_branch?: string;
  /**
   * The user's OWN fork of the upstream repo, normalized HTTPS clone URL
   * (per-hive-learning-loops-2026-06-14 P-072 / D-007b). The CONTRIBUTION seam:
   * a platform self-hive (or any member without upstream write) git-syncs its
   * local commits to THIS fork remote — never the canonical upstream — and
   * improvements reach upstream only as human-reviewed PRs (open-fork-pr) or
   * moderated Comb knowledge-pack listings. Absent ⇒ no fork configured (the
   * default for every existing harness): git-sync stays commit-only / pushes the
   * upstream only when the operator has write (decideGitSyncPush). This is a LOCAL
   * config seam only — setting it performs NO outward git action (D-007: the live
   * fork-push / PR-open is the gated platform:contribute path).
   */
  fork_remote?: string;
  /**
   * Where this harness's execution plane runs (`cloud-deployment-layer-2026-06-06`
   * P-003). A sibling to the blueprint (D-001), supplied at instantiation and
   * persisted here in workspace PG. Absent ⇒ `{ target: 'local' }` (every existing
   * harness), so the launch path runs locally exactly as before.
   */
  deployment?: DeploymentConfig;
  /**
   * The currently-provisioned cloud frame handle, when this harness is deployed
   * (cloud-deployment-layer P-012). Persisted so teardown can DESTROY the right
   * machine across operator restarts (a frame outlives the process that made it).
   * Absent ⇒ not deployed / running locally.
   */
  deploymentFrame?: Frame;
  // ── Per-install INSTANCE config in workspace PG (cloud-deployment-layer P-008) ──
  // The instance fields that used to live in `.papercusp/config.json`; here they're
  // in workspace PG so they FEDERATE to a cloud frame (D-007) instead of being
  // stuck in a local file. Absent ⇒ fall back to config.json (un-migrated).
  /** Which prompt set the orchestrator pulls (staging/department/production). */
  phase?: string;
  /** Per-phase config (port / dbPath / …). */
  phases?: Record<string, Record<string, unknown>>;
  /** Department slug. */
  dept?: string;
  /** Per-instance overrides of blueprint knobs (maxCostUsd, parallelWorkers, …) —
   *  the residue of config.json after phase/phases/dept are split out. */
  configOverrides?: Record<string, unknown>;
  /**
   * The local HTTP endpoint this harness's sidecar advertised on boot
   * (`harness-provided-cadence-ops-2026-06-26` P-005). When a harness ships
   * dispatched ops (`ops:` manifest, D-001), its sidecar POSTs `{host,port}` to
   * the operator (`POST /harness/endpoint`), which persists it HERE so the
   * routines engine / a proxy CoordOp's `run()` can find the sidecar to dispatch
   * to (`harnessApiBase`). The durable registration path (vs. a home-dir
   * discovery file): it lives in workspace PG with the rest of the project row,
   * survives operator restarts, and is generic across harnesses. A DEPLOYED
   * harness uses `deploymentFrame.callablePort` instead; this is the LOCAL path.
   * Absent ⇒ no sidecar has advertised (the op dispatch fails closed with a clear
   * "endpoint not registered" error — the cron is seeded INACTIVE so it never
   * fires silently).
   */
  localEndpoint?: HarnessLocalEndpoint;
  /**
   * WI-1937 (D-001 `launchSession`, option B — leader steer, msg mre5tvu2
   * 2026-07-09): this project row is an EPHEMERAL registry entry for a P-104
   * foreign-work clone (`provisionForeignClone`, p2p/foreign-clone.ts) — NOT a
   * real harness a human registered. It exists solely so
   * `resolveProject`/`spawnAgentInHarness` (fleet/operator-spawn.ts) can cwd a
   * `foreign-session` spawn into the SANDBOXED clone path via the exact same
   * registry-resolution chokepoint every other spawn uses — zero core
   * spawn-path changes, the invariant "every spawn resolves via the registry"
   * stays intact. Deregistered (`deregisterEphemeralForeignHarness`) when its
   * `p2p_foreign_workspaces` row transitions to `reaped` (foreign-workspaces.ts
   * / revocation-reaper.ts) or by `sweepOrphanedEphemeralForeignHarnesses` if
   * that call was missed. Consumers that ENUMERATE all projects for
   * listing/selection/default-inference MUST filter these out
   * (`isEphemeralForeignProject`) — a slug-scoped `.find(p => p.slug === X)`
   * lookup is unaffected and SHOULD still resolve it (that's how the spawn leg
   * finds its clone).
   */
  ephemeral_foreign?: boolean;
  /** The `p2p_foreign_workspaces` offer id this ephemeral row was registered
   *  for (WI-1937) — the join key `deregisterEphemeralForeignHarness` /
   *  `sweepOrphanedEphemeralForeignHarnesses` use to find/remove it. */
  foreign_offer_id?: string;
}

/** A harness sidecar's advertised local HTTP endpoint (P-005). */
export interface HarnessLocalEndpoint {
  /** Loopback host the sidecar bound (typically `127.0.0.1`). */
  host: string;
  /** The sidecar's HTTP port. */
  port: number;
  /** The sidecar process pid (diagnostics — detect a stale advert after a crash). */
  pid?: number;
  /** ISO timestamp of the advert (staleness check / last-seen). */
  advertisedAt: string;
}

export interface HarnessRegistry {
  projects: ProjectEntry[];
  /** Per-Hive Queen control-frame handles (cloud-deployment-layer P-016) — kept in
   *  the registry blob (workspace PG) alongside per-harness deployment frames, so
   *  teardown can DESTROY the Queen across restarts. Keyed by potId. */
  hiveControlFrames?: Record<string, Frame>;
  /** Per-Hive directory metadata (p2p-hive-directory P-004) — title/description/
   *  visibility/memberTopics/inviteSecret the directory announces. Kept in the
   *  registry blob (workspace PG, no migration) keyed by potId; a public/invite
   *  entry is announced on boot. Shape = the directory's `HiveDirectoryMeta`
   *  (lib/hive-publish.ts). */
  hiveDirectoryMeta?: Record<string, import('./hive-publish').HiveDirectoryMeta>;
}

export interface SaveRegistryOptions {
  /**
   * Permit reducing a populated registry to empty. Required by the
   * intentional-removal paths (DELETE /harness/projects/:slug,
   * /installed/prune). Every other caller only grows the registry, so
   * the default (false) guards against the silent total-wipe that lost
   * the `default` workspace's harnesses on 2026-05-25.
   */
  allowEmpty?: boolean;
}

export async function loadHarnessRegistry(
  workspaceId?: string,
  // WI-1378: { fresh:true } bypasses the operator-state read cache so a
  // correctness-critical caller (the joiner hive-home resolve on the sidecar-process
  // rekey) sees a just-committed cross-process registry write. Default (cached) is
  // the hot path — do not pass fresh there.
  opts?: { fresh?: boolean },
): Promise<HarnessRegistry> {
  const raw = await readOperatorState<HarnessRegistry>('harness_registry', workspaceId, opts);
  return {
    // Read-side canonicalization (WI-3168): fold the legacy `papercup` dogfood
    // entry into `papercusp` so EVERY existing install's selector is clean
    // immediately, without waiting for a write or a data migration.
    projects: canonicalizeLegacyPapercup(raw?.projects ?? []),
    ...(raw?.hiveControlFrames ? { hiveControlFrames: raw.hiveControlFrames } : {}),
    ...(raw?.hiveDirectoryMeta ? { hiveDirectoryMeta: raw.hiveDirectoryMeta } : {}),
  };
}

/**
 * Return whether a registered project is a real Hive. Watchdogs use this
 * narrow registry predicate before acting on persisted started bits so a
 * deleted/typo slug cannot keep re-arming a wake forever.
 */
export async function isRegisteredHive(workspaceId: string, slug: string): Promise<boolean> {
  const registry = await loadHarnessRegistry(workspaceId);
  return registry.projects.some((project) => project.slug === slug && project.harness_kind === 'hive');
}

/** Upstream coordinates an invite link carries for the repo it clones. */
export interface LinkJoinedUpstream {
  /** `owner/repo` from the link. */
  github?: string;
  repoId?: number;
}

/**
 * The fields a link-joined entry is missing, relative to the ONE registry shape
 * for it (WI-10003277). Empty when the entry is complete. Existing values are
 * never overwritten, even divergent ones.
 */
function linkJoinedPatch(p: ProjectEntry, upstream: LinkJoinedUpstream): Partial<ProjectEntry> {
  return {
    ...(p.github_remote || !upstream.github ? {} : { github_remote: `https://github.com/${upstream.github}` }),
    ...(typeof p.github_repository_id === 'number' || typeof upstream.repoId !== 'number'
      ? {}
      : { github_repository_id: upstream.repoId }),
    ...(p.joined_via_link === undefined ? { joined_via_link: true } : {}),
    // WI-3891: without these three, isRegisteredHive()/isHiveProject() never
    // recognize the entry (probe:emit refuses harness_not_federated, pot:get and
    // pot:list report hive_not_found) and federation-scope does not count the
    // hive as shared. Mirrors bootstrap-papercusp-hive.ts's self-admit shape: a
    // real repo checkout that is a joiner-side hive member, never its own home.
    ...(p.harness_kind === 'hive' ? {} : { harness_kind: 'hive' }),
    ...(p.remote_hive === true ? {} : { remote_hive: true }),
    ...(p.self_repo === true ? {} : { self_repo: true }),
  };
}

/**
 * Insert-or-enrich the entry for a checkout joined through an invite LINK. This
 * is the one writer of that shape (WI-10003277). Three paths used to write it
 * three ways: the join-link route stamped the WI-3891 shape, the join
 * orchestrator's pre-boot registration wrote only `joined_via_link` + upstream
 * coords, and the boot-time join-state heal wrote a bare `{ slug, path }`. A
 * join that died after the pre-boot write (the route answers 502, and every
 * retry then stops at 409 slug_conflict) kept the short row for good, so the
 * member never counted its own hive as shared: seat offers were skipped
 * `hive_not_shared` on the P-202 rig, 2026-09-26.
 *
 * An existing same-slug entry is enriched only when it is this clone (same
 * path) or is already marked link-joined; anything else is a different
 * checkout and is left alone. Returns `reg` itself when nothing changes.
 */
export function upsertLinkJoinedEntry(
  reg: HarnessRegistry,
  entry: { slug: string; path: string } & LinkJoinedUpstream,
): HarnessRegistry {
  const { slug, path, ...upstream } = entry;
  const existing = reg.projects.find((p) => p.slug === slug);
  if (!existing) {
    const fresh: ProjectEntry = { slug, path };
    return { ...reg, projects: [...reg.projects, { ...fresh, ...linkJoinedPatch(fresh, upstream) }] };
  }
  if (existing.joined_via_link !== true && existing.path !== path) return reg;
  const patch = linkJoinedPatch(existing, upstream);
  if (Object.keys(patch).length === 0) return reg;
  return { ...reg, projects: reg.projects.map((p) => (p.slug === slug ? { ...p, ...patch } : p)) };
}

/**
 * Complete every `joined_via_link` entry that is missing part of the
 * link-joined shape: the boot-time heal for rows an older build left short.
 * Returns `reg` itself and no slugs when nothing changes.
 */
export function healLinkJoinedEntries(reg: HarnessRegistry): { registry: HarnessRegistry; healed: string[] } {
  const healed: string[] = [];
  const projects = reg.projects.map((p) => {
    if (p.joined_via_link !== true) return p;
    const patch = linkJoinedPatch(p, {});
    if (Object.keys(patch).length === 0) return p;
    healed.push(p.slug);
    return { ...p, ...patch };
  });
  return healed.length === 0 ? { registry: reg, healed } : { registry: { ...reg, projects }, healed };
}

/**
 * The registry's uniqueness invariant: `slug` is the primary key. Every
 * insert path guards with `projects.some(p => p.slug === …)` and every update
 * path replaces in place (`projects.map`), so a duplicate slug is always a
 * caller bug — and a duplicate makes the ubiquitous downstream
 * `projects.find(p => p.slug === …)` non-deterministic (which row wins depends
 * on array order). This is the single store-layer guard that enforces the
 * invariant at the write boundary regardless of caller discipline: collapse to
 * one entry per slug, LAST-write-wins (matching the upsert-replace intent), and
 * `onCollapse` surfaces the bug so it's traceable rather than silent. A
 * duplicate-free input is returned UNCHANGED (same reference) — the common case
 * pays nothing.
 *
 * Pure + exported so it's unit-testable without PG.
 */
export function dedupeProjectsBySlug(
  projects: ProjectEntry[],
  onCollapse?: (slug: string) => void,
): ProjectEntry[] {
  // Fast path: scan for any dup before allocating.
  const seen = new Set<string>();
  let hasDup = false;
  for (const p of projects) {
    if (seen.has(p.slug)) {
      hasDup = true;
      break;
    }
    seen.add(p.slug);
  }
  if (!hasDup) return projects;

  // Last-write-wins: keep the LAST entry per slug, preserving first-seen order
  // of the surviving rows.
  const lastIndex = new Map<string, number>();
  projects.forEach((p, i) => lastIndex.set(p.slug, i));
  const collapsed: ProjectEntry[] = [];
  const emitted = new Set<string>();
  projects.forEach((p, i) => {
    if (lastIndex.get(p.slug) !== i) {
      onCollapse?.(p.slug);
      return; // a later entry for this slug wins
    }
    if (emitted.has(p.slug)) return;
    emitted.add(p.slug);
    collapsed.push(p);
  });
  return collapsed;
}

/** The pre-rename repo NAME of the papercusp dogfood repo (see `canonicalizeLegacyPapercup`). */
const LEGACY_DOGFOOD_SLUG = 'papercup';
/**
 * The canonical product/hive slug the legacy dogfood name maps to — the SHARED
 * constant, not a fourth private copy of the literal (EI-19370922358009801: three
 * independent copies of `'papercusp'` are why the triage self-scope allowlist could
 * keep the pre-rename spelling for weeks without anything noticing).
 */
const CANONICAL_DOGFOOD_SLUG = PLATFORM_POT_SLUG;

/**
 * Legacy-identity guard (WI-3168): `papercup` is the PRE-RENAME name of the
 * papercusp dogfood repo (`github.com/Papercusp/papercup` → product/hive slug
 * `papercusp`; the REPO kept its name, the PRODUCT was renamed 2026-06-20 — see
 * `ProjectEntry.self_repo` above and migrations 295/359/360). A bare clone of
 * that repo (e.g. into `.papercusp-workspaces/clones/papercup`) gets registered
 * with the raw repo NAME as its slug, so a phantom "papercup" pot surfaces in the
 * selector ALONGSIDE the real `papercusp` hive — observed on BOTH the owner dev
 * box and the packaged Mac install. There is no legitimate standalone `papercup`
 * harness; it is always this stale duplicate. Collapse it into the canonical
 * identity so the phantom pot can never appear — applied at the store boundary on
 * every registration path (write) and every existing install (read):
 *   - a canonical `papercusp` entry already exists → DROP the `papercup` dup;
 *   - else (no `papercusp`) → RENAME `papercup`→`papercusp` so the dogfood
 *     identity is preserved, never lost.
 *
 * Idempotent + pure: a registry without a `papercup` entry is returned UNCHANGED
 * (same reference), so the common case pays nothing. Exported for unit tests.
 */
export function canonicalizeLegacyPapercup(projects: ProjectEntry[]): ProjectEntry[] {
  const idx = projects.findIndex((p) => p.slug === LEGACY_DOGFOOD_SLUG);
  if (idx === -1) return projects;
  const hasCanonical = projects.some((p) => p.slug === CANONICAL_DOGFOOD_SLUG);
  if (hasCanonical) {
    // Stale duplicate of the papercusp dogfood identity — drop it.
    return projects.filter((_, i) => i !== idx);
  }
  // No canonical entry present — preserve the dogfood identity under its correct slug.
  return projects.map((p, i) => (i === idx ? { ...p, slug: CANONICAL_DOGFOOD_SLUG } : p));
}

/**
 * The set of `harness:<slug>` improvement/work scopes belonging to one Hive
 * (per-hive-learning-loops P-040, D-008 — the Hive is the tenancy unit). A Hive
 * is identified by its HOME slug; its members are the home itself plus every
 * project whose `hive_slug` points at it (shared-hive-federation D-003 keeps the
 * within-Hive harness_slug as the component scope). Pure over the registry
 * projects so it's unit-testable without PG.
 */
export function hiveMemberHarnessScopes(
  projects: Pick<ProjectEntry, 'slug' | 'hive_slug'>[],
  potHomeSlug: string,
): string[] {
  const slugs = new Set<string>();
  // The home harness is always a member, even before any peer joins.
  slugs.add(potHomeSlug);
  for (const p of projects) {
    if (p.slug === potHomeSlug || p.hive_slug === potHomeSlug) slugs.add(p.slug);
  }
  return [...slugs].map((s) => `harness:${s}`);
}

/**
 * The filesystem path whose repo-backed content (docs, source, tests-as-files)
 * belongs to a harness. A `harness_kind:'hive'` harness is repo-LESS — its `path`
 * is the Hive's state dir, NOT a code checkout — so its repo-backed content lives
 * in its MEMBER repo (git-sync-any-hive: a coding Hive's files ARE its member's).
 * EXCEPTION: a `self_repo` hive IS its own repo checkout (papercup→papercusp merge:
 * the home hive and its dogfood repo are ONE entry) — it uses its OWN path and never
 * borrows a member, so a stray project that set `hive_slug` to this hive can't hijack
 * its docs/tests/source reads.
 * Returns the member repo's path for a repo-less Hive, else the harness's own path.
 * Pure over the registry projects; returns undefined when the slug isn't registered.
 */
export function resolveHarnessContentPath(
  reg: Pick<HarnessRegistry, 'projects'>,
  slug: string,
): string | undefined {
  const project = reg.projects.find((p) => p.slug === slug);
  if (!project) return undefined;
  // A repo-less hive home borrows its member's checkout; a `self_repo` hive is
  // its OWN checkout and must use its own path (never a stray member's).
  if (project.harness_kind === 'hive' && !project.self_repo) {
    const member = reg.projects.find(
      (p) => p.hive_slug === slug && p.harness_kind !== 'hive' && p.path,
    );
    if (member) return member.path;
  }
  return project.path;
}

/**
 * Append an audit_log row recording every registry size change, so a
 * future wipe is traceable to its actor + timestamp (the 2026-05-25
 * incident left no trail because this write was silent). Best-effort —
 * audit failure never blocks the registry write.
 */
async function auditRegistryWrite(
  ws: string,
  prevCount: number,
  nextCount: number,
): Promise<void> {
  try {
    const { sql } = (await import('@papercusp/db-org')).getOrgPg();
    const id = `hreg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await sql.unsafe(
      `INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        id,
        Date.now(),
        'operator',
        'harness_registry.write',
        ws,
        JSON.stringify({ prevCount, nextCount, delta: nextCount - prevCount }),
        ws,
      ],
    );
  } catch (err) {
     
    console.warn('[harness-registry] audit write failed:', err);
  }
}

export async function saveHarnessRegistry(
  reg: HarnessRegistry,
  workspaceId?: string,
  opts: SaveRegistryOptions = {},
): Promise<void> {
  const ws = workspaceId ?? activeWorkspaceId();
  // Legacy-identity guard (WI-3168): neutralize the stale `papercup` dogfood
  // entry at the WRITE boundary too, so no registration path can ever persist a
  // phantom "papercup" pot (self-healing regardless of which caller adds it).
  const canonical = canonicalizeLegacyPapercup(reg.projects ?? []);
  // Uniqueness invariant (store-layer guard): collapse any accidental
  // duplicate slug last-write-wins before persisting, so a buggy caller can
  // never leave the row with two entries sharing a slug (which would make
  // downstream find(p=>p.slug===…) non-deterministic). A clean input is
  // unchanged; a collapse is logged so the offending caller is traceable.
  const next = dedupeProjectsBySlug(canonical, (slug) =>
     
    console.warn(`[harness-registry] saveHarnessRegistry collapsed duplicate slug '${slug}' (workspace '${ws}')`),
  );
  const prev = await readOperatorState<HarnessRegistry>('harness_registry', workspaceId);
  const prevCount = prev?.projects?.length ?? 0;

  // Catastrophic-empty guard: refuse to wipe a populated registry unless
  // the caller explicitly opts in. This is the single barrier that would
  // have prevented the 2026-05-25 silent loss of every `default` harness.
  if (next.length === 0 && prevCount > 0 && !opts.allowEmpty) {
    throw new Error(
      `saveHarnessRegistry refused: emptying ${prevCount} project(s) in workspace ` +
        `'${ws}' requires { allowEmpty: true }. Only intentional-removal paths ` +
        `(project delete / installed prune) should pass it.`,
    );
  }

  await writeOperatorState(
    'harness_registry',
    {
      projects: next,
      ...(reg.hiveControlFrames ? { hiveControlFrames: reg.hiveControlFrames } : {}),
      // Was silently dropped on every save before 2026-06-10 (audit P-006
      // adjacency) — any registry write wiped the Hive directory metadata.
      ...(reg.hiveDirectoryMeta ? { hiveDirectoryMeta: reg.hiveDirectoryMeta } : {}),
    },
    workspaceId,
  );
  if (next.length !== prevCount) {
    await auditRegistryWrite(ws, prevCount, next.length);
  }
  await notifyRegistryChanged();
}

/**
 * Push invalidation + per-process lite-cache bust after any registry
 * mutation, so open harness lists live-update without a remount (EI-206).
 * The notify rides pg_notify, so writes from OTHER operator processes
 * (e.g. an MCP-side harness:create) reach this process's SSE subscribers
 * too — and every cluster worker's operator-state cache drops its registry
 * entry on it (startOperatorStateCacheCoherence, WI-10004071).
 *
 * AWAITED, and UN-DEDUPED (WI-10004071): the NOTIFY is published before the
 * write returns, so a caller that writes and then hands off to a request on a
 * sibling worker never races it; and `dedupeWindowMs: 0` because the bus's
 * default 90 s source dedupe keys on name|args|data, which is identical for
 * every registry write — a second back-to-back write (harness:create then
 * pot:add-member) was silently dropped. Registry writes are rare, so there is
 * no storm to dedupe. A notify failure still never fails the write.
 */
async function notifyRegistryChanged(): Promise<void> {
  try {
    const [{ bustProjectsLiteCache }, { notifySyncInvalidate }] = await Promise.all([
      import('./harness/projects-lite'),
      import('./sync-sse'),
    ]);
    bustProjectsLiteCache();
    await notifySyncInvalidate('harnessProjects.lite', {}, undefined, { dedupeWindowMs: 0 });
  } catch (err) {
    console.warn('[harness-registry] sync invalidate failed:', err);
  }
}

/**
 * Atomic read-modify-write on the registry (audit P-006 / EI-82).
 *
 * `loadHarnessRegistry()` + mutate + `saveHarnessRegistry()` is a lost-update
 * race: two concurrent mutators (e.g. a POST create and a DELETE) both read,
 * then the second save silently reverts the first. This helper runs the
 * mutator inside the operator-state row's `SELECT … FOR UPDATE` transaction,
 * so concurrent mutations serialize and each sees the previous committed
 * value.
 *
 * The mutator must return the FULL next registry (return `reg` unchanged to
 * no-op). The catastrophic-empty guard applies unless `opts.allowEmpty`.
 */
export async function mutateHarnessRegistry(
  mutator: (reg: HarnessRegistry) => HarnessRegistry,
  workspaceId?: string,
  opts: SaveRegistryOptions = {},
): Promise<HarnessRegistry> {
  const ws = workspaceId ?? activeWorkspaceId();
  let prevCount = 0;
  let nextCount = 0;
  const next = await updateOperatorState<HarnessRegistry>(
    'harness_registry',
    { projects: [] },
    (raw) => {
      const current: HarnessRegistry = {
        // Canonicalize on read INSIDE the tx (WI-3168) so the mutator sees the
        // clean set and any lingering `papercup` entry is dropped on this write.
        projects: canonicalizeLegacyPapercup(raw?.projects ?? []),
        ...(raw?.hiveControlFrames ? { hiveControlFrames: raw.hiveControlFrames } : {}),
        ...(raw?.hiveDirectoryMeta ? { hiveDirectoryMeta: raw.hiveDirectoryMeta } : {}),
      };
      prevCount = current.projects.length;
      const mutated = mutator(current);
      // Uniqueness invariant (store-layer guard): collapse any accidental
      // duplicate slug last-write-wins inside the tx, so the committed row is
      // always one entry per slug regardless of the mutator's discipline.
      // Canonicalize again (WI-3168) in case the mutator re-added the legacy entry.
      const dedupedProjects = dedupeProjectsBySlug(canonicalizeLegacyPapercup(mutated.projects ?? []), (slug) =>
         
        console.warn(`[harness-registry] mutateHarnessRegistry collapsed duplicate slug '${slug}' (workspace '${ws}')`),
      );
      nextCount = dedupedProjects.length;
      if (nextCount === 0 && prevCount > 0 && !opts.allowEmpty) {
        // Throwing rolls the FOR UPDATE transaction back.
        throw new Error(
          `mutateHarnessRegistry refused: emptying ${prevCount} project(s) in workspace ` +
            `'${ws}' requires { allowEmpty: true }. Only intentional-removal paths ` +
            `(project delete / installed prune) should pass it.`,
        );
      }
      return { ...mutated, projects: dedupedProjects };
    },
    workspaceId,
  );
  if (nextCount !== prevCount) {
    await auditRegistryWrite(ws, prevCount, nextCount);
  }
  await notifyRegistryChanged();
  return next;
}

// ── WI-1937 D-001 (option B): ephemeral foreign-clone registry rows ──
// No SQL migration needed for any of this — `ProjectEntry` lives in a single
// JSONB blob per workspace (see the module doc comment), so the two new
// optional fields above are just a TS interface change, read/written through
// the existing `mutateHarnessRegistry`/`loadHarnessRegistry` machinery.

/** True for an ephemeral P-104 foreign-clone registry row (see
 *  `ProjectEntry.ephemeral_foreign`). Enumeration/listing/default-inference
 *  call-sites should filter these out; a slug-scoped lookup should not —
 *  it's how the foreign-session spawn leg resolves its sandboxed clone. */
export function isEphemeralForeignProject(p: Pick<ProjectEntry, 'ephemeral_foreign'>): boolean {
  return p.ephemeral_foreign === true;
}

/** The registry slug an ephemeral foreign-clone row uses — one row per offer,
 *  so `slug` uniqueness (the registry's PK) doubles as the per-offer claim. */
export function ephemeralForeignHarnessSlug(offerId: string): string {
  return `foreign-${offerId}`;
}

/**
 * WI-1937 D-001 option B: register an EPHEMERAL harness_registry row for a
 * P-104 foreign-work clone so `resolveProject`/`spawnAgentInHarness` can cwd a
 * `foreign-session` spawn into the sandboxed clone path via the same
 * registry-resolution chokepoint every other spawn uses. Upsert-by-slug
 * (idempotent on the offer id — `mutateHarnessRegistry`'s dedupe collapses a
 * re-register to the latest row).
 */
export async function registerEphemeralForeignHarness(
  offerId: string,
  clonePath: string,
  workspaceId?: string,
): Promise<ProjectEntry> {
  const slug = ephemeralForeignHarnessSlug(offerId);
  const entry: ProjectEntry = {
    slug,
    path: clonePath,
    ephemeral_foreign: true,
    foreign_offer_id: offerId,
  };
  await mutateHarnessRegistry(
    (reg) => ({ ...reg, projects: [...reg.projects.filter((p) => p.slug !== slug), entry] }),
    workspaceId,
  );
  return entry;
}

/**
 * WI-1937: deregister the ephemeral harness row for a reaped/parked foreign
 * clone. Idempotent and never throws on a missing row — "already gone" is a
 * success, not an error (a raced double-deregister, e.g. reap path + orphan
 * sweep both firing, must not blow up either caller).
 */
export async function deregisterEphemeralForeignHarness(
  offerId: string,
  workspaceId?: string,
): Promise<boolean> {
  const slug = ephemeralForeignHarnessSlug(offerId);
  let removed = false;
  await mutateHarnessRegistry((reg) => {
    const next = reg.projects.filter((p) => p.slug !== slug);
    removed = next.length !== reg.projects.length;
    return { ...reg, projects: next };
  }, workspaceId);
  return removed;
}

/**
 * WI-1937 orphan sweep: an ephemeral foreign-harness row whose
 * `p2p_foreign_workspaces` row is gone or already `reaped` is a LEAK (the
 * reap path's deregister call was missed, e.g. a crash between the state
 * transition and the deregister) — remove it. `checkLive` is injected
 * (production callers wire `getForeignWorkspaceByOffer`, p2p/foreign-workspaces.ts
 * — kept out of THIS module's import graph so harness-registry.ts, a
 * generic/foundational lib, never depends on the p2p package) so this stays
 * unit-testable without PG. Run it on the same schedule as the P-106
 * supervision sweep (`superviseForeignSessions`, foreign-supervision.ts).
 */
export async function sweepOrphanedEphemeralForeignHarnesses(
  workspaceId: string | undefined,
  checkLive: (offerId: string) => Promise<{ state: string } | null>,
  /** Injectable registry read/write seams (default: this module's real PG-
   *  backed fns) — lets the sweep's ORCHESTRATION (which rows get swept,
   *  under what live/reaped/missing conditions) be unit-tested without PG,
   *  matching the `checkLive` injection above. */
  deps: {
    loadRegistry?: typeof loadHarnessRegistry;
    deregister?: typeof deregisterEphemeralForeignHarness;
  } = {},
): Promise<{ swept: number; removed: string[] }> {
  const loadRegistry = deps.loadRegistry ?? loadHarnessRegistry;
  const deregister = deps.deregister ?? deregisterEphemeralForeignHarness;
  const reg = await loadRegistry(workspaceId, { fresh: true });
  const ephemeral = reg.projects.filter(isEphemeralForeignProject);
  const removed: string[] = [];
  for (const p of ephemeral) {
    const offerId = p.foreign_offer_id;
    if (!offerId) continue; // malformed row — leave for manual inspection, don't guess
    const ws = await checkLive(offerId).catch(() => null);
    if (!ws || ws.state === 'reaped') {
      const didRemove = await deregister(offerId, workspaceId);
      if (didRemove) removed.push(offerId);
    }
  }
  return { swept: ephemeral.length, removed };
}
