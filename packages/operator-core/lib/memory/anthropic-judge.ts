/**
 * Anthropic-backed `LlmJudge` for conflict-check (P-017).
 *
 * Plan: papercusp-su-memory-2026-05-25 (Phase 4, P-017 wire-up).
 *
 * Wraps `@anthropic-ai/sdk` with the conflict-detection prompt from
 * `conflict-check.buildConflictPrompt` + `parseConflictResponse`.
 * Best-effort: any LLM failure returns `{ conflicts: [] }` so the
 * caller's write proceeds.
 *
 * Model: `claude-haiku-4-5` (same as mem0's fact-extraction LLM).
 * API key resolution: env `ANTHROPIC_API_KEY` first; absent → returns
 * a no-op judge that always reports zero conflicts (defensive — no
 * point throwing when the env isn't set, since callers feature-flag
 * the call anyway).
 */

import {
  type LlmJudge,
  buildConflictPrompt,
  parseConflictResponse,
} from './conflict-check';

const MODEL = 'claude-haiku-4-5';
const MAX_TOKENS = 256;
const TIMEOUT_MS = 5_000;

/**
 * Can a REAL judge be built, or would `createAnthropicJudge()` hand back the
 * no-op branch? Cheap and synchronous BY DESIGN: it only asks whether a key
 * resolves, and deliberately does NOT construct an Anthropic client — callers
 * use it to decide whether the expensive work that FEEDS the judge is worth
 * doing at all, so it must be far cheaper than that work.
 *
 * Why this exists (memory-write-latency-2026-07-26 P-007, EI-18746586784230719):
 * `remember.ts` ran a full semantic neighbour search on EVERY write purely to
 * feed the conflict judge — but this operator has no ANTHROPIC_API_KEY, so the
 * judge was the instant no-op and the search fed nothing. Measured: that search
 * was 85-95% of the write path (982ms at a 250-char body, 3,222ms at 3,000).
 * The no-op branch is still the right behaviour for a keyless judge; what was
 * wrong was that nothing could ASK about it before paying to feed it.
 */
export function conflictJudgeAvailable(opts?: { apiKey?: string }): boolean {
  return Boolean((opts?.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '').trim());
}

let _warnedJudgeUnavailable = false;

/**
 * One-time, leading-edge warning for the state where conflict-check is ENABLED
 * but no judge can be built — i.e. the feature is configured on and silently
 * doing nothing.
 *
 * The silence WAS the bug: a default-ON contradiction guard sat inert in this
 * operator indefinitely because a keyless judge returns `{conflicts: []}`, which
 * is byte-identical to a healthy "no conflicts found". Nothing logged, nothing
 * surfaced. Leading-edge only, so a long-running operator logs one line rather
 * than one per write. (The broader detector gap — the feature being classified
 * as ops config instead of a FLAGS capability — is filed as EI-18747066020546067.)
 */
export function warnConflictJudgeUnavailableOnce(): void {
  if (_warnedJudgeUnavailable) return;
  _warnedJudgeUnavailable = true;
  // NODE_ENV guard mirrors op-deadline.ts / injection.ts — the repo's
  // fail-on-console treats a console.warn under vitest as a test failure.
  if (process.env.NODE_ENV === 'test') return;
  console.warn(
    '[memory] conflict-check is ENABLED (PAPERCUSP_MEMORY_CONFLICT_CHECK) but no ANTHROPIC_API_KEY ' +
      'resolves in this process, so the judge is a no-op and no contradiction can ever be detected. ' +
      'The neighbour search that feeds it is being SKIPPED rather than paid for. ' +
      'Set a key (gateway-routed) to enable it for real, or set PAPERCUSP_MEMORY_CONFLICT_CHECK=off ' +
      'to make the intent explicit.',
  );
}

/** Test-only: reset the one-time warn latch. */
export function resetConflictJudgeWarnForTest(): void {
  _warnedJudgeUnavailable = false;
}

let _warnedPackJudgeUnavailable = false;

