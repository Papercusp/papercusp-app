#!/usr/bin/env node
/**
 * EL Conv AI end-to-end smoke test.
 *
 * Mints a conversation token via our bootstrap endpoint, opens a
 * text-only WebSocket session via @elevenlabs/client (no audio), sends
 * "hello", waits 15s, prints every event. If the agent's LLM is alive,
 * we'll see a `agent_response` event. If the WebSocket hangs up, we
 * print why.
 */
import { Conversation } from '@elevenlabs/client';

// node-side polyfill for sessionStorage / window globals — the SDK
// reaches for them on import.
if (typeof globalThis.window === 'undefined') {
  const noopStorage = {
    getItem: () => null, setItem: () => {}, removeItem: () => {},
    clear: () => {}, key: () => null, length: 0,
  };
  Object.defineProperty(globalThis, 'window', { value: globalThis, writable: false });
  Object.defineProperty(globalThis, 'document', {
    value: { addEventListener: () => {}, removeEventListener: () => {} },
    writable: false,
  });
  Object.defineProperty(globalThis, 'localStorage', { value: noopStorage, writable: false });
  Object.defineProperty(globalThis, 'sessionStorage', { value: noopStorage, writable: false });
  // navigator is read-only on Node 22+; if we can override, do; if not, ignore.
  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'el-connect-test/1.0' },
      writable: false,
      configurable: true,
    });
  } catch { /* keep node default */ }
}

const BASE = process.env.OPERATOR_BASE ?? 'http://localhost:3055';
const TIMEOUT_MS = 20_000;

console.log('[1/4] minting conversation token via', `${BASE}/api/agent-mcp/operator-elevenlabs-bootstrap`);
const r = await fetch(`${BASE}/api/agent-mcp/operator-elevenlabs-bootstrap`);
if (!r.ok) {
  const body = await r.text().catch(() => '');
  console.error('mint failed:', r.status, body);
  process.exit(1);
}
const { conversationToken, agentId } = await r.json();
console.log('   agentId:', agentId);
console.log('   token:', conversationToken.slice(0, 40), '... (len', conversationToken.length, ')');

console.log('[2/4] opening WebSocket session (textOnly, no audio)');
let agentSpoke = false;
let lastEvent = Date.now();
const events = [];

