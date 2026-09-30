/**
 * hive-release-env — resolve a hive's effective staging→main release gate and the env
 * overlay the green-checkpoint / deploy SUBPROCESS runs under.
 *
 * Plan per-hive-git-and-release-gate-2026-06-29 (P-006, D-007/D-008).
 *
 * The release lib (apps/operator/lib/release/release-config.ts) is intentionally
 * lightweight + fully env-overridable and CANNOT import the harness registry / blueprint
 * layer. So per-hive generalization lives HERE (operator-core, where both are reachable):
 * compute the per-hive env vars from the registry path + the hive's `releaseGate` knob and
 * hand them to the subprocess; its `releaseConfig()` re-derives everything from that env.
 * No change to release-config.ts is needed — its env seam already supports this.
 *
 * Operator-home retains its systemd-unit env + releaseConfig defaults, except that routing
 * from a different tooling checkout binds the subject to its registered canonical repo.
 * The gate is effective ONLY when `releaseGate.enabled` AND the
 * hive actually has a repo (belt-and-suspenders — a repo-less / non-coding hive can never
 * be gated, D-002).
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { getHarnessAdminUrl } from '../../embedded-pg-discovery';
import { loadHarnessRegistry } from '../../harness-registry';
import { operatorResolveExtends } from '../../blueprint/installed-blueprints';
import { resolveAndValidate } from '../../agent-tools/blueprint/_resolve';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

/** Fallback green command when a hive has neither an explicit releaseGate.greenCmd nor a
 *  detected `testCommand` knob — gate on "it at least builds", never an unconditional FF. */
export const DEFAULT_GREEN_CMD = 'npm run build';

export interface HiveReleaseGate {
  enabled: boolean;
  integrationBranch: string;
  releaseRef: string;
  /** Explicit green command, or null to fall back to testCommand → DEFAULT_GREEN_CMD. */
  greenCmd: string | null;
  /** WI-2828: opt-in only — defaults to '' (skip the operator-SPA build leg) unless the
   *  hive's blueprint explicitly sets releaseGate.spaBuildWorkspace to the workspace it
   *  actually carries. Never silently defaults to '@papercusp/operator-vite'. */
  spaBuildWorkspace?: string | null;
  /** Deploy target (leg 3). null/undefined ⇒ green-gate only (no release-trigger). */
  deploy: { systemdUnit?: string; healthUrl?: string } | null;
  /** The repo's detected test command (the existing `testCommand` knob) — the preferred
   *  greenCmd default so the gate runs the SAME command the worker/gym use (D-004). */
  testCommand?: string;
}

/**
 * Resolve a hive's effective `releaseGate` knob (+ `testCommand`) by reading its
 * `.papercusp/blueprint.yaml` and resolving the blueprint `extends` chain. Returns null
 * when the hive has no blueprint file or it fails to resolve.
 *
 * `registryDefaultBranch` (WI-5164) — the registry entry's `github_default_branch`, when
 * known — is used to resolve `integrationBranch` ONLY when the blueprint does not specify
 * one explicitly. A `create_from_repo` pot (e.g. a GitHub repo whose default branch is
 * `master`/`main`) carries this from its registry entry; a fresh-init `self_repo` hive's
 * initial commit is made on `staging` (see hive-repo-init.ts), so its own recorded
 * `github_default_branch` (when a remote is published) is `staging` too — passing it
 * through here is a no-op for that case and changes nothing for the papercusp-style
 * monorepo blueprints that rely on the `staging` convention. Omitted ⇒ the old hardcoded
 * `'staging'` fallback (unknown-branch / no registry entry available to the caller).
 */