/**
 * One-time, leading-edge warning for the knowledge-packs conflict judge
 * (manage.ts `realJudge()` / candidates.ts `lazyConflictJudge()`) — the OTHER
 * consumer of `createAnthropicJudge()` besides memory:remember
 * (EI-18746586784230719: "the same no-op judge is wired into knowledge-packs
 * ... so pack-install conflict classification and the hive conflict sweep are
 * equally inert"). Unlike memory:remember there is no feature flag to check —
 * pack install/upgrade/sweep call the judge unconditionally — so the only
 * signal that it is silently inert is this warning.
 */
export function warnKnowledgePackJudgeUnavailableOnce(): void {
  if (_warnedPackJudgeUnavailable) return;
  _warnedPackJudgeUnavailable = true;
  if (process.env.NODE_ENV === 'test') return;
  console.warn(
    '[knowledge-packs] conflict/duplicate classification (classifyPackInstall, sweepHiveConflicts, ' +
      'candidate auto-review) runs unconditionally, but no ANTHROPIC_API_KEY resolves in this process, ' +
      'so the judge is a no-op: every item classifies as "clean"/no-pair regardless of actual conflicts. ' +
      'Set a key (gateway-routed) to enable real conflict detection for knowledge packs.',
  );
}

/** Test-only: reset the knowledge-packs one-time warn latch. */
export function resetKnowledgePackJudgeWarnForTest(): void {
  _warnedPackJudgeUnavailable = false;
}

/**
 * Build the Anthropic-backed judge. Returns a no-op judge when no
 * API key is present (caller still calls it; it just returns empty
 * conflicts).
 */
export function createAnthropicJudge(opts?: {
  apiKey?: string;
  model?: string;
}): LlmJudge {
  const apiKey = opts?.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
  const model = opts?.model ?? MODEL;

  if (!apiKey) {
    // Silent no-op: caller's feature flag is the real gate.
    return async () => ({ conflicts: [] });
  }

  return async ({ newText, neighbors }) => {
    let client: { messages: { create: (...args: unknown[]) => Promise<unknown> } };
    try {
      const mod = (await import('@anthropic-ai/sdk')) as unknown as {
        default: new (opts: { apiKey: string; baseURL?: string }) => typeof client;
      };
      const Anthropic = mod.default;
      // Route through the inference gateway when it's pointing us at the localhost
      // pacing pool (gateway sets PAPERCUSP_ANTHROPIC_URL / ANTHROPIC_BASE_URL) — so
      // this in-process best-effort judge load-balances across the account pool and
      // is paced like every other call, instead of egressing DIRECT to one account on
      // its API key. Absent the env (gateway off) → unchanged direct egress.
      let baseURL = process.env.PAPERCUSP_ANTHROPIC_URL ?? process.env.ANTHROPIC_BASE_URL;
      // su-5e6cc (2026-06-30): SELF-ROUTE through the gateway when the INFERENCE_GATEWAY
      // flag is on, instead of only inheriting the env another in-process caller (scout/
      // gym) happened to set — so this judge routes through the Anthropic pool even when
      // it runs outside bg-host. Best-effort; any failure → unchanged direct egress.
      if (!baseURL) {
        try {
          const { getFlag } = await import('@papercusp/flags/server');
          const { FLAGS } = await import('@papercusp/flags');
          if (await getFlag(FLAGS.INFERENCE_GATEWAY, 'system')) {
            const { gatewayLlmEnv } = await import('../inference-gateway/spawn-env');
            baseURL = gatewayLlmEnv(true).PAPERCUSP_ANTHROPIC_URL;
          }
        } catch {
          /* best-effort — gateway resolution must never break the judge */
        }
      }
      client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
    } catch {
      return { conflicts: [] };
    }

    const prompt = buildConflictPrompt({ newText, neighbors });

    const timeout = new Promise<{ conflicts: never[] }>((resolve) =>
      setTimeout(() => resolve({ conflicts: [] }), TIMEOUT_MS),
    );

    const llmCall = (async () => {
      try {
        const response = (await client.messages.create({
          model,
          max_tokens: MAX_TOKENS,
          messages: [{ role: 'user', content: prompt }],
        })) as { content?: Array<{ type: string; text?: string }> };
        const text = (response.content ?? [])
          .filter((c) => c.type === 'text')
          .map((c) => c.text ?? '')
          .join('');
        return parseConflictResponse(text);
      } catch {
        return { conflicts: [] };
      }
    })();

    return Promise.race([llmCall, timeout]);
  };
}
