/**
 * pot-canonical-slug-reconcile — WI-559 / EI-18775450536624845.
 *
 * Keeps `harness_shared.pots.canonical_pot_home_slug` (migration 686) TRUE for a
 * joined remote VIEW: the OWNER-authored home slug the Pot's rows actually travel
 * under on the wire, which since the demux fix is also the scope every hive-home-
 * grained projection persists under and the target of `pot_members_pot_fkey`.
 *
 * ── WHY A JOINER NEEDS THIS AT ALL ────────────────────────────────────────────
 * `pots.pot_home_slug` is the LOCAL handle — the registry entry / identity row /
 * local scope key. `join-hive` derives a view's handle `freeSlug(kebab(potId),
 * taken)`, which SUFFIXES on a local name collision, so the local handle can
 * legitimately differ from the owner's slug on a perfectly healthy join. Before
 * migration 686 the FK demanded a LOCAL handle for a FEDERATED scope, so on any
 * joiner where the two diverged EVERY inbound roster op failed
 * `pot_members_pot_fkey`, the merge pass aborted every ~60s, and the WI-255
 * apply-quarantine escalated a structural mismatch into PERMANENT row loss — the
 * joiner's roster stayed empty and it admitted nobody.
 *
 * ── THE ONE RULE: MATCH BY PUBKEY, NEVER BY NAME ──────────────────────────────
 * The local slug is exactly the untrustworthy value being repaired, so it can never
 * be the key. The Pot's Ed25519 pubkey is its real identity and already agrees
 * across machines. `loadAnnouncedHiveHomeSlug` resolves the owner's slug from the
 * signature-verified announce for that pubkey and ALREADY skips a `potIdSynthetic`
 * descriptor — the D-007 join-link seed mints a verified pubkey binding but GUESSES
 * its potId (`${repoName}-pot`), and trusting that guess could rebind a joiner whose
 * handle was already correct, turning this repair into a regression. Do not
 * re-implement or weaken that guard here; this module depends on it.
 *
 * ── FAIL-OPEN, ALWAYS ─────────────────────────────────────────────────────────
 * Every miss (not a view, no identity row, no resolvable announce, a slug collision)
 * leaves the row exactly as it is — canonical == local, i.e. today's behavior — and
 * returns a typed reason. Nothing here throws, because every call site is a
 * best-effort step on the boot path: failing to IMPROVE the binding must never break
 * a Pot that is working.
 */
import { getHiveBySlug, setPotCanonicalHomeSlug } from './hive-store';
import { loadAnnouncedHiveHomeSlug } from './hive-membership-store';
import { loadHarnessRegistry } from './harness-registry';

export type ReconcilePotCanonicalSlugResult =
  /** The row now names `canonical`; `changed` says whether this call moved it. */
  | { ok: true; changed: boolean; local: string; canonical: string }
  /** Left as-is, on purpose. `reason` names which guard declined. */
  | { ok: false; reason: ReconcileSkipReason; local: string; detail?: string };

export type ReconcileSkipReason =
  /** Not a `remote_hive` registry view — an OWNED Pot is the authority for its own
   *  slug, and rebinding it would double-apply its own rows as remote. */
  | 'not_a_joined_view'
  /** No `pots` row for this slug, or it carries no pubkey — nothing to match on. */
  | 'no_identity_row'
  /** No signature-verified announce resolves a slug for this pubkey (or the only
   *  descriptor is a synthetic/guessed one, which is deliberately not trusted). */
  | 'no_announced_slug'
  /** Another local Pot already claims that federated scope. Forcing it would give
   *  one wire Pot two identity rows and make the demux ambiguous. */
  | 'canonical_taken'
  /** The identity row is not a remote view (owned Pot) — the store's own guard. */
  | 'not_a_remote_view'
  /** A PG fault. Swallowed so boot continues; the detail carries the message. */
  | 'error';

export interface ReconcilePotCanonicalSlugDeps {
  loadRegistry?: typeof loadHarnessRegistry;
  getPotBySlug?: typeof getHiveBySlug;
  loadAnnouncedSlug?: typeof loadAnnouncedHiveHomeSlug;
  setCanonical?: typeof setPotCanonicalHomeSlug;
}

/**
 * Reconcile ONE joined view's federated scope key. Idempotent: a row already
 * naming the announced slug returns `{ ok: true, changed: false }` without a write,
 * so this is cheap to call on every boot.
 *
 * @param viewSlug the LOCAL handle of the joined view (the registry project slug).
 */
