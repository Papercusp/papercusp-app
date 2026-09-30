/**
 * worker-breaker-watch.ts — turn a tripped persistent-worker crash-breaker into an
 * ANNOUNCED signal (WI-37700; direct follow-on to WI-37696).
 *
 * WI-37696 made the three breakers OBSERVABLE — `cpuWorker` on the operator host's
 * `/api/health/deep`, `workers.{embedder,reranker}` on the embed sidecar's `/healthz`.
 * That closed "the state is unreachable". It did NOT close "nobody looks": nothing in
 * the tree polls either surface, so a tripped `disabled` latch is discoverable only by
 * someone who ALREADY suspects it. Since the fallback path returns identical values and
 * emits no error, no log line and no exit code, nobody ever acquires that suspicion.
 *
 * ── Why this file watches only TWO of the three breakers ──────────────────────────────
 *
 * The three workers do not share a process, and the right mechanism follows from the
 * process topology rather than from a preference for one style:
 *
 *   • embedder + reranker live in the embed SIDECAR — ONE process. So a single read of
 *     its `/healthz` IS a complete census of both, and polling from outside is exactly
 *     right. It also has to be from outside: the sidecar is an esbuild bundle with no PG
 *     and no coord client, so it cannot announce anything itself, and both latches live
 *     in GENERIC borrowable libs (`libs/generic/memory`, `libs/generic/rerank`) where a
 *     papercusp-specific notifier would need a `configure*()` seam apiece.
 *
 *   • cpuWorker lives in the OPERATOR HOST, which is a `node:cluster` reuseport FLEET
 *     (`hono-host.ts` listens with `reusePort: true`; `cluster-fork.ts` forks N workers),
 *     and `_workerDisabled` is module-global PER PROCESS. So one GET of `/api/health/deep`
 *     reports whichever worker the kernel handed the connection to — 1 of N, a SAMPLE and
 *     not a census. Polling it would converge only statistically, could never say WHICH
 *     worker tripped, and would re-announce the same trip from a different sample. That
 *     leg is therefore announced AT THE LATCH instead, from inside the process that owns
 *     the state — see `cpu-task-worker.ts`'s `configureCpuWorkerBreakerNotifier`. Each
 *     worker reports its own trip, which dissolves the sampling problem rather than
 *     working around it.
 *
 * ⚠ `formatBreakerTrip` renders the SIDECAR leg only — it has exactly one call site, in
 * `workerBreakerWatchTick` below. This header previously claimed both legs rendered
 * through it; they never did (`cpu-task-worker.ts`'s `tripBreaker` has always built its
 * own summary inline), so editing this formatter does NOT change the cpuWorker message.
 * The two have since diverged on purpose: cpuWorker re-arms itself and names its crash
 * cause (EI-20505664003243915), while the sidecar breakers below still latch permanently
 * and still report no cause — so the "PERMANENT ... never re-arms" wording here remains
 * accurate for THESE two workers and must not be copied to the cpuWorker leg.
 *
 * ── Report-only, inherited from WI-37696 ─────────────────────────────────────────────
 * A fallen-back worker is DEGRADED, not down: it still returns correct vectors, scores
 * and JSON, just on the wrong thread. This watcher therefore only ANNOUNCES. It must
 * never fail a health check, gate readiness, or restart anything — doing so would convert
 * a working soft degradation into an outage.
 *
 * Pure + dependency-injected (no PG, no DBOS, no fetch of its own) so it is testable
 * without a live sidecar; the thin production adapter is
 * `harness/routines/worker-breaker-watch-action.ts`. Same split as
 * `supervision/unit-reconciler.ts` + `supervision-reconcile-action.ts`.
 */

/** The breaker fields WI-37696 put on the sidecar's `/healthz`, per worker. */
export interface SidecarWorkerBreaker {
  alive: boolean;
  /** Latched permanently once tripped ⇒ inline fallback for the rest of the process. */
  disabled: boolean;
  pendingCount: number;
  keepAlive: boolean;
}

/** The two sidecar-hosted worker names, in a fixed order so output is deterministic. */
export const SIDECAR_WORKER_NAMES = ['embedder', 'reranker'] as const;
export type SidecarWorkerName = (typeof SIDECAR_WORKER_NAMES)[number];

