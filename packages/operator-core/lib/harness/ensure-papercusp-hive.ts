/**
 * Ship Papercusp itself as a shared HIVE by default
 * (domain-generic-hive-architecture-2026-06-18 P-029, D-010).
 *
 * The shared-hive dogfood counterpart of register-papercusp.ts (which registers
 * the papercup REPO as a private coding HARNESS). This ensures the canonical
 * `papercusp` SHARED HIVE exists: a generic `coding` (kind:'hive') hive —
 * Papercusp's own dev orchestrator built from the SAME generic parts every coding
 * hive uses. The Papercusp-specific knowledge rides the per-hive override + seeded
 * packs, NEVER the blueprint (D-010: "dogfood both flows; Papercusp specifics via
 * override only"). The standalone flow's counterpart is the dogfood-coding-standalone
 * hive (P-026); this is the shared-hive flow (P-027) shipped by default (P-029).
 *
 * Slug is `papercusp` (NOT the legacy `papercup-hive`, retired 2026-06-19 with the
 * papercup→papercusp rebrand). This is the workspace's HOME hive — name it
 * explicitly via PAPERCUSP_POT_HOME_SLUG so resolveHomeHiveSlug() resolves it
 * deterministically rather than via incidental registry order (the home-hive
 * decoupling, 2026-06-19).
 *
 * Idempotent + best-effort, mirroring registerPapercupHarness exactly:
 *   - no-op when papercup isn't on disk (packaged install) — dogfood is dev-only.
 *   - no-op when the hive already exists (idempotent; safe on every bootstrap).
 *   - idle: no Queen wake on create (wakeInSeconds omitted) — seeding never spends.
 *
 * VISIBILITY (deliberate, reversible default): the hive is shared-CAPABLE — it
 * mints its per-Hive federation identity (Ed25519 keypair + entity row) so it can
 * federate over the P2P substrate — but it is created PRIVATE / local with NO
 * public Comb announce. This matches the publish system's own default ("private
 * hives never announce"). Flipping `papercusp` to a public/invite listing is the
 * owner's explicit go-live step (hive:set-listing), not an automatic broadcast.
 */

import { loadHarnessRegistry } from '../harness-registry';
import { PAPERCUSP_WORKSPACE_ID, ensurePapercuspWorkspace } from './papercusp-workspace';
import { detectPapercupRoot } from './register-papercusp';

/** Slug the Papercusp shared hive is created under. Stable; downstream may reference it. */
export const PAPERCUSP_HIVE_SLUG = 'papercusp' as const;

export interface EnsurePapercuspHiveResult {
  /** Final state of the ensure. */
  state: 'already-present' | 'newly-created' | 'skipped';
  /** The hive slug when present/created; null when skipped. */
  slug: string | null;
  /** Human-readable reason — primarily for the 'skipped' case. */
  reason?: string;
}

/** A `createPotHarness`-shaped result (the only fields this helper reads). */
interface CreateHiveLike {
  ok: boolean;
  error?: string;
  message?: string;
}

/**
 * Injectable seams (the lib/ DI-for-tests pattern, e.g. _pot-scope.ts): the
 * production path defaults to the real impls; unit tests pass fakes so the helper
 * is exercised without PG / the keychain / the filesystem.
 */
export interface EnsurePapercuspHiveDeps {
  detectRoot?: () => string | null;
  ensureWorkspace?: () => void;
  loadRegistry?: (ws: string) => Promise<{ projects: Array<{ slug: string }> }>;
  createHive?: (opts: {
    slug: string;
    workspaceId: string;
    createdBy?: string;
    /** B-merge (owner-directed): link the repo IN PLACE as the hive home (path=repo),
     *  so 'papercusp' is ONE entry that is its own repo — no separate member harness. */
    existingPath?: string;
  }) => Promise<CreateHiveLike>;
}

/**
 * Ensure the `papercusp` shared hive exists in the papercusp-workspace sentinel.
 * Idempotent + best-effort. Auto-detects the repo (no-op when absent); pass
 * `pathOverride` to force detection (tests / explicit callers).
 */
export async function ensurePapercuspHive(
  opts: { pathOverride?: string } = {},
  deps: EnsurePapercuspHiveDeps = {},
): Promise<EnsurePapercuspHiveResult> {
  const detectRoot = deps.detectRoot ?? detectPapercupRoot;
  const ensureWorkspace = deps.ensureWorkspace ?? ensurePapercuspWorkspace;
  const loadRegistry = deps.loadRegistry ?? loadHarnessRegistry;

  // Dogfood is dev-only: a packaged install (papercup repo not on disk) no-ops,
  // exactly like registerPapercupHarness.
  const root = opts.pathOverride ?? detectRoot();
  if (!root) {
    return {
      state: 'skipped',
      slug: null,
      reason: 'papercup root not detected (packaged install, or operator running from a non-repo dir)',
    };
  }

  // Ensure the sentinel workspace exists first (idempotent).
  try {
    ensureWorkspace();
  } catch (e) {
    return {
      state: 'skipped',
      slug: null,
      reason: `ensurePapercuspWorkspace failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // Idempotent: a `papercusp` hive already in the sentinel workspace → done.
  const reg = await loadRegistry(PAPERCUSP_WORKSPACE_ID);
  if (reg.projects.some((p) => p.slug === PAPERCUSP_HIVE_SLUG)) {
    return { state: 'already-present', slug: PAPERCUSP_HIVE_SLUG };
  }

  // Create the generic `coding` shared hive — private/local/idle, blueprint
  // default pack. blueprintId omitted ⇒ HIVE_BLUEPRINT_ID ('coding'); knowledgePack
  // omitted ⇒ the blueprint's declared generic `coding` pack (P-017); deployment
  // omitted ⇒ local (no announce); wakeInSeconds omitted ⇒ idle.
  const createHive =
    deps.createHive ??
    (async (o) => {
      const { createPotHarness } = await import('../agent-tools/pot/_create');
      return createPotHarness(o);
    });
  const res = await createHive({
    slug: PAPERCUSP_HIVE_SLUG,
    workspaceId: PAPERCUSP_WORKSPACE_ID,
    createdBy: 'system:dogfood-bootstrap',
    // B-merge (owner-directed papercup→papercusp): papercusp IS its own repo. Link the
    // detected repo root in place as the hive home (createPotHarness existingPath mode),
    // so there is ONE 'papercusp' entry (harness_kind:'hive', path=repo) and no separate
    // 'papercup' member harness. resolveHarnessContentPath returns this path (no member).
    existingPath: root,
  });
  if (!res.ok) {
    // slug_exists is benign (a race, or a pre-entity hive) → treat as present.
    if (res.error === 'slug_exists') return { state: 'already-present', slug: PAPERCUSP_HIVE_SLUG };
    return {
      state: 'skipped',
      slug: null,
      reason: `${res.error ?? 'create_failed'}: ${res.message ?? ''}`.slice(0, 200),
    };
  }
  return { state: 'newly-created', slug: PAPERCUSP_HIVE_SLUG };
}
