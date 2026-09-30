/**
 * harness:create — scaffold a new harness and instantiate a Blueprint into it.
 * Composes the existing creation primitives (registry + per-harness PG schema +
 * local-dir init) and writes the git-canonical `.papercusp/blueprint.yaml`; the
 * runtime projects it to PG lazily (getEffectiveBlueprint) on first use, so the
 * file stays the source of truth (D-006/D-021). No `orchestrator.spawn` (P-007).
 *
 * requiresRepo (P-008): the blueprint's `knobs.requiresRepo` decides whether a
 * NEW harness gets a git repo (coding=true → git-init) or a repo-less state dir
 * (research=false → plain mkdir, NO git-init; runs PG/file-canonical with no git
 * operations). An existing `path` is used as-is either way.
 *
 * harness-blueprint-orchestration-2026-06-03 P-007 + P-008 / B1+B2.
 */
import { z } from 'zod';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { defineTool } from '@papercusp/agent-mcp';
import { validateBlueprintDependencies } from '@papercusp/blueprint-distribution';
import { COORD_ROLES } from '../coordination/roles';
import { operatorResolveExtends } from '../../blueprint/installed-blueprints';
import { loadBlueprintFromFile } from '@papercusp/orchestrator/blueprint';
import { resolveAndValidate } from '../blueprint/_resolve';
import { DeploymentConfigSchema, parseDeploymentConfig } from '../../deployment/config-schema';
import { resolveCreatePotMembership } from './create-pot-membership';
import { applyGenomeConfig, writeGenomePrompts } from '../../instance-spec/genome-storage';
import type { InstanceConfigFields } from '../../deployment/instance-config';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';

const fail = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, ...payload }) }],
});

/**
 * The Hive→member DOMAIN-PROFILE overlay (hive-blueprint-generalization P-021). A
 * member harness born into a Hive inherits the Hive's DELIVERABLE acceptance/output so
 * its finalize gate matches the Hive's intent — the live smoke surfaced that a
 * generic-hive's `acceptance.kind=judge` / `output.kind=artifacts` is declared on the
 * Hive, but deliverables finalize in the member (research/review/vote), which otherwise
 * keeps the coding/default profile. Only the NON-CODING kinds propagate: acceptance
 * `judge`/`human-gate` (a coding hive's defaulted `none` does not) and a non-`repo-commit`
 * output. So a coding hive overlays nothing → its members are byte-identical. Pure.
 */
export function hiveMemberProfileOverlay(hiveBp: {
  acceptance?: { kind?: string } | null;
  output?: { kind?: string } | null;
}): { acceptance?: unknown; output?: unknown } {
  const overlay: { acceptance?: unknown; output?: unknown } = {};
  const ak = hiveBp.acceptance?.kind;
  if (ak === 'judge' || ak === 'human-gate') overlay.acceptance = hiveBp.acceptance;
  const ok = hiveBp.output?.kind;
  if (ok != null && ok !== 'repo-commit') overlay.output = hiveBp.output;
  return overlay;
}

