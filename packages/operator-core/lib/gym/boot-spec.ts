/**
 * P-001 "minimal bootable unit" — the spawn spec for the dedicated gym-operator.
 *
 * Per D-018 (Option A), the gym runs the real pipeline on ONE long-lived headless
 * operator+DBOS process, NOT the live :3070 fleet operator. This builder encodes
 * the exact environment that makes that instance hermetic:
 *
 *   - booted from a PINNED papercup checkout (a worktree/clone parked at a fixed
 *     SHA) so the harness-under-test code can't drift mid-run (D-016);
 *   - pointed at a DEDICATED gym PG database (both admin-DSN resolution keys), so
 *     no gym schema/run ever touches the live PG and no live DSN leaks in;
 *   - on a DEDICATED port; DBOS autoloop scoped (default: manual) so the runner
 *     starts each pipeline explicitly for deterministic 1-feature-per-harness runs;
 *   - DBOS app-version pinned to the harness commit, isolating the gym DBOS app
 *     from the live one and keeping workflow recovery stable for the run.
 *
 * Pure: returns the spawn spec; the caller spawns with `{ ...process.env, ...env }`
 * so these explicit gym overrides win (dotenv.config() does not override set vars).
 */
import { AGENT_ROLES } from '@papercusp/agent-mcp';

import { LEARNING_MODEL_SPEC } from '../learning/model-policy';
import { isPinnedCommit } from './clone';

/**
 * Canonical model map for every built-in role the dedicated Gym operator can
 * spawn. Deriving this from the runtime role registry makes newly added roles
 * inherit the learning policy automatically instead of falling through to a
 * heterogeneous committed floor or the agent command's implicit default.
 */
export const CANONICAL_GYM_AGENT_MODELS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(AGENT_ROLES.map((role) => [role, LEARNING_MODEL_SPEC])),
);

export interface GymOperatorBootConfig {
  /** Absolute path to the pinned papercup checkout (worktree/clone @ harnessCommit). */
  pinnedCheckoutPath: string;
  /** The pinned harness-under-test commit SHA (D-016) — recorded as gym_runs_params.harness_commit. */
  harnessCommit: string;
  /** DSN of the dedicated gym Postgres database. */
  gymDatabaseUrl: string;
  /** Dedicated Hono port for this instance. */
  honoPort: number;
  /** Workspace id to pin for the instance's lifetime. */
  workspaceId: string;
  /** PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES; default 'none' (manual dispatch only). */
  autoloopScope?: string;
  /** PAPERCUSP_DBOS_MAX_PIPELINES; default 4 (matches the DBOS pipeline queue). */
  maxPipelines?: number;
  /** Bind interface; default loopback. */
  bindHost?: string;
  /** Optional pin of the agent CLI command (AGENT_CMD). */
  agentCmd?: string;
  /**
   * Optional explicit per-role map. Real Gym runs omit this and receive
   * CANONICAL_GYM_AGENT_MODELS; zero-LLM fixtures pass `{}` so their injected
   * fake command is not backend-swapped by a Codex-shaped model spec.
   */
  agentModels?: Record<string, string>;
  /** Optional explicit override of the gym-operator's own per-turn invoke wall-clock timeout
   *  (PAPERCUSP_DBOS_INVOKE_TIMEOUT_MS); default `gymWorkerInvokeTimeoutMs()` (below). */
  invokeTimeoutMs?: number;
}

/** Default per-turn invoke wall-clock budget (ms) for the isolated gym-operator's spawned agent
 *  turns (worker/architect/etc — orchestrator-runner.ts's `invokeTimeoutMs()`), env-overridable
 *  via PAPERCUSP_GYM_WORKER_INVOKE_TIMEOUT_MS. Deliberately WIDER than the shared fleet default
 *  (45min) — EI-481: a live gym cycle wedged when a `worker` turn was flat-SIGTERM'd (exit 143,
 *  empty stderr) mid-93min-runtime under sustained upstream-429 pressure on the shared
 *  inference-gateway pool, and the cycle then produced nothing until the 60-min stale-run reclaim
 *  cleared it. Root cause: orchestrator-runner's `runChild()` kill timer is a flat WALL-CLOCK
 *  deadline (`opts.timeoutMs ?? invokeTimeoutMs()`), reading PAPERCUSP_DBOS_INVOKE_TIMEOUT_MS
 *  PER-PROCESS — the gym-operator is its own dedicated process (D-018), so pinning this var here
 *  (an "explicit gym override", per this file's header) only widens the gym's OWN worker budget;
 *  it never touches the shared :3070 default every other role relies on. Gym is already the most
 *  latency-tolerant lane in the fleet (tier 4 batch, DEFAULT_GATEWAY_PRIORITY_MAP — it already
 *  yields to interactive/su traffic at the gateway admission layer), so giving its turns more
 *  wall-clock room to pace/retry through contention rather than being killed mid-backoff is a safe,
 *  gym-scoped widening, not a fleet-wide policy change. */
