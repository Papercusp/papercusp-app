/**
 * Cost-cap enforcement. Mirrors bash check_cost_cap:
 *
 *   - Sum total_cost_usd across all *.jsonl in <logDir>
 *   - If config.maxCostUsd is set and total >= cap → exit 6
 *   - Soft warn at maxCostUsdWarnThreshold (default 0.8) — fires once
 *     per mission. Sentinel is `harness_mission_state.cost_warn_fired`
 *     (PG-canonical) or `<stateDir>/.cost-warn-fired` (FS fallback). The
 *     PG row is reset to false at mission start by clearMissionStatePg
 *     in `runMainLoopBody` so each new run.sh invocation re-fires the
 *     warn at the threshold.
 *   - Optional auto-pause via SIGSTOP when warn threshold hit
 *     (config.maxCostUsdAutoPause)
 *
 * The summed value is exposed so callers can log + decide. The
 * over-cap and auto-pause behaviors are returned as a typed result;
 * the main loop converts them to terminal exits.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { costFromTokens } from '@papercusp/model-pricing';
import { configGet } from './config';
import type { HarnessConfig } from './types';

export interface CostCapResult {
  /** Summed total_cost_usd across all .jsonl files in the log dir. */
  total: number;
  /** Cap from config.json, or null when not configured. */
  cap: number | null;
  /** True if total >= cap (caller must exit 6). */
  overCap: boolean;
  /** True if the soft warn fired this iteration. */
  warned: boolean;
  /** Whether config.maxCostUsdAutoPause asked for SIGSTOP. */
  shouldPause: boolean;
}

/**
 * Token usage parsed from a run's JSONL stream (rate-limit-layer-v2 D-002 capture point 2;
 * made backend-aware by cross-backend-cost-capture D-005). All three backends' terminal
 * shapes are understood:
 *
 *   claude  — last `{"type":"result", total_cost_usd, usage:{input_tokens,…}}` wins
 *             (the result event is cumulative). `usage.input_tokens` EXCLUDES cache
 *             reads/writes (separate fields) — the canonical semantics here.
 *   codex   — `{"type":"turn.completed", usage:{input_tokens, cached_input_tokens?,
 *             output_tokens}}` SUMMED across events (per-turn counts; tokens only, no
 *             cost). OpenAI-style `input_tokens` INCLUDES the cached subset, so the
 *             cached count is subtracted out of `inputTokens` to match claude semantics.
 *   omp     — assistant `{"type":"message_end", message:{model, usage:{input, output,
 *             cacheRead, cacheWrite, cost:{total}}}}` SUMMED per turn; falls back to the
 *             terminal `agent_end.messages` list when no message_end carried usage
 *             (never both — that would double-count).
 *
 *   owned  — terminal `{"type":"done", usage:{inputTokens,…,costUsd}}` wins
 *             (the owned loop emits cumulative totals in camelCase).
 *
 * `model` remains the pricing/display model. Its provenance distinguishes a
 * per-turn report from a session-init selection or the requested run_meta model;
 * only a per-turn report can attest an operation's actual execution model.
 */
export interface RunUsage {
  /** UNCACHED input tokens (claude `usage.input_tokens` semantics). */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** Provider-reported cost (claude `total_cost_usd`, omp `usage.cost.total`). Undefined for codex. */
  costUsd?: number;
  /** Wall-clock duration when the stream reports one (claude `result.duration_ms` only). */
  durationMs?: number;
  /** Model id for pricing/display (per-turn report > session init > requested). */
  model?: string;
  /** The launch request, which must never stand in for an actual model attestation. */
  requestedModel?: string;
  /** Every distinct model reported by an assistant turn in this run. */
  observedModels?: string[];
  /** Source of `model`; only `turn` proves what served an assistant turn. */
  modelProvenance?: 'turn' | 'session-init' | 'request';
  /** Backend when derivable ('claude-code' | 'codex' | 'omp' | …) — run_meta line > shape inference. */
  backend?: string;
  /**
   * Assistant turns in the run — the round-trip metric (queen-brief-cache B-06 /
   * P-010, Win-2: a precomputed brief should cut the Queen's turns/wake). From
   * claude `result.num_turns`; undefined for codex/omp (not yet counted).
   */
  turns?: number;
}

