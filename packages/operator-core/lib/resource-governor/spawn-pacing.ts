/**
 * Boot-window pacing for agent spawns (EI-21935016329074048).
 *
 * WHY THE DURABLE GOVERNOR DOES NOT ALREADY COVER THIS. `spawnGovernedAgentProcess`
 * admits an agent at process start and then holds its lease for the whole process
 * LIFETIME, so the governor rations STEADY-STATE agent capacity — and it must, because
 * a fleet is supposed to run twenty agents at once. Nothing rations BOOT capacity,
 * which is a different and far scarcer resource: a starting agent boots a CLI, restores
 * a `--resume` transcript, and completes an MCP handshake against :3070, and its kickoff
 * brief is delivered only if all of that finishes inside a FIXED submit-verify budget
 * (psu-pty-host's `SUBMIT_VERIFY_POLL_MS` x `SUBMIT_VERIFY_POLLS` plus the
 * native-turn-marker deadline). Those two ceilings are not interchangeable, so an agent
 * can be perfectly within the governor's steady-state budget and still lose its brief.
 *
 * THE OBSERVED FAILURE. 21 `capability:launch-agent { resume }` calls fired in one tight
 * loop all started at once. All 21 reported success; the two slowest boots exceeded the
 * fixed budget, burned their resubmits, and came up live at an idle prompt with the
 * brief DISCARDED. That is the worst available shape — the launch reports success, so
 * nothing upstream registers a failure, and a resumed agent simply sits there with no
 * instruction until a human notices.
 *
 * THE FIX IS TO PACE THE STARTS, NOT TO WIDEN THE BUDGET. Widening the deadline is the
 * classic mitigation: it leaves the contention in place and buys margin that the next
 * larger burst spends again. Capping how many agents boot at once removes the
 * contention itself, so the budget that already exists becomes sufficient.
 *
 * PACING IS PROCESS-WIDE ON PURPOSE. The failing burst was 21 SEPARATE tool calls, so a
 * per-call `stagger_ms` argument — the fix the original report proposed — would not have
 * paced it at all; each call had a batch of exactly one. Only state shared across calls
 * can serialize them, which is why this lives at the single chokepoint every agent
 * launch already passes through rather than in any one caller.
 *
 * FAIL-OPEN BY DESIGN. Pacing may DELAY a launch; it must never refuse one. A waiter
 * that exceeds `maxWaitMs` proceeds anyway and is counted in `failOpenCount`. A late
 * agent is recoverable, a refused launch is a new outage — and a pacer that can wedge
 * the fleet's ability to start agents would be a worse bug than the one it fixes.
 */
import { pinModuleState } from '@papercusp/module-singleton';

export interface SpawnPacingConfig {
  /** How many agents may be inside their boot window at once. `0` disables pacing. */
  readonly maxConcurrentBoots: number;
  /** How long a slot stays held after the spawn call returns, covering the boot itself. */
  readonly bootSettleMs: number;
  /** Upper bound on queue wait before a waiter proceeds anyway (fail-open). */
  readonly maxWaitMs: number;
}

export const DEFAULT_SPAWN_PACING: SpawnPacingConfig = {
  maxConcurrentBoots: 4,
  bootSettleMs: 3_000,
  maxWaitMs: 120_000,
};

/**
 * `spawnProcess` returns as soon as the process is SPAWNED, which takes milliseconds —
 * so holding a slot only for that call would pace nothing. The slot is therefore held
 * for the spawn plus `bootSettleMs`, which is the interval that actually models "this
 * agent is still booting". Read a non-numeric or negative value as "use the default"
 * rather than as zero: a typo'd env var must not silently disable the guard.
 */