export const DEFAULT_GYM_WORKER_INVOKE_TIMEOUT_MS = 90 * 60 * 1000; // 90 min (shared default: 45 min)

/** Resolve the gym-operator's per-turn invoke timeout: env override
 *  PAPERCUSP_GYM_WORKER_INVOKE_TIMEOUT_MS, else DEFAULT_GYM_WORKER_INVOKE_TIMEOUT_MS. Fail-soft to
 *  the default on a missing/invalid/non-positive value (mirrors gymBudgetFloorUsd()'s pattern). */
export function gymWorkerInvokeTimeoutMs(): number {
  const raw = process.env.PAPERCUSP_GYM_WORKER_INVOKE_TIMEOUT_MS;
  if (raw == null || raw.trim() === '') return DEFAULT_GYM_WORKER_INVOKE_TIMEOUT_MS;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(
      `[gym-boot-spec] PAPERCUSP_GYM_WORKER_INVOKE_TIMEOUT_MS="${raw}" is not a positive number — using ${DEFAULT_GYM_WORKER_INVOKE_TIMEOUT_MS}`,
    );
    return DEFAULT_GYM_WORKER_INVOKE_TIMEOUT_MS;
  }
  return n;
}

export interface GymOperatorBootSpec {
  command: string;
  args: string[];
  cwd: string;
  /** The explicit gym overrides; merge onto process.env (these win). */
  env: Record<string, string>;
}

