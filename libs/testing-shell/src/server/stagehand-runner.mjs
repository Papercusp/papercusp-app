#!/usr/bin/env node
/**
 * Stagehand runner — the LLM browser-walk subprocess for the universal
 * `ai-explore` domain (moved into @papercusp/testing-shell from the operator's
 * apps/operator/scripts/stagehand-runner.mjs as Phase 3 of
 * universal-testing-domains-generic-2026-06-03).
 *
 * Reads a JSON config from stdin:
 *   { goal, startUrl, model, apiKey, baseUrl?, maxSteps, maxCostUsd, headless }
 * `baseUrl` (optional) points the Stagehand model client at an Anthropic-compatible
 * surface other than api.anthropic.com — e.g. the inference gateway, so this runner can
 * use the default account instead of a raw key. Pass the ROOT (no `/v1`): the Anthropic
 * SDK appends `/v1/messages` itself.
 * `startUrl` is REQUIRED — the lib bakes in no project-specific default; the
 * caller (each app's route) supplies it.
 *
 * Emits NDJSON events on stdout (one per line):
 *   {type:"start", goal, model, startUrl}
 *   {type:"step", n, action, ok, durationMs, result?}
 *   {type:"log", level, line}
 *   {type:"metrics", inputTokens, outputTokens, totalTokens, costUsd}
 *   {type:"done", totalMs, steps, costUsd}
 *   {type:"error", message}
 *
 * @browserbasehq/stagehand is imported dynamically so this file is only loaded
 * in a subprocess that has it (an optional peer dep). Exits 0 on success.
 */

import { setTimeout as sleep } from 'node:timers/promises';

// Suppress the AI SDK "System messages in the prompt…" warning (Stagehand uses
// that pattern intentionally; the warning is noise on the user-facing log).
const SDK_WARNING_PATTERN = 'AI SDK Warning: System messages in the prompt';
{
  const realWarn = console.warn;
  console.warn = (...args) => {
    const first = args[0];
    if (typeof first === 'string' && first.includes(SDK_WARNING_PATTERN)) return;
    realWarn.apply(console, args);
  };
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    if (typeof chunk === 'string' && chunk.includes(SDK_WARNING_PATTERN)) return true;
    if (chunk instanceof Buffer && chunk.includes(SDK_WARNING_PATTERN)) return true;
    return realWrite(chunk, ...rest);
  };
}

