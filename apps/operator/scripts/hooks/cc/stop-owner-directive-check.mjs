#!/usr/bin/env node
/**
 * stop-owner-directive-check — the turn-end owner-directive check (P-007 of plan
 * owner-directive-delivery-redesign-2026-09-22).
 *
 * At each Stop, asks the local operator whether this session owes anything on an
 * owner directive addressed to it before its turn ends:
 *   • an over-cap directive with no summary: blocked until orders:summarize;
 *   • a directive it replied to that is still open: asked done-or-still-open,
 *     once per directive.
 * The rules live server-side in operator-core's owner-directive-turn-end-check.ts;
 * this script only relays the verdict as a Stop `decision: block`.
 *
 * WHY BLOCKING AT Stop CANNOT WEDGE A SESSION: Claude sets `stop_hook_active` on
 * the continuation that follows our own block, and we exit early on it, so a turn
 * is bounced at most once.
 *
 * FAIL-SILENT: no PAPERCUSP_SID (not a psu session), an unreachable or slow
 * operator, a bad response — each ends the turn normally with no output.
 */
import { operatorBase, sessionId } from '../inject/core.mjs';

/** Hard wall on the operator call; past it the turn ends unchecked. */
export const CHECK_TIMEOUT_MS = 2500;

/** @param {unknown} v */
function truthy(v) {
  return v === true || v === 'true' || v === 1 || v === '1';
}

/**
 * The block reason for this Stop, or null to let the turn end.
 * @param {{ hook: Record<string, unknown>, env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch }} input
 * @returns {Promise<string | null>}
 */
export async function evaluateStop({ hook, env = process.env, fetchImpl = globalThis.fetch }) {
  if (truthy(hook.stop_hook_active ?? hook.stopHookActive)) return null;
  const owner = sessionId(env);
  if (!owner) return null;
  const params = new URLSearchParams({ owner });
  if (env.PAPERCUSP_WORKSPACE) params.set('workspace', env.PAPERCUSP_WORKSPACE);
  const res = await fetchImpl(`${operatorBase(env)}/api/agent-mcp/turn-end-directive-check?${params}`, {
    method: 'POST',
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const body = await res.json();
  return typeof body?.reason === 'string' && body.reason.trim() ? body.reason : null;
}

/**
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
function readStdin(timeoutMs) {
  return new Promise((done) => {
    if (process.stdin.isTTY) return done('');
    let data = '';
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        done(data);
      }
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.on('data', (c) => {
      data += c;
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      finish();
    });
  });
}

async function main() {
  try {
    const raw = await readStdin(250);
    const hook = raw.trim() ? JSON.parse(raw) : {};
    const reason = await evaluateStop({ hook });
    if (reason) process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
  } catch {
    // Fail silent: a broken check degrades to no check, never to a blocked agent.
  }
  process.exit(0);
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('stop-owner-directive-check.mjs');
if (invokedDirectly) main();