export function buildGymOperatorBootSpec(cfg: GymOperatorBootConfig): GymOperatorBootSpec {
  if (!isPinnedCommit(cfg.harnessCommit)) {
    throw new Error(
      `gym harness-under-test commit must be a pinned hex SHA (D-016), got: ${JSON.stringify(cfg.harnessCommit)}`,
    );
  }

  const env: Record<string, string> = {
    // Hermetic PG: pin every DSN key the operator AND its spawned worker subprocess
    // consult. getHarnessAdminUrl() (operator side) reads HARNESS_ADMIN_DATABASE_URL >
    // DATABASE_URL; the orchestrator pg-bootstrap (WORKER subprocess, inheriting this
    // env) reads PAPERCUSP_DATABASE_URL > ~/.papercusp/embedded-pg.json > :5432/papercusp.
    // Pin ALL THREE so neither the live DATABASE_URL nor a live embedded-pg.json can leak
    // in — without PAPERCUSP_DATABASE_URL the worker silently connects to the live dev DB
    // (a hermeticity breach) where the gym harness schema is absent → UPDATE 42P01.
    DATABASE_URL: cfg.gymDatabaseUrl,
    HARNESS_ADMIN_DATABASE_URL: cfg.gymDatabaseUrl,
    PAPERCUSP_DATABASE_URL: cfg.gymDatabaseUrl,
    // GYM-1 layer-2 fix (gym-unwedge-scout-novelty-2026-07-02): the org-pg APP
    // resolver (libs/db connection.ts resolveAppUrl) consults HARNESS_DATABASE_URL
    // FIRST and NEVER falls back to DATABASE_URL — unpinned, the gym-operator fell
    // through to the hardcoded harness_app:harness_app_pwd@localhost:5432 default
    // against the LIVE native PG → "password authentication failed" on EVERY
    // getOrgPg() consumer at boot. This was the REAL error behind the 12-day
    // gym-cycle:error streak (masked by the detail-dropping recorder, also fixed).
    HARNESS_DATABASE_URL: cfg.gymDatabaseUrl,
    // GYM-1 layer-3 fix: pgbouncerEnabled() defaults ON for server-class hosts
    // (hostClass fallback when the env is unset), and maybePgbouncer() then
    // REWRITES the pinned container URL's host to the LIVE pooler at :6432 —
    // whose credentials differ → "password authentication failed" at boot even
    // with every DSN pinned. The hermetic sandbox must ALWAYS dial its container
    // DIRECTLY: pin the bouncer OFF.
    PAPERCUSP_PGBOUNCER: '0',
    // GYM-1 layer-5 fix (monitor-agent finding, 15:40): bg-host's
    // PAPERCUSP_POT_HOME_SLUG=papercusp leaks through the process.env spread,
    // and the home-harness STARTUP VALIDATION then fatals — 'papercusp' is not
    // a registered project in the HERMETIC container's registry. The gym
    // operator runs NO hive: pin the home slug EMPTY (resolvePotHomeSlug
    // treats blank as unset → the hive-home validation is a no-op).
    PAPERCUSP_POT_HOME_SLUG: '',
    // WI-2604 root cause (1): bg-host's dev-api service sets PAPERCUSP_MCP_PROXY_BASE
    // (mcp-host-availability-resilience P-005, e.g. http://127.0.0.1:9071 fronting the
    // LIVE :3070 operator) and that leaks through the `...process.env` spread. Both
    // `resolveSpawnOperatorBase` (orchestrator spawn-mcp.ts, signs the per-spawn URL)
    // and `resolveAgentMcpBaseUrl` (mcp-base-url.ts, worker chunk-loop spawns) check
    // this env var BEFORE the spawning host's own PAPERCUSP_HONO_PORT — so every gym
    // eval agent's `.mcp.json` pointed at the proxy → the LIVE :3070 operator instead
    // of this dedicated gym-operator's own port. The live operator then verified the
    // signature against ITS OWN spawn-signing-key (from the live DB), while the gym
    // process signed with the GYM DB's preminted key → HMAC mismatch → invalid_signature
    // on every gym eval spawn. Blank it so eval agents always hand-shake THIS hermetic
    // instance (matching PAPERCUSP_POT_HOME_SLUG's seal above).
    PAPERCUSP_MCP_PROXY_BASE: '',
    // WI-2604 root cause (1b), found 2026-07-26: the dev-box .env.local sets
    // PAPERCUSP_OPERATOR_URL=http://localhost:3070/api/mcp (EI-286 leg (b)) and it
    // leaks through the `...process.env` spread exactly like PAPERCUSP_MCP_PROXY_BASE
    // above — dbos-invoke's this-host pin only applies when the var is UNSET, so
    // every gym worker's .mcp.json handshook the LIVE :3070 operator, where
    // role=worker rightly has zero capabilities (empty system_principals) and the
    // throwaway harness doesn't exist. Result: 100% of gym runs 07-20→07-26
    // terminal_state='escalated' with an empty diff — the workers could not write a
    // byte, and the capability seeds (runner-ports.ts) never applied because the
    // dispatch happened on the WRONG HOST. Pin it to THIS hermetic instance.
    PAPERCUSP_OPERATOR_URL: `http://${cfg.bindHost ?? '127.0.0.1'}:${cfg.honoPort}/api/mcp`,
    PAPERCUSP_HONO_PORT: String(cfg.honoPort),
    PAPERCUSP_BIND_HOST: cfg.bindHost ?? '127.0.0.1',
    PAPERCUSP_WORKSPACE_ID: cfg.workspaceId,
    // The launcher shell may carry the shared dev host's clustered HTTP settings
    // (PAPERCUSP_CLUSTER=16, PAPERCUSP_CLUSTER_WORKERS=6). A clustered gym host
    // serves requests from workers while DBOS launches only in the background
    // primary, so the pipeline route can call DBOS.listWorkflows() in a process
    // where DBOS was never launched. Pin both precedence-sensitive knobs off:
    // resolveClusterWorkers() checks PAPERCUSP_CLUSTER_WORKERS before CLUSTER.
    PAPERCUSP_CLUSTER: '0',
    PAPERCUSP_CLUSTER_WORKERS: '0',
    // Boot the durable orchestrator; keep auto-dispatch off by default so the
    // runner owns when each feature pipeline starts (deterministic).
    PAPERCUSP_DBOS_ENABLE: '1',
    // Generic routines engine (git-sync-auto-commit P-001) — git-sync + future
    // per-harness scheduled tasks. Routines stay inert unless active=true.
    PAPERCUSP_DBOS_ROUTINES: '1',
    PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES: cfg.autoloopScope ?? 'none',
    PAPERCUSP_DBOS_MAX_PIPELINES: String(cfg.maxPipelines ?? 4),
    // Isolate the gym DBOS application + keep recovery stable for the run.
    DBOS__APPVERSION: `gym-${cfg.harnessCommit.slice(0, 12)}`,
    // Not the Tauri desktop/IPC context.
    PAPERCUSP_IPC_ENABLE: '0',
    // EI-368: headless utility profile — skip the voice cluster, hyperbee
    // substrate, and embedder warm-up. The gym never uses them, they inherit
    // port scans from the launcher env, and they carry the heavy native-module
    // surface suspected in the intermittent boot abort (Napi::Error terminate
    // mid-DBOS-migration → half-migrated dbos schema → "column was_forked_from
    // does not exist" on the first pipeline call).
    PAPERCUSP_UTILITY_HOST: '1',
    // The gym REQUIRES DBOS launched: its readiness gate (/api/health/ready) is
    // `dbosEnabled ? dbosLaunched : true`, and it runs feature pipelines through
    // DBOS. backgroundWorkersEnabled() — which bundles the DBOS launch — defaults
    // OFF under VITEST and under an inherited PAPERCUSP_BACKGROUND_WORKERS=0 (the
    // dev-box .env.local / the :3170 staging operator set it request-only). Either
    // leak leaves PAPERCUSP_DBOS_ENABLE=1 waiting on a launch that never happens →
    // /api/health/ready stuck at 503 → the runner's 120s readiness timeout (the
    // gym cycle then fails before it starts). Seal both, matching this spec's
    // hermeticity contract: force backgroundWorkers ON (the gym runs against its
    // OWN isolated DB, so no EI-126 two-host conflict; PAPERCUSP_UTILITY_HOST still
    // strips the dogfood/voice/embedder legs) and blank an inherited VITEST so a
    // test/CI-spawned gym boots as a real operator, not a suppressed vitest worker.
    PAPERCUSP_BACKGROUND_WORKERS: '1',
    VITEST: '',
    // EI-481: widen the gym-operator's OWN per-turn invoke wall-clock timeout — see
    // gymWorkerInvokeTimeoutMs() above. An explicit gym override (this env object wins over the
    // inherited process.env spread), so this never affects the shared :3070 default.
    PAPERCUSP_DBOS_INVOKE_TIMEOUT_MS: String(cfg.invokeTimeoutMs ?? gymWorkerInvokeTimeoutMs()),
  };

  if (cfg.agentCmd) env.AGENT_CMD = cfg.agentCmd;
  // ALWAYS pin per-role models. Real Gym runs default EVERY built-in spawnable
  // role to the canonical learning model, sealing them both from the launcher's
  // inherited AGENT_MODELS and from heterogeneous committed role floors. A newly
  // registered role is covered automatically through AGENT_ROLES. Zero-LLM
  // fixtures explicitly pass `{}` so their injected Node command remains fake.
  env.AGENT_MODELS = JSON.stringify(cfg.agentModels ?? CANONICAL_GYM_AGENT_MODELS);

  return {
    command: 'npx',
    args: ['tsx', 'bin/hono-host.ts'],
    cwd: `${cfg.pinnedCheckoutPath}/apps/operator`,
    env,
  };
}