/**
 * Per-worker verdict for one tick.
 *
 * `absent` is deliberately NOT folded into `ok`. The sidecar runs a BUILT BUNDLE frozen
 * at its build time (see `describeUnfitSidecar` — version skew is a live, expected state
 * here), so a build predating WI-37696 answers `/healthz` 200 with no `workers` block at
 * all. Reading that missing block as `disabled:false` would manufacture a FALSE ALL-CLEAR
 * from a sidecar that cannot report — the precise failure this whole item exists to stop,
 * one level up. Unknown must stay unknown.
 */
export type BreakerVerdict = 'ok' | 'disabled' | 'absent';

export interface WorkerBreakerWatchDeps {
  /** Parsed `/healthz` body, or null when the sidecar did not answer. */
  fetchSidecarHealth: () => Promise<unknown | null>;
  /** Announce one trip. Report-only — never restarts or gates anything. */
  notify: (a: { summary: string }) => Promise<void>;
  /** For the message body only; never used to decide anything. */
  sidecarUrl: string;
}

/**
 * Cross-tick memory, so a PERMANENT latch is announced once rather than every tick.
 *
 * Edge-triggered on false→true, with two deliberate properties:
 *   • an EMPTY state announces on first observation — a breaker that tripped before this
 *     watcher started must still be reported, or the silent-forever defect survives the
 *     one case it is most likely to occur in (a trip during boot);
 *   • `pid` resets everything when the sidecar process changes, so a restarted sidecar
 *     that trips again is announced again rather than being suppressed by the previous
 *     process's memory. Without the pid check, the reset would depend on observing an
 *     intermediate `disabled:false` — which a fast restart-then-trip never shows.
 */
export interface WorkerBreakerWatchState {
  /** Last verdict seen per worker; absent = never observed. */
  lastDisabled: Map<string, boolean>;
  /** pid of the sidecar these observations came from. */
  sidecarPid: number | null;
}

export function createWorkerBreakerWatchState(): WorkerBreakerWatchState {
  return { lastDisabled: new Map(), sidecarPid: null };
}

export interface WorkerBreakerWatchResult {
  /** false ⇒ the sidecar did not answer; nothing was read and nothing announced. */
  reachable: boolean;
  /** Per-worker verdict this tick (empty when unreachable). */
  verdicts: Partial<Record<SidecarWorkerName, BreakerVerdict>>;
  /** Workers announced THIS tick (a false→true edge, or a first observation of true). */
  announced: SidecarWorkerName[];
  /** True when the sidecar answered but carried no `workers` block (stale bundle). */
  readingsAbsent: boolean;
}

/**
 * Render a tripped breaker as one actionable line.
 *
 * Shared by both legs so the sidecar-polled and the latch-announced messages read alike.
 * States the CONSEQUENCE rather than the field value: `disabled:true` means nothing to a
 * reader who has not read WI-37688, whereas "permanently fell back to main-thread work"
 * is the thing worth waking up for. Names the process explicitly because the three
 * breakers live in two (really N+1) processes and "which one" is the first question.
 */
export function formatBreakerTrip(a: {
  /** The breaker, e.g. 'embedder' / 'reranker' / 'cpuWorker'. */
  worker: string;
  /** Where it tripped, e.g. 'embed sidecar http://127.0.0.1:3384 (pid 1234)'. */
  where: string;
  /** What is now happening instead, in consequence terms. */
  consequence: string;
  /** How to clear it. */
  remedy: string;
}): string {
  return (
    `⚠ worker-breaker TRIPPED: \`${a.worker}\` on ${a.where} has latched \`disabled\` — ` +
    `${a.consequence} This is PERMANENT for the life of that process: the breaker never ` +
    `re-arms itself, and the fallback returns identical results, so nothing else will ` +
    `ever signal it. ${a.remedy}`
  );
}

