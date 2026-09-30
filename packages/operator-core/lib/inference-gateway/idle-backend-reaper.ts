/**
 * idle-backend-reaper — stop on-demand local inference backends that have been idle past their
 * TTL, freeing what they hold (for `llama-ornith`, ~19.8GB of VRAM).
 * Plan: on-demand-local-inference-lifecycle-2026-08-17 (P-007).
 *
 * Pure logic + injected effects, deliberately: this module never imports the provisioner (whose
 * `stopLocalBackend` does the actual systemctl work) and never opens a DB connection of its own.
 * The composition happens in `harness/routines/idle-backend-reaper-action.ts`. That keeps the
 * dependency direction one-way — the provisioner reads the gateway registry, not the reverse —
 * and it means every branch below is testable without systemd, without PG, and without a GPU.
 *
 * THE RULE THIS MODULE EXISTS TO GET RIGHT: idle means idle for the WHOLE TTL, not idle at the
 * instant we sampled. A reaper that stops a backend because one poll saw no active slot will
 * eventually stop one in the gap between two requests. So a poll never decides on its own — it
 * only ever moves a durable watermark (`last_busy_at`, migration 845) forward, and the stop
 * decision is made against that watermark.
 */
import type { LocalBackendRecord } from './local-backend-store';

/**
 * What a single poll learned about a backend. Four states, not a boolean, because each one has a
 * genuinely different disposition and collapsing them loses the two that matter:
 *
 *  - `busy`       at least one slot is processing → move the watermark, never reap.
 *  - `idle`       answered, nothing processing → a reap CANDIDATE, decided against the watermark.
 *  - `down`       nothing listening. For an on-demand backend this is the normal steady state
 *                 between uses, so it must be silent and free — not an alarm, and never a reap
 *                 (there is nothing to stop).
 *  - `unreadable` it ANSWERED but we cannot tell whether it is working — `/slots` disabled,
 *                 an unexpected body, a proxy returning its own error page. Distinct from `down`
 *                 on purpose: this is the "armed but silently does nothing" shape, where the
 *                 reaper runs forever and reaps nothing while looking healthy. It is reported
 *                 loudly and never reaped, because we do not stop what we cannot observe.
 */
export type BusyObservation =
  | { state: 'busy' }
  | { state: 'idle' }
  | { state: 'down' }
  | { state: 'unreadable'; detail: string };

export interface IdleBackendReaperDeps {
  /** The working set: enabled + lifecycle='on-demand' (store's `listOnDemandLocalBackends`). */
  listOnDemand: () => Promise<LocalBackendRecord[]>;
  probeBusy: (backend: LocalBackendRecord) => Promise<BusyObservation>;
  stopBackend: (backend: LocalBackendRecord) => Promise<{ ok: boolean; error?: string }>;
  /** Move the durable watermark forward (store's `markLocalBackendBusy`). */
  markBusy: (id: string) => Promise<boolean>;
  now?: () => Date;
}

export interface IdleBackendReaperConfig {
  /** TTL for a backend whose own `idleTtlSec` is NULL. */
  defaultIdleTtlSec: number;
  /** Report what would be stopped without stopping anything. */
  dryRun?: boolean;
  /** How often this reaper actually runs. Used ONLY to detect the sampling-gap
   *  misconfiguration described on `warnings` below — it does not affect any decision. */
  pollIntervalSec?: number;
}

export interface IdleBackendReapResult {
  scanned: number;
  /** Stopped this sweep (or, under dryRun, would have been). */
  stopped: string[];
  busy: string[];
  /** Idle but not yet past TTL — the normal pre-reap state. */
  waiting: Array<{ id: string; idleSec: number; ttlSec: number }>;
  down: string[];
  unreadable: Array<{ id: string; detail: string }>;
  failures: Array<{ id: string; error: string }>;
  /** Configuration problems worth shouting about — see `sampling-gap` below. */
  warnings: string[];
  dryRun: boolean;
}

/** A backend whose TTL is not comfortably larger than the poll interval cannot be judged idle
 *  with any confidence: requests that start and finish between two polls are invisible, so the
 *  watermark can stay put through real traffic. Four samples per TTL is the floor this warns
 *  below — not a tuning knob so much as a statement that one or two samples is not evidence. */
const MIN_SAMPLES_PER_TTL = 4;

