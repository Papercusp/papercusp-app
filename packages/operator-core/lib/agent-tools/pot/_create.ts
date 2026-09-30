/**
 * createPotHarness — provision a new local pot's home harness
 * (hive-tool-namespace-2026-06-08 P-004, D-005).
 *
 * Composes the SAME primitives `harness:create` uses (blueprint resolve+validate,
 * dir provision, registry, schema scaffold, blueprint.yaml, trigger
 * materialization) for the built-in `hive` (kind:'hive') blueprint — but with two
 * pot-specific differences:
 *   1. it stamps `harness_kind: 'hive'` on the registry entry (harness:create
 *      never sets harness_kind, so resolvePot could not otherwise find it), and
 *   2. it optionally fires the initial Mug wake (a ROOT, parentless launch).
 *
 * Transactional: each side effect pushes an undo onto a stack; a failure rolls
 * them back in reverse so a half-made pot (registered, no schema, dangling dir)
 * never lingers (D-005). The pot is a built-in blueprint with no external deps,
 * so the cupboard dependency-validation gate in harness:create is intentionally
 * omitted here.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { getOrgPg } from '@papercusp/db-org';
import type { DeploymentConfig } from '@papercusp/deployment-driver';
import { loadHarnessRegistry, saveHarnessRegistry } from '../../harness-registry';
import { pinRepoKey } from '../../sync/pot-git/repo-identity';
import { operatorResolveExtends, availableHiveBlueprintIds } from '../../blueprint/installed-blueprints';
import { resolveAndValidate } from '../blueprint/_resolve';
import { POT_BLUEPRINT_ID, declarePotTimeWake, recordPotWake } from '../../pot/wake';
import { POT_KIND } from './_resolve';

export interface CreatePotOpts {
  slug: string;
  workspaceId: string;
  /** Parent dir for the home-harness folder. Default ~/.papercusp/hives. */
  parentDir?: string;
  /**
   * LINK an EXISTING local repo in place as the pot home, instead of
   * provisioning a fresh dir under `parentDir/slug` ("every created Pot is a
   * pot" — the standalone/plain-harness path is being retired). When set, the
   * resolved path is used AS-IS: the fresh-dir creation and the dest_exists
   * guard are skipped (the path must already exist → `path_not_found` if not),
   * and the dir-removal undo is a NO-OP — a rollback must NEVER delete the
   * user's existing repo. Steps 2-6 (register harness_kind:'hive', mint
   * identity, scaffold schema, write <path>/.papercusp/blueprint.yaml, arm
   * wakes) proceed unchanged with this path. `parentDir` is ignored when set.
   */
  existingPath?: string;
  deployment?: DeploymentConfig;
  /** Wake the Mug `wakeInSeconds` from now (0 = immediately). Omit ⇒ create
   *  idle (no wake declared; wake later via pot:wake / pot:declare-wake). */
  wakeInSeconds?: number;
  kickoff?: string;
  /**
   * Knowledge pack to seed into the pot's `pot:<slug>` memory pool
   * (learning-packs-2026-06-11 P-005). Omit ⇒ the default pack (D-004);
   * `null` ⇒ seed nothing. Flag-gated (KNOWLEDGE_PACKS) + best-effort —
   * a seed failure never fails the create.
   */
  knowledgePack?: string | null;
  /** Project shapes from blueprint detection — filters `applies_to`-tagged
   *  learnings (D-002). Omit (repo-less) ⇒ `any`-tagged items only. */
  projectShapes?: import('../../knowledge-packs/pack-format').AppliesTo[];
  /** metadata.created_by on seeded rows. Default 'system'. */
  createdBy?: string;
  /**
   * Provision the per-POT learning loop (gym + scout) at create
   * (per-pot-learning-loops P-020, D-003/D-008). `false` ⇒ skip; omit ⇒
   * provision when the PER_POT_LEARNING_LOOPS flag is on. Flag-gated +
   * best-effort — a provision failure warns and reports, never fails the create.
   */
  provisionLearningLoop?: boolean;
  /**
   * The kind:'hive' blueprint id to provision + launch (pot-blueprint-generalization
   * P-006). Default POT_BLUEPRINT_ID ('hive', the coding pot); 'work' for a
   * non-coding pot. Resolved local → installed → built-in.
   */
  blueprintId?: string;
  /**
   * Remote-publish policy for a FRESH coding-pot repo (per-pot-git-and-release-gate
   * D-003). 'auto' (default) ⇒ create a PRIVATE GitHub remote + push when git creds are
   * present (gh auth), else stay local-only. 'local-only' ⇒ never create a remote. Only
   * the fresh-init path consults this; a linked/cloned repo keeps its own remote.
   */
  repoRemote?: 'auto' | 'local-only';
  /** gh owner/org for the auto-created remote; default = the authenticated login. */
  repoOwner?: string;
}

export interface SeededLearningsSummary {
  packId: string;
  packVersion?: string;
  count?: number;
  error?: string;
}

export interface ProvisionedLoopSummary {
  /** The dark gym_autoloop_config row was laid down (enabled:false, budget:null). */
  gymAutoloop?: boolean;
  /** The inactive scout routine was laid down under the pot's install_slug. */
  scoutRoutine?: boolean;
  /** Per-cycle scout budget the routine carries (USD). */
  scoutMaxCostUsd?: number;
  error?: string;
}

