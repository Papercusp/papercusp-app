/**
 * Action-block executor. Parses worker output for a markdown-fenced
 * ```actions ... ``` block containing a JSON array, then POSTs each
 * action to `/api/admin/execute-action` on the operator (default :3055).
 *
 * Auth: every request carries `Authorization: Bearer <token>` where the
 * token is the harness's own `harness_token` (read from
 * .papercusp/config.json). The executor derives `callingHarness` from the
 * token, so we don't include it in the body.
 *
 * Mirrors bash's process_actions_block. Used by department workers
 * (NEXT_WORKER_CEO_MODE branch) and any other role that emits typed
 * action blocks.
 */
import { randomUUID } from 'node:crypto';

export interface ProcessActionsOptions {
  /** Worker stdout to scan. */
  stdout: string;
  /** Optional callingDept slug (read from config.json `dept` in bash). */
  callingDept?: string;
  /** Bearer token for /api/admin/execute-action (harness_token from config.json). */
  bearerToken?: string;
  /** Logger for per-action results. */
  log: (message: string) => void;
  /** Override the API endpoint (test harness uses this). */
  apiUrl?: string;
  /** Per-action POST timeout in ms. Default 30s. */
  timeoutMs?: number;
}

export interface ProcessActionsResult {
  /** Number of actions detected and POSTed. */
  count: number;
  /** Number of actions that returned a non-2xx or errored. */
  errors: number;
}

/**
 * Extract the contents of the FIRST ```actions ... ``` fenced block.
 * Returns null if no such block exists. Pure function (no I/O).
 */
export function extractActionsBlock(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/);
  let inBlock = false;
  const captured: string[] = [];
  for (const line of lines) {
    if (!inBlock) {
      if (line.trim() === '```actions' || line.trimStart().startsWith('```actions')) {
        inBlock = true;
      }
      continue;
    }
    // inBlock = true
    if (line.trim().startsWith('```')) {
      // closing fence — return what we have.
      return captured.join('\n');
    }
    captured.push(line);
  }
  return null;
}

/** Parse the captured block as JSON. Returns null on malformed input. */
export function parseActionsJson(blockText: string): unknown[] | null {
  try {
    const parsed = JSON.parse(blockText);
    if (!Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Process the action block end-to-end. Returns counts; never throws.
 */
export async function processActionsBlock(
  opts: ProcessActionsOptions,
): Promise<ProcessActionsResult> {
  const block = extractActionsBlock(opts.stdout);
  if (block === null || block.trim().length === 0) {
    return { count: 0, errors: 0 };
  }
  const actions = parseActionsJson(block);
  if (actions === null) {
    opts.log('ACTIONS: malformed JSON block, skipping');
    return { count: 0, errors: 0 };
  }
  opts.log(`ACTIONS: ${actions.length} op(s) detected`);

  const operatorBase = process.env.PAPERCUSP_OPERATOR_BASE ?? 'http://localhost:3055';
  const apiUrl = opts.apiUrl ?? `${operatorBase}/api/admin/execute-action`;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  let errors = 0;
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const body = JSON.stringify({
      actionId: randomUUID(),
      action,
      ...(opts.callingDept ? { callingDept: opts.callingDept } : {}),
    });

    const result = await postActionWithTimeout(apiUrl, body, timeoutMs, opts.bearerToken);
    opts.log(`  action ${i + 1}/${actions.length}: ${result.responseText}`);
    if (!result.ok) errors++;
  }
  return { count: actions.length, errors };
}

interface ActionPostResult {
  ok: boolean;
  status: number;
  responseText: string;
}

async function postActionWithTimeout(
  url: string,
  body: string,
  timeoutMs: number,
  bearerToken?: string,
): Promise<ActionPostResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (bearerToken) headers['Authorization'] = `Bearer ${bearerToken}`;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, responseText: text };
  } catch (err) {
    return { ok: false, status: 0, responseText: `{"ok":false,"error":"${(err as Error).message}"}` };
  } finally {
    clearTimeout(timer);
  }
}