export default defineTool({
  name: 'harness:create',
  description:
    'Create a harness and instantiate a Blueprint into it. Provide an existing repo `path` OR `parentDir`+`folderName` to make a new dir; choose the blueprint via `blueprintId` (resolved local → installed → built-in, e.g. "coding"/"research" or a Cupboard-installed id) OR an inline `blueprint` object. The blueprint\'s knobs.requiresRepo decides git-init: coding → a git repo, research → a repo-less state dir. Registers the harness, provisions its PG schema, writes the git-canonical .papercusp/blueprint.yaml. Returns {ok, slug, path, blueprint}.',
  guidance: {
    when: 'Spinning up a new managed harness (coding from a repo, or a repo-less research harness) configured by a blueprint. The agent-authorable path to a new harness.',
    notWhen: 'Running an existing harness (orchestrator). Authoring a blueprint without creating a harness — blueprint:create/extend.',
    chaining: 'blueprint:extend/validate → harness:create { slug, path|parentDir+folderName, blueprintId|blueprint }.',
    seeAlso: [
      'harness:generate-from-repo (create from an existing repo instead of a blueprint)',
      'blueprint:validate (validate the blueprint first)',
      'harness:overview (inspect the new harness)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      slug: z
        .string()
        .min(1)
        .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be lowercase alphanumeric + dashes')
        .describe('Unique harness slug'),
      path: z.string().min(1).optional().describe('Absolute path to an existing repo/dir'),
      parentDir: z.string().min(1).optional().describe('Parent dir to create a new harness folder in'),
      folderName: z.string().min(1).optional().describe('New folder name (with parentDir)'),
      blueprintId: z.string().min(1).optional().describe('A blueprint to extend — resolved local → installed → built-in (e.g. coding/base/research or a Cupboard-installed id)'),
      blueprint: z.record(z.string(), z.unknown()).optional().describe('An inline blueprint object (alternative to blueprintId)'),
      autoInstallDeps: z
        .boolean()
        .optional()
        .describe('When the blueprint declares deps that are not installed but are installable from the Cupboard, INSTALL them (transitively) before the gate instead of failing. Opt-in (default false). Code-tool packs install globally; runtime-plugin capability grants for this harness are a separate cupboard:install-deps {harness} call. tool-distribution-discovery D-002.'),
      deployment: DeploymentConfigSchema.optional().describe('Where this harness\'s execution plane runs — a sibling to the blueprint (cloud-deployment-layer D-001). Omit ⇒ {target:"local"}. e.g. {target:"latitude",region:"NYC",kind:"vm"}.'),
      instance: z
        .object({
          genome: z
            .object({
              prompts: z.record(z.string(), z.string()).optional(),
              config: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
            })
            .optional()
            .describe('The genome surface (prompt overlays + placement/wake/memory/coordination config knobs) to seed this instance with.'),
          phase: z.string().optional(),
          phases: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
          dept: z.string().optional(),
          configOverrides: z.record(z.string(), z.unknown()).optional(),
        })
        .optional()
        .describe('Per-install INSTANCE config to seed (cloud-deployment-layer P-008 + retire-snapshots-instance-spec P-005): the genome + phase/phases/dept/configOverrides. This is what `boot(InstanceSpec)` threads to reproduce a captured instance — record/reuse the spec at create.'),
      pot: z
        .string()
        .min(1)
        .regex(/^[a-z0-9][a-z0-9-]*$/, 'pot must be a harness slug')
        .optional()
        .describe('Create this harness directly INTO a Hive: the home slug of a kind:\'hive\' harness. Stamps the new harness\'s hive_slug so its substrate federates over the Hive topic (shared-hive-federation D-010 create-time membership producer). Omit ⇒ a standalone harness. The complement of pot:add-member (which adds an EXISTING harness).'),
    })
    // WI-3646 class fix (finding #7, instance #3 of "missing-slug → silent
    // zero-federation"): a caller sending `hive` instead of the real `pot`
    // field (`_create_from_repo.ts`'s `defaultCreateMember`, live-repro'd on a
    // fresh-deb rig) had the extra key silently DROPPED by the default
    // (non-strict) zod object — `args.pot` stayed undefined and the new
    // harness never got `hive_slug` stamped, with NO error surfaced anywhere.
    // `.strict()` turns any future field-name typo/drift on this schema into a
    // loud validation error instead of a silent, undetectable no-op — closing
    // the whole class, not just this one instance.
    .strict()
    .refine((a) => a.path != null || (a.parentDir != null && a.folderName != null), {
      message: 'pass `path`, or both `parentDir` and `folderName`',
    })
    .refine((a) => a.blueprintId != null || a.blueprint != null, {
      message: 'pass `blueprintId` or `blueprint`',
    }),
  async handler(args, ctx) {
    const { loadHarnessRegistry, mutateHarnessRegistry } = await import('../../harness-registry');

    const workspaceId = resolveConcreteWorkspaceId(
      undefined,
      ctx?.workspaceId,
      ctx?.principal?.workspaceId,
    );
    const reg = await loadHarnessRegistry(workspaceId);
    if (reg.projects.some((p) => p.slug === args.slug)) return fail({ error: 'slug already exists' });

    // Create-time Hive membership (shared-hive-federation D-010 producer): when
    // `pot` is given, validate it's a real Hive home + capture the hive_slug to
    // stamp on the new registry entry below. Fail-fast before any dir/schema side
    // effect, like the deployment + dependency gates. No nesting guard needed —
    // harness:create never sets harness_kind, so the new harness is never a Hive
    // home (Hive homes come only from pot:create), so it cannot nest a Hive.
    let potMembership: string | undefined;
    if (args.pot != null) {
      const membership = resolveCreatePotMembership(reg, args.pot);
      if (!membership.ok) return fail({ error: membership.error, message: membership.message });
      potMembership = membership.hive_slug;
    }

    // 1. Resolve + validate the blueprint FIRST — knobs.requiresRepo drives the
    //    dir/git decision below. `blueprintId` → a thin inheriting child
    //    (`{ id: slug, extends: <id> }`); `blueprint` → as-authored.
    //    `extends` resolution is composed (D-005): the target repo's local
    //    `.papercusp/blueprints` (when `path` is given) → installed
    //    (`~/.papercusp/blueprints`, Cupboard-installed) → built-in.
    const resolver = operatorResolveExtends({
      localDirs: args.path != null ? [join(resolvePath(args.path), '.papercusp', 'blueprints')] : [],
    });
    const childObj: Record<string, unknown> = args.blueprint ?? { id: args.slug, extends: args.blueprintId };
    // hive-blueprint-generalization P-021: a member harness born INTO a Hive inherits
    // the Hive's DELIVERABLE acceptance/output domain profile, so a generic-hive's
    // research/review/vote member finalizes under judge + artifacts. This is the missing
    // wiring the live smoke surfaced — the judge gate (P-009) + artifacts sink (P-010)
    // live on the harness that FINALIZES the deliverable (the member), but the profile is
    // declared on the Hive, whose own harness only runs hive-wake placement items. Only
    // the non-coding kinds propagate (acceptance judge/human-gate; non-repo-commit output),
    // so a coding hive — acceptance defaults to 'none', output 'repo-commit' — overlays
    // NOTHING and its members are byte-identical. An explicitly-authored `blueprint` is
    // respected as-is (no overlay). See agent-insights/generic-hive-acceptance-propagation-gap.
    if (potMembership && args.blueprint == null) {
      const potPath = reg.projects.find((p) => p.slug === potMembership)?.path;
      if (potPath) {
        try {
          const hiveBp = loadBlueprintFromFile(join(potPath, '.papercusp', 'blueprint.yaml'), resolver).blueprint;
          const overlay = hiveMemberProfileOverlay(hiveBp);
          if (overlay.acceptance != null && childObj.acceptance == null) childObj.acceptance = overlay.acceptance;
          if (overlay.output != null && childObj.output == null) childObj.output = overlay.output;
        } catch {
          /* hive blueprint unreadable → no overlay; the member keeps its own profile */
        }
      }
    }
    const validation = resolveAndValidate(childObj, resolver);
    if (validation.parseError || !validation.ok) {
      return fail({ error: 'blueprint invalid', parseError: validation.parseError, errors: validation.validation?.errors });
    }
    if (args.blueprintId && resolver(args.blueprintId) == null) {
      return fail({ error: `unknown blueprint "${args.blueprintId}" — not in the local, installed, or built-in tiers` });
    }
    const requiresRepo = validation.blueprint!.knobs.requiresRepo !== false;

    // 1a. Validate the deployment config (cloud-deployment-layer P-003). Deployment
    //     is a SIBLING input to the blueprint (D-001), not a blueprint property —
    //     it describes where THIS install's execution plane runs. Defaults to
    //     {target:'local'} so existing harnesses are unaffected. Fail-fast on a
    //     non-local target with no registered driver (a cloud backend registers
    //     its driver via configureDeployment at operator bootstrap).
    const deploymentResult = parseDeploymentConfig(args.deployment);
    if (!deploymentResult.ok) {
      return fail({ error: deploymentResult.error, registeredTargets: deploymentResult.registeredTargets });
    }
    const deployment = deploymentResult.config;

    // 1b. Import-time dependency validation (harness-blueprint-distribution
    //     E2 — P-003/P-004; revive-cupboard-distribution D-003;
    //     tool-distribution-granularity D-002/D-006 — the pack model).
    //     A blueprint declares `dependencies.{tools,packs,plugins}`; the gate
    //     resolves each against the live pack catalog (built-ins + installed
    //     units + Cupboard listings) HERE, at create — closing the call-time
    //     `unknown_tool` gap (capabilities/invoke.ts). A declared tool with no
    //     known provider hard-fails; a tool/pack/plugin installable from the
    //     Cupboard is advisory. Fail-fast: before any dir/registry/schema side
    //     effect. No-op for a blueprint that declares no deps.
    const declaredTools = validation.blueprint!.dependencies?.tools ?? [];
    const declaredPacks = validation.blueprint!.dependencies?.packs ?? [];
    const declaredPlugins = validation.blueprint!.dependencies?.plugins ?? [];
    // P-012↔P-013: a blueprint may also declare `dependencies.datatypes`, resolved against
    // the workspace datatype registry. Dark for every blueprint that declares none — the
    // registry query + the datatype gate below are skipped.
    const declaredDatatypes = validation.blueprint!.dependencies?.datatypes ?? [];
    if (
      declaredTools.length > 0 ||
      declaredPacks.length > 0 ||
      declaredPlugins.length > 0 ||
      declaredDatatypes.length > 0
    ) {
      const { derivePackCatalog, depHostSetsFromCatalog } = await import('../../cupboard/pack-catalog');
      const deps = { tools: declaredTools, packs: declaredPacks, plugins: declaredPlugins, datatypes: declaredDatatypes };
      // The workspace's registered datatype ids satisfy `declaredDatatypes` (the loop
      // closure). Queried only when datatypes are actually declared; failure ⇒ none
      // registered (the dep then reports missing, which is the correct conservative gate).
      let datatypeNames: string[] = [];
      if (declaredDatatypes.length > 0) {
        const { getOrgPg } = await import('@papercusp/db-org');
        const { listRegisteredDatatypeNames } = await import('../../datatype-registry-store');
        datatypeNames = await listRegisteredDatatypeNames(getOrgPg().sql, workspaceId).catch(() => []);
      }
      // Local-only first: when every declared dep resolves in-process, skip
      // the Cupboard round-trip entirely.
      const localCatalog = await derivePackCatalog({ includeCupboard: false });
      const localCheck = validateBlueprintDependencies(deps, depHostSetsFromCatalog(localCatalog, datatypeNames));
      let depCheck = localCheck;
      let cupboardReachable = true;
      if (!localCheck.ok) {
        const catalog = await derivePackCatalog({});
        cupboardReachable = catalog.cupboardReachable;
        depCheck = validateBlueprintDependencies(deps, depHostSetsFromCatalog(catalog, datatypeNames));
      }
      // Auto-install the installable deps before the gate (tool-distribution-discovery
      // D-002): when opted in, resolve each Cupboard-installable tool/pack/plugin to its
      // listing and install it (transitively, via the shared install IO) so a blueprint
      // whose only unmet deps live in the Cupboard just works — instead of hard-failing.
      // Opt-in only: silent installs on every create would surprise.
      const anyInstallable =
        depCheck.installable.tools.length > 0 ||
        depCheck.installable.packs.length > 0 ||
        depCheck.installable.plugins.length > 0;
      if (args.autoInstallDeps && anyInstallable) {
        const { resolveAndInstallDeps } = await import('../../cupboard/resolve-and-install');
        const { installCupboardUnitFromListing } = await import('../../cupboard/install-io');
        await resolveAndInstallDeps(
          { tools: declaredTools, packs: declaredPacks, plugins: declaredPlugins },
          {
            deriveCatalog: () => derivePackCatalog({}),
            installUnit: (u) => installCupboardUnitFromListing(u),
          },
        );
        // Re-validate against the post-install catalog; the gate below now passes
        // if the installs satisfied the previously-installable deps.
        const after = await derivePackCatalog({});
        cupboardReachable = after.cupboardReachable;
        depCheck = validateBlueprintDependencies(deps, depHostSetsFromCatalog(after, datatypeNames));
      }
      // Tools with NO known provider are a hard gate (the in-process catalog is
      // authoritative; a Cupboard-installable provider downgrades to advisory).
      if (depCheck.missing.tools.length > 0) {
        return fail({
          error: 'blueprint tool dependencies unmet',
          missing: { tools: depCheck.missing.tools },
          installable: depCheck.installable,
          messages: depCheck.messages,
        });
      }
      // Packs/plugins: hard-fail only when the Cupboard was actually reachable —
      // a transient cupboard-unreachable must not false-fail a unit that may be
      // installable there. `installable` units (in the Cupboard) never block.
      if (cupboardReachable && (depCheck.missing.plugins.length > 0 || depCheck.missing.packs.length > 0)) {
        return fail({
          error: 'blueprint pack/plugin dependencies unmet',
          missing: { packs: depCheck.missing.packs, plugins: depCheck.missing.plugins },
          installable: depCheck.installable,
          messages: depCheck.messages,
        });
      }
      // Datatypes (P-012↔P-013): a declared datatype must be registered in the workspace
      // (the local tier has no Cupboard-install path, so a missing one is a hard gate —
      // declare it first via meta:define-datatype).
      if (depCheck.missing.datatypes.length > 0) {
        return fail({
          error: 'blueprint datatype dependencies unmet',
          missing: { datatypes: depCheck.missing.datatypes },
          installable: depCheck.installable,
          messages: depCheck.messages,
        });
      }
    }

    // 2. Resolve / create the harness directory — conditional on requiresRepo (P-008).
    let path: string;
    let gitInitialized = false;
    if (args.path != null) {
      path = resolvePath(args.path);
      if (!existsSync(path)) return fail({ error: 'path does not exist' });
    } else {
      const dest = resolvePath(join(args.parentDir!, args.folderName!));
      if (existsSync(dest)) return fail({ error: 'destination already exists' });
      if (requiresRepo) {
        // coding-style: git-init a real repo via the shared helper.
        const { initLocalHarnessDir } = await import('../../harness/init-local-dir');
        const init = await initLocalHarnessDir({ parentDir: args.parentDir!, folderName: args.folderName! });
        path = init.path;
        gitInitialized = true;
      } else {
        // research / repo-less: a plain state dir, NO git-init. The harness runs
        // PG/file-canonical with no git operations (P-008).
        mkdirSync(dest, { recursive: true });
        path = dest;
      }
    }

    // 3. Register the harness + provision its PG schema. The deployment config is
    //    persisted on the registry entry (workspace PG) — local omits it. The
    //    optional `instance` config (genome + phase/phases/dept/overrides) is seeded
    //    onto the entry too — this is the record/reuse-at-create half of the
    //    InstanceSpec wiring (retire-snapshots-instance-spec P-005), what boot(spec)
    //    threads to reproduce a captured instance. The genome's config knobs fold
    //    into configOverrides.genome; its prompt overlays are written to disk below.
    const instanceFields: InstanceConfigFields = {};
    if (args.instance) {
      if (args.instance.phase !== undefined) instanceFields.phase = args.instance.phase;
      if (args.instance.phases !== undefined) instanceFields.phases = args.instance.phases;
      if (args.instance.dept !== undefined) instanceFields.dept = args.instance.dept;
      const genomeConfig = args.instance.genome?.config ?? {};
      const folded = applyGenomeConfig(args.instance.configOverrides, genomeConfig);
      if (Object.keys(folded).length > 0) instanceFields.configOverrides = folded;
    }
    const newEntry = {
      slug: args.slug,
      path,
      ...(potMembership ? { hive_slug: potMembership } : {}),
      ...(deployment.target !== 'local' ? { deployment } : {}),
      ...instanceFields,
    };
    // Atomic insert (audit P-006 / EI-82): the top-of-handler dup check is a
    // pure TOCTOU window — a concurrent create/register/hive:join could land
    // this slug (or revert our write) between that read and the save. Mirror
    // the sibling HTTP route (POST /harness/projects, projects.ts:312-328):
    // route the write through `mutateHarnessRegistry` so it runs inside the
    // operator-state row's FOR UPDATE tx (concurrent mutations serialize, each
    // sees the prior commit), and RE-CHECK the slug inside the mutation so a
    // dup that appeared after our read is rejected instead of duplicated. A
    // plain loadHarnessRegistry()→push→saveHarnessRegistry() is the lost-update
    // race that drops one of two concurrent creates with no error.
    let dupRace = false;
    await mutateHarnessRegistry((cur) => {
      if (cur.projects.some((p) => p.slug === args.slug)) {
        dupRace = true;
        return cur;
      }
      return { ...cur, projects: [...cur.projects, newEntry] };
    }, workspaceId);
    if (dupRace) return fail({ error: 'slug already exists' });
    let provisioning: { ok: true } | { ok: false; error: string };
    try {
      const { scaffoldHarnessSchema } = await import('../../scaffold-harness-schema');
      await scaffoldHarnessSchema(args.slug);
      provisioning = { ok: true };
    } catch (e) {
      provisioning = { ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
    }

    // 4. Write the git-canonical blueprint file. PG projection is lazy.
    //    Shaped-fail on fs errors: this is the first post-registration step that
    //    could THROW, and an escaped throw here surfaces as the framework's
    //    opaque `handler_error:` text while leaving the registry row + folder
    //    with no explanation (the "dangling create" an agent chased on the
    //    Windows rig, 2026-07-07 / WI-3291 follow-up). Report the real error
    //    plus the partial state instead.
    const bpDir = join(path, '.papercusp');
    const bpFile = join(bpDir, 'blueprint.yaml');
    try {
      mkdirSync(bpDir, { recursive: true });
      writeFileSync(bpFile, stringifyYaml(childObj, { lineWidth: 100 }), 'utf8');

      // 4a. Write the genome's prompt overlays to `.papercusp/genome/` (git-canonical),
      //     completing the instance-config seed (the config knobs went to PG above).
      const genomePrompts = args.instance?.genome?.prompts;
      if (genomePrompts && Object.keys(genomePrompts).length > 0) {
        writeGenomePrompts(path, genomePrompts);
      }
    } catch (e) {
      return fail({
        error: `blueprint write failed after registration: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`,
        slug: args.slug,
        path,
        registered: true,
        provisioning,
      });
    }

    // 5. Materialize the blueprint's triggers.schedule into harness_shared.routines
    //    (P-021/D-018). Each entry → a cron routine whose target_role is its action
    //    (default system:blueprint-run); the shipped routinesTick dispatches due rows.
    //    Best-effort — a routines hiccup must not fail harness creation.
    let scheduledRoutines: string[] = [];
    try {
      const { materializeBlueprintTriggers } = await import('../../blueprint/materialize-triggers');
      const rows = await materializeBlueprintTriggers(args.slug, validation.blueprint!);
      scheduledRoutines = rows.map((r) => r.name);
    } catch (e) {
      console.warn(`[harness:create] materialize triggers failed (${args.slug}): ${e instanceof Error ? e.message : e}`);
    }

    // 5a. A harness born INTO a hive is a MEMBER checkout — seed its
    //     `system:git-sync` routine (git-sync-any-hive B-01, the
    //     `harness:create { hive }` producer). Best-effort like the trigger
    //     materialization above: the seeder never throws and a failure never
    //     fails the create (its outcome is reported as `gitSync`). Eligibility
    //     (homes/views/cloud/non-repos) + idempotency live in the seeder; push
    //     is decided creator-side from the registry-known coords — none exist
    //     on this path, so the routine seeds quiet commit-only (push:false,
    //     no_upstream_remote). When this create runs inside the from-repo
    //     composition, _create_from_repo's later coords-rich seed (step 7.25)
    //     UPGRADES this still-machine-default row via the seeder's
    //     untouched-coords-less carve-out — that's how the probed push +
    //     default branch win on the default path.
    let gitSync: import('../../harness/git-sync/git-sync-routine').SeedGitSyncRoutineOutcome | undefined;
    if (potMembership) {
      try {
        const { seedGitSyncRoutineForMember } = await import('../../harness/git-sync/git-sync-routine');
        gitSync = await seedGitSyncRoutineForMember({
          workspaceId,
          installSlug: args.slug,
          entry: newEntry,
          joinerSide: false,
        });
      } catch (e) {
        gitSync = {
          seeded: false,
          reason: 'error',
          message: (e instanceof Error ? e.message : String(e)).slice(0, 300),
        };
      }
    }

    // 5a-bis. per-hive-git-and-release-gate P-018: a code MEMBER (e.g. a create_from_repo
    //     clone like oddsmith) IS the hive's code repo — seed its staging→main
    //     green-checkpoint too (the member-side equivalent of the self_repo home's step 6f).
    //     FLAG-GATED (PER_POT_RELEASE_GATE, default-OFF) + self-gating (seedHiveReleaseRoutines
    //     skips non-coding / repo-less / the operator-home), so a coding member gates by
    //     default once the flag is on. Best-effort — never fails the create.
    if (potMembership) {
      try {
        const { seedHiveReleaseRoutines } = await import('../../harness/routines/seed-hive-release-routines');
        const { getOrgPg } = await import('@papercusp/db-org');
        const { sql } = getOrgPg();
        await seedHiveReleaseRoutines({ sql, workspaceId, potSlug: args.slug });
      } catch (e) {
        console.warn(
          `[harness:create] release-routine seed failed (${args.slug}): ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    // 5b. Doc-integrity TWIN of the git-sync seed (owner 2026-06-22): a repo harness
    //     inherits doc-drift tracking, so a NEW coding hive is doc-honest FROM BIRTH —
    //     its existing docs are registered as tracked records now, and the post-sync
    //     freshness sweep self-bootstraps docs added later. Gated on requiresRepo (no
    //     repo ⇒ no docs) + the inherited `knobs.docs.track` (default true via `base`;
    //     `track:false` opts out). Best-effort + deterministic (no LLM, D-006): never
    //     fails the create; outcome reported as `docTracking`.
    let docTracking: import('../../harness/docs/seed-doc-tracking').SeedDocTrackingOutcome | undefined;
    const docsKnob = ((validation.blueprint!.knobs ?? {}) as Record<string, unknown>).docs as
      | { track?: boolean }
      | undefined;
    if (requiresRepo && docsKnob?.track !== false) {
      try {
        const { seedHarnessDocTracking } = await import('../../harness/docs/seed-doc-tracking');
        docTracking = await seedHarnessDocTracking({ harnessSlug: args.slug, workspaceId });
      } catch (e) {
        docTracking = {
          seeded: false,
          reason: 'error',
          message: (e instanceof Error ? e.message : String(e)).slice(0, 300),
        };
      }
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            slug: args.slug,
            path,
            requiresRepo,
            gitInitialized,
            blueprintFile: bpFile,
            blueprint: { id: validation.blueprint!.id, version: validation.blueprint!.version },
            deployment,
            ...(potMembership ? { pot: potMembership } : {}),
            warnings: validation.validation!.warnings,
            provisioning,
            scheduledRoutines,
            ...(gitSync ? { gitSync } : {}),
            ...(docTracking ? { docTracking } : {}),
          }),
        },
      ],
    };
  },
});