export function resolveHiveReleaseGate(hivePath: string, registryDefaultBranch?: string): HiveReleaseGate | null {
  const bpFile = join(hivePath, '.papercusp', 'blueprint.yaml');
  if (!existsSync(bpFile)) return null;
  let childObj: Record<string, unknown>;
  try {
    childObj = (parseYaml(readFileSync(bpFile, 'utf8')) ?? {}) as Record<string, unknown>;
  } catch {
    return null;
  }
  const resolver = operatorResolveExtends({ localDirs: [] });
  const validation = resolveAndValidate(childObj, resolver);
  if (!validation.ok || !validation.blueprint) return null;
  const knobs = (validation.blueprint.knobs ?? {}) as Record<string, unknown>;
  const gate = (knobs.releaseGate ?? {}) as Record<string, unknown>;
  // GATED when releaseGate.enabled is explicitly true, OR — when the knob is unset — it's a
  // CODING profile (output.kind:'repo-commit' + requiresRepo). Coding MEMBERS run kind:harness
  // blueprints (coding-factory / coding-solo) that carry no releaseGate knob but ARE code
  // repos, so they gate by default; explicit releaseGate.enabled:false (the non-coding `work`
  // blueprint) opts OUT. (per-hive-git-and-release-gate P-017 — gate code-in-member hives,
  // not just self_repo homes.)
  const outputKind =
    ((validation.blueprint as { output?: { kind?: string } }).output?.kind as string | undefined) ?? 'repo-commit';
  const codingProfile = outputKind === 'repo-commit' && knobs.requiresRepo !== false;
  const enabled = gate.enabled === true || (gate.enabled !== false && codingProfile);
  const fromRepo = (knobs.fromRepo ?? {}) as Record<string, unknown>;
  // WI-2828 durable fix (opt-in polarity): default to SKIPPING the operator-SPA build leg
  // for every subject hive, unless it EXPLICITLY opts in via releaseGate.spaBuildWorkspace.
  // The old default (null, when neither `fromRepo.frontend:false` nor an explicit
  // spaBuildWorkspace knob was set) left PAPERCUSP_SPA_BUILD_WORKSPACE unset, and
  // release-config.ts's OWN fallback then silently assumed '@papercusp/operator-vite' —
  // so ANY foreign/subject hive that doesn't carry that workspace (e.g. quartermaster,
  // whose frontend is apps/desktop) had its gate's SPA-build leg try to build a workspace
  // that doesn't exist in its tree and red-pin the whole gate (21 consecutive reds before
  // the quartermaster blueprint's own `fromRepo.frontend:false` bridge unblocked it).
  // `fromRepo.frontend === false` still forces the skip explicitly (kept for clarity /
  // back-compat with existing blueprints that already set it); the operator-home
  // (papercusp itself) is unaffected — it returns via the isOperatorHome early exit in
  // resolveHiveReleaseEnv before this value is ever read.
  const spaBuildWorkspace =
    fromRepo.frontend === false
      ? ''
      : typeof gate.spaBuildWorkspace === 'string'
        ? gate.spaBuildWorkspace
        : '';
  return {
    enabled,
    integrationBranch:
      typeof gate.integrationBranch === 'string'
        ? gate.integrationBranch
        : registryDefaultBranch || 'staging',
    releaseRef: typeof gate.releaseRef === 'string' ? gate.releaseRef : 'main',
    greenCmd: typeof gate.greenCmd === 'string' ? gate.greenCmd : null,
    spaBuildWorkspace,
    deploy: (gate.deploy as HiveReleaseGate['deploy']) ?? null,
    testCommand: typeof knobs.testCommand === 'string' ? knobs.testCommand : undefined,
  };
}

export interface HiveReleaseEnv {
  /** Whether this hive should run the green gate (enabled knob AND has a repo). */
  enabled: boolean;
  /** Why disabled, when enabled === false. */
  reason?: 'not_found' | 'no_blueprint' | 'gate_disabled' | 'no_repo';
  /** The env overlay to merge over process.env for the green-checkpoint/deploy subprocess.
   *  EMPTY for the operator-home slug (preserve exact current behavior). */
  env: Record<string, string>;
  /** Env keys to DELETE from the inherited process.env before the overlay is applied.
   *  `env` alone cannot express a deletion, and the thing that has to go is an INHERITED
   *  value, not a missing one (EI-20709645463022690). EMPTY for the operator-home slug. */
  clearEnv: string[];
  /** Whether a deploy target is configured (releaseGate.deploy) → release-trigger seeded. */
  hasDeploy: boolean;
  /** True for the operator-home (papercusp) slug — overlay is intentionally empty. */
  isOperatorHome: boolean;
  /** The resolved green command (for logging / the /admin/git surface). */
  greenCmd?: string;
  /** True when greenCmd came from the per-hive owner override (hive_settings), not the
   *  blueprint knob / detected testCommand / build fallback (P-014 /admin/git surface). */
  greenCmdOverridden?: boolean;
}

function disabled(reason: HiveReleaseEnv['reason']): HiveReleaseEnv {
  return { enabled: false, reason, env: {}, clearEnv: [], hasDeploy: false, isOperatorHome: false };
}

/**
 * Compute the per-hive release-gate env overlay for the green-checkpoint / deploy
 * subprocess. Returns `{ enabled:false, reason }` when the hive shouldn't be gated
 * (not found / no blueprint / gate disabled / no repo) — callers skip seeding/running.
 */
