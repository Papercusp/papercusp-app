#!/usr/bin/env node
/**
 * check-fleet-auth.mjs — DEFINITIVELY determine what auth the fleet's spawned `claude` bees use.
 *
 * WHY THIS EXISTS (the recurring mistake this prevents):
 *   Agents repeatedly conclude "we're on the Claude Max subscription" from the PRESENCE of
 *   `~/.claude/.credentials.json` (a `subscriptionType: max` OAuth block) — WITHOUT checking what
 *   the spawned `claude -p` process actually presents ON THE WIRE. Credential presence ≠ the
 *   subscription serving the workload. Two traps reinforce the wrong conclusion:
 *     1. claude-code reports a NON-ZERO `total_cost_usd` even on a subscription (it's an
 *        equivalent-cost ESTIMATE, not a bill), so cost telemetry looks like "API billing."
 *     2. the bees still authenticate + 429 (rate-limited), so it "looks like it's working, just busy."
 *
 *   This script reads the GROUND TRUTH: it runs a real claude-code call with `--debug`, inspects the
 *   actual request headers, and prints a verdict. `x-api-key` ⇒ API key; `authorization: Bearer` +
 *   `anthropic-beta: oauth-…` ⇒ subscription OAuth. It also greps every spawn-relevant env for
 *   `ANTHROPIC_API_KEY` (the only thing that would flip a `claude` spawn off the OAuth path).
 *
 * USAGE:  node scripts/check-fleet-auth.mjs            (npm run check:fleet-auth)
 * EXIT:   0 always (diagnostic). Read the VERDICT line.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const mask = (s) => (s ? `${String(s).slice(0, 6)}…(set, len ${String(s).length})` : '(unset)');

/** Resolve the claude binary the fleet uses: $CLAUDE, or the first token of $AGENT_CMD, else `claude`. */
function resolveClaudeBin() {
  if (process.env.CLAUDE) return process.env.CLAUDE.trim().split(/\s+/)[0];
  if (process.env.AGENT_CMD) return process.env.AGENT_CMD.trim().split(/\s+/)[0];
  return 'claude';
}

/**
 * Run claude once with `ANTHROPIC_LOG=debug` — THAT (the SDK's HTTP logging), not the `--debug`
 * flag, dumps the actual request (method/url/headers incl. anthropic-beta + authorization/x-api-key).
 * stdin is closed (`input: ''`) so claude doesn't wait ~3s for piped input.
 */
function probeWireAuth(bin) {
  const r = spawnSync(
    bin,
    ['-p', 'Reply with exactly: PING', '--output-format', 'json', '--model', 'claude-haiku-4-5-20251001'],
    {
      encoding: 'utf8',
      timeout: 90_000,
      maxBuffer: 64 * 1024 * 1024,
      input: '',
      env: { ...process.env, ANTHROPIC_LOG: 'debug' },
    },
  );
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  if (r.error && !out.trim()) return { ok: false, reason: r.error.message, out: '' };
  return { ok: true, out };
}