export async function reconcilePotCanonicalSlug(
  workspaceId: string,
  viewSlug: string,
  deps: ReconcilePotCanonicalSlugDeps = {},
): Promise<ReconcilePotCanonicalSlugResult> {
  const loadRegistry = deps.loadRegistry ?? loadHarnessRegistry;
  const getPot = deps.getPotBySlug ?? getHiveBySlug;
  const loadAnnounced = deps.loadAnnouncedSlug ?? loadAnnouncedHiveHomeSlug;
  const setCanonical = deps.setCanonical ?? setPotCanonicalHomeSlug;

  try {
    // (1) VIEWS ONLY. Same `remote_hive` registry signal the joiner topic and the
    //     projection rebind key on, so this engages exactly when those do.
    const reg = await loadRegistry(workspaceId, { fresh: true });
    const entry = reg.projects.find((p) => p.slug === viewSlug);
    if (entry?.remote_hive !== true) {
      return { ok: false, reason: 'not_a_joined_view', local: viewSlug };
    }

    // (2) The pubkey — the only sound key. Prefer the identity row; fall back to the
    //     coord join-hive stamps on the registry view (present on joins made after
    //     that stamping landed, and the leg that answers before the identity row is
    //     written).
    const row = await getPot(workspaceId, viewSlug);
    const pubkey =
      row?.pubkeyBase64 ??
      (typeof (entry as { hive_pubkey?: unknown }).hive_pubkey === 'string'
        ? ((entry as { hive_pubkey?: string }).hive_pubkey as string)
        : undefined);
    if (!row || !pubkey) {
      return { ok: false, reason: 'no_identity_row', local: viewSlug };
    }

    // (3) The owner's authored slug, BY PUBKEY. Synthetic descriptors are skipped
    //     inside loadAnnouncedHiveHomeSlug — see the header note.
    const canonical = await loadAnnounced(workspaceId, pubkey);
    if (!canonical) {
      return { ok: false, reason: 'no_announced_slug', local: viewSlug };
    }

    // (4) Already true (the overwhelmingly common case, incl. every healthy joiner
    //     whose handle agrees with the owner's) — no write.
    if (row.canonicalHomeSlug === canonical) {
      return { ok: true, changed: false, local: viewSlug, canonical };
    }

    const res = await setCanonical(workspaceId, viewSlug, canonical);
    if (!res.ok) {
      return { ok: false, reason: res.reason as ReconcileSkipReason, local: viewSlug };
    }

    if (res.changed) {
      // Loud on purpose: this line is the receipt that a joiner's federated scope
      // moved, and it is what an operator correlates against the roster filling in.
      console.warn(
        `[pot-canonical-slug] reconciled joined view '${viewSlug}' -> federated scope ` +
          `'${canonical}' (matched by pubkey; local handle unchanged). ` +
          `pot_members rows for this Pot now have an FK parent.`,
      );
    }
    return { ok: true, changed: res.changed, local: viewSlug, canonical };
  } catch (e) {
    return {
      ok: false,
      reason: 'error',
      local: viewSlug,
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Reconcile EVERY joined view in the workspace. The boot-path entry point: a joiner
 * may hold several views, and the one whose scope is wrong is not knowable up front.
 * Best-effort per view — one failure never aborts the sweep.
 */
export async function reconcileAllJoinedPotCanonicalSlugs(
  workspaceId: string,
  deps: ReconcilePotCanonicalSlugDeps = {},
): Promise<{ reconciled: number; changed: number; results: ReconcilePotCanonicalSlugResult[] }> {
  const loadRegistry = deps.loadRegistry ?? loadHarnessRegistry;
  let views: string[] = [];
  try {
    const reg = await loadRegistry(workspaceId, { fresh: true });
    views = reg.projects.filter((p) => p.remote_hive === true).map((p) => p.slug);
  } catch {
    return { reconciled: 0, changed: 0, results: [] };
  }
  const results: ReconcilePotCanonicalSlugResult[] = [];
  for (const slug of views) {
    results.push(await reconcilePotCanonicalSlug(workspaceId, slug, deps));
  }
  return {
    reconciled: results.filter((r) => r.ok).length,
    changed: results.filter((r) => r.ok && r.changed).length,
    results,
  };
}
