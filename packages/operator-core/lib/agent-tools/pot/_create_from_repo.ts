/**
 * _create_from_repo — the create-a-Pot-from-a-GitHub-URL composition
 * (hive-from-github-url-2026-06-11 P-006; D-001 the unit is the Pot).
 *
 * Composes the shipped primitives — nothing here is new machinery:
 *
 *   lookupPotForRepo (P-005)            → join offer when the repo's Pot exists
 *   cloneGithubRepo (P-008 dogfood-1b)   → the member checkout (+ default branch)
 *   detectFromRepo → detectionToOverride → the member's blueprint, test-verified
 *   createPotHarness (pot:create)      → the Pot home (eager keypair mint)
 *   harness:create { pot }              → the member, born INTO the Pot (D-010)
 *   registry github coords (P-002)       → fork-PR context + member_repos derivation
 *   publishCreatedPot (P-007)           → visibility-gated announce + bindings
 *
 * Failure discipline: every side effect before the publish step is undone
 * best-effort in reverse on a later failure (clone dir, pot home, member
 * registration) — a failed create must not leave a half-pot in the registry.
 * The publish step itself is best-effort and NEVER fails the create (its
 * outcome is reported; a re-publish rides discovery:set_pot / the boot tick).
 */

import { rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import {
  cloneGithubRepo,
  isCloneError,
  parseGithubUrl,
  type CloneResult,
} from '../../harness/clone-github';
import {
  lookupHiveForRepo as lookupPotForRepo,
  type RepoHiveLookup as RepoPotLookup,
} from '../../harness/lookup-hive-for-repo';
import { loadHarnessRegistry, mutateHarnessRegistry, type ProjectEntry } from '../../harness-registry';
import type {
  SeedGitSyncRoutineOpts,
  SeedGitSyncRoutineOutcome,
} from '../../harness/git-sync/git-sync-routine';
import { createPotHarness, type CreatePotResult, type SeededLearningsSummary } from './_create';
import { shapesFromDetection } from '../../knowledge-packs/seed';
import {
  publishCreatedHive as publishCreatedPot,
  republishHiveAfterMemberAdd as republishPotAfterMemberAdd,
  type PublishCreatedHiveOutcome as PublishCreatedPotOutcome,
} from '../../hive-publish-from-repo';
import { formatHarnessLink } from '../../harness/url-scheme';
import {
  deriveHiveFederationTopic,
  topicAsHex,
} from '../../sync/hyperbee/derive-swarm-topic';
import { trackDetached } from '../../detached-imports';

// ── Options / results ─────────────────────────────────────────────────────────

export interface CreatePotFromRepoOpts {
  githubUrl: string;
  /** Base slug — default: the repo name (lowercased). Member = `<base>`, Pot home = `<base>-pot`.
   *  On collision the base auto-suffixes `-2`..`-9` (plan OQ-1: tools never stall on a prompt). */
  slug?: string;
  shallow?: boolean;
  /**
   * Run the detected test command once to verify it. Default FALSE on this
   * paste-a-URL path (hardening D-001): the command comes from a repo the
   * operator may have never seen — running it is arbitrary code execution.
   * Explicit opt-in only; `harness:generate-from-repo` (a local repo you
   * already trust) keeps its own default-true.
   */
  runTests?: boolean;
  testTimeoutMs?: number;
  /** Parent dir for the POT HOME folder (default ~/.papercusp/hives). */
  parentDir?: string;
  /**
   * P-008 create-anyway: proceed even when the lookup finds an existing
   * Pot/share for this repo (e.g. it has no join links yet). The result is
   * explicitly flagged `duplicateOf` — the dispute lands in the claim/supersede
   * flow (a duplicate's Cupboard row is also refused by the per-repo
   * uniqueness, which surfaces in publish.cupboard.errors).
   */
  force?: boolean;
  /**
   * P-009 into-pot mode: add the repo as a member of this EXISTING
   * `kind:'hive'` home instead of standing up a new pot. No new identity, no
   * new listing — the pot's existing listing is re-published with the new
   * member's repo coords (+ its Cupboard/local rows only, for public hives).
   */
  intoPot?: string;
  /**
   * P-008 (hardening): client-minted progress id — the composition records
   * real step transitions against it (from-repo-progress store → the sync
   * channel), replacing the form's optimistic-only strip. Optional;
   * best-effort throughout.
   */
  progressId?: string;
  /**
   * Knowledge pack seeded into the new pot home (knowledge-packs P-005).
   * Omit ⇒ default pack; null ⇒ none. Ignored in into-pot mode (the home
   * already exists — install packs there via knowledge_packs:install).
   */
  knowledgePack?: string | null;
  workspaceId: string;
}

export interface CreatePotFromRepoCreated {
  potSlug: string;
  memberSlug: string;
  memberPath: string;
  defaultBranch?: string;
  githubRepositoryId?: number;
  detection?: unknown;
  /** knowledge-packs P-005: what seeded into the new pot home (absent in
   *  into-pot mode / flag-off / pack 'none'). */
  seededLearnings?: SeededLearningsSummary;
  /** P-008: set when `force` created past an existing pot/share — the
   *  duplicate marker the supersede flow resolves. */
  duplicateOf?: { kind: 'hive' | 'legacy_shared_harness'; potPubkey?: string; source: string };
}

export type CreatePotFromRepoResult =
  | { ok: false; error: string; message?: string; cleanup?: string[] }
  | { ok: true; existing: Exclude<RepoPotLookup, { kind: 'none' | 'invalid_url' }> }
  | {
      ok: true;
      created: CreatePotFromRepoCreated;
      /** Cupboard reachability at lookup time (D-004 degradation flag). */
      bindingUnverified: boolean;
      publish:
        | PublishCreatedPotOutcome
        | { skipped: 'unpublished_hive' };
      /** git-sync-any-pot B-01: outcome of seeding the member's `system:git-sync`
       *  routine. Best-effort — a failed/ineligible seed never fails the create. */
      gitSync: SeedGitSyncRoutineOutcome;
    };

// ── Injectable seams (tests pass fakes; production uses the defaults) ─────────

export interface CreatePotFromRepoDeps {
  lookup?: typeof lookupPotForRepo;
  clone?: typeof cloneGithubRepo;
  /** Build + validate the member blueprint for a fresh clone. Returns the inline
   *  blueprint object, or an error string. Default: detectFromRepo →
   *  detectionToOverride → resolveAndValidate (the generate-from-repo spine);
   *  a repo that already carries .papercusp/blueprint.yaml passes ITS OWN
   *  blueprint through (harness:create rewrites the same bytes). */
  buildBlueprint?: (
    slug: string,
    repoPath: string,
    opts: { runTests: boolean; testTimeoutMs?: number },
  ) => Promise<
    | { ok: true; blueprint: Record<string, unknown>; detection?: unknown }
    | { ok: false; error: string }
  >;
  createPot?: typeof createPotHarness;
  republish?: typeof republishPotAfterMemberAdd;
  /** harness:create composition for the member (inline blueprint + pot membership). */
  createMember?: (args: {
    slug: string;
    path: string;
    blueprint: Record<string, unknown>;
    pot: string;
    workspaceId: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  publish?: typeof publishCreatedPot;
  /** B-07 / C-2: record the owner's beacon-publish consent. Default: the shared
   *  `beacon-consent` accessor (writes the federated `beacon-publish-consent`
   *  pot setting). Best-effort — a consent write never fails the create. */
  setBeaconConsent?: (workspaceId: string, potHomeSlug: string, consent: boolean) => Promise<void>;
  /** git-sync-any-pot B-01: seed the new member's `system:git-sync` routine.
   *  Default: seedGitSyncRoutineForMember (lazy-imported). Best-effort — a
   *  seeding failure NEVER fails the create (mirrors the publish discipline). */
  seedGitSync?: (opts: SeedGitSyncRoutineOpts) => Promise<SeedGitSyncRoutineOutcome>;
  loadRegistry?: typeof loadHarnessRegistry;
  mutateRegistry?: typeof mutateHarnessRegistry;
  /** Remove a half-created pot home (reverse of createPotHarness). Best-effort. */
  removePotHome?: (slug: string, workspaceId: string) => Promise<void>;
  rmDir?: (path: string) => Promise<void>;
  /** P-008 step recorder (default: the from-repo-progress store). */
  recordStep?: (
    progressId: string,
    step: 'lookup' | 'clone' | 'detect' | 'create' | 'seed' | 'publish',
    status: 'running' | 'done' | 'error' | 'skipped',
  ) => void;
}

async function defaultBuildBlueprint(
  slug: string,
  repoPath: string,
  opts: { runTests: boolean; testTimeoutMs?: number },
): Promise<
  | { ok: true; blueprint: Record<string, unknown>; detection?: unknown }
  | { ok: false; error: string }
> {
  const { detectFromRepo, detectionToOverride } = await import('../../blueprint/detect-from-repo');
  const { resolveAndValidate } = await import('../blueprint/_resolve');
  const det = detectFromRepo(repoPath, {
    runTests: opts.runTests,
    ...(opts.testTimeoutMs ? { testTimeoutMs: opts.testTimeoutMs } : {}),
  });
  if (det.skip) {
    // The clone already carries .papercusp/blueprint.yaml — it IS a papercusp
    // project; adopt its own blueprint (harness:create re-writes the same file).
    try {
      const own = parseYaml(readFileSync(join(repoPath, '.papercusp', 'blueprint.yaml'), 'utf8'));
      if (own && typeof own === 'object') {
        return { ok: true, blueprint: own as Record<string, unknown> };
      }
      return { ok: false, error: 'repo blueprint.yaml is not an object' };
    } catch (e) {
      return { ok: false, error: `repo blueprint.yaml unreadable: ${e instanceof Error ? e.message : e}` };
    }
  }
  const override = detectionToOverride(slug, det);
  const validation = resolveAndValidate(override);
  if (validation.parseError || !validation.ok) {
    return { ok: false, error: validation.parseError ?? 'generated blueprint failed validation' };
  }
  const { testCommand, toolchains, flags, notes } = det;
  return {
    ok: true,
    blueprint: override,
    detection: {
      testCommand: testCommand
        ? { command: testCommand.command, verified: testCommand.verified }
        : null,
      toolchains,
      flags,
      notes,
    },
  };
}

/** Exported for tests (WI-1861 — failure detail must survive the parse). */
export async function defaultCreateMember(args: {
  slug: string;
  path: string;
  blueprint: Record<string, unknown>;
  pot: string;
  workspaceId: string;
}): Promise<{ ok: boolean; error?: string }> {
  const { default: createTool } = await import('../harness/create');
  const { workspaceId, pot, ...rest } = args;
  // WI-3646 FOLLOW-UP (found live via a fresh-deb rig re-verify, 4834d):
  // `harness:create`'s actual Zod field for create-time Pot membership is
  // `pot` (see harness/create.ts's schema + its D-010 handling of `args.pot`),
  // NOT `hive` — but this call site was built (and every test here mocks)
  // passing `hive`. Zod silently drops the unrecognized `hive` key (no
  // `.strict()`), so `args.pot` was always undefined here and NO member
  // harness ever got born with `hive_slug` stamped via this path — the
  // create-from-repo composition (used by e.g. a fresh `pot:create_from_repo`
  // publish, not just `intoPot` adds) has been silently non-federating since
  // this call site was written. This is DISTINCT from (and upstream of) the
  // linkExisting-branch backfill fix in `_create.ts`: that fix only helps when
  // a PRE-EXISTING sibling harness is being linked into a pot; a genuinely
  // FRESH create-from-repo (no pre-existing harness at the clone path) never
  // took that branch at all and relied on this (broken) call instead.
  const createArgs = { ...rest, pot: pot };
  const res = (await createTool.handler(createArgs as never, { workspaceId } as never)) as {
    content: { text: string }[];
  };
  try {
    // WI-1861: carry harness:create's failure DETAIL through, not just the headline.
    // The narrow `{ error }` pick swallowed `parseError` / `errors[]` / `missing`,
    // so a live 'blueprint invalid' red reached the smoke output with the failing
    // field unnamed — undiagnosable from the artifact alone. Flatten the detail
    // fields into the error string so pot:create_from_repo's `message` names them.
    const parsed = JSON.parse(res.content[0].text) as {
      ok?: boolean;
      error?: string;
      parseError?: string;
      errors?: unknown;
      missing?: unknown;
      messages?: unknown;
    };
    if (parsed.ok === true) return { ok: true };
    const detail = [
      parsed.error,
      parsed.parseError ? `parseError: ${parsed.parseError}` : null,
      parsed.errors != null ? `errors: ${JSON.stringify(parsed.errors)}` : null,
      parsed.missing != null ? `missing: ${JSON.stringify(parsed.missing)}` : null,
      parsed.messages != null ? `messages: ${JSON.stringify(parsed.messages)}` : null,
    ]
      .filter(Boolean)
      .join(' | ');
    return { ok: false, ...(detail ? { error: detail.slice(0, 2000) } : {}) };
  } catch {
    return { ok: false, error: 'harness:create returned an unparseable response' };
  }
}

async function defaultRemovePotHome(slug: string, workspaceId: string): Promise<void> {
  // Reverse of createPotHarness's registry/dir effects, best-effort: drop the
  // registry entry; the home dir is removed by the caller (it knows the path).
  await mutateHarnessRegistry(
    (reg) => ({ ...reg, projects: reg.projects.filter((p) => p.slug !== slug) }),
    workspaceId,
  );
}

// ── Slug derivation ────────────────────────────────────────────────────────────

function kebab(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/--+/g, '-');
}

/** member `<base>`, home `<base>-pot`; auto-suffix the base on collision (OQ-1). */
export function deriveSlugs(
  base: string,
  taken: ReadonlySet<string>,
): { memberSlug: string; potSlug: string } | null {
  for (let i = 0; i < 9; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const member = candidate;
    const pot = `${candidate}-pot`;
    if (!taken.has(member) && !taken.has(pot)) return { memberSlug: member, potSlug: pot };
  }
  return null;
}

// ── The composition ────────────────────────────────────────────────────────────

export async function createPotFromRepo(
  opts: CreatePotFromRepoOpts,
  deps: CreatePotFromRepoDeps = {},
): Promise<CreatePotFromRepoResult> {
  const lookup = deps.lookup ?? lookupPotForRepo;
  const clone = deps.clone ?? cloneGithubRepo;
  const buildBlueprint = deps.buildBlueprint ?? defaultBuildBlueprint;
  const createPot = deps.createPot ?? createPotHarness;
  const createMember = deps.createMember ?? defaultCreateMember;
  const publish = deps.publish ?? publishCreatedPot;
  const setBeaconConsent =
    deps.setBeaconConsent ??
    (async (workspaceId: string, potHomeSlug: string, consent: boolean) => {
      const { setBeaconPublishConsent } = await import('../../beacon-consent');
      await setBeaconPublishConsent(workspaceId, potHomeSlug, consent);
    });
  const seedGitSync =
    deps.seedGitSync ??
    (async (o: SeedGitSyncRoutineOpts) =>
      (await import('../../harness/git-sync/git-sync-routine')).seedGitSyncRoutineForMember(o));
  const loadRegistry = deps.loadRegistry ?? loadHarnessRegistry;
  const mutateRegistry = deps.mutateRegistry ?? mutateHarnessRegistry;
  const removePotHome = deps.removePotHome ?? defaultRemovePotHome;
  const rmDir = deps.rmDir ?? (async (p: string) => rm(p, { recursive: true, force: true }));

  // D-001 (hardening): verify-by-running is OPT-IN for pasted URLs.
  const runTests = opts.runTests === true;

  // P-008: real step transitions, recorded best-effort against the client's
  // progressId (no-op without one). A helper so call-sites stay one-liners.
  const recordStep =
    deps.recordStep ??
    ((id: string, step: 'lookup' | 'clone' | 'detect' | 'create' | 'seed' | 'publish', status: 'running' | 'done' | 'error' | 'skipped') => {
      void trackDetached(import('../../harness/from-repo-progress'))
        .then((m) => m.recordFromRepoStep(id, step, status))
        .catch(() => {});
    });
  const pid = opts.progressId ?? '';
  const mark = (
    step: 'lookup' | 'clone' | 'detect' | 'create' | 'seed' | 'publish',
    status: 'running' | 'done' | 'error' | 'skipped',
  ): void => {
    if (pid) {
      try {
        recordStep(pid, step, status);
      } catch {
        /* progress is UX, never load-bearing */
      }
    }
  };

  const parsed = parseGithubUrl(opts.githubUrl);
  if (!parsed) return { ok: false, error: 'invalid_url', message: `not a GitHub URL: ${opts.githubUrl}` };

  // 1 — paste-time lookup (P-005). An existing Pot/legacy share → join offer,
  //     ZERO side effects.
  mark('lookup', 'running');
  const found = await lookup(opts.githubUrl);
  if (found.kind === 'invalid_url') {
    mark('lookup', 'error');
    return { ok: false, error: 'invalid_url', message: found.message };
  }
  mark('lookup', 'done');
  let duplicateOf: CreatePotFromRepoCreated['duplicateOf'];
  if (found.kind === 'hive' || found.kind === 'legacy_shared_harness') {
    if (!opts.force) return { ok: true, existing: found };
    // P-008 create-anyway: proceed, explicitly flagged for the supersede flow.
    duplicateOf = {
      kind: found.kind,
      ...(found.kind === 'hive' && found.hive.hivePubkey
        ? { potPubkey: found.hive.hivePubkey }
        : {}),
      source: found.source,
    };
  }
  const bindingUnverified = found.kind === 'none' ? found.bindingUnverified : false;
  const repoId = found.coords.githubRepositoryId;
  const repoIsPrivate = found.coords.private;
  // Visibility is derived from the repo's privacy, never chosen (pot-visibility-from-repo-privacy):
  //   public repo  → 'public' (discoverable directory listing)
  //   private repo → 'invite' (hidden, secret-gated) — surfaced to users as "Private"
  // The true local-only 'private' visibility is retired.
  const visibility: 'public' | 'invite' = repoIsPrivate ? 'invite' : 'public';

  // 2 — slugs (collision-resilient, OQ-1) + into-pot validation (fail-fast,
  //     before any clone side effect).
  const reg = await loadRegistry(opts.workspaceId);
  const taken = new Set(reg.projects.map((p) => p.slug));
  const base = kebab(opts.slug ?? parsed.repo);
  if (!base) return { ok: false, error: 'invalid_slug', message: `cannot derive a slug from '${parsed.repo}'` };

  let memberSlug: string;
  let potSlug: string;
  const intoPot = opts.intoPot;
  if (intoPot) {
    const home = reg.projects.find((p) => p.slug === intoPot);
    if (!home || home.harness_kind !== 'hive') {
      return {
        ok: false,
        error: 'hive_not_found',
        message: `'${intoPot}' is not a pot (kind:'hive') in this workspace`,
      };
    }
    const member = deriveSlugs(base, taken); // reuse the suffixing; we only need the member half
    if (!member) {
      return { ok: false, error: 'slug_exhausted', message: `slugs ${base}..${base}-9 are all taken` };
    }
    memberSlug = member.memberSlug;
    potSlug = intoPot;
  } else {
    const slugs = deriveSlugs(base, taken);
    if (!slugs) {
      return { ok: false, error: 'slug_exhausted', message: `slugs ${base}..${base}-9 are all taken` };
    }
    memberSlug = slugs.memberSlug;
    potSlug = slugs.potSlug;
  }

  const cleanup: string[] = [];

  // 3 — clone the member checkout.
  mark('clone', 'running');
  const cloned = await clone(opts.githubUrl, {
    destName: memberSlug,
    ...(opts.shallow !== undefined ? { shallow: opts.shallow } : {}),
  });
  if (isCloneError(cloned)) {
    mark('clone', 'error');
    return { ok: false, error: `clone_${cloned.code}`, message: cloned.message };
  }
  mark('clone', 'done');
  const memberPath = (cloned as CloneResult).path;
  const defaultBranch = (cloned as CloneResult).defaultBranch;

  const fail = async (error: string, message: string): Promise<CreatePotFromRepoResult> => {
    return { ok: false, error, message, cleanup };
  };

  // 4 — the member blueprint (test-verified detection, or the repo's own).
  mark('detect', 'running');
  const bp = await buildBlueprint(memberSlug, memberPath, {
    runTests,
    ...(opts.testTimeoutMs ? { testTimeoutMs: opts.testTimeoutMs } : {}),
  });
  if (!bp.ok) {
    mark('detect', 'error');
    await rmDir(memberPath).catch(() => {});
    cleanup.push('clone removed');
    return fail('blueprint_failed', bp.error);
  }
  mark('detect', 'done');
  mark('create', 'running');

  // 5 — the Pot home (eager identity mint; transactional inside). Skipped in
  //     into-pot mode — the home already exists.
  let pot: CreatePotResult | null = null;
  if (!intoPot) {
    // knowledge-packs P-005: seed the selected pack into the new home,
    // shape-filtered by what detection learned about the repo.
    const projectShapes = shapesFromDetection(bp.detection);
    pot = await createPot({
      slug: potSlug,
      workspaceId: opts.workspaceId,
      ...(opts.parentDir ? { parentDir: opts.parentDir } : {}),
      ...(opts.knowledgePack !== undefined ? { knowledgePack: opts.knowledgePack } : {}),
      ...(projectShapes ? { projectShapes } : {}),
    });
    if (!pot.ok) {
      mark('create', 'error');
      await rmDir(memberPath).catch(() => {});
      cleanup.push('clone removed');
      return fail(`hive_${pot.error ?? 'create_failed'}`, pot.message ?? 'pot create failed');
    }
  }

  // 6 — the member, born INTO the pot (harness:create { pot } — D-010 producer).
  const member = await createMember({
    slug: memberSlug,
    path: memberPath,
    blueprint: bp.blueprint,
    pot: potSlug,
    workspaceId: opts.workspaceId,
  });
  if (!member.ok) {
    mark('create', 'error');
    if (pot) {
      await removePotHome(potSlug, opts.workspaceId).catch(() => {});
      if (pot.path) await rmDir(pot.path).catch(() => {});
      cleanup.push('pot home removed');
    }
    await rmDir(memberPath).catch(() => {});
    cleanup.push('clone removed');
    return fail('member_create_failed', member.error ?? 'harness:create failed');
  }
  mark('create', 'done');
  // knowledge-packs P-006: the seed step settles retrospectively from the pot
  // create's summary (seeding ran inside it) — done / error / skipped, real
  // data only. into-pot mode never seeds (no new home) → skipped.
  mark(
    'seed',
    pot?.seededLearnings
      ? pot.seededLearnings.error
        ? 'error'
        : 'done'
      : 'skipped',
  );

  // 7 — stamp the upstream coords on the member entry (P-002): the fork-PR
  //     context + the member_repos announce derivation both read these.
  await mutateRegistry((cur) => {
    return {
      ...cur,
      projects: cur.projects.map((p) =>
        p.slug === memberSlug
          ? {
              ...p,
              github_remote: parsed.cloneUrl,
              ...(repoId !== undefined ? { github_repository_id: repoId } : {}),
              ...(defaultBranch ? { github_default_branch: defaultBranch } : {}),
            }
          : p,
      ),
    };
  }, opts.workspaceId).catch(() => {});

  // 7.25 — seed the member's `system:git-sync` routine (git-sync-any-pot B-01;
  //        BOTH the new-pot and the P-009 into-pot paths land here, after the
  //        member registration succeeded). Best-effort, NEVER fails the create —
  //        the seeder folds every failure into its outcome (same discipline as
  //        the publish step below). Push comes from B-02's probe+decider
  //        (creator side), branch from the clone's default branch, active per
  //        the provisional P-005 creator split, cron jittered per slug. The
  //        entry is synthesized from the exact coords stamped in step 7 — no
  //        registry re-read.
  const memberEntry: ProjectEntry = {
    slug: memberSlug,
    path: memberPath,
    hive_slug: potSlug,
    github_remote: parsed.cloneUrl,
    ...(repoId !== undefined ? { github_repository_id: repoId } : {}),
    ...(defaultBranch ? { github_default_branch: defaultBranch } : {}),
  };
  const gitSync: SeedGitSyncRoutineOutcome = await seedGitSync({
    workspaceId: opts.workspaceId,
    installSlug: memberSlug,
    entry: memberEntry,
    joinerSide: false,
  }).catch((e) => ({
    seeded: false as const,
    reason: 'error' as const,
    message: e instanceof Error ? e.message : String(e),
  }));

  // 7.5 — auto-set the beacon-publish consent from the derived visibility (B-07 /
  //       C-2). No user opt-in: a PUBLIC pot auto-enables the live status beacon
  //       (it's a public-directory discoverability signal); an INVITE (hidden,
  //       secret-gated) pot auto-disables it (a hidden pot must never broadcast).
  //       into-pot re-adds don't touch the existing home's setting. Best-effort —
  //       like the publish step, never fails the create.
  if (!intoPot) {
    await setBeaconConsent(opts.workspaceId, potSlug, visibility === 'public').catch(() => {});
  }

  // 8 — publish per derived visibility (P-007). Best-effort: NEVER fails the
  //     create. visibility ∈ {public, invite} — both publish a listing (public =
  //     discoverable directory; invite = hidden, secret-gated). into-pot mode
  //     (P-009) re-publishes the EXISTING listing instead — new member rows only;
  //     an unpublished pot stays untouched.
  let publishOutcome:
    | PublishCreatedPotOutcome
    | { skipped: 'unpublished_hive' };
  mark('publish', 'running');
  if (intoPot) {
    const republish = deps.republish ?? republishPotAfterMemberAdd;
    publishOutcome = await republish({
      workspaceId: opts.workspaceId,
      potSlug,
      onlyRepoIds: repoId !== undefined ? [repoId] : [],
      ...(repoIsPrivate !== undefined ? { repoIsPrivate } : {}),
    }).catch((e) => ({
      announced: false,
      reachablePeers: 0,
      cupboard: { attempted: false as const },
      error: e instanceof Error ? e.message : String(e),
    }));
  } else {
    publishOutcome = await publish({
      workspaceId: opts.workspaceId,
      potSlug,
      title: `${parsed.owner}/${parsed.repo}`,
      description: `Pot for ${parsed.cloneUrl}`,
      visibility,
      ...(repoIsPrivate !== undefined ? { repoIsPrivate } : {}),
    }).catch((e) => ({
      announced: false,
      reachablePeers: 0,
      cupboard: { attempted: false as const },
      error: e instanceof Error ? e.message : String(e),
    }));
  }

  // WI-3577: a registry re-read inside publishListingForMeta (members filtered
  // by hive_slug === potSlug) can come back empty even though THIS request just
  // registered the member (observed on a duplicateOf/cupboard-hit force:true
  // create against a heavily-reused fixture repo, e.g. octocat/Hello-World hit
  // by many concurrent fleet rig runs — a same-process registry-read race, not
  // reproducible in isolation/unit tests). memberLinks then comes back absent,
  // and rig_owner_publish_hive (bin/lib/deb-hetzner-rig.sh) has nothing to
  // resolve a join link from. This request already knows everything needed to
  // build ITS OWN member's join link without re-reading the registry at all —
  // synthesize a self-link fallback whenever publish succeeded with a
  // potPubkey but came back with no memberLinks, so a from-repo create is
  // NEVER joinable-blind for its own just-created member.
  if (
    'hivePubkey' in publishOutcome &&
    publishOutcome.hivePubkey &&
    !publishOutcome.memberLinks?.length &&
    repoId !== undefined
  ) {
    try {
      const topicHex = topicAsHex(deriveHiveFederationTopic(publishOutcome.hivePubkey));
      const selfLink = formatHarnessLink({
        topic: topicHex,
        github: `${parsed.owner}/${parsed.repo}`,
        repoOwner: parsed.owner,
        repoName: parsed.repo,
        repoId,
      });
      publishOutcome = { ...publishOutcome, memberLinks: [selfLink] };
    } catch {
      /* fallback is best-effort — never fail the create over it */
    }
  }

  mark(
    'publish',
    'skipped' in publishOutcome || ('announced' in publishOutcome && !publishOutcome.announced && publishOutcome.error)
      ? 'skipped'
      : 'done',
  );

  return {
    ok: true,
    created: {
      potSlug,
      memberSlug,
      memberPath,
      ...(defaultBranch ? { defaultBranch } : {}),
      ...(repoId !== undefined ? { githubRepositoryId: repoId } : {}),
      ...(bp.detection !== undefined ? { detection: bp.detection } : {}),
      ...(pot?.seededLearnings ? { seededLearnings: pot.seededLearnings } : {}),
      ...(duplicateOf ? { duplicateOf } : {}),
    },
    bindingUnverified,
    publish: publishOutcome,
    gitSync,
  };
}
