import nodeCluster from 'node:cluster';
import { pinModuleState } from '@papercusp/module-singleton';

/**
 * background-workers.ts — the ONE evaluation of the EI-126 rule: should THIS
 * process run shared-DB background machinery (federation drains, DBOS
 * workflows, boot-time hive watchdog / wake-rule registration)?
 *
 * Two hosts running it against one papercusp DB caused the 2026-06-08 DBOS
 * appVersion war (EI-126); module-scope boot effects bypassing the rule let
 * every vitest WORKER run a "host boot" hive-watchdog check against the live
 * DB — 11 staged watchdog wakes per test run (EI-312 leg 1).
 *
 * Rule: explicit PAPERCUSP_BACKGROUND_WORKERS wins when set; otherwise default
 * ON everywhere EXCEPT the dev-box staging operator (PAPERCUSP_HONO_PORT=3170,
 * request-only by design) — and NEVER under vitest (tests must not poke the
 * live wake system, whatever the box's env says).
 */
export function backgroundWorkersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.VITEST) return false;
  return env.PAPERCUSP_BACKGROUND_WORKERS != null
    ? env.PAPERCUSP_BACKGROUND_WORKERS !== '0'
    : env.PAPERCUSP_HONO_PORT !== '3170';
}

/**
 * EI-19304005891638175: `backgroundWorkersEnabled()` answers "should THIS
 * process do background work?" — it is env-only, so a forked node:cluster
 * worker inherits its parent's env and answers TRUE in all N processes of a
 * clustered host (measured: all 17 of the :3070 release cluster). Several
 * boot-time crash-recovery checks (`potBootCheck`, `overwatchBootCheck`) used
 * it AS IF it meant "am I the one host-singleton?", which it does not — that
 * question additionally needs `cluster.isPrimary`. This is the mistake
 * `isSubstrateOwnerProcess` (below) already avoids for the hyperbee substrate,
 * and `host-bootstrap.ts`'s credential-sync watcher (EI-3385) already avoids
 * by hand with an inline `cluster.isPrimary` check — this gives that combined
 * predicate ONE name so the next "arm this exactly once per host" gate finds
 * it instead of reaching for `backgroundWorkersEnabled()` alone again.
 *
 * Unlike `isSubstrateOwnerProcess` (which negates `requestOnlyHost`, a PURE
 * env predicate with no vitest short-circuit — the substrate write path must
 * stay gate-testable under vitest), this composes with
 * `backgroundWorkersEnabled()` itself, so it inherits its VITEST short-circuit:
 * a vitest worker is never a "host singleton" for background-machinery
 * purposes, matching every other predicate in this file.
 */
export function isHostSingleton(opts?: { isPrimary?: boolean; env?: NodeJS.ProcessEnv }): boolean {
  const isPrimary = opts?.isPrimary ?? nodeCluster.isPrimary;
  return isPrimary && backgroundWorkersEnabled(opts?.env ?? process.env);
}

/**
 * Headless UTILITY host (PAPERCUSP_UTILITY_HOST=1) — a short-lived dedicated
 * operator instance (the gym-operator, future eval/bench hosts) that needs the
 * request surface + DBOS pipelines but none of the interactive/dogfood legs.
 *
 * backgroundWorkersEnabled() can't express this: it bundles the DBOS launch
 * with the shared-DB drains, and the gym needs DBOS ON. This flag instead
 * gates the boot legs that are irrelevant to a utility instance AND carry the
 * process's heavy native-module surface (EI-368 — the gym-operator
 * intermittently died with a bare `terminate called after throwing an
 * instance of 'Napi::Error'` mid-boot; the suspect natives all live behind
 * these legs):
 *  - the hyperbee/holepunch dogfood substrate (sodium/udx/rocksdb natives)
 *  - the voice cluster (mobile/desktop WS, local audio socket, relay — more
 *    holepunch natives + port scanning)
 *  - the boot-time embedder warm-up (onnxruntime)
 *
 * Independent of backgroundWorkers: a utility host usually keeps
 * backgroundWorkers ON for its own dedicated DB (DBOS pipelines); the gated
 * legs check BOTH.
 */
export function utilityHostEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PAPERCUSP_UTILITY_HOST === '1';
}