/** Extract usage from a run's JSONL body across all three backend stream formats. Null when nothing usable. */
export function extractRunUsage(jsonlBody: string): RunUsage | null {
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  const add = (a: number | undefined, b: number | undefined): number | undefined =>
    b === undefined ? a : (a ?? 0) + b;

  let metaModel: string | undefined;
  let metaBackend: string | undefined;
  let initModel: string | undefined;
  const observedModels = new Set<string>();

  // claude: last result event wins (cumulative)
  let claude: RunUsage | null = null;
  // codex: per-turn sums
  let codex: RunUsage | null = null;
  // omp: per-assistant-turn sums + agent_end fallback
  let omp: RunUsage | null = null;
  let ompFallback: RunUsage | null = null;
  // owned loop: terminal done carries cumulative totals
  let ownedLoop: RunUsage | null = null;

  const readOmpMessage = (msg: Record<string, unknown>): RunUsage | null => {
    if (!msg || typeof msg !== 'object' || msg.role !== 'assistant') return null;
    if (typeof msg.model === 'string' && msg.model) observedModels.add(msg.model);
    const u = msg.usage as Record<string, unknown> | undefined;
    if (!u || typeof u !== 'object') return null;
    const cost = u.cost as Record<string, unknown> | undefined;
    const out: RunUsage = {
      inputTokens: num(u.input),
      outputTokens: num(u.output),
      cacheReadTokens: num(u.cacheRead),
      cacheCreationTokens: num(u.cacheWrite),
      costUsd: cost && typeof cost === 'object' ? num(cost.total) : undefined,
    };
    if (
      out.inputTokens === undefined &&
      out.outputTokens === undefined &&
      out.costUsd === undefined
    ) {
      return null;
    }
    return out;
  };
  const accumulate = (acc: RunUsage | null, turn: RunUsage): RunUsage => ({
    inputTokens: add(acc?.inputTokens, turn.inputTokens),
    outputTokens: add(acc?.outputTokens, turn.outputTokens),
    cacheReadTokens: add(acc?.cacheReadTokens, turn.cacheReadTokens),
    cacheCreationTokens: add(acc?.cacheCreationTokens, turn.cacheCreationTokens),
    costUsd: add(acc?.costUsd, turn.costUsd),
  });

  for (const raw of jsonlBody.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // skip malformed lines
    }
    if (!obj || typeof obj !== 'object') continue;

    // run_meta stamp (invoke.ts appends at subprocess exit) — authoritative attribution
    if (obj.type === 'papercusp.run_meta') {
      if (typeof obj.model === 'string' && obj.model) metaModel = obj.model;
      if (typeof obj.backend === 'string' && obj.backend) metaBackend = obj.backend;
      continue;
    }

    // The CLI's init model is a session selection, not proof of what a later
    // gateway request actually served (the gateway may downgrade it).
    if (obj.type === 'system' && obj.subtype === 'init' && typeof obj.model === 'string') {
      initModel = obj.model;
      continue;
    }

    // Claude assistant messages report the model used for an actual turn.
    if (obj.type === 'assistant' && obj.message && typeof obj.message === 'object' &&
        !Array.isArray(obj.message)) {
      const turnModel = (obj.message as Record<string, unknown>).model;
      if (typeof turnModel === 'string' && turnModel) observedModels.add(turnModel);
      continue;
    }

    // claude terminal: {"type":"result"} — last wins; OpenAI-style aliases kept defensively
    if (obj.type === 'result') {
      const u = (obj.usage ?? {}) as Record<string, unknown>;
      const usage: RunUsage = {
        inputTokens: num(u.input_tokens) ?? num(u.prompt_tokens),
        outputTokens: num(u.output_tokens) ?? num(u.completion_tokens),
        cacheReadTokens: num(u.cache_read_input_tokens) ?? num(u.cached_tokens),
        cacheCreationTokens: num(u.cache_creation_input_tokens),
        costUsd: num(obj.total_cost_usd),
        durationMs: num(obj.duration_ms),
        turns: num(obj.num_turns),
      };
      if (
        usage.inputTokens !== undefined ||
        usage.outputTokens !== undefined ||
        usage.costUsd !== undefined
      ) {
        claude = usage; // last result event wins
      }
      continue;
    }

    // codex terminal: {"type":"turn.completed", usage} — sum per turn
    if (obj.type === 'turn.completed') {
      const u = obj.usage as Record<string, unknown> | undefined;
      if (!u || typeof u !== 'object') continue;
      const rawInput = num(u.input_tokens);
      const cached = num(u.cached_input_tokens) ?? num(u.cached_tokens);
      // OpenAI input_tokens includes the cached subset — subtract to match claude semantics.
      const uncached =
        rawInput !== undefined && cached !== undefined && cached <= rawInput
          ? rawInput - cached
          : rawInput;
      const turn: RunUsage = {
        inputTokens: uncached,
        outputTokens: num(u.output_tokens),
        cacheReadTokens: cached,
      };
      if (turn.inputTokens !== undefined || turn.outputTokens !== undefined) {
        codex = accumulate(codex, turn);
      }
      continue;
    }

    // Owned loop terminal: camelCase ModelUsage totals. Last done wins, just
    // like Claude's cumulative result event.
    if (obj.type === 'done') {
      const u = obj.usage as Record<string, unknown> | undefined;
      if (!u || typeof u !== 'object') continue;
      const usage: RunUsage = {
        inputTokens: num(u.inputTokens),
        outputTokens: num(u.outputTokens),
        cacheReadTokens: num(u.cacheReadTokens),
        cacheCreationTokens: num(u.cacheCreationTokens),
        costUsd: num(u.costUsd),
        turns: num(obj.stepCount),
      };
      if (
        usage.inputTokens !== undefined ||
        usage.outputTokens !== undefined ||
        usage.costUsd !== undefined
      ) {
        ownedLoop = usage;
      }
      continue;
    }

    // omp: assistant message_end carries per-turn usage
    if (obj.type === 'message_end') {
      const turn = readOmpMessage(obj.message as Record<string, unknown>);
      if (turn) omp = accumulate(omp, turn);
      continue;
    }
    // omp terminal: agent_end carries the FULL messages list — fallback only
    if (obj.type === 'agent_end' && Array.isArray(obj.messages)) {
      for (const m of obj.messages) {
        const turn = readOmpMessage(m as Record<string, unknown>);
        if (turn) ompFallback = accumulate(ompFallback, turn);
      }
      continue;
    }
  }

  // One format per file in practice; precedence mirrors terminal-shape specificity.
  const usage = ownedLoop ?? claude ?? codex ?? omp ?? ompFallback;
  if (!usage) return null;
  const backend =
    metaBackend ?? (ownedLoop ? 'owned-loop' : claude ? 'claude-code' : codex ? 'codex' : 'omp');
  // Preserve the fallback for pricing, but label it so a model-policy result
  // gate cannot mistake a requested/selected model for a served one.
  const actualModels = [...observedModels];
  const model = actualModels.at(-1) ?? initModel ?? metaModel;
  const modelProvenance = actualModels.length > 0 ? 'turn' : initModel ? 'session-init' : metaModel ? 'request' : undefined;
  return {
    ...usage,
    ...(model !== undefined ? { model } : {}),
    ...(metaModel !== undefined ? { requestedModel: metaModel } : {}),
    ...(actualModels.length > 0 ? { observedModels: actualModels } : {}),
    ...(modelProvenance ? { modelProvenance } : {}),
    backend,
  };
}