/** Classify the wire auth from the --debug request dump. */
function classifyWire(out) {
  const hasApiKeyHeader = /["'\s]x-api-key["'\s:]/i.test(out);
  const hasOauthBeta = /anthropic-beta["'\s:]+[^\n]*oauth-/i.test(out);
  const hasAuthorization = /["'\s]authorization["'\s:]/i.test(out);
  const endpoint = (/https:\/\/[^\s"']*\/v1\/messages[^\s"']*/i.exec(out) || [])[0] || '(not seen)';
  let verdict = 'unknown';
  if (hasApiKeyHeader) verdict = 'api-key';
  else if (hasOauthBeta || (hasAuthorization && !hasApiKeyHeader)) verdict = 'oauth-subscription';
  return { verdict, hasApiKeyHeader, hasOauthBeta, hasAuthorization, endpoint };
}

/** Best-effort: is ANTHROPIC_API_KEY set in the spawning hosts' process envs? (Linux /proc) */
function hostEnvApiKey() {
  const procDir = '/proc';
  if (!existsSync(procDir)) return [];
  let pids;
  try {
    pids = readdirSync(procDir).filter((p) => /^\d+$/.test(p));
  } catch {
    return [];
  }
  // Group by service label; report whether ANY of that service's procs had the key set.
  const bySvc = new Map(); // svc -> { checked, set }
  for (const pid of pids) {
    let cmd = '';
    try {
      cmd = readFileSync(join(procDir, pid, 'cmdline'), 'utf8').replace(/\0/g, ' ');
    } catch {
      continue;
    }
    const svcMatch = /papercup-(?:dev|staging)-api|hono-host\.ts|hono-host/.exec(cmd);
    if (!svcMatch) continue;
    const svc = svcMatch[0].replace(/\.ts$/, '');
    let env = '';
    try {
      env = readFileSync(join(procDir, pid, 'environ'), 'utf8');
    } catch {
      continue;
    }
    const set = /(?:^|\0)ANTHROPIC_API_KEY=[^\0]/.test(env);
    const cur = bySvc.get(svc) || { checked: 0, set: 0 };
    cur.checked += 1;
    if (set) cur.set += 1;
    bySvc.set(svc, cur);
  }
  return [...bySvc.entries()].map(([svc, v]) => ({ svc, ...v }));
}

function envFileApiKey() {
  for (const f of ['apps/operator/.env.local', '.env.local', '.env']) {
    if (!existsSync(f)) continue;
    const line = readFileSync(f, 'utf8').split('\n').find((l) => /^\s*ANTHROPIC_API_KEY\s*=/.test(l));
    if (line) return { file: f, value: mask(line.split('=').slice(1).join('=').trim()) };
  }
  return null;
}

function credSubscription() {
  const f = join(homedir(), '.claude', '.credentials.json');
  if (!existsSync(f)) return '(no ~/.claude/.credentials.json)';
  try {
    const d = JSON.parse(readFileSync(f, 'utf8'));
    return (d.claudeAiOauth || {}).subscriptionType || '(no claudeAiOauth block)';
  } catch {
    return '(unreadable)';
  }
}

// ─────────────────────────────────────── run ───────────────────────────────────────
console.log('check-fleet-auth — what do the fleet bees actually authenticate with?\n');

const bin = resolveClaudeBin();
console.log(`claude binary (CLAUDE/AGENT_CMD/default): ${bin}`);
console.log(`~/.claude credentials subscriptionType:  ${credSubscription()}`);
console.log(`ANTHROPIC_API_KEY in this env:            ${mask(process.env.ANTHROPIC_API_KEY)}`);

const ef = envFileApiKey();
console.log(`ANTHROPIC_API_KEY in env files:           ${ef ? `${ef.file} → ${ef.value}` : '(not in .env.local/.env)'}`);

const hostHits = hostEnvApiKey();
if (hostHits.length) {
  for (const h of hostHits) {
    console.log(`ANTHROPIC_API_KEY on ${h.svc.padEnd(22)}  ${h.set ? `SET in ${h.set}/${h.checked} procs` : `unset (${h.checked} procs)`}`);
  }
} else {
  console.log('ANTHROPIC_API_KEY on spawning hosts:      (no host process found / not readable)');
}

console.log('\nprobing the wire (running `claude -p --debug` once — this is the source of truth)…');
const probe = probeWireAuth(bin);
if (!probe.ok) {
  console.log(`\n⚠ could not run ${bin}: ${probe.reason}`);
  console.log('VERDICT: UNKNOWN — could not probe the wire. Fix the claude binary, then re-run.');
  process.exit(0);
}

const w = classifyWire(probe.out);
console.log(`  endpoint:        ${w.endpoint}`);
console.log(`  x-api-key header: ${w.hasApiKeyHeader ? 'PRESENT' : 'absent'}`);
console.log(`  authorization:    ${w.hasAuthorization ? 'PRESENT (Bearer)' : 'absent'}`);
console.log(`  anthropic-beta oauth-*: ${w.hasOauthBeta ? 'PRESENT' : 'absent'}`);

console.log('\n──────────────────────────────────────────────────────────────────────────');
if (w.verdict === 'oauth-subscription') {
  console.log('VERDICT: the fleet authenticates via the Claude SUBSCRIPTION OAuth (Bearer +');
  console.log('         anthropic-beta: oauth-…), NOT an API key.');
  console.log('');
  console.log('  ⚠ A CONSUMER subscription (Pro/Max) is gated for INTERACTIVE, single-session');
  console.log('    Claude Code. Driving it HEADLESS (`claude -p`) at fleet concurrency gets');
  console.log('    throttled hard ("Server is temporarily limiting requests"). If the fleet is');
  console.log('    persistently rate-limited, the subscription is the WRONG auth for this workload —');
  console.log('    provision an ANTHROPIC_API_KEY (or Bedrock/Vertex) with a real rate-limit tier.');
} else if (w.verdict === 'api-key') {
  console.log('VERDICT: the fleet uses an ANTHROPIC_API_KEY (x-api-key) — the pay-per-token API');
  console.log('         with proper API rate-limit tiers. (NOT the consumer subscription.)');
} else {
  console.log('VERDICT: UNKNOWN — could not classify the wire auth from the debug dump.');
  console.log('         Inspect the request headers in the --debug output manually.');
}
console.log('');
console.log('  NOTE: claude-code reports a NON-ZERO total_cost_usd EVEN on a subscription (an');
console.log('  equivalent-cost ESTIMATE, not a bill). Do NOT infer the plan from cost telemetry —');
console.log('  the wire auth above is the only reliable signal. See');
console.log('  /internal/docs/agent-insights/fleet-inference-auth.');
console.log('──────────────────────────────────────────────────────────────────────────');
process.exit(0);