/**
 * Whether THIS process should arm the in-process REACTION MATCHER — project the
 * persisted hive-wake subscriptions into the in-memory reaction registry so a tool
 * invoked HERE fires its demand-wake reaction in-process (EI-307).
 *
 * This is REQUEST-SERVING work, NOT a background loop: no tick, no drain, no
 * resource cost beyond one PG read at boot, and it must be live on EVERY operator
 * host that serves tool calls — INCLUDING the dev-box staging operator
 * (PAPERCUSP_HONO_PORT=3170). `backgroundWorkersEnabled()` deliberately turns the
 * loops OFF on :3170 (request-only by design); bundling the matcher projection into
 * that gate is exactly the EI-307 bug — a `work_items:create` landing on :3170
 * matched no rule (staging's matcher was never armed) so the hive demand-wake
 * silently dropped. The matcher therefore arms wherever requests are served:
 * everywhere except tests (a vitest worker must not poke the live wake system).
 *
 * `PAPERCUSP_BACKGROUND_WORKERS=0` is deliberately NOT a matcher kill switch:
 * the clustered :3070 request workers and the :3170 staging host both carry that
 * value to disable background loops while still serving the tool calls whose
 * events the matcher must observe. Treating it as a full disable leaves every
 * request-serving process with an empty process-local reaction registry.
 */
export function reactionMatcherShouldArm(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.VITEST) return false;
  return true;
}

/**
 * Whether THIS process actually LAUNCHES DBOS: a background-workers host with DBOS
 * enabled — mirroring host-bootstrap's launch gate (`backgroundWorkers &&
 * PAPERCUSP_DBOS_ENABLE === '1'`). Request-only hosts set PAPERCUSP_BACKGROUND_WORKERS=0
 * (or run on the :3170 staging port) and delegate DBOS to the dedicated bg-host, so
 * their local `dbosStarted()` is false BY DESIGN.
 *
 * Unlike backgroundWorkersEnabled()/reactionMatcherShouldArm(), this is a PURE
 * predicate gating no machinery — so it deliberately has NO vitest short-circuit, and
 * readiness handlers (/api/health/ready, /api/health/deep) that call it argless under
 * test compute the real env-derived value. The bug it fixes: those handlers gated
 * readiness on the bare PAPERCUSP_DBOS_ENABLE env flag (which is set in the shared
 * .env.local that EVERY host sources), so a request-only host — which never launches
 * DBOS — reported `ready:false`/503 forever even while perfectly able to serve.
 */
export function dbosLaunchesHere(env: NodeJS.ProcessEnv = process.env): boolean {
  const backgroundHost =
    env.PAPERCUSP_BACKGROUND_WORKERS != null
      ? env.PAPERCUSP_BACKGROUND_WORKERS !== '0'
      : env.PAPERCUSP_HONO_PORT !== '3170';
  return backgroundHost && env.PAPERCUSP_DBOS_ENABLE === '1';
}

/**
 * Whether THIS process is a REQUEST-ONLY secondary host that must NOT join the
 * shared P2P substrate — the per-harness content swarm AND the hive-directory
 * gossip topic. The single-writer bg-host owns that machinery (EI-126): a second
 * host joining the swarm doubles the drain/announce loops and, for the directory
 * topic specifically, pulls in every public hive's peers.
 *
 * Unlike backgroundWorkersEnabled(), this is a PURE env predicate with NO vitest
 * short-circuit (like the sibling dbosLaunchesHere): it answers the boot-wiring
 * question "did the operator DECLARE itself request-only" — an explicit
 * PAPERCUSP_BACKGROUND_WORKERS=0, or the :3170 staging port — so a test can flip
 * it via env and the gate bites in every process, vitest included. (Bundling the
 * vitest short-circuit in would make every unit test look request-only, wrongly
 * suppressing swarm-injecting directory-wire tests.)
 *
 * EI-9534: the LAZY hive-directory wire (fired by discovery/federation-status
 * reads, publish, join) had no such gate — the boot-all substrate path is gated,
 * but this one wasn't — so a secondary host with PAPERCUSP_BACKGROUND_WORKERS=0
 * still joined the directory swarm, grew to ~74 connections + ~3.2 GB RSS, and
 * self-OOM-recycled (memory-watchdog exit 75). `requestOnlyHost()` is the gate.
 */
export function requestOnlyHost(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PAPERCUSP_BACKGROUND_WORKERS != null
    ? env.PAPERCUSP_BACKGROUND_WORKERS === '0'
    : env.PAPERCUSP_HONO_PORT === '3170';
}

/**
 * Does THIS process actually own (i.e. boot + hold the handles for) the hyperbee
 * substrate? The single source of truth for that question — deliberately shared by
 * both sides of the booted-handles sync so they can never disagree:
 *
 *   - READ side (`in-process-status.ts`): decides whether to trust the process-local
 *     handle map or fall back to the primary's cached broadcast.
 *   - WRITE side (`cluster-booted-handles-sync.ts`): decides whether this process is
 *     even ENTITLED to broadcast a snapshot.
 *
 * `nodeCluster.isPrimary` alone answers "am I a node:cluster-forked worker", NOT "did I
 * boot the substrate". Under the dedicated `papercup-bg-host` topology those diverge:
 * :3070/:3270 are declared request-only and never boot the substrate — bg-host does.
 * In particular, :3070 is a clustered request host: its workers fail `isPrimary`, while
 * its request-only primary fails `requestOnlyHost`. Neither half alone identifies the
 * substrate owner; the combined predicate does.
 *
 * EI-18735338283879820: keeping this predicate in ONE place is the actual fix. WI-5307
 * corrected the read side with an inline copy of this expression but left the write side
 * ungated, so a request-only primary happily broadcast an EMPTY snapshot every 5s; workers
 * cached it as fresh and rendered `reachedSubstrateOwner:true, bootedCount:0` — a confident
 * false zero, indistinguishable from a genuinely dead substrate, while bg-host had 51
 * harnesses booted. Two copies of one rule is what let the halves drift apart.
 */