export async function resolveHiveReleaseEnv(slug: string, workspaceId: string): Promise<HiveReleaseEnv> {
  const reg = await loadHarnessRegistry(workspaceId);
  const entry = reg.projects.find((p) => p.slug === slug);
  if (!entry) return disabled('not_found');

  const gate = resolveHiveReleaseGate(entry.path, entry.github_default_branch);
  if (!gate) return disabled('no_blueprint');
  if (!gate.enabled) return disabled('gate_disabled');

  // A harness is gateable when its checkout has a real `.git` — a self_repo HOME (fresh-init
  // hive) OR a code MEMBER (a create_from_repo clone, e.g. oddsmith). The metadata-only home
  // (no .git) is correctly excluded — the gate rides the code-bearing harness, not the
  // control dir. (P-017: gate code-in-member hives, not just self_repo homes.)
  const hasRepo = existsSync(join(entry.path, '.git'));
  if (!hasRepo) return disabled('no_repo');

  // Operator-home (papercusp): EMPTY overlay → the subprocess uses the existing systemd-unit
  // env + releaseConfig defaults, i.e. EXACT current behavior (D-007, regression-safe).
  if (slug === operatorHomeHarnessSlug()) {
    return { enabled: true, env: {}, clearEnv: [], hasDeploy: !!gate.deploy, isOperatorHome: true };
  }

  const parent = dirname(entry.path);
  // Per-hive owner override (P-014): top precedence over the blueprint knob / detected
  // testCommand / build fallback, so editing the green command on /admin/git actually
  // changes what the gate runs. Best-effort — a DB hiccup must never break gate routing.
  let greenCmdOverride: string | null = null;
  try {
    const { getReleaseGreenCmdOverride } = await import('../../hive-settings-store');
    greenCmdOverride = await getReleaseGreenCmdOverride(workspaceId, slug);
  } catch {
    greenCmdOverride = null;
  }
  const greenCmd = greenCmdOverride ?? gate.greenCmd ?? gate.testCommand ?? DEFAULT_GREEN_CMD;
  const env: Record<string, string> = {
    PAPERCUSP_INTEGRATION_ROOT: entry.path,
    PAPERCUSP_RELEASE_SLUG: slug,
    PAPERCUSP_INTEGRATION_BRANCH: gate.integrationBranch,
    PAPERCUSP_RELEASE_REF: gate.releaseRef,
    PAPERCUSP_GREEN_CMD: greenCmd,
    PAPERCUSP_RELEASE_ROOT: join(parent, `${slug}-release`),
    PAPERCUSP_CHECKPOINT_ROOT: join(parent, `${slug}-checkpoint`),
    PAPERCUSP_CHECKPOINT_LOG_DIR: join(homedir(), '.papercusp', 'checkpoint-logs', slug),
  };
  // WI-2828: ALWAYS thread the resolved value (now always a string — resolveHiveReleaseGate
  // defaults it to '' rather than null) so a subject hive can never fall through to
  // release-config.ts's own '@papercusp/operator-vite' fallback by omission.
  env.PAPERCUSP_SPA_BUILD_WORKSPACE = gate.spaBuildWorkspace ?? '';

  // EI-20709645463022690: the gate subprocess inherited the OPERATOR's DATABASE_URL, so a
  // SUBJECT pot's suite silently dialed the papercusp database instead of its own. Observed
  // on sidestage: a "schema drift — 39 tables" red that nobody could reproduce in the pot's
  // own tree, because the tables it saw were papercusp's.
  //
  // Two DIFFERENT consumers read a DSN out of this subprocess's env, and they must be
  // separated rather than both served by one variable:
  //   1. the SUBJECT pot's own code/tests — read bare DATABASE_URL, and want THEIR database;
  //   2. the gate's OWN bookkeeping — green-checkpoint.ts dynamically imports operator-core
  //      (gate-verdict-target, coordination/messages, escalations, db-boot-migrate) to record
  //      its verdict, and genuinely wants the PAPERCUSP database.
  // So deleting DATABASE_URL alone would fix (1) by BREAKING (2) — verdict recording for
  // every pot gate. Instead, hand papercusp's DSN to its own namespaced channel and clear
  // the ambient one:
  //   embedded-pg-discovery resolves the admin DB from
  //   ['HARNESS_ADMIN_DATABASE_URL', 'DATABASE_URL', 'PAPERCUSP_PG_URL'] + discovery file +
  //   native fallback — HARNESS_ADMIN_DATABASE_URL OUTRANKS DATABASE_URL.
  // This is an EXISTING convention, not a new one: the gated pots already ship
  // libs/test-config/src/admin-test-runs-reporter.ts reading HARNESS_ADMIN_DATABASE_URL to
  // report their test runs back to papercusp (today it falls through to a hardcoded
  // localhost:5432/papercusp literal because nothing sets the var — this sets it properly).
  // Their setup-no-real-pg.ts hermeticity guard blocks real pools at buildClient regardless
  // of env, so setting this variable cannot trip it.
  //
  // Measured before landing: of the 24 gated non-operator-home harnesses, only oddsmith,
  // quartermaster and sidestage reference a DSN at all. oddsmith/quartermaster use their own
  // namespaced vars + testcontainers; sidestage's database.module.ts resolves
  // `env.DATABASE_URL ?? DEFAULT_DATABASE_URL` — so clearing the inherited value is exactly
  // what lets its OWN hermetic default win. None construct a bare `new Pool()`, so nothing
  // depends on inheriting PG* either. Operator-home never reaches this code (early return
  // above), which is what keeps papercusp's own PG-backed gate legs untouched (D-007).
  env.HARNESS_ADMIN_DATABASE_URL = getHarnessAdminUrl();
  const clearEnv = [
    'DATABASE_URL',
    'PGHOST',
    'PGPORT',
    'PGDATABASE',
    'PGUSER',
    'PGPASSWORD',
    'PGSSLMODE',
  ];

  return {
    enabled: true,
    env,
    clearEnv,
    hasDeploy: !!gate.deploy,
    isOperatorHome: false,
    greenCmd,
    greenCmdOverridden: greenCmdOverride != null,
  };
}