/** Narrow an unknown `/healthz` body to the breaker block, without trusting its shape. */
function readSidecarBreakers(body: unknown): {
  pid: number | null;
  workers: Partial<Record<SidecarWorkerName, SidecarWorkerBreaker>> | null;
} {
  if (typeof body !== 'object' || body === null) return { pid: null, workers: null };
  const rec = body as Record<string, unknown>;
  const pid = typeof rec.pid === 'number' ? rec.pid : null;
  const raw = rec.workers;
  if (typeof raw !== 'object' || raw === null) return { pid, workers: null };
  const workersRec = raw as Record<string, unknown>;
  const out: Partial<Record<SidecarWorkerName, SidecarWorkerBreaker>> = {};
  for (const name of SIDECAR_WORKER_NAMES) {
    const w = workersRec[name];
    if (typeof w !== 'object' || w === null) continue;
    const wr = w as Record<string, unknown>;
    // `disabled` is the one field acted on, so a non-boolean is treated as
    // unreadable (worker omitted) rather than coerced — a truthy string would
    // otherwise announce, and a missing field would silently read as all-clear.
    if (typeof wr.disabled !== 'boolean') continue;
    out[name] = {
      alive: wr.alive === true,
      disabled: wr.disabled,
      pendingCount: typeof wr.pendingCount === 'number' ? wr.pendingCount : 0,
      keepAlive: wr.keepAlive === true,
    };
  }
  return { pid, workers: Object.keys(out).length > 0 ? out : null };
}

const CONSEQUENCE: Record<SidecarWorkerName, string> = {
  embedder:
    'every embed now runs INLINE on the sidecar request thread instead of its persistent ' +
    'worker, blocking that loop for the duration of each forward pass.',
  reranker:
    'every rerank now runs INLINE on the sidecar request thread instead of its persistent ' +
    'worker, so each /rerank blocks that loop for a full cross-encoder pass and the ' +
    'per-call timeout bound is only accurate to one batch.',
};

/**
 * One watch tick over the sidecar's two breakers.
 *
 * Never throws: a watcher that dies on a malformed body stops watching, which is
 * indistinguishable from an all-clear to everyone downstream.
 */
export async function workerBreakerWatchTick(
  deps: WorkerBreakerWatchDeps,
  state: WorkerBreakerWatchState,
): Promise<WorkerBreakerWatchResult> {
  const empty: WorkerBreakerWatchResult = {
    reachable: false,
    verdicts: {},
    announced: [],
    readingsAbsent: false,
  };

  let body: unknown | null;
  try {
    body = await deps.fetchSidecarHealth();
  } catch {
    // An unreachable sidecar is NOT this watcher's business to announce: the
    // supervision reconciler already owns "a supervised unit is down", and
    // duplicating it here would double-page for one event.
    return empty;
  }
  if (body === null) return empty;

  const { pid, workers } = readSidecarBreakers(body);

  // A different process ⇒ different module state. Drop the previous process's memory
  // so a fresh trip is announced rather than suppressed (see WorkerBreakerWatchState).
  if (pid !== null && state.sidecarPid !== null && pid !== state.sidecarPid) {
    state.lastDisabled.clear();
  }
  if (pid !== null) state.sidecarPid = pid;

  if (workers === null) {
    // Answered, but carries no readable breaker block — a bundle predating WI-37696.
    // Report unknown; deliberately do NOT touch lastDisabled, so a later readable tick
    // still sees a true first observation rather than inheriting a phantom all-clear.
    return { reachable: true, verdicts: {}, announced: [], readingsAbsent: true };
  }

  const verdicts: Partial<Record<SidecarWorkerName, BreakerVerdict>> = {};
  const announced: SidecarWorkerName[] = [];
  const where = `the embed sidecar ${deps.sidecarUrl}${pid === null ? '' : ` (pid ${pid})`}`;

  for (const name of SIDECAR_WORKER_NAMES) {
    const w = workers[name];
    if (!w) {
      verdicts[name] = 'absent';
      continue;
    }
    verdicts[name] = w.disabled ? 'disabled' : 'ok';
    const previously = state.lastDisabled.get(name);
    state.lastDisabled.set(name, w.disabled);
    // Announce on a false→true edge AND on a first-ever observation of true.
    if (w.disabled && previously !== true) {
      announced.push(name);
      try {
        await deps.notify({
          summary: formatBreakerTrip({
            worker: name,
            where,
            consequence: CONSEQUENCE[name],
            remedy:
              'Restart the owning process to clear it — on hosts running the systemd unit ' +
              'that is `systemctl --user restart papercup-embed-sidecar.service`. The ' +
              'sidecar keeps answering 200 and serving correct results either way, so this ' +
              'is a performance regression to schedule, not an outage to page on.',
          }),
        });
      } catch {
        // A failed notify must not abort the remaining workers' checks, and must not
        // leave `lastDisabled` claiming we announced. Re-arm so the next tick retries.
        state.lastDisabled.set(name, false);
      }
    }
  }

  return { reachable: true, verdicts, announced, readingsAbsent: false };
}