export function isSubstrateOwnerProcess(opts?: {
  isPrimary?: boolean;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const isPrimary = opts?.isPrimary ?? nodeCluster.isPrimary;
  return isPrimary && !requestOnlyHost(opts?.env ?? process.env);
}

/**
 * WI-10006280: is THIS process an operator HOST, as opposed to a process that
 * merely IMPORTS the tool registry?
 *
 * `agent-tools/index.ts` boot-starts the await sweeper, the predicate-watch
 * poller and the interest-watch sweeper. Those loops claim and EXECUTE other
 * agents' wake deliveries. As unconditional module-scope effects they started in
 * every process that imported the registry: a scratch tsx driver (measured
 * 2026-10-06, its log carried `[wake-budget] delivery #439485 for su-b9ccbf0d…`
 * and four more foreign deliveries) and the gen-tool-catalog / tool-weight /
 * gen-doc-tool-catalog / gen-tool-delivery build scripts. (Vitest workers were
 * spared only because `managedSetInterval` is inert inside a Vitest worker.) A
 * short-lived process that claims a delivery and exits kills it mid-flight, and
 * a resume it spawned dies with its cgroup.
 *
 * None of the env predicates above can answer this. `backgroundWorkersEnabled()`
 * is false in exactly the processes that DO run these loops today: the :3070
 * request workers and :3170 carry PAPERCUSP_BACKGROUND_WORKERS=0, and the
 * registry reaches them lazily on their first MCP request. Gating on it would
 * silence the sweepers fleet-wide. And no env var is set in a host but absent in
 * a script that sources the same `.env.local`.
 *
 * So the host DECLARES itself: `runBootstrap()` (apps/operator/bin/host-bootstrap.ts)
 * calls `declareOperatorHostProcess()` first. Every operator host runs it: the
 * hono-host primary, every clustered request worker (`onWorker`), bg-host (a
 * hono-host bundle) and the desktop's serve.ts. Import-time loops register
 * through `whenOperatorHostProcess()`. If the host already declared, they start
 * now. Otherwise they queue until it does, which covers a registry imported
 * before boot. In a process that never declares (a script, a build generator,
 * a vitest worker), they never start.
 *
 * Explicit LAZY starts (an `events:await` registration calling
 * `startAwaitSweeper()`) are unaffected: a process that registers an await has
 * asked for the sweeper.
 */
const OPERATOR_HOST_STATE = pinModuleState('@papercusp/operator-core.operator-host-process', () => ({
  declared: false,
  pending: [] as Array<{ name: string; start: () => void }>,
}));

function runHostStart(name: string, start: () => void): void {
  try {
    start();
  } catch (e) {
    // Never block host boot: a missing table (pre-migration) must not wedge it.
    console.warn(`[host] ${name} failed to start (non-fatal): ${e instanceof Error ? e.message : e}`);
  }
}

/** Declare THIS process an operator host and run every queued host-only start. Idempotent. */
export function declareOperatorHostProcess(): void {
  if (OPERATOR_HOST_STATE.declared) return;
  OPERATOR_HOST_STATE.declared = true;
  for (const { name, start } of OPERATOR_HOST_STATE.pending.splice(0)) runHostStart(name, start);
}

/** True once `declareOperatorHostProcess()` ran in this process. */
export function isOperatorHostProcess(): boolean {
  return OPERATOR_HOST_STATE.declared;
}

/**
 * Run `start` only in an operator host: now if the host has declared itself,
 * else when it does. In a process that never declares (scripts, build
 * generators, vitest workers) it never runs.
 */
export function whenOperatorHostProcess(name: string, start: () => void): void {
  if (OPERATOR_HOST_STATE.declared) {
    runHostStart(name, start);
    return;
  }
  OPERATOR_HOST_STATE.pending.push({ name, start });
}

/** Test seam: forget the declaration and any queued starts. */
export function __resetOperatorHostProcessForTests(): void {
  OPERATOR_HOST_STATE.declared = false;
  OPERATOR_HOST_STATE.pending.length = 0;
}

/** Test seam: names of host-only starts queued and not yet run. */
export function __pendingOperatorHostStartsForTests(): string[] {
  return OPERATOR_HOST_STATE.pending.map((p) => p.name);
}
