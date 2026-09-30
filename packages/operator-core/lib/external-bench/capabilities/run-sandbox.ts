/**
 * run-sandbox.ts — {@link RunSandbox}, the per-(suite-run × arm) isolation boundary
 * (plan benchmark-capability-injection-redesign-2026-06-17, P-002 / D-003 / D-007).
 *
 * A run-sandbox is backed by a per-run EPHEMERAL HIVE. Its `potSlug` is the single
 * shared namespace every capability scopes through:
 *   - memory → `memory:*` with `hive_slug = potSlug` (the hive's shared pool — see
 *     memory:remember's `hive_slug` arg: "every agent in every member harness of that
 *     hive recalls it");
 *   - work-queue → `work_items:*` scoped to `memberSlug` (the member harness holds the
 *     run's items);
 *   - coord → `coord:*` scoped to `potSlug` (peer messages stay in the sandbox).
 *
 * BOOT mirrors `su-independent-backlog.ts`'s real ops EXACTLY: `createHive` (idle Queen
 * seat) → `registerMember` (the member harness, with `hive_slug` → the home so it scopes
 * to the hive) → `seedFeature` (a lone bootstrap feature so the member's work-queue is a
 * real, scaffolded harness). The sandbox PERSISTS for the whole run/arm — memory
 * ACCUMULATES across all tasks (D-007). {@link RunSandbox.dispose} tears it down
 * (`dropMember` → `dissolveHive`) at run end → wiped, never leaks to production or
 * between runs.
 *
 * Both the hive ops AND the loopback run-tool are dependency-injected ({@link OpenRunSandboxDeps})
 * so the unit tests never boot a real hive or fire a real MCP call.
 */
import type { OpenRunSandboxDeps } from './capability-tools';
import type { RunSandbox, SandboxHiveOps, SandboxId } from './types';

export interface OpenRunSandboxArgs {
  /** The benchmark suite (e.g. `swe-bench-pro`) — part of the sandbox identity + slug. */
  suite: string;
  /** The arm under test (e.g. `+memory`, `ours`, `vanilla`) — part of the sandbox identity + slug. */
  arm: string;
  /** The suite-run id — part of the sandbox identity + slug. */
  runId: string;
  /** Override the workspace; defaults to `deps.workspaceId`. */
  workspaceId?: string;
  /**
   * Override the ephemeral-hive slug (and member slug prefix). Defaults to a generated
   * `xbench-cap-<suite>-<arm>-<short>` slug. The clone path the member registers against
   * defaults to a per-sandbox scratch dir under the system tmp (no repo is needed for the
   * capability-only sandbox — the member exists to scope the work-queue).
   */
  potSlug?: string;
  /** The member harness's clone path. Defaults to a per-sandbox scratch dir. */
  clonePath?: string;
}

/**
 * Open a run-sandbox: boot the ephemeral hive + member harness, seed the bootstrap
 * feature, and return the {@link RunSandbox} the capability tools bind to. The
 * `dispose()` returned tears the hive down. NEVER leaks a half-booted hive: if any boot
 * step throws AFTER the hive was created, we best-effort dissolve before rethrowing.
 *
 * Dependency-inject `deps.hiveOps` (the {@link SandboxHiveOps}) + `deps.runTool` (the
 * loopback run-tool) so a test passes fakes — NO real hive, NO real MCP call.
 */