/**
 * Hermeticity (real-mode auth) — EI-232: a Claude-Code launcher session
 * carries its OWN per-session CLAUDE_CONFIG_DIR + nested-session markers
 * (psu-isolation). Every gym runnable spawns its gym-operator with
 * `{ ...process.env, ...spec.env, ...overrides }`, which inherits those
 * launcher-session vars — and once inside the hermetic gym-operator, every
 * spawned `claude -p` real-mode agent then reads the LAUNCHER's per-session
 * config dir instead of the user-global `~/.claude`, and auths against the
 * launcher session's rotating OAuth: every real-mode `decide` invoke exits 1
 * with "Failed to authenticate. API Error: 401 Invalid authentication
 * credentials" (observed live in the hive-loop-e2e P-007 real run). Fake
 * mode is immune (no auth), which is why no gym runnable caught this until a
 * real-mode run did. The production fleet's own spawns run with none of
 * these vars set — this scrub just matches that.
 *
 * Call this on the FINAL merged child env object (after `{ ...process.env,
 * ...spec.env, ...overrides }`), not on `spec.env` alone — the leak comes
 * from the `...process.env` spread, so deleting from `spec.env` before the
 * merge would not remove it from the result.
 *
 * Mutates `env` in place (matches Node's `spawn({ env })` call shape) and
 * also returns it for chaining.
 */
export function scrubLauncherClaudeSessionEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDECODE;
  return env;
}