export interface CheckpointRouting {
  /** Tooling checkout containing the checkpoint/deploy executable, not necessarily its subject. */
  root: string;
  /** Subject env overlay; home routing overrides only a noncanonical integration root. */
  extraEnv: Record<string, string>;
  /** Env keys to DELETE from the inherited env before `extraEnv` is applied (EMPTY for
   *  operator-home / default — its behavior stays byte-identical, D-007). */
  clearEnv: string[];
  /** Present when this installSlug should NOT run a suite (not a gated coding hive). */
  skip?: { reason: string };
}

/**
 * Decide how a `system:green-checkpoint` / `system:release-trigger` fire should run, given
 * the FIRING routine's installSlug (per-hive-git-and-release-gate P-010). The operator-home
 * slug (or no slug) → caller tooling with the registered home repo as subject. An
 * unregistered home keeps the standalone default. A gated coding hive → its env overlay. A
 * non-gated slug (gate disabled / no repo) → `skip` (the handler records it and runs no
 * suite — a stray routine for a non-coding hive must never run the home suite).
 */
export async function resolveCheckpointRouting(
  ctx: { installSlug?: string | null; workspaceId: string },
  defaultRoot: string,
): Promise<CheckpointRouting> {
  const homeSlug = operatorHomeHarnessSlug();
  if (!ctx.installSlug || ctx.installSlug === homeSlug) {
    // EI-22765691547893941: the :3170 tooling checkout and :3070/scheduled launcher
    // used different integration roots for the SAME durable queue. Per-root run locks
    // then allowed concurrent runs, duplicate prewarming and incompatible snapshot keys.
    // Reuse the registry's subject identity just as foreign-hive routing does; do not
    // replace the caller's tooling (which may carry a not-yet-deployed launcher fix).
    const registry = await loadHarnessRegistry(ctx.workspaceId);
    const subjectRoot = registry.projects.find((project) => project.slug === homeSlug)?.path;
    return {
      root: defaultRoot,
      extraEnv: subjectRoot && subjectRoot !== defaultRoot
        ? { PAPERCUSP_INTEGRATION_ROOT: subjectRoot }
        : {},
      clearEnv: [],
    };
  }
  const hive = await resolveHiveReleaseEnv(ctx.installSlug, ctx.workspaceId);
  if (!hive.enabled)
    return { root: defaultRoot, extraEnv: {}, clearEnv: [], skip: { reason: hive.reason ?? 'not-gated' } };
  // CRUCIAL (P-019): `root` is the TOOLING root — where green-checkpoint.ts + setup-release-
  // checkout.sh + tsx physically live (the papercusp operator tree, `defaultRoot`). It is NOT
  // the hive's repo: the hive's checkout has no release scripts. The hive is the SUBJECT,
  // carried ONLY in extraEnv (PAPERCUSP_INTEGRATION_ROOT) so the script runs FROM papercusp
  // and OPERATES ON the hive. (Earlier this returned the hive root → script-not-found.)
  return { root: defaultRoot, extraEnv: hive.env, clearEnv: hive.clearEnv };
}