function positiveInt(raw: string | undefined, fallback: number): number {
  // Trim BEFORE the numeric read. `Number(' ')` is 0, not NaN, so an env var set to
  // whitespace would otherwise parse as a deliberate `0` and silently DISABLE pacing on
  // the host that typo'd it — reintroducing the dropped-brief bug in the one place
  // nobody would look for it.
  const trimmed = raw?.trim();
  if (trimmed == null || trimmed === '') return fallback;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

export function agentSpawnPacingConfig(
  env: NodeJS.ProcessEnv = process.env,
): SpawnPacingConfig {
  return {
    maxConcurrentBoots: positiveInt(
      env.PAPERCUSP_AGENT_SPAWN_MAX_CONCURRENT_BOOTS,
      DEFAULT_SPAWN_PACING.maxConcurrentBoots,
    ),
    bootSettleMs: positiveInt(
      env.PAPERCUSP_AGENT_SPAWN_BOOT_SETTLE_MS,
      DEFAULT_SPAWN_PACING.bootSettleMs,
    ),
    maxWaitMs: positiveInt(
      env.PAPERCUSP_AGENT_SPAWN_PACING_MAX_WAIT_MS,
      DEFAULT_SPAWN_PACING.maxWaitMs,
    ),
  };
}

interface PacingState {
  /** Agents currently inside their boot window. */
  active: number;
  /** FIFO queue — a burst is admitted in arrival order, never last-in-first-out. */
  waiters: Array<() => void>;
  /** Observability: total admitted, and how many had to fail open. */
  admittedCount: number;
  failOpenCount: number;
  maxObservedQueueDepth: number;
  /**
   * Release timers still pending. A slot is held for `bootSettleMs` AFTER its spawn
   * returns, so a timer routinely outlives the call that scheduled it — and, in tests,
   * the case that scheduled it. Tracking them is what makes the reset below total:
   * clearing counters alone leaves a live timer that later decrements `active` and
   * hands a slot to an unrelated waiter, which presents as an order-dependent flake.
   */
  pendingReleases: Set<ReturnType<typeof setTimeout>>;
}

/**
 * Pinned rather than a bare module-scoped `let`: several ordinary loader seams here
 * (tsx's CJS preflight beside the ESM loader, a bare specifier and a relative path
 * reaching the same file, `node_modules/@papercusp/*` symlinked into the repo) can
 * produce two module records. A split pacer is worse than no pacer, because each record
 * would enforce its own half of the limit while reporting that the limit is enforced.
 */
const state = pinModuleState(
  '@papercusp/operator-core.agent-spawn-pacing',
  (): PacingState => ({
    active: 0,
    waiters: [],
    admittedCount: 0,
    failOpenCount: 0,
    maxObservedQueueDepth: 0,
    pendingReleases: new Set(),
  }),
);

/** Point-in-time pacing counters, for tests and diagnostics. */
export function agentSpawnPacingStats(): Readonly<{
  active: number;
  queued: number;
  admittedCount: number;
  failOpenCount: number;
  maxObservedQueueDepth: number;
}> {
  return {
    active: state.active,
    queued: state.waiters.length,
    admittedCount: state.admittedCount,
    failOpenCount: state.failOpenCount,
    maxObservedQueueDepth: state.maxObservedQueueDepth,
  };
}

/** Drop all pacing state. Tests only — never call this from production paths. */
export function resetAgentSpawnPacingForTests(): void {
  // Cancel pending releases FIRST. Otherwise a timer scheduled by an earlier test fires
  // during a later one, decrements `active` and admits that test's queued waiter
  // normally — so an assertion about fail-open (or about the cap) silently measures the
  // previous test's leftovers instead of its own subject.
  for (const timer of state.pendingReleases) clearTimeout(timer);
  state.pendingReleases.clear();
  // Release anyone still queued rather than stranding their promise forever: a test
  // that resets mid-burst must not leave a hung await behind for the next test file.
  const stranded = state.waiters.splice(0, state.waiters.length);
  state.active = 0;
  state.admittedCount = 0;
  state.failOpenCount = 0;
  state.maxObservedQueueDepth = 0;
  for (const release of stranded) {
    try {
      release();
    } catch {
      /* a reset must not throw on behalf of an abandoned waiter */
    }
  }
}

function acquire(config: SpawnPacingConfig): Promise<void> {
  if (config.maxConcurrentBoots <= 0) return Promise.resolve();
  if (state.active < config.maxConcurrentBoots) {
    state.active += 1;
    state.admittedCount += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    const admit = (failedOpen: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const index = state.waiters.indexOf(waiter);
      if (index >= 0) state.waiters.splice(index, 1);
      state.active += 1;
      state.admittedCount += 1;
      if (failedOpen) state.failOpenCount += 1;
      resolve();
    };
    const waiter = () => admit(false);
    // Fail-open: a stuck or crashed holder must never make the fleet unlaunchable.
    const timer = setTimeout(() => admit(true), config.maxWaitMs);
    // Never keep the process alive just to enforce pacing.
    timer.unref?.();
    state.waiters.push(waiter);
    if (state.waiters.length > state.maxObservedQueueDepth) {
      state.maxObservedQueueDepth = state.waiters.length;
    }
  });
}

function scheduleRelease(config: SpawnPacingConfig): void {
  if (config.maxConcurrentBoots <= 0) return;
  const release = () => {
    state.active -= 1;
    const next = state.waiters.shift();
    if (next) next();
  };
  if (config.bootSettleMs <= 0) {
    release();
    return;
  }
  const timer = setTimeout(() => {
    state.pendingReleases.delete(timer);
    release();
  }, config.bootSettleMs);
  timer.unref?.();
  state.pendingReleases.add(timer);
}

/**
 * Run `spawn` under boot-window pacing.
 *
 * The caller is delayed only at ACQUIRE time; once `spawn` resolves this returns
 * immediately, while the slot stays held for `bootSettleMs` to cover the boot the spawn
 * just started. A spawn that throws releases its slot on the same schedule — a failed
 * launch still consumed real boot capacity on its way down, and releasing early would
 * let a crash-looping caller pace nothing at all.
 */
export async function withAgentSpawnPacing<T>(
  spawn: () => Promise<T>,
  config: SpawnPacingConfig = agentSpawnPacingConfig(),
): Promise<T> {
  await acquire(config);
  try {
    return await spawn();
  } finally {
    scheduleRelease(config);
  }
}
