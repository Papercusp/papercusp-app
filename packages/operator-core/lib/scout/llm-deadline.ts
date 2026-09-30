/**
 * Deadline wrapper for Scout's downstream LLM phases.
 *
 * Ideators already distinguish admission from generation. Critics and recombine
 * use the same injected transport, so they need the same contract: a cycle
 * deadline bounds admission, while a per-call cap bounds generation after an
 * upstream response starts. The child AbortSignal is composed by the production
 * runner with the scheduler's signal, so a local timeout cancels the real
 * transport instead of merely abandoning a Promise.race.
 */
import type { ScoutLlmCall } from './types';

/** Default generation cap for critic calls (measured output is below this). */
export const DEFAULT_SCOUT_CRITIC_TIMEOUT_MS = 180_000;
/** Default generation cap for recombine calls (measured output is below this). */
export const DEFAULT_SCOUT_RECOMBINE_TIMEOUT_MS = 180_000;

const ADMISSION_BACKSTOP_GRACE_MS = 5_000;
const CYCLE_DEADLINE_MARGIN_MS = 5_000;

type ScoutLlmCallInput = Parameters<ScoutLlmCall>[0];
type ScoutLlmCallResult = Awaited<ReturnType<ScoutLlmCall>>;

export interface ScoutPhaseLlmOptions {
  llmCall: ScoutLlmCall;
  input: ScoutLlmCallInput;
  /** Human-readable phase label used in timeout/abort errors. */
  phase: string;
  /** Per-call generation cap; <=0 or non-finite disables the generation cap. */
  timeoutMs?: number;
  /** Optional caller cancellation signal. */
  signal?: AbortSignal;
  /** Absolute epoch-ms deadline of the owning Scout cycle. */
  cycleDeadlineMs?: number;
  /** Test seam for the small admission backstop grace. */
  admissionBackstopGraceMs?: number;
}

/**
 * Call a downstream Scout phase with separate admission and generation budgets.
 *
 * A transport that does not emit `onResponseStart` is still bounded by the total
 * call ceiling, which prevents codex/subprocess transports from becoming
 * unbounded merely because they lack the streaming response hook.
 */
export async function callScoutPhaseLlm(opts: ScoutPhaseLlmOptions): Promise<ScoutLlmCallResult> {
  const generationTimeoutMs = opts.timeoutMs;
  const hasGenerationCap = Number.isFinite(generationTimeoutMs) && (generationTimeoutMs as number) > 0;

  const admissionBudgetMs = (() => {
    if (opts.cycleDeadlineMs === undefined || !Number.isFinite(opts.cycleDeadlineMs)) return undefined;
    const remaining = opts.cycleDeadlineMs - Date.now();
    const reserve = hasGenerationCap ? (generationTimeoutMs as number) : 0;
    return Math.max(0, remaining - reserve);
  })();

  const grace = opts.admissionBackstopGraceMs ?? ADMISSION_BACKSTOP_GRACE_MS;
  const totalCeilingMs = (() => {
    if (admissionBudgetMs === undefined) return hasGenerationCap ? (generationTimeoutMs as number) : undefined;
    const uncapped = admissionBudgetMs + (hasGenerationCap ? (generationTimeoutMs as number) : 0) + grace;
    const remaining = opts.cycleDeadlineMs! - Date.now();
    const insideCycle = Math.max(0, remaining - CYCLE_DEADLINE_MARGIN_MS);
    return Math.min(uncapped, insideCycle);
  })();

  if (totalCeilingMs === undefined && !opts.signal) {
    return opts.llmCall(opts.input);
  }

  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let parentAbort: (() => void) | null = null;
  let locallyAdmitted = false;
  let responseStarted = false;
  let settled = false;
  let onAdmitted: () => void = () => {};
  let onResponseStart: () => void = () => {};

  const rejectOnAbort = new Promise<never>((_, reject) => {
    const abort = (err: Error) => {
      if (!ctrl.signal.aborted) ctrl.abort(err);
      reject(err);
    };

    if (opts.signal) {
      if (opts.signal.aborted) {
        abort(new Error(`Scout ${opts.phase} aborted`));
        return;
      }
      parentAbort = () => abort(new Error(`Scout ${opts.phase} aborted`));
      opts.signal.addEventListener('abort', parentAbort, { once: true });
    }

    const arm = (ms: number) => {
      if (settled) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (settled) return;
        if (responseStarted) {
          abort(
            new Error(
              `Scout ${opts.phase} timed out after ${Math.trunc(generationTimeoutMs as number)}ms of GENERATION ` +
                `(upstream response started — this is not an admission wait)`,
            ),
          );
        } else if (admissionBudgetMs !== undefined) {
          abort(
            new Error(
              `Scout ${opts.phase} did not receive an upstream response before the cycle deadline ` +
                `(${locallyAdmitted ? 'local admission observed' : 'local admission unobserved — transport may not expose admission'}; ` +
                `response start unobserved; queueing versus generation unknown)`,
            ),
          );
        } else {
          abort(new Error(`Scout ${opts.phase} timed out after ${Math.trunc(generationTimeoutMs as number)}ms`));
        }
      }, ms);
      if (typeof timer.unref === 'function') timer.unref();
    };

    if (totalCeilingMs !== undefined) arm(totalCeilingMs);
    onAdmitted = () => {
      locallyAdmitted = true;
    };
    onResponseStart = () => {
      responseStarted = true;
      if (hasGenerationCap) arm(generationTimeoutMs as number);
      else if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
  });

  try {
    return await Promise.race([
      opts.llmCall({
        ...opts.input,
        signal: ctrl.signal,
        ...(admissionBudgetMs !== undefined ? { governorMaxWaitMs: admissionBudgetMs } : {}),
        onAdmitted: () => onAdmitted(),
        onResponseStart: () => onResponseStart(),
      }),
      rejectOnAbort,
    ]);
  } finally {
    settled = true;
    if (timer) clearTimeout(timer);
    if (parentAbort && opts.signal) opts.signal.removeEventListener('abort', parentAbort);
  }
}