export interface CreatePotResult {
  ok: boolean;
  slug?: string;
  path?: string;
  waked?: boolean;
  /** Present when seeding was attempted (knowledge-packs P-005). */
  seededLearnings?: SeededLearningsSummary;
  /**
   * One entry per SHARED co-seed pack actually attempted (knowledge-packs/co-seed
   * — `fleet-lessons`, `papercusp`), in seed order. Present only when at least one
   * was attempted; a pack that is absent, empty, or IS the declared pack is not
   * attempted and so has no entry.
   *
   * This is REPORTED rather than only logged so the co-seed is observable by a
   * caller and assertable by a test. Before this, the one co-seed was a
   * `console.log` and nothing could see whether it had happened.
   */
  coSeededLearnings?: SeededLearningsSummary[];
  /** Present when per-pot learning-loop provisioning was attempted (P-020). */
  provisionedLoop?: ProvisionedLoopSummary;
  /** Present when a fresh coding-pot repo was finalized — commit + branch + optional
   *  remote publish (per-pot-git-and-release-gate P-003/P-004). */
  repoInit?: PotRepoInitSummary;
  error?: string;
  message?: string;
}

export interface PotRepoInitSummary {
  /** The integration branch the fresh repo is on (default 'staging'). */
  branch: string;
  /** true when the initial scaffold commit was made (fresh repo; false for link/clone). */
  committed: boolean;
  /** 'remote' = a GitHub remote was set; 'local-only' = no remote (creds absent/disabled/failed). */
  remoteMode: 'remote' | 'local-only';
  /** The remote URL when remoteMode==='remote'. */
  remote?: string;
  /** Why local-only (no_git_credentials, no_owner_resolved, gh_repo_create_failed: …). */
  remoteReason?: string;
}