// For WebSocket text mode the SDK wants either a `signedUrl` (server-
// minted) or `agentId` directly. Get a signed URL via the EL API.
const credPath = `${process.env.HOME}/.papercusp/credentials.json`;
const fs = await import('node:fs');
async function tryLoopbackKey() {
  for (const port of [process.env.OPERATOR_PORT ?? '3070', '3070', '3055']) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/agent-mcp/el-admin-creds`);
      if (!r.ok) continue;
      const d = await r.json();
      return d.apiKey ?? null;
    } catch { /* try next */ }
  }
  return null;
}
let xiKey = process.env.XI_API_KEY ?? null;
if (!xiKey && fs.existsSync(credPath)) {
  try { xiKey = JSON.parse(fs.readFileSync(credPath, 'utf8'))?.elevenlabs?.apiKey ?? null; } catch { /* ignore */ }
}
if (!xiKey) xiKey = await tryLoopbackKey();
if (!xiKey) {
  console.error('no XI_API_KEY env, no', credPath, 'and operator app not reachable on 127.0.0.1:3070/3055');
  process.exit(1);
}
const signedUrlResp = await fetch(
  `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${agentId}`,
  { headers: { 'xi-api-key': xiKey } },
);
if (!signedUrlResp.ok) {
  console.error('signed_url mint failed:', signedUrlResp.status, await signedUrlResp.text());
  process.exit(1);
}
const { signed_url: signedUrl } = await signedUrlResp.json();
console.log('   signedUrl:', signedUrl.slice(0, 60), '...');

// Stub clientTools that match the EL-registered names. Returning a
// realistic shape proves the agent picks up our tool result.
const stubTools = {
  harness_status: async ({ slug }) => JSON.stringify({ slug, feature_total: 88, feature_counts: { passed: 28, in_progress: 3 }, summary_excerpt: 'sheets harness — last update 4m ago' }),
  harness_list: async () => JSON.stringify([{ slug: 'sheets', path: '/x/sheets' }, { slug: 'forms', path: '/x/forms' }]),
  workspace_list: async () => JSON.stringify([{ id: 'default', name: 'Default' }]),
  panel_toggle: async () => JSON.stringify({ open: true }),
  panel_open: async () => JSON.stringify({ open: true }),
  panel_close: async () => JSON.stringify({ open: false }),
  panel_cards: async () => JSON.stringify({
    count: 2,
    cards: [
      { id: 'sug-1', title: 'Replan needed for sheets', action: 'send_directive', tier: 'medium', status: 'pending', targetHarness: 'sheets', reason: 'spec drift detected', autoDispatch: false },
      { id: 'sug-2', title: 'Forms validator failed', action: 'send_directive', tier: 'high', status: 'pending', targetHarness: 'forms', reason: 'schema check', autoDispatch: false },
    ],
  }),
  panel_dispatch_card: async ({ id }) => JSON.stringify({ ok: true, id }),
  panel_dismiss_card: async ({ id }) => JSON.stringify({ ok: true, id }),
  operator_scan: async () => JSON.stringify({ ok: true }),
  operator_approve_pending: async () => JSON.stringify({ ok: true }),
  operator_across_workspaces: async () => JSON.stringify({ ok: true }),
  navigate: async ({ path }) => JSON.stringify({ path }),
};

const conv = await Conversation.startSession({
  signedUrl,
  connectionType: 'websocket',
  textOnly: true,
  clientTools: stubTools,
  onConnect: ({ conversationId }) => {
    events.push({ t: 'connect', conversationId });
    console.log('   onConnect — conversationId:', conversationId);
    lastEvent = Date.now();
  },
  onDisconnect: (details) => {
    events.push({ t: 'disconnect', details });
    console.log('   onDisconnect:', JSON.stringify(details).slice(0, 300));
    lastEvent = Date.now();
  },
  onMessage: ({ message, source }) => {
    events.push({ t: 'message', source, message });
    console.log(`   [${source}]`, String(message).slice(0, 500));
    // Skip the canned first_message — only set agentSpoke on a real reply.
    if (source === 'ai' && message && String(message).trim() && !/^Hi, what can I help/.test(String(message))) {
      agentSpoke = true;
    }
    lastEvent = Date.now();
  },
  onModeChange: (mode) => {
    events.push({ t: 'mode', mode });
    console.log('   onModeChange:', mode);
    lastEvent = Date.now();
  },
  onStatusChange: (status) => {
    events.push({ t: 'status', status });
    console.log('   onStatusChange:', status);
    lastEvent = Date.now();
  },
  onError: (msg, ctx) => {
    events.push({ t: 'error', msg, ctx });
    console.log('   onError:', msg, ctx ? JSON.stringify(ctx).slice(0, 200) : '');
    lastEvent = Date.now();
  },
});

console.log('[3/4] session opened; waiting for first_message + sending probe in 2s');
await new Promise((res) => setTimeout(res, 2_000));

const probe = process.env.EL_PROBE ?? "what's on my operator panel?";
console.log('   sending:', JSON.stringify(probe));
try {
  await conv.sendUserMessage(probe);
} catch (e) {
  console.log('   sendUserMessage threw:', e?.message ?? e);
}

console.log('[4/4] waiting up to 15s for agent reply');
const start = Date.now();
while (Date.now() - start < 15_000) {
  if (agentSpoke) {
    console.log('   ✅ agent replied — pipeline alive');
    break;
  }
  await new Promise((res) => setTimeout(res, 250));
}

if (!agentSpoke) {
  console.log('   ❌ agent never replied within 15s');
  console.log('   last event was', Math.round((Date.now() - lastEvent) / 1000), 's ago');
}

console.log('[done] ending session');
try { await conv.endSession(); } catch { /* ignore */ }

await new Promise((res) => setTimeout(res, 500));
console.log('\n--- summary ---');
console.log('total events:', events.length);
console.log('agent spoke:', agentSpoke);
console.log('last event types:', events.slice(-10).map((e) => e.t).join(','));

process.exit(agentSpoke ? 0 : 1);
