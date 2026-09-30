#!/usr/bin/env -S npx tsx
/**
 * `operator` CLI — power-user surface for the Operator system.
 *
 * Talks to the running operator app via HTTP (default http://localhost:3055)
 * for the network-bound subcommands and reads/writes filesystem state for
 * the rest. Set `OPERATOR_BASE_URL` to point at a different deployment.
 *
 *   operator status                 # scan-rate, dispatch-rate, breaker, lock
 *   operator stats                  # 7-day KPIs (same JSON as the settings panel)
 *   operator scan [--background]    # trigger a scan, stream the SSE result
 *   operator pause | resume         # toggle background scanning
 *   operator budget [N]             # show or set the daily cap (USD)
 *   operator prefs list|remove|purge ...  # delegates to audit-prefs.ts
 *   operator dismiss-clear          # forget all dismissed-cooldown entries
 *   operator candidates             # list standing-approval candidates
 *   operator approve <cap> <target> # promote a candidate to STANDING-APPROVE
 *   operator config                 # print substrate prompt + paths
 */

import {
  listPreferenceEntries,
  removePreferenceEntry,
} from '@papercusp/operator-core/lib/operator-preferences';
import { OPERATOR_SUBSTRATE_PROMPT } from '@papercusp/operator-core/lib/operator-prompt-system';

const BASE = process.env.OPERATOR_BASE_URL ?? 'http://localhost:3055';

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`HTTP ${r.status} ${path}: ${text || r.statusText}`);
  }
  const ct = r.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) return (await r.json()) as T;
  return (await r.text()) as unknown as T;
}

async function statusCmd() {
  const [budget, candidates, trigger] = await Promise.all([
    api<{ configured: boolean; dailyCapUsd: number; todaySpendUsd: number; exceeded: boolean }>('GET', '/api/agent-mcp/operator-budget'),
    api<{ candidates: { capability: string; targetHarness: string; count: number }[] }>('GET', '/api/agent-mcp/operator-standing-approvals').catch(() => ({ candidates: [] })),
    api<{ fingerprint: string }>('GET', '/api/agent-mcp/operator-trigger-state').catch(() => ({ fingerprint: '(unavailable)' })),
  ]);
  console.log('budget:           ', budget.configured ? `$${budget.todaySpendUsd.toFixed(2)} / $${budget.dailyCapUsd}` : '(not configured)');
  if (budget.exceeded) console.log('                   ⚠ exceeded — operator paused for today');
  console.log('trigger state fp: ', trigger.fingerprint);
  console.log('approval cands:   ', candidates.candidates.length);
  for (const c of candidates.candidates.slice(0, 5)) {
    console.log(`  - ${c.capability} → ${c.targetHarness} (${c.count}× in 24h)`);
  }
}

async function statsCmd() {
  const stats = await api<Record<string, unknown>>('GET', '/api/agent-mcp/operator-stats');
  console.log(JSON.stringify(stats, null, 2));
}

async function scanCmd(args: string[]) {
  const background = args.includes('--background');
  const url = `${BASE}/api/agent-mcp/operator-scan${background ? '?background=1' : ''}`;
  console.error(`streaming ${url} …`);
  const r = await fetch(url);
  if (!r.ok || !r.body) {
    console.error(`HTTP ${r.status} ${await r.text()}`);
    process.exit(1);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev = block.match(/^event:\s*(\S+)/m)?.[1] ?? 'message';
      const data = block.match(/^data:\s*(.*)$/m)?.[1] ?? '';
      if (ev === 'suggestion') {
        try {
          const s = JSON.parse(data) as { title: string; actualTier: string; auto_dispatch: boolean };
          console.log(`[${s.actualTier}${s.auto_dispatch ? ' auto' : ' ask'}] ${s.title}`);
        } catch {
          console.log(data);
        }
      } else if (ev === 'done') {
        console.error(`done: ${data}`);
      } else if (ev === 'error') {
        console.error(`error: ${data}`);
      }
    }
  }
}