/**
 * Sum run cost across all *.jsonl files in a log dir — the per-harness `maxCostUsd`
 * cap input. Backend-aware (cross-backend-cost-capture P-004): provider-reported cost
 * wins per file (claude `total_cost_usd`, omp `cost.total`); a tokens-only file (codex)
 * is priced from `@papercusp/model-pricing` when its model is derivable. Unpriceable
 * files contribute 0 (never a fabricated estimate).
 */
export function sumJsonlCost(logDir: string): number {
  if (!existsSync(logDir)) return 0;
  let entries: string[] = [];
  try {
    entries = readdirSync(logDir);
  } catch {
    return 0;
  }
  let total = 0;
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    let body: string;
    try {
      body = readFileSync(join(logDir, name), 'utf8');
    } catch {
      continue;
    }
    const usage = extractRunUsage(body);
    if (!usage) continue;
    if (usage.costUsd !== undefined) {
      total += usage.costUsd;
    } else if (usage.model) {
      const est = costFromTokens(usage.model, usage);
      if (est.priced) total += est.usd;
    }
  }
  return total;
}

/**
 * Inspect cost; return what the loop should do about it.
 *
 * FS-sentinel soft-warn — fires once per mission via a `.cost-warn-fired`
 * sentinel in stateDir. The PG-sentinel overload (harness_mission_state's
 * `cost_warn_fired`) was retired with the legacy orchestrator run-loop on
 * 2026-06-06 (archive-legacy-orchestrator-deadcode); the live caller (the
 * DBOS orchestrator-loop) only ever used this FS path.
 */
export function evaluateCostCap(
  cfg: HarnessConfig,
  logDir: string,
  stateDir: string,
): CostCapResult {
  const cap = parseCap(cfg);
  const total = sumJsonlCost(logDir);

  if (cap === null) {
    return { total, cap: null, overCap: false, warned: false, shouldPause: false };
  }

  if (total >= cap) {
    return { total, cap, overCap: true, warned: false, shouldPause: false };
  }

  // Soft warn — fires once per mission via an FS sentinel.
  const sentinelPath = join(stateDir, '.cost-warn-fired');
  const sentinelExists = existsSync(sentinelPath);
  const warnFraction = Number(configGet<unknown>(cfg, 'maxCostUsdWarnThreshold', 0.8));
  const warnThreshold = cap * (Number.isFinite(warnFraction) ? warnFraction : 0.8);
  const atWarn = total >= warnThreshold && !sentinelExists;

  if (atWarn) {
    writeFileSync(sentinelPath, '');
  }
  const shouldPause =
    atWarn && configGet<boolean>(cfg, 'maxCostUsdAutoPause', false) === true;

  return { total, cap, overCap: false, warned: atWarn, shouldPause };
}

function parseCap(cfg: HarnessConfig): number | null {
  const v = configGet<unknown>(cfg, 'maxCostUsd', null);
  if (typeof v === 'number' && v > 0 && Number.isFinite(v)) return v;
  return null;
}