// input / output per 1M tokens (rough; mirrored by DEFAULT_MODELS in ai-explore.ts).
const ANTHROPIC_PRICING = {
  'anthropic/claude-sonnet-4-6': { in: 3.0, out: 15.0 },
  'anthropic/claude-opus-4-7': { in: 15.0, out: 75.0 },
  'anthropic/claude-haiku-4-5': { in: 1.0, out: 5.0 },
};
const PRICING_FALLBACK = { in: 3.0, out: 15.0 };

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function readStdinJson() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function main() {
  let cfg;
  try {
    cfg = await readStdinJson();
  } catch (err) {
    emit({ type: 'error', message: `bad config: ${err.message}` });
    process.exit(2);
  }

  const goal = String(cfg.goal ?? '').trim();
  const startUrl = String(cfg.startUrl ?? '').trim();
  const modelName = String(cfg.model ?? 'anthropic/claude-sonnet-4-6');
  const apiKey = String(cfg.apiKey ?? '');
  // Optional Anthropic-compatible base URL (gateway root, no `/v1`). Empty ⇒ the SDK default.
  const baseURL = String(cfg.baseUrl ?? '').trim();
  const maxSteps = Number(cfg.maxSteps ?? 20);
  const maxCostUsd = Number(cfg.maxCostUsd ?? 1.0);
  const headless = cfg.headless !== false;

  if (!goal) { emit({ type: 'error', message: 'goal is required' }); process.exit(2); }
  if (!startUrl) { emit({ type: 'error', message: 'startUrl is required' }); process.exit(2); }
  if (!apiKey) { emit({ type: 'error', message: 'apiKey is required' }); process.exit(2); }

  const t0 = Date.now();
  emit({ type: 'start', goal, startUrl, model: modelName });

  let Stagehand;
  try {
    const mod = await import('@browserbasehq/stagehand');
    Stagehand = mod.Stagehand ?? mod.default?.Stagehand ?? mod.default;
  } catch (err) {
    emit({ type: 'error', message: `failed to import @browserbasehq/stagehand: ${err.message}` });
    process.exit(3);
  }

  const stagehand = new Stagehand({
    env: 'LOCAL',
    // Stagehand's ModelConfiguration is `ClientOptions & { modelName }`, and ClientOptions
    // carries both `apiKey` and `baseURL` (v3 types/public/model.d.ts) — so pointing this at
    // the gateway needs no custom transport, just the extra field. Omitted when unset so the
    // direct-to-Anthropic path is unchanged.
    model: { modelName, apiKey, ...(baseURL ? { baseURL } : {}) },
    verbose: 0,
    localBrowserLaunchOptions: { headless },
    logger: (entry) => {
      const line = typeof entry === 'string' ? entry : (entry?.message ?? JSON.stringify(entry));
      const s = String(line);
      if (s.includes(SDK_WARNING_PATTERN)) return;
      emit({ type: 'log', level: entry?.level ?? 'info', line: s.slice(0, 500) });
    },
  });

  let steps = 0;
  let costUsd = 0;
  let aborted = false;

  const watchdog = setInterval(async () => {
    try {
      const m = await stagehand.metrics;
      const pricing = ANTHROPIC_PRICING[modelName] ?? PRICING_FALLBACK;
      costUsd = (((m?.totalPromptTokens ?? 0) / 1e6) * pricing.in) + (((m?.totalCompletionTokens ?? 0) / 1e6) * pricing.out);
      if (costUsd >= maxCostUsd && !aborted) {
        aborted = true;
        emit({ type: 'log', level: 'warn', line: `cost cap $${maxCostUsd.toFixed(2)} reached at $${costUsd.toFixed(4)} — aborting` });
      }
    } catch { /* metrics unavailable mid-flight is fine */ }
  }, 2_000);

  try {
    await stagehand.init();
    const page = stagehand.page ?? stagehand.context?.pages?.()?.[0];
    if (!page) throw new Error('no page available after stagehand.init()');
    emit({ type: 'log', level: 'info', line: `navigating to ${startUrl}` });
    await page.goto(startUrl, { waitUntil: 'domcontentloaded' });

    const agent = stagehand.agent();
    const stepT0 = Date.now();
    emit({ type: 'log', level: 'info', line: `executing agent goal: ${goal}` });

    const result = await agent.execute({ instruction: goal, maxSteps });
    const stepMs = Date.now() - stepT0;
    steps = (result?.actions?.length ?? result?.steps?.length ?? 0);

    emit({ type: 'step', n: steps, action: 'agent.execute', ok: result?.success !== false, durationMs: stepMs, result: result?.message ?? null });

    const m = await stagehand.metrics;
    const pricing = ANTHROPIC_PRICING[modelName] ?? PRICING_FALLBACK;
    const inputTokens = m?.totalPromptTokens ?? 0;
    const outputTokens = m?.totalCompletionTokens ?? 0;
    costUsd = ((inputTokens / 1e6) * pricing.in) + ((outputTokens / 1e6) * pricing.out);
    emit({ type: 'metrics', inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, costUsd });
  } catch (err) {
    emit({ type: 'error', message: err?.message ?? String(err) });
  } finally {
    clearInterval(watchdog);
    try { await stagehand.close(); } catch { /* ignore close errors */ }
    emit({ type: 'done', totalMs: Date.now() - t0, steps, costUsd });
    await sleep(50);
    process.exit(aborted ? 4 : 0);
  }
}

// Run only when executed directly — not when imported.
const argv1 = (process.argv[1] || '').replace(/\\/g, '/');
if (argv1.endsWith('stagehand-runner.mjs')) {
  main().catch((err) => {
    emit({ type: 'error', message: err?.message ?? String(err) });
    process.exit(1);
  });
}