async function pauseCmd(paused: boolean) {
  // Pause state is held in harness_shared.operator_paused (PG, migration 029).
  // The background scanner polls /api/agent-mcp/operator-pause-flag.
  const { setPaused, setResumed } = await import('@papercusp/operator-core/lib/device-operator-actions');
  if (paused) {
    await setPaused('cli');
    console.log('paused — background scans will stop on next poll');
  } else {
    await setResumed();
    console.log('resumed');
  }
}

async function budgetCmd(args: string[]) {
  if (args.length === 0) {
    const b = await api<{ configured: boolean; dailyCapUsd: number; todaySpendUsd: number }>('GET', '/api/agent-mcp/operator-budget');
    console.log(b.configured ? `$${b.todaySpendUsd.toFixed(2)} / $${b.dailyCapUsd}` : '(not configured)');
    return;
  }
  const cap = Number(args[0]);
  if (!Number.isFinite(cap) || cap <= 0) {
    console.error('usage: operator budget [N]   (N > 0)');
    process.exit(1);
  }
  await api('PUT', '/api/agent-mcp/operator-budget', { dailyCapUsd: cap });
  console.log(`budget set to $${cap}/day`);
}

async function dismissClearCmd() {
  const { existsSync, rmSync } = await import('node:fs');
  const { papercuspPath } = await import('@papercusp/operator-core/lib/papercusp-root');
  const p = papercuspPath('system', 'operator', 'dismissed.json');
  if (existsSync(p)) {
    rmSync(p);
    console.log(`removed ${p}`);
  } else {
    console.log('(no dismissed file)');
  }
}

async function candidatesCmd() {
  const { candidates } = await api<{ candidates: { capability: string; targetHarness: string; count: number; lastSeenAt: string }[] }>(
    'GET',
    '/api/agent-mcp/operator-standing-approvals',
  );
  if (!candidates.length) {
    console.log('(no candidates)');
    return;
  }
  for (const c of candidates) {
    console.log(`${c.capability} → ${c.targetHarness}    (${c.count}× in 24h, last ${c.lastSeenAt})`);
  }
}

async function approveCmd(args: string[]) {
  const [cap, target] = args;
  if (!cap || !target) {
    console.error('usage: operator approve <capability> <target_harness>');
    process.exit(1);
  }
  await api('POST', '/api/agent-mcp/operator-standing-approvals', { capability: cap, targetHarness: target, decision: 'approve' });
  console.log(`approved standing dispatch: ${cap} → ${target}`);
}

function configCmd() {
  console.log('=== Substrate prompt (read-only) ===\n');
  console.log(OPERATOR_SUBSTRATE_PROMPT);
}

async function prefsCmd(args: string[]) {
  const sub = args[0];
  if (sub === 'list') {
    const filterIdx = args.indexOf('--filter');
    const filter = filterIdx >= 0 ? args[filterIdx + 1] : 'all';
    let entries = await listPreferenceEntries();
    if (filter === 'user-typed') entries = entries.filter((e) => e.tags.includes('USER-TYPED'));
    if (filter === 'operator-proposed') entries = entries.filter((e) => e.tags.some((t) => t.startsWith('OPERATOR-PROPOSED')));
    if (!entries.length) {
      console.log('(no entries)');
      return;
    }
    for (const e of entries) {
      console.log(`\n[${e.key}] ${e.date} · ${e.tags.join(' ')}`);
      console.log(e.body);
    }
    return;
  }
  if (sub === 'remove') {
    const key = args[1];
    if (!key) {
      console.error('usage: operator prefs remove <key>');
      process.exit(1);
    }
    if (!removePreferenceEntry(key)) {
      console.error(`no entry with key=${key}`);
      process.exit(1);
    }
    console.log(`removed ${key}`);
    return;
  }
  console.error('usage: operator prefs <list|remove> [...]');
  process.exit(1);
}