export async function openRunSandbox(deps: OpenRunSandboxDeps, args: OpenRunSandboxArgs): Promise<RunSandbox> {
  const workspaceId = args.workspaceId ?? deps.workspaceId;
  const id: SandboxId = { suite: args.suite, arm: args.arm, runId: args.runId };
  const potSlug = args.potSlug ?? generateSandboxSlug(args);
  const memberSlug = `${potSlug}-m`;
  const clonePath = args.clonePath ?? defaultClonePath(deps, potSlug);

  const hiveOps = deps.hiveOps;

  // CREATE the ephemeral hive (the shared namespace's home). A create failure aborts —
  // there is nothing to tear down yet.
  await hiveOps.createHive({ slug: potSlug, workspaceId });

  // From here a boot failure must dissolve the created hive before rethrowing (no leak).
  try {
    await hiveOps.registerMember({ member: memberSlug, clonePath, hiveHome: potSlug, workspaceId });
    await hiveOps.seedFeature({
      member: memberSlug,
      featureId: bootstrapFeatureId(potSlug),
      title: `capability-sandbox bootstrap (${args.suite}/${args.arm})`,
      spec: 'Bootstrap feature scaffolding the run-sandbox work-queue. Benchmark tasks enqueue real work_items here.',
      workspaceId,
    });
  } catch (err) {
    await disposeHive(hiveOps, { potSlug, memberSlug, workspaceId }).catch(() => {});
    throw err;
  }

  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return; // idempotent — a double-dispose must not double-tear-down.
    disposed = true;
    await disposeHive(hiveOps, { potSlug, memberSlug, workspaceId });
  };

  return {
    id,
    potSlug,
    memberSlug,
    workspaceId,
    runTool: deps.runTool,
    dispose,
  };
}

/** Tear the ephemeral hive down: drop the member, then dissolve the hive. Best-effort each. */
async function disposeHive(
  hiveOps: SandboxHiveOps,
  input: { potSlug: string; memberSlug: string; workspaceId: string },
): Promise<void> {
  await hiveOps.dropMember({ member: input.memberSlug, workspaceId: input.workspaceId }).catch(() => {});
  await hiveOps.dissolveHive({ hiveHome: input.potSlug, workspaceId: input.workspaceId }).catch(() => {});
}

/** The member's lone bootstrap feature id (stable per hive). */
function bootstrapFeatureId(potSlug: string): string {
  return `xbench-cap-bootstrap-${potSlug}`;
}

/**
 * A slug safe for a harness/hive slug: lowercased, non-alnum collapsed to `-`, bounded,
 * with a short random suffix so concurrent (suite, arm) sandboxes never collide. Pure
 * except for the random suffix.
 */
function generateSandboxSlug(args: OpenRunSandboxArgs): string {
  const sanitize = (s: string): string =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 16);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `xbench-cap-${sanitize(args.suite)}-${sanitize(args.arm)}-${suffix}`;
}

/** Per-sandbox scratch clone path (the member registers here; no repo is required). */
function defaultClonePath(deps: OpenRunSandboxDeps, potSlug: string): string {
  const base = deps.scratchParent ?? '/tmp/xbench-capabilities';
  return `${base}/${potSlug}`;
}

/**
 * The LIVE {@link SandboxHiveOps} — wires to `liveHiveOps` exactly as
 * `su-independent-backlog.ts`'s real ops do. Lazy dynamic import keeps this module
 * import-light so the fake-driven unit test never loads the hive/PG ops.
 */
export function liveSandboxHiveOps(workspaceId: string): SandboxHiveOps {
  const liveOps = async () => {
    const { liveHiveOps } = await import('../../pot-eval/live-ops');
    return liveHiveOps({ workspaceId });
  };
  return {
    async createHive({ slug, workspaceId }) {
      const ops = await liveOps();
      await ops.createHive({ slug, workspaceId });
    },
    async registerMember({ member, clonePath, hiveHome, workspaceId }) {
      const ops = await liveOps();
      await ops.registerMember({ member, clonePath, hiveHome, workspaceId });
    },
    async seedFeature({ member, featureId, title, spec, workspaceId }) {
      const ops = await liveOps();
      await ops.seedFeature({ member, featureId, title, spec, workspaceId });
    },
    async dropMember({ member, workspaceId }) {
      const ops = await liveOps();
      await ops.dropMember({ member, workspaceId }).catch(() => {});
    },
    async dissolveHive({ hiveHome, workspaceId }) {
      const ops = await liveOps();
      await ops.dissolveHive({ hiveHome, workspaceId }).catch(() => {});
    },
  };
}