export async function runIdleBackendReap(
  deps: IdleBackendReaperDeps,
  config: IdleBackendReaperConfig,
): Promise<IdleBackendReapResult> {
  const now = deps.now ?? (() => new Date());
  const dryRun = config.dryRun === true;
  const result: IdleBackendReapResult = {
    scanned: 0,
    stopped: [],
    busy: [],
    waiting: [],
    down: [],
    unreadable: [],
    failures: [],
    warnings: [],
    dryRun,
  };

  const backends = await deps.listOnDemand();
  result.scanned = backends.length;

  for (const backend of backends) {
    const ttlSec = backend.idleTtlSec ?? config.defaultIdleTtlSec;

    if (config.pollIntervalSec && config.pollIntervalSec * MIN_SAMPLES_PER_TTL > ttlSec) {
      result.warnings.push(
        `${backend.id}: idle TTL ${ttlSec}s gives fewer than ${MIN_SAMPLES_PER_TTL} polls at a ` +
          `${config.pollIntervalSec}s interval — a request that starts and finishes between two ` +
          `polls is invisible to the watermark, so this backend could be stopped while in use. ` +
          `Raise its idleTtlSec or shorten the reaper's interval.`,
      );
    }

    let observation: BusyObservation;
    try {
      observation = await deps.probeBusy(backend);
    } catch (err) {
      // A probe that THREW told us nothing. Treat it exactly like `unreadable` rather than like
      // idle: an exception is not evidence of quiescence.
      result.unreadable.push({
        id: backend.id,
        detail: `probe threw: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    if (observation.state === 'busy') {
      result.busy.push(backend.id);
      try {
        await deps.markBusy(backend.id);
      } catch (err) {
        // Losing a watermark write is not cosmetic: the backend keeps an OLD last_busy_at while
        // genuinely working, so a later sweep can find it "idle past TTL" and stop it mid-use.
        result.failures.push({
          id: backend.id,
          error: `busy but watermark write FAILED (backend may be wrongly reaped later): ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
      continue;
    }

    if (observation.state === 'down') {
      result.down.push(backend.id);
      continue;
    }

    if (observation.state === 'unreadable') {
      result.unreadable.push({ id: backend.id, detail: observation.detail });
      continue;
    }

    // ── idle: the only path that can reap, and it decides against the WATERMARK, never against
    //    this single observation.
    const idleSec = Math.floor((now().getTime() - new Date(backend.lastBusyAt).getTime()) / 1000);

    if (!Number.isFinite(idleSec)) {
      result.unreadable.push({
        id: backend.id,
        detail: `unparseable lastBusyAt '${backend.lastBusyAt}' — refusing to compute an idle age from it`,
      });
      continue;
    }

    // A negative age means the watermark is in the future (clock skew, or a stamp from another
    // host). Not idle by any reading, and certainly not idle for a full TTL.
    if (idleSec < ttlSec) {
      result.waiting.push({ id: backend.id, idleSec, ttlSec });
      continue;
    }

    if (dryRun) {
      result.stopped.push(backend.id);
      continue;
    }

    try {
      const stop = await deps.stopBackend(backend);
      if (stop.ok) result.stopped.push(backend.id);
      else result.failures.push({ id: backend.id, error: stop.error ?? 'stop failed without an error' });
    } catch (err) {
      result.failures.push({ id: backend.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
}

/**
 * The default `probeBusy` for a llama-server backend: read `/slots` and report whether any slot
 * is processing. This is the same signal Phase 1 used to establish that ornith was idle (all 3
 * slots `is_processing:false`).
 *
 * Probed at the REGISTRY baseUrl, so it traverses whatever a routed request traverses — for
 * ornith that is the sanitizing proxy on :11435, not the llama-server on :11436.
 */
export async function probeLlamaServerSlots(
  baseUrl: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<BusyObservation> {
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${baseUrl}/slots`, { signal: AbortSignal.timeout(opts.timeoutMs ?? 5000) });
  } catch {
    // Connection refused / timeout. For an on-demand backend this is the expected steady state
    // between uses, so it is `down` — not an error, and nothing to stop.
    return { state: 'down' };
  }

  if (!res.ok) {
    // It answered, so something IS listening — we just cannot read its work state. llama-server
    // returns 501 here when the slots endpoint is disabled, which would otherwise present as a
    // reaper that runs forever and never reaps.
    return { state: 'unreadable', detail: `GET /slots → HTTP ${res.status}` };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    return { state: 'unreadable', detail: `GET /slots returned unparseable JSON: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!Array.isArray(body)) {
    return { state: 'unreadable', detail: `GET /slots returned ${typeof body}, expected an array of slots` };
  }

  const processing = body.some(
    (slot) => typeof slot === 'object' && slot !== null && (slot as { is_processing?: unknown }).is_processing === true,
  );
  return processing ? { state: 'busy' } : { state: 'idle' };
}