export async function createPotHarness(opts: CreatePotOpts): Promise<CreatePotResult> {
  const ws = opts.workspaceId;

  const reg = await loadHarnessRegistry(ws);
  if (reg.projects.some((p) => p.slug === opts.slug)) {
    return { ok: false, error: 'slug_exists', message: `A harness '${opts.slug}' already exists in this workspace.` };
  }

  // Resolve + validate the chosen kind:'hive' blueprint (default the coding `hive`;
  // 'work' for a non-coding pot — pot-blueprint-generalization P-006).
  // EI-3388: when linking an EXISTING repo as the pot home (opts.existingPath),
  // also check ITS `.papercusp/blueprints` as a local resolver tier — the same
  // local -> installed -> built-in composition harness:create already applies
  // for its `path` arg (see agent-tools/harness/create.ts). Before this fix
  // pot:create passed localDirs:[] unconditionally, so a pot-scoped blueprint
  // authored in an existing repo's `.papercusp/blueprints/<id>/` (a custom
  // `extends` parent, e.g. an ops/scout variant) could never resolve without a
  // manual copy into the global `~/.papercusp/blueprints` installed tier.
  const blueprintId = opts.blueprintId ?? POT_BLUEPRINT_ID;
  const resolver = operatorResolveExtends({
    localDirs: opts.existingPath != null ? [join(resolvePath(opts.existingPath), '.papercusp', 'blueprints')] : [],
  });
  const childObj: Record<string, unknown> = { id: opts.slug, extends: blueprintId };
  const validation = resolveAndValidate(childObj, resolver);
  if (validation.parseError || !validation.ok || !validation.blueprint) {
    return {
      ok: false,
      error: 'blueprint_invalid',
      message: validation.parseError ?? 'the pot blueprint failed to resolve/validate',
    };
  }
  // P-019: a pot MUST run a kind:'pot' blueprint — reject a harness blueprint
  // (e.g. `research`) passed by mistake, and surface the installable pot templates so
  // the choice is discoverable (the "selectable at create" picker's validation backbone).
  if (validation.blueprint.kind !== 'pot') {
    const choices = availableHiveBlueprintIds();
    return {
      ok: false,
      error: 'not_a_hive_blueprint',
      message:
        `Blueprint "${blueprintId}" is kind:'${validation.blueprint.kind}', not a pot — pot:create needs a ` +
        `kind:'pot' blueprint. Available pot blueprints: ${choices.length ? choices.join(', ') : '(none found)'}.`,
    };
  }
  const requiresRepo = validation.blueprint.knobs.requiresRepo !== false;

  // LINK-EXISTING mode: when `existingPath` is set, use it as the pot home AS-IS
  // — skip the fresh-dir provision below AND the dest_exists guard; instead the
  // path must already exist (path_not_found if not). Otherwise (fresh mode) the
  // home is a new dir at parentDir/slug and dest_exists guards against a clash.
  const linkExisting = typeof opts.existingPath === 'string' && opts.existingPath.trim() !== '';

  // CODING hives MUST be backed by a git repo (per-hive-git-and-release-gate-2026-06-29
  // D-002): a repo-commit-output blueprint that would end up repo-less — neither linking/
  // cloning an existing repo NOR initializing a fresh one (requiresRepo:false) — is
  // rejected here. It is impossible to create a coding pot without either cloning an
  // existing repo or initializing a new one. `output.kind` is the INDEPENDENT coding
  // signal (defaults to 'repo-commit'); the non-coding `work` profile
  // (output.kind:'artifacts') is exempt and may be repo-less (its repo, if any, is
  // backup-only). Using output.kind (not requiresRepo) avoids a circular guard.
  const outputKind = validation.blueprint.output?.kind ?? 'repo-commit';
  const isCodingProfile = outputKind === 'repo-commit';
  if (isCodingProfile && !linkExisting && !requiresRepo) {
    return {
      ok: false,
      error: 'hive_requires_repo',
      message:
        `Coding pot "${opts.slug}" (blueprint "${blueprintId}", output.kind=repo-commit) must be backed by a ` +
        `git repo. Either link/clone an existing repo (existingPath / pot:create_from_repo) or use a blueprint ` +
        `with knobs.requiresRepo:true so a fresh repo is initialized. A repo-less coding pot is not allowed.`,
    };
  }

  const parentDir = opts.parentDir ?? join(homedir(), '.papercusp', 'hives');
  // Fresh-install fix (shared-pot-member-content-federation D-035): on a brand-new
  // machine the DEFAULT pot-home parent (~/.papercusp/hives) does not exist yet, and
  // initLocalHarnessDir hard-fails ('parent_missing') rather than creating it — so the
  // FIRST pot create/from-repo on a clean install errors ("Parent directory does not
  // exist: …/.papercusp/hives"; pinned live on a fresh Hetzner VM). Ensure the default
  // parent exists. A caller-PROVIDED parentDir keeps the existsSync guard (intentional —
  // never auto-create an arbitrary user-named path).
  if (!opts.parentDir) {
    try {
      mkdirSync(parentDir, { recursive: true });
    } catch {
      // best-effort — initLocalHarnessDir still guards + surfaces a clear error.
    }
  }
  const dest = linkExisting
    ? resolvePath(opts.existingPath!.trim())
    : resolvePath(join(parentDir, opts.slug));
  if (linkExisting) {
    if (!existsSync(dest)) {
      return { ok: false, error: 'path_not_found', message: `Path to link does not exist: ${dest}` };
    }
  } else if (existsSync(dest)) {
    return { ok: false, error: 'dest_exists', message: `Destination already exists: ${dest}` };
  }

  // ── side effects begin: each pushes an undo; rollback runs them in reverse ──
  const undo: Array<() => Promise<void> | void> = [];
  const rollback = async () => {
    for (const u of undo.reverse()) {
      try {
        await u();
      } catch {
        /* best-effort cleanup */
      }
    }
  };

  try {
    // 1. Provision the dir (pot is normally repo-less; honor the blueprint knob).
    //    LINK-EXISTING: the dir already exists (verified above) — use it AS-IS,
    //    do NOT create a fresh one, and the removal undo is a NO-OP so a rollback
    //    never deletes the user's existing repo (only the registry/identity/schema
    //    undos apply in link mode).
    let path: string;
    if (linkExisting) {
      path = dest;
      undo.push(() => {
        /* link mode: NEVER delete the user's existing repo on rollback */
      });
    } else {
      if (requiresRepo) {
        const { initLocalHarnessDir } = await import('../../harness/init-local-dir');
        const init = await initLocalHarnessDir({ parentDir, folderName: opts.slug });
        path = init.path;
      } else {
        mkdirSync(dest, { recursive: true });
        path = dest;
      }
      undo.push(() => {
        try {
          rmSync(path, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      });
    }

    // 2. Register with harness_kind:'hive' (the marker resolvePot filters on —
    //    harness:create does NOT set this, so the pot path must).
    const fresh = await loadHarnessRegistry(ws);

    // WI-3646: LINK-EXISTING mode creates a NEW pot-home registry entry at `dest`,
    // but any PRE-EXISTING harness registry entry that already lives at that same
    // path (the common case: `pot:create { existingPath }` turning an already-running
    // harness into a pot-home) never had its OWN `hive_slug` backfilled — only the
    // JOIN path (`_create_from_repo.ts`'s `hive_slug: potSlug` write) does that. Without
    // it, `potHomeSlugForHarness`/`resolvePotSwarmBinding` return null for that harness
    // and it never binds to any swarm topic — it silently never federates with the rest
    // of the pot it supposedly owns (confirmed live: rig-a's `hello-world` harness vs.
    // its own `hello-world-pot`). Backfill `hive_slug` onto every sibling entry sharing
    // this path so it resolves its swarm binding correctly from here on.
    if (linkExisting) {
      let backfilled = false;
      for (const p of fresh.projects) {
        if (p.slug !== opts.slug && resolvePath(p.path) === dest && p.hive_slug !== opts.slug) {
          p.hive_slug = opts.slug;
          backfilled = true;
        }
      }
      if (backfilled) {
        undo.push(async () => {
          const r = await loadHarnessRegistry(ws);
          for (const p of r.projects) {
            if (p.path && resolvePath(p.path) === dest && p.hive_slug === opts.slug) {
              delete p.hive_slug;
            }
          }
          await saveHarnessRegistry(r, ws, { allowEmpty: true });
        });
      }
    }

    fresh.projects.push({
      slug: opts.slug,
      path,
      harness_kind: POT_KIND,
      // A pot backed by a git repo IS its own checkout → mark self_repo so git-sync commits
      // its tree. TWO repo-backed paths set it now: LINK-existing (an existing repo, papercup→
      // papercusp Option-B merge 2026-06-20) AND FRESH-init (a coding pot gets a fresh repo,
      // requiresRepo:true — per-pot-git-and-release-gate D-002/P-003). Without self_repo a
      // self-repo pot is git-sync-ineligible ('hive_home') and origin freezes (the 2026-06-20
      // incident). A repo-less pot home (non-coding, requiresRepo:false, no existingPath) stays
      // unmarked.
      ...(linkExisting || requiresRepo ? { self_repo: true } : {}),
      ...(opts.deployment && opts.deployment.target !== 'local' ? { deployment: opts.deployment } : {}),
    });
    await saveHarnessRegistry(fresh, ws);
    undo.push(async () => {
      const r = await loadHarnessRegistry(ws);
      await saveHarnessRegistry(
        { ...r, projects: r.projects.filter((p) => p.slug !== opts.slug) },
        ws,
        { allowEmpty: true },
      );
    });

    // 2b. Mint the Pot's first-class identity — a per-Pot Ed25519 keypair (secret
    //     in the OS keychain) + the entity row in PG (shared-pot-federation P-002;
    //     the pubkey is the dial-able id + federation topic key, P-003). Best-effort:
    //     a transient keychain/PG hiccup must not fail an otherwise-good create —
    //     resolvePot lazy-backfills the identity on first read. On success, push the
    //     undo so a later-step failure rolls the entity row back too.
    try {
      const { ensureHiveIdentity: ensurePotIdentity } = await import('../../hive-identity');
      await ensurePotIdentity(ws, opts.slug);
      undo.push(async () => {
        const { deleteHive: deletePot } = await import('../../hive-store');
        await deletePot(ws, opts.slug).catch(() => {});
      });
    } catch (e) {
      console.warn(
        `[pot:create] pot identity mint failed (${opts.slug}); resolvePot will lazy-backfill it: ${e instanceof Error ? e.message : e}`,
      );
    }

    // 3. Provision the harness PG schema (the inverse of dissolve's schema drop).
    const { scaffoldHarnessSchema, dropHarnessSchema } = await import('../../scaffold-harness-schema');
    await scaffoldHarnessSchema(opts.slug);
    undo.push(async () => {
      await dropHarnessSchema(opts.slug).catch(() => {});
    });

    // 4. Write the git-canonical blueprint file (the pot blueprint).
    const bpDir = join(path, '.papercusp');
    mkdirSync(bpDir, { recursive: true });
    writeFileSync(join(bpDir, 'blueprint.yaml'), stringifyYaml(childObj, { lineWidth: 100 }), 'utf8');

    // 5. Materialize the pot blueprint's triggers (best-effort, like harness:create).
    try {
      const { materializeBlueprintTriggers } = await import('../../blueprint/materialize-triggers');
      await materializeBlueprintTriggers(opts.slug, validation.blueprint);
    } catch (e) {
      console.warn(`[pot:create] materialize triggers failed (${opts.slug}): ${e instanceof Error ? e.message : e}`);
    }

    // 6. Arm the Mug's DEFAULT event-wake subscriptions (start-pot-wake
    //    P-002 / D-001): plan-started / work-item-created / escalation-raised.
    //    REPLACE — a fresh pot has no tuned policy to preserve. Best-effort:
    //    pot:start re-affirms (ENSURE) so a transient failure here self-heals.
    //    The helper is retirement-aware: after P-068 it is a no-op, because a
    //    newly-created Pot is still a valid container but `pot:wake` refuses.
    try {
      const { armDefaultPotWakeSubscriptions, blueprintWakeSubscriptions } = await import(
        '../../pot/wake-defaults'
      );
      // P-013: a pot blueprint may declare its own `wake.subscriptions`; absent
      // (today's coding pot + generic-pot) → the universal three defaults apply.
      // REPLACE here is the behavior-determining arm; pot:start's ENSURE preserves it.
      await armDefaultPotWakeSubscriptions(ws, {
        mode: 'replace',
        subscriptions: blueprintWakeSubscriptions(validation.blueprint.wake),
        installSlug: opts.slug,
      });
    } catch (e) {
      console.warn(
        `[pot:create] default wake-subscription arm failed (${opts.slug}): ${e instanceof Error ? e.message : e}`,
      );
    }

    // 6b. Seed the selected knowledge pack into the pot's `pot:<slug>` memory
    //     pool (knowledge-packs P-005, D-001 copy-not-link). Flag-gated +
    //     best-effort: a seed failure warns and reports, never fails the
    //     create — but a LATER step failure rolls seeded rows back (the undo
    //     joins the stack). Runs before the first wake so the Mug's opening
    //     turn already recalls the pack.
    let seededLearnings: SeededLearningsSummary | undefined;
    // One entry per SHARED co-seed pack actually attempted. Reported on the
    // result (not just logged) so the co-seed is observable and assertable.
    const coSeededLearnings: SeededLearningsSummary[] = [];
    if (opts.knowledgePack !== null) {
      // EI-1539: imported OUTSIDE the try so the catch below can name the default
      // pack too — the error path must never hardcode a pack id, or it reports a
      // pack that stops existing the moment the default is repointed.
      const { DEFAULT_KNOWLEDGE_PACK_ID } = await import('../../knowledge-packs/pack-format');
      // Records the pack we actually resolved, so a seed failure reports the REAL
      // pack (including a blueprint-declared one) instead of re-deriving a guess
      // that cannot see `seed.packId`.
      let attemptedPackId: string | undefined;
      try {
        const [{ getFlag }, { FLAGS }] = await Promise.all([
          import('@papercusp/flags/server'),
          import('@papercusp/flags'),
        ]);
        if (await getFlag(FLAGS.KNOWLEDGE_PACKS, 'system')) {
          const { loadKnowledgePack } = await import('../../knowledge-packs/load-packs');
          const { seedPackIntoHive: seedPackIntoPot } = await import('../../knowledge-packs/seed');
          // P-014: an explicit arg wins; else the blueprint's declared seed pack
          // (a generic-pot can seed a different pack); else the global default.
          //
          // resolveSeedPackKey reads BOTH the canonical `knowledge.pack` and the
          // pre-rename `learning.pack` (blueprint YAML is a true boundary under
          // knowledge-packs-2026-07-11 D-001 — we never rewrite a user's installed
          // blueprint). It also arbitrates the case where an old blueprint extends
          // a renamed first-party base, so an author's explicit legacy choice is
          // never silently replaced by the base's inherited pack. See its header.
          const { resolveSeedPackKey } = await import('../../knowledge-packs/seed-pack-key');
          const seed = resolveSeedPackKey(validation.blueprint);
          if (seed.deprecatedKey && seed.packId) {
            console.warn(
              `[pot:create] blueprint '${validation.blueprint.id}' declares the deprecated ` +
                `\`learning.pack\` key — rename it to \`knowledge.pack\` ` +
                (seed.conflict
                  ? `(it is overriding the inherited \`knowledge.pack: ${seed.conflict.knowledge}\`, ` +
                    `so '${seed.conflict.learning}' is being seeded)`
                  : `(seeding '${seed.packId}')`),
            );
          }
          const packId = opts.knowledgePack ?? seed.packId ?? DEFAULT_KNOWLEDGE_PACK_ID;
          attemptedPackId = packId;
          const loaded = await loadKnowledgePack(packId);
          if (!loaded) {
            seededLearnings = { packId, error: 'pack_not_found' };
            console.warn(`[pot:create] knowledge pack '${packId}' not found; seeding skipped (${opts.slug})`);
          } else {
            const res = await seedPackIntoPot({
              workspaceId: ws,
              potSlug: opts.slug,
              pack: loaded.pack,
              ...(opts.projectShapes ? { shapes: opts.projectShapes } : {}),
              ...(opts.createdBy ? { createdBy: opts.createdBy } : {}),
            });
            undo.push(res.undo);
            seededLearnings = {
              packId: res.packId,
              packVersion: res.packVersion,
              count: res.seeded,
              ...(res.error ? { error: res.error } : {}),
            };
          }
          // A new pot ALSO seeds the SHARED co-seed packs (knowledge-packs/co-seed:
          // `fleet-lessons` — cross-hive lessons adopted from the candidate loop,
          // knowledge-pack-loop-integrity-2026-07-19 P-006a; and `papercusp` —
          // tier-1 PRODUCT knowledge, memory-corpus-hygiene-and-release-distribution-2026-08-03
          // D-003/D-008) so it starts current instead of waiting for the delivery
          // routine's next tick. Best-effort + undo-stacked like the blueprint
          // pack; a pack that is absent, empty, or IS the declared pack is skipped.
          //
          // The try/catch is PER PACK, deliberately: with a list, a single
          // wrapping catch would let the first failing pack silently suppress
          // every pack after it — the co-seed equivalent of a swallowed loop.
          //
          // The OUTER try guards only the list import: without it a co-seed
          // failure would fall through to the declared-pack catch below and
          // overwrite a SUCCESSFUL `seededLearnings` with an error — reporting
          // the blueprint pack as failed because a shared pack was not.
          try {
            const { CO_SEED_PACK_IDS } = await import('../../knowledge-packs/co-seed');
            for (const coSeedPackId of CO_SEED_PACK_IDS) {
              if (coSeedPackId === packId) continue; // already seeded as the declared pack
              try {
                const shared = await loadKnowledgePack(coSeedPackId);
                if (!shared || shared.pack.items.length === 0) continue;
                const sr = await seedPackIntoPot({
                  workspaceId: ws,
                  potSlug: opts.slug,
                  pack: shared.pack,
                  ...(opts.projectShapes ? { shapes: opts.projectShapes } : {}),
                  ...(opts.createdBy ? { createdBy: opts.createdBy } : {}),
                });
                undo.push(sr.undo);
                coSeededLearnings.push({
                  packId: coSeedPackId,
                  packVersion: sr.packVersion,
                  count: sr.seeded,
                });
                console.log(
                  `[pot:create] seeded ${coSeedPackId} v${sr.packVersion} (${sr.seeded} learning(s)) into ${opts.slug}`,
                );
              } catch (e) {
                const coSeedMsg = e instanceof Error ? e.message : String(e);
                coSeededLearnings.push({ packId: coSeedPackId, error: coSeedMsg.slice(0, 200) });
                console.warn(
                  `[pot:create] ${coSeedPackId} co-seed failed (${opts.slug}, best-effort): ${coSeedMsg}`,
                );
              }
            }
          } catch (e) {
            console.warn(
              `[pot:create] co-seed pack list unavailable (${opts.slug}, best-effort): ${e instanceof Error ? e.message : e}`,
            );
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[pot:create] knowledge-pack seed failed (${opts.slug}): ${msg}`);
        seededLearnings = {
          packId: attemptedPackId ?? opts.knowledgePack ?? DEFAULT_KNOWLEDGE_PACK_ID,
          error: msg.slice(0, 200),
        };
      }
    }

    // 6c. Provision this pot's OWN per-pot learning loop (per-pot-learning-loops
    //     P-020, D-003/D-008): a DARK gym_autoloop_config row + an INACTIVE scout
    //     routine, BOTH keyed to the pot's own install_slug (NOT @singleton —
    //     that's reserved for the workspace-singleton frontier loops, D-008). Both
    //     ship inert (the gym tick doubly refuses a disabled+unbudgeted row; an
    //     inactive routine never fires) — the owner arms each via the gym/routines
    //     UI. Same contract as the knowledge-pack seed above: flag-gated +
    //     best-effort (a failure warns and reports, NEVER fails the create), and a
    //     LATER step failure rolls the rows back (the undo joins the stack). The
    //     matching teardown at pot:dissolve is P-021.
    let provisionedLoop: ProvisionedLoopSummary | undefined;
    if (opts.provisionLearningLoop !== false) {
      try {
        const [{ getFlag }, { FLAGS }] = await Promise.all([
          import('@papercusp/flags/server'),
          import('@papercusp/flags'),
        ]);
        if (await getFlag(FLAGS.PER_POT_LEARNING_LOOPS, 'system')) {
          const { provisionPotLearningLoop } = await import('../../pot/provision-learning-loop');
          const { sql } = getOrgPg();
          const res = await provisionPotLearningLoop({ sql, workspaceId: ws, potSlug: opts.slug });
          undo.push(res.undo);
          provisionedLoop = {
            gymAutoloop: res.gymAutoloop,
            scoutRoutine: res.scoutRoutine,
            ...(res.scoutMaxCostUsd != null ? { scoutMaxCostUsd: res.scoutMaxCostUsd } : {}),
            ...(res.error ? { error: res.error } : {}),
          };
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[pot:create] per-pot learning-loop provision failed (${opts.slug}): ${msg}`);
        provisionedLoop = { error: msg.slice(0, 200) };
      }
    }

    // 6d. Arm this pot's OWN cross-Pot outbox-drain routine. Without it a pot's
    //     substrate_outbox is never reconciled — every federated-table write enqueues
    //     a row and they grow unbounded (papercusp hit 24k undrained, 2026-06-19,
    //     because only the operator-home install was ever seeded). The drain action
    //     self-gates to a no-op when the pot has no published peers, so seeding it
    //     ACTIVE is safe. Best-effort + undo, like the learning-loop above; the
    //     matching teardown is in teardownPotLearningLoop (pot:dissolve).
    try {
      const { armHiveCrossHiveDrainRoutine } = await import('../../harness/routines/arm-hive-cross-hive-drain');
      const { sql } = getOrgPg();
      const armed = await armHiveCrossHiveDrainRoutine({ sql, workspaceId: ws, potSlug: opts.slug });
      undo.push(armed.undo);
    } catch (e) {
      console.warn(
        `[pot:create] arm cross-pot-outbox-drain failed (${opts.slug}): ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    // 6b. Record the MUG-HOME device pubkey (domain-generic-pot P-021 / I2 /
    //     closes mug-guard.ts D-008). The creating node IS this Pot's Mug home
    //     in the local flow, so stamp its device pubkey into hive_settings — a
    //     federated setting the steering lease asserts HOME-SWARM against before a
    //     cross-Swarm steer (steering-lease.checkSteeringLease → evaluateMugTurnGate),
    //     so a second Swarm with a lower pubkey can't silently usurp steering from the
    //     node the owner actually deployed the Mug on. Best-effort + undo (a later
    //     step failure rolls it back); a resolution failure WARNS and leaves the home
    //     unset (the lease then falls back to the lock-authority election — unchanged).
    //     NOTE: a cloud deploy:pot that places the Mug on a DIFFERENT node should
    //     override this at placement time (the cloud-placement follow-on; the local
    //     create flow — the only one exercisable today — is correct here).
    try {
      const { resolveUsageActor } = await import('../../harness/usage-actor');
      const self = await resolveUsageActor();
      if (self?.devicePubkey) {
        const { setQueenHomePubkey, deleteHiveSetting, QUEEN_HOME_PUBKEY_SETTING_KEY } = await import(
          '../../hive-settings-store'
        );
        await setQueenHomePubkey(ws, opts.slug, self.devicePubkey);
        undo.push(async () => {
          try {
            await deleteHiveSetting(ws, opts.slug, QUEEN_HOME_PUBKEY_SETTING_KEY);
          } catch {
            /* best-effort rollback */
          }
        });
        // WI-280: self-register the OWNER in hive_members at create. Two membership-population gaps
        // minted 0 epoch keys live: (1) open-mode auto-admit never upserted the joiner (fixed at the
        // boot.ts admit seam), (2) NOTHING registered the owner at create — so after a member is
        // revoked the boundary's remaining-member wrap-set (loadAllPotMemberDevicePubkeys) was empty
        // and the re-key could not advance. upsertPotMember INSERTs the row + grants [0..current] to
        // the owner's device. device_pubkey is the RAW base64 form (resolveUsageActor.devicePubkey),
        // wrap-consistent with the joiner's frame.device_pubkey — NOT the ed25519:-tagged contributor-
        // file form (wrapKeyToMember asserts 32 raw bytes). Best-effort: a membership-write hiccup must
        // NEVER fail create. Only device_pubkey is read by the live rekey/revoke paths, so the other
        // attestation fields are create-time placeholders (the projection's LWW refines the row later
        // when a real federated self-row with an HLC arrives).
        try {
          const [{ upsertHiveMember: upsertPotMember }, { resolveLocalGithubIdentity }, { unsafeFederatedPotScope }] =
            await Promise.all([
              import('../../hive-membership-store'),
              import('../../identity/resolve-local-github-identity'),
              import('../../federated-pot-scope'),
            ]);
          const gh = await resolveLocalGithubIdentity();
          if (gh.kind === 'ok') {
            await upsertPotMember({
              workspaceId: ws,
              // ⚠ SCOPE (WI-6312): certified, not resolved. This is pot CREATION — the creator
              // IS the owner, so the federated scope is this slug BY CONSTRUCTION; there is no
              // canonical slug to diverge from yet, and resolving would be a no-op read.
              potHomeSlug: unsafeFederatedPotScope(
                opts.slug,
                'pot creation: the creator is the owner, so canonical == local by construction',
              ),
              githubUserId: self.githubUserId,
              githubUsername: gh.githubLogin,
              deviceAttestations: [
                {
                  device_pubkey: self.devicePubkey,
                  gist_id: '',
                  gist_url: '',
                  device_label: 'owner-home',
                  created_at: Date.now(),
                  signature_by_device: '',
                },
              ],
              bindingStatus: 'verified',
            });
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // The owner self-row is BEST-EFFORT and FKs harness_shared.pots(workspace_id, home_slug). In a
          // fresh create the hives PARENT row is written by a later federation/keypair step (and in a
          // PG-free unit test the parent is never written), so an FK / parent-missing error here is the
          // EXPECTED no-op (the row is re-asserted when membership is next touched) — NOT a real failure,
          // so it must not trip vitest-fail-on-console (EI-1874). Stay silent for that case; surface any
          // other (genuine) failure as a warn. The live witness path has the parent, so the owner still
          // mints epoch-0 at create (members=1 proven live).
          if (!/hive_members_hive_fkey|foreign key|violates/i.test(msg)) {
             
            console.warn(`[pot:create] owner self-row upsert failed (${opts.slug}): ${msg}`);
          }
        }
      }
    } catch (e) {
      console.warn(
        `[pot:create] mug-home-pubkey record failed (${opts.slug}): ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    // 6e. Finalize a FRESH coding-pot repo (per-hive-git-and-release-gate-2026-06-29
    //     P-003/P-004, D-003). The home was `git init`'d empty (step 1); now that the
    //     scaffold (.papercusp/blueprint.yaml) is written, make the initial commit on the
    //     `staging` integration branch so git-sync has a real repo to push (a bare init
    //     with no commit/branch freezes origin — the 2026-06-20 incident). Then, by
    //     DEFAULT, publish to a PRIVATE GitHub remote when git creds are present (gh auth),
    //     else stay local-only — the local staging→main gate still runs (D-003). Only the
    //     fresh-init path runs (a linked/cloned repo keeps its own history/branch/remote).
    //     Best-effort: a failure here NEVER fails the create (a local repo is still valid).
    //     Placed last (just before the wake) so a created remote is never orphaned by a rollback.
    let repoInit: PotRepoInitSummary | undefined;
    if (!linkExisting && requiresRepo) {
      try {
        const { commitInitialHiveRepo, publishHiveRepo } = await import('../../harness/hive-repo-init');
        const committed = await commitInitialHiveRepo({ path, slug: opts.slug });
        let remote: string | undefined;
        let remoteMode: 'remote' | 'local-only' = 'local-only';
        let remoteReason: string | undefined;
        if ((opts.repoRemote ?? 'auto') !== 'local-only') {
          const publish = await publishHiveRepo({
            path,
            slug: opts.slug,
            ...(opts.repoOwner ? { owner: opts.repoOwner } : {}),
            branch: committed.branch,
          });
          remoteMode = publish.mode;
          remote = publish.remote;
          remoteReason = publish.reason;
          if (publish.mode === 'remote' && publish.remote) {
            // Record the remote so git-sync pushes it (push:true) and recovery/federation
            // resolve origin. Re-load the registry (earlier steps may have re-saved it).
            const reg2 = await loadHarnessRegistry(ws);
            const entry = reg2.projects.find((p) => p.slug === opts.slug);
            if (entry) {
              entry.github_remote = publish.remote;
              if (publish.repoId) entry.github_repository_id = publish.repoId;
              entry.github_default_branch = publish.defaultBranch ?? committed.branch;
              // EI-18788176839043286: stamping the coords above is the exact instant a
              // pot's pot-git repoKey would flip from `slug` to `gh-<id>` — a different
              // bare-store path AND a different wire key, which silently abandons the
              // old store and orphans every peer still keyed on it (live: the P-302 rig
              // sat 7 days on the tower's abandoned store while reporting ok:true).
              // PIN it so it can never drift again. Deliberately AFTER the stamp: this
              // is the fresh create+publish flow, no peer exists yet, so the
              // upstream-derived `gh-<id>` is the right value and a later joiner
              // derives the same one. (Pinning BEFORE the stamp would freeze it to the
              // bare slug and REGRESS the new-pot case — see the work-item.) Idempotent:
              // an entry already pinned by the boot backfill keeps its existing key,
              // which is what protects an ESTABLISHED pot from this same re-key.
              entry.pot_repo_key = pinRepoKey(entry);
              // A3: this device OWNS the pot, so its key is the one announced on
              // the member join links and adopted verbatim by every joiner —
              // whatever value it settles on becomes the shared one. Stamped
              // 'local' because it is still a local derivation (the owner never
              // joins its own pot, so nothing will ever override it).
              entry.pot_repo_key_source = 'local';
              await saveHarnessRegistry(reg2, ws);
            }
            if (publish.recoveredFromPushFailure) {
              // EI-7163: the FIRST `gh repo create --push` attempt's push leg silently
              // failed and a same-call retry recovered it — worth a loud log even though
              // the outcome is fine, since a persistent version of this same fault
              // degrades to the local-only branch below with no visible remote at all.
              console.warn(
                `[pot:create] ${opts.slug}: gh repo create's push leg failed on the first attempt and ` +
                  `recovered on retry (remote=${publish.remote}) — if this repeats, check gh's git_protocol ` +
                  `vs this box's ssh identity (EI-7163's root cause).`,
              );
            }
          } else if (publish.mode === 'local-only' && publish.reason?.startsWith('push_failed_after_remote_create')) {
            // EI-7163: the release-critical silent-degradation case — `gh repo create`
            // DID create a real remote GitHub repo (and `gh` already configured a local
            // `origin` pointing at it), but the push leg failed even on retry. Treating
            // this as an ordinary local-only outcome would silently strand a real,
            // unpushed remote repo with no operator-visible signal. Log loudly (not the
            // generic warn below) with the orphaned remote so a human/agent can manually
            // `git push` it or clean it up.
            console.error(
              `[pot:create] ${opts.slug}: gh created a remote repo (${publish.remote ?? 'origin'}) but BOTH ` +
                `push attempts failed — the remote is configured locally but UNPUSHED (not orphan-cleaned; ` +
                `a manual \`git -C ${path} push -u origin ${committed.branch}\` or repo deletion may be needed). ` +
                `reason=${publish.reason}`,
            );
          }
        }
        repoInit = {
          branch: committed.branch,
          committed: committed.committed,
          remoteMode,
          ...(remote ? { remote } : {}),
          ...(remoteReason ? { remoteReason } : {}),
        };
      } catch (e) {
        console.warn(
          `[pot:create] fresh-repo finalize failed (${opts.slug}); the pot keeps its local repo: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    // 6f. Seed the per-pot pipeline routines for a self_repo pot home
    //     (per-hive-git-and-release-gate-2026-06-29 P-009): git-sync (so the home's
    //     `staging` accumulates + pushes commits — a self_repo home IS git-sync-eligible)
    //     AND the staging→main green-checkpoint (flag-gated PER_POT_RELEASE_GATE,
    //     default-OFF → a no-op until the owner opts a pot in; D-008). Both best-effort —
    //     a failure NEVER fails the create. The release-routine undo joins the rollback
    //     stack. Runs for any self_repo home (fresh OR linked); skipped for a repo-less
    //     (non-coding) home. seedHiveReleaseRoutines self-gates (skips the operator-home +
    //     non-coding/repo-less); git-sync self-gates via its eligibility check.
    const hasOwnRepo = linkExisting || requiresRepo;
    if (hasOwnRepo) {
      const regNow = await loadHarnessRegistry(ws);
      const homeEntry = regNow.projects.find((p) => p.slug === opts.slug);
      if (homeEntry) {
        try {
          const { seedGitSyncRoutineForMember } = await import('../../harness/git-sync/git-sync-routine');
          await seedGitSyncRoutineForMember({
            workspaceId: ws,
            installSlug: opts.slug,
            entry: homeEntry,
            joinerSide: false,
          });
        } catch (e) {
          console.warn(
            `[pot:create] git-sync seed failed (${opts.slug}): ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        try {
          const { seedHiveReleaseRoutines } = await import('../../harness/routines/seed-hive-release-routines');
          const { sql } = getOrgPg();
          const seeded = await seedHiveReleaseRoutines({ sql, workspaceId: ws, potSlug: opts.slug });
          if (seeded.seeded) undo.push(seeded.undo);
        } catch (e) {
          console.warn(
            `[pot:create] release-routine seed failed (${opts.slug}): ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }

    // 7. Initial wake (optional): fire the Mug now, or declare a time wake.
    //    ROOT launch (no `parent`) — the no-nest guard passes for a parentless pot.
    let waked = false;
    if (opts.wakeInSeconds != null) {
      const seededNote =
        seededLearnings && !seededLearnings.error && (seededLearnings.count ?? 0) > 0
          ? ` Your pot's shared memory was pre-seeded with ${seededLearnings.count} learnings from the '${seededLearnings.packId}' pack — starting wisdom, editable, not gospel; run convention discovery to bind its discovery rules to this project.`
          : '';
      const kickoff =
        opts.kickoff ??
        `Pot '${opts.slug}' created. You are the operator in charge; survey the fleet and figure out what to do.${seededNote}`;
      if (opts.wakeInSeconds <= 0) {
        // Lazy: fireLaunchBlueprint's module (blueprint/launch-blueprint) transitively
        // pulls in the fleet spawn machinery -> work-items -> the whole sync/hyperbee
        // projection-registration graph (boot-all). Loading that eagerly at module scope
        // dragged every createPotHarness caller/test into that heavy graph even on the
        // (common) no-wake path that never calls this. Every other side-effecting
        // subsystem in this file is already imported lazily at its call site — this
        // matches that convention instead of being the one static exception.
        const { fireLaunchBlueprint } = await import('../../blueprint/launch-blueprint');
        await fireLaunchBlueprint(blueprintId, { installSlug: opts.slug, workspaceId: ws, kickoff });
        await recordPotWake(ws);
      } else {
        const { sql } = getOrgPg();
        await declarePotTimeWake(sql, {
          workspaceId: ws,
          installSlug: opts.slug,
          at: new Date(Date.now() + opts.wakeInSeconds * 1000),
          kickoff,
          blueprintId,
        });
      }
      waked = true;
    }

    return {
      ok: true,
      slug: opts.slug,
      path,
      waked,
      ...(seededLearnings ? { seededLearnings } : {}),
      ...(coSeededLearnings.length > 0 ? { coSeededLearnings } : {}),
      ...(provisionedLoop ? { provisionedLoop } : {}),
      ...(repoInit ? { repoInit } : {}),
    };
  } catch (e) {
    await rollback();
    return { ok: false, error: 'create_failed', message: (e instanceof Error ? e.message : String(e)).slice(0, 400) };
  }
}