async function voiceCmd(args: string[]) {
  const sub = args[0];
  if (sub === 'status' || !sub) {
    const [prefs, creds, spend] = await Promise.all([
      api<Record<string, unknown>>('GET', '/api/agent-mcp/operator-voice-prefs'),
      api<Record<string, { configured: boolean }>>('GET', '/api/agent-mcp/operator-credentials'),
      api<{ perKCharRate: number; spend: { date: string; estimatedUsd: number }[] }>('GET', '/api/agent-mcp/operator-tts-spend'),
    ]);
    console.log('STT engine:        ', prefs.sttEngine);
    console.log('TTS engine:        ', prefs.ttsEngine);
    console.log('Configured keys:   ', Object.entries(creds).filter(([, v]) => v.configured).map(([k]) => k).join(', ') || '(none)');
    const today = spend.spend?.[0];
    if (today) console.log('Today TTS spend:   ', `${today.estimatedUsd.toFixed(2)} @ ${prefs.perKCharRate ?? spend.perKCharRate}/1k`);
    return;
  }
  if (sub === 'test') {
    const provider = args[1];
    if (!provider) { console.error('usage: operator voice test <elevenlabs|openai|cartesia|deepgram>'); process.exit(1); }
    const r = await api<{ ok: boolean; error?: string; tier?: string; voicesAvailable?: number; projects?: number }>('POST', `/api/agent-mcp/operator-${provider}-test`);
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  if (sub === 'set-engine') {
    const engineKind = args[1] as 'stt' | 'tts';
    const value = args[2];
    if (!engineKind || !value || !['stt', 'tts'].includes(engineKind)) {
      console.error('usage: operator voice set-engine <stt|tts> <engine-name>');
      process.exit(1);
    }
    const field = engineKind === 'stt' ? 'sttEngine' : 'ttsEngine';
    await api('PUT', '/api/agent-mcp/operator-voice-prefs', { [field]: value });
    console.log(`set ${field} = ${value}`);
    return;
  }
  if (sub === 'set-key') {
    const provider = args[1];
    const key = args[2];
    if (!provider || !key) { console.error('usage: operator voice set-key <elevenlabs|openai|cartesia|deepgram> <api-key>'); process.exit(1); }
    const fieldMap: Record<string, string> = {
      elevenlabs: 'elevenlabsApiKey', openai: 'openaiApiKey',
      cartesia: 'cartesiaApiKey', deepgram: 'deepgramApiKey',
    };
    const field = fieldMap[provider];
    if (!field) { console.error('unknown provider'); process.exit(1); }
    await api('PUT', '/api/agent-mcp/operator-credentials', { [field]: key });
    console.log(`set ${provider} key (${key.length} chars)`);
    return;
  }
  if (sub === 'spend') {
    const spend = await api<{ perKCharRate: number; softCapUsd: number; hardCapUsd: number; spend: { date: string; chars: number; estimatedUsd: number }[] }>('GET', '/api/agent-mcp/operator-tts-spend');
    console.log(`Rate: ${spend.perKCharRate}/1k chars`);
    console.log(`Soft cap: ${spend.softCapUsd}/day  ·  Hard cap: ${spend.hardCapUsd}/day`);
    console.log('Last 7 days:');
    for (const d of spend.spend) {
      console.log(`  ${d.date}  ${d.estimatedUsd.toFixed(3).padStart(7)}  (${d.chars} chars)`);
    }
    return;
  }
  console.error('usage: operator voice <status|test|set-engine|set-key|spend>');
  process.exit(1);
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case 'status':         return await statusCmd();
    case 'stats':          return await statsCmd();
    case 'scan':           return await scanCmd(rest);
    case 'pause':          return await pauseCmd(true);
    case 'resume':         return await pauseCmd(false);
    case 'budget':         return await budgetCmd(rest);
    case 'prefs':          return prefsCmd(rest);
    case 'dismiss-clear':  return await dismissClearCmd();
    case 'candidates':     return await candidatesCmd();
    case 'approve':        return await approveCmd(rest);
    case 'config':         return configCmd();
    case 'voice':          return await voiceCmd(rest);
    default:
      console.error('usage: operator <status|stats|scan|pause|resume|budget|prefs|dismiss-clear|candidates|approve|config|voice>');
      process.exit(1);
  }
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
