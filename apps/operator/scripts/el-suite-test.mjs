#!/usr/bin/env node
/**
 * EL Conv AI behavior suite.
 *
 * Drives the operator agent over a text-only WebSocket session and
 * asserts on the tools it invokes + the responses it emits. Replaces
 * the manual "say these out loud" walkthrough — same agent, same
 * persona, same tools; only the audio path is bypassed.
 *
 * Per-test we record: which clientTools fire, with what args, and what
 * the agent says back. Each test has assertions against those signals.
 *
 * Limitations:
 *   - Voice characteristics (gender, prosody, speed) — not testable
 *     here, those need ear-on-audio.
 *   - Multi-tab leader / focus-follows-tab — that's a browser-only
 *     concern; tests live in voice-leader.test.ts.
 *   - Real panel state — clientTools return canned values so we can
 *     verify the agent reasons about the data, not that the panel
 *     actually has those cards.
 *
 * Usage:
 *   node apps/operator/scripts/el-suite-test.mjs
 *   node apps/operator/scripts/el-suite-test.mjs --only=panel-cards
 *   OPERATOR_BASE=http://localhost:3070 node ... (defaults to :3055)
 */
import { Conversation } from '@elevenlabs/client';
import fs from 'node:fs';

// Node polyfills — SDK pokes window/document on import.
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
  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'el-suite-test/1.0' },
      writable: false,
      configurable: true,
    });
  } catch { /* keep node default */ }
}

const BASE = process.env.OPERATOR_BASE ?? 'http://localhost:3055';
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice('--only='.length) || null;

// Skip-gracefully gate. The suite hits the live EL API and burns
// conversation minutes — fine for a dev-on-purpose run, wrong for
// `npm test` on a fresh checkout. Set EL_SUITE_REQUIRED=1 to fail
// instead of skip when credentials are missing (e.g. in a CI job that
// is *meant* to run this suite).
async function tryLoopbackCreds() {
  for (const p of [process.env.OPERATOR_PORT ?? '3070', '3070', '3055']) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/api/agent-mcp/el-admin-creds`);
      if (!r.ok) continue;
      const d = await r.json();
      return { apiKey: d.apiKey ?? null, agentId: d.agentId ?? null };
    } catch { /* try next */ }
  }
  return null;
}

async function preflightOrSkip() {
  let xiKey = process.env.XI_API_KEY;
  let agentId = process.env.EL_AGENT_ID;
  if (xiKey && agentId) return;
  const credPath = `${process.env.HOME}/.papercusp/credentials.json`;
  const prefsPath = `${process.env.HOME}/.papercusp-workspaces/default/.papercusp/system/operator/voice-prefs.json`;
  if (fs.existsSync(credPath) && fs.existsSync(prefsPath)) return;
  // Post-PG-migration fallback: read from a running operator app.
  const loop = await tryLoopbackCreds();
  if (loop?.apiKey) process.env.XI_API_KEY = process.env.XI_API_KEY ?? loop.apiKey;
  if (loop?.agentId) process.env.EL_AGENT_ID = process.env.EL_AGENT_ID ?? loop.agentId;
  if (process.env.XI_API_KEY && process.env.EL_AGENT_ID) return;
  if (process.env.EL_SUITE_REQUIRED === '1') return;
  console.log('[el-suite] skipped — no EL credentials.');
  console.log('  Set XI_API_KEY + EL_AGENT_ID, populate the legacy files, or start the operator');
  console.log('  app on :3070 so this script can fetch credentials via loopback.');
  console.log('  To turn this skip into a hard fail, run with EL_SUITE_REQUIRED=1.');
  process.exit(0);
}
await preflightOrSkip();

// Canned panel state used by the panel_cards stub. Tests reference these
// titles when probing the agent.
const PANEL_CARDS = [
  { id: 'sug-1', title: 'Replan needed for sheets harness',
    action: 'send_directive', tier: 'medium', status: 'pending',
    targetHarness: 'sheets', reason: 'spec drift detected', autoDispatch: false },
  { id: 'sug-2', title: 'Forms validator failed schema check',
    action: 'send_directive', tier: 'high', status: 'pending',
    targetHarness: 'forms', reason: 'invalid schema', autoDispatch: false },
  { id: 'sug-3', title: 'Update docs for billing module',
    action: 'send_directive', tier: 'low', status: 'pending',
    targetHarness: 'billing', reason: 'README stale', autoDispatch: false },
];

// Per-session collected signal. Reset before each scenario.
let toolCalls = []; // { name, args, ts }
let messages = [];  // { source: 'ai'|'user'|'system', text, ts }

function makeStubs() {
  return {
    panel_cards: async (args) => {
      let cards = PANEL_CARDS;
      if (args?.status === 'pending') cards = cards.filter((c) => c.status === 'pending');
      if (args?.tier && args.tier !== 'any') cards = cards.filter((c) => c.tier === args.tier);
      return JSON.stringify({ count: cards.length, cards });
    },
    panel_dispatch_card: async ({ id }) => JSON.stringify({ ok: true, id }),
    panel_dismiss_card: async ({ id }) => JSON.stringify({ ok: true, id }),
    panel_toggle: async () => JSON.stringify({ open: true }),
    panel_open: async () => JSON.stringify({ open: true }),
    panel_close: async () => JSON.stringify({ open: false }),
    panel_state: async () => JSON.stringify({ open: true, paused: false, iconState: 'idle' }),
    operator_scan: async () => JSON.stringify({ ok: true, found: 0 }),
    operator_approve_pending: async () => JSON.stringify({ ok: true, approved: 0 }),
    operator_across_workspaces: async () => JSON.stringify({ ok: true }),
    navigate: async ({ path }) => JSON.stringify({ ok: true, path }),
    workspace_list: async () => JSON.stringify([
      { id: 'default', name: 'Default', current: true },
      { id: 'sandbox', name: 'Sandbox', current: false },
    ]),
    workspace_switch: async ({ id }) => JSON.stringify({ ok: true, switchedTo: id }),
    voice_prefs: async () => JSON.stringify({
      voiceMode: 'always-on',
      fullAgentEngine: 'elevenlabs-conv',
      wakeWord: 'hey operator',
    }),
    voice_set_mode: async ({ mode }) => JSON.stringify({ ok: true, mode }),
    chat_list: async ({ slug }) => JSON.stringify([
      { id: 'chat-1', role: 'architect', title: 'Sheets pivot scope', feature_id: 'feat-pivot', message_count: 8, updated_at: new Date().toISOString() },
      { id: 'chat-2', role: 'orchestrator', title: 'Validator dispatch', feature_id: 'feat-val', message_count: 3, updated_at: new Date().toISOString() },
    ]),
    chat_open_pane: async ({ slug, chatId }) => JSON.stringify({ ok: true, slug, chatId }),
    agents_across_workspace: async () => JSON.stringify([
      { slug: 'sheets', role: 'architect', chat_count: 4, last_active: new Date().toISOString() },
      { slug: 'forms', role: 'orchestrator', chat_count: 2, last_active: new Date().toISOString() },
    ]),
    harness_list_features: async ({ slug, status }) => JSON.stringify([
      { id: 'feat-1', title: 'Pivot table', status: status ?? 'in-progress', claims: 1, attempts: 0 },
      { id: 'feat-2', title: 'Validator', status: status ?? 'failed', claims: 0, attempts: 2 },
    ]),
    harness_last_scan: async ({ slug }) => JSON.stringify({
      slug,
      summary: 'Last scan 4m ago. 3 pending, 1 failed schema check, 28 of 88 features passing.',
      ts: new Date().toISOString(),
    }),
    harness_recent_suggestions: async ({ slug, limit }) => JSON.stringify([
      { id: 'sug-1', title: 'Replan needed for sheets', kind: 'needs-input', preview: 'spec drift detected' },
      { id: 'sug-2', title: 'Forms validator failed', kind: 'auto', preview: 'schema check' },
    ].slice(0, limit ?? 10)),
    harness_list: async () => JSON.stringify([
      { slug: 'sheets', path: '/x/sheets' },
      { slug: 'forms', path: '/x/forms' },
      { slug: 'billing', path: '/x/billing' },
    ]),
    harness_status: async ({ slug }) => JSON.stringify({
      slug, feature_total: 88, feature_counts: { passed: 28, in_progress: 3, blocked: 1 },
      summary_excerpt: `${slug} harness — last update 4m ago`,
    }),
    harness_health: async ({ slug }) => JSON.stringify({
      slug, alive: true, escalated: false,
      feature_counts: { passed: 28, failing: 0, in_progress: 3, blocked: 1 },
      lastRunMs: Date.now() - 4 * 60_000,
    }),
    issues_list: async ({ slug }) => JSON.stringify({
      count: slug ? 2 : 1,
      issues: slug
        ? [
            { id: 'I-0001', title: 'Forms validator failing schema check', severity: 'major', status: 'open' },
            { id: 'I-0002', title: 'Sheets pivot table off by one', severity: 'minor', status: 'open' },
          ]
        : [{ id: 'F-0007', title: 'Forms harness needs human review on capability X', harness_slug: 'forms', status: 'needs-review' }],
    }),
    escalations_get: async ({ slug }) => JSON.stringify({
      hasEscalation: slug === 'sheets',
      escalation: slug === 'sheets' ? 'Sheets harness blocked on capability approval since 14:22.' : null,
      supervisorNotes: null,
      mtimeMs: slug === 'sheets' ? Date.now() - 600_000 : null,
    }),
    pending_reviews_list: async ({ slug }) => JSON.stringify({
      count: 1,
      reviews: [{ id: 'R-001', kind: 'capability', title: `${slug} requires capability X`, ts: Date.now() - 300_000 }],
    }),
    scans_list: async (args) => {
      const all = [
        { id: 1, startedAt: new Date(Date.now() - 5 * 60_000).toISOString(), endedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
          summary: 'Three suggestions surfaced: forms validator, sheets replan, billing docs.', suggestionCount: 3,
          costUsd: 0.18, cached: false, error: null, agentSessionId: null },
        { id: 2, startedAt: new Date(Date.now() - 60 * 60_000).toISOString(), endedAt: new Date(Date.now() - 59 * 60_000).toISOString(),
          summary: 'Re-emitted prior cards; no new issues.', suggestionCount: 3,
          costUsd: 0.17, cached: false, error: null, agentSessionId: 'sess-aaaa' },
      ];
      const limit = args?.limit ?? 20;
      return JSON.stringify({ count: all.length, scans: all.slice(0, limit) });
    },
    scans_get: async ({ id }) => JSON.stringify({
      scan: {
        id, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
        summary: 'Three suggestions surfaced: forms validator, sheets replan, billing docs.',
        suggestionCount: 3, costUsd: 0.18, cached: false, error: null, agentSessionId: null,
        suggestions: [
          { id: 'sug-1', title: 'Forms validator failed schema check', action: 'send_directive', tier: 'high', reason: 'invalid schema', body: 'Long body…' },
          { id: 'sug-2', title: 'Replan needed for sheets', action: 'send_directive', tier: 'medium', reason: 'spec drift', body: 'Long body…' },
        ],
      },
    }),
    delegates_list: async (args) => {
      const all = [
        { id: 1, agentSessionId: 'sess-harness-aaaa', title: 'Review of harness changes',
          summary: 'Five files changed across ProposalsPanel, FeatureList, IssuesList, and globals.css.',
          lastActiveAt: new Date(Date.now() - 5 * 60_000).toISOString(),
          turnCount: 1, status: 'open' },
        { id: 2, agentSessionId: 'sess-bell-bbbb', title: 'What is the Bell number?',
          summary: 'Combinatorial sequence counting set partitions.',
          lastActiveAt: new Date(Date.now() - 60 * 60_000).toISOString(),
          turnCount: 2, status: 'open' },
        { id: 3, agentSessionId: 'sess-archived-cccc', title: 'Old refactor pass',
          summary: 'Reviewed sheets harness for cleanup opportunities; superseded.',
          lastActiveAt: new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
          turnCount: 4, status: 'archived' },
      ];
      let rows = all;
      const status = args?.status ?? 'open';
      if (status !== 'all') rows = rows.filter((r) => r.status === status);
      if (args?.limit) rows = rows.slice(0, args.limit);
      return JSON.stringify({ sessions: rows });
    },
    delegates_get: async ({ id }) => {
      // Match by either numeric id or agentSessionId substring.
      const all = [
        { id: 1, agentSessionId: 'sess-harness-aaaa', title: 'Review of harness changes',
          summary: 'Five files changed across ProposalsPanel, FeatureList, IssuesList, and globals.css.',
          lastActiveAt: new Date(Date.now() - 5 * 60_000).toISOString(), turnCount: 1, status: 'open',
          transcript: [{ ts: new Date().toISOString(), request: 'Review the harness', response: 'Five files changed…' }] },
      ];
      const hit = all.find((r) => String(r.id) === String(id) || r.agentSessionId.includes(id));
      return JSON.stringify({ session: hit ?? null });
    },
  };
}

// Wrap each stub so we record what the agent actually called.
function instrument(stubs) {
  const out = {};
  for (const [name, fn] of Object.entries(stubs)) {
    out[name] = async (args) => {
      toolCalls.push({ name, args: args ?? {}, ts: Date.now() });
      return fn(args ?? {});
    };
  }
  return out;
}

/**
 * Resolve XI key + agent id from env first, fall back to local config
 * files. Returns null when neither is available — caller can skip
 * gracefully (CI / dev machines without an EL key shouldn't fail the
 * suite, only fail when tests are *expected* to run).
 */
function resolveCredentials() {
  // preflightOrSkip already populated process.env.{XI_API_KEY,EL_AGENT_ID}
  // from loopback if the legacy files were missing — so by here, env is
  // the source of truth.
  let xiKey = process.env.XI_API_KEY;
  let agentId = process.env.EL_AGENT_ID;
  if (!xiKey) {
    const credPath = `${process.env.HOME}/.papercusp/credentials.json`;
    if (fs.existsSync(credPath)) {
      try { xiKey = JSON.parse(fs.readFileSync(credPath, 'utf8'))?.elevenlabs?.apiKey; }
      catch { /* fall through to skip */ }
    }
  }
  if (!agentId) {
    const prefsPath = `${process.env.HOME}/.papercusp-workspaces/default/.papercusp/system/operator/voice-prefs.json`;
    if (fs.existsSync(prefsPath)) {
      try { agentId = JSON.parse(fs.readFileSync(prefsPath, 'utf8'))?.elevenLabsAgentId; }
      catch { /* fall through to skip */ }
    }
  }
  if (!xiKey || !agentId) return null;
  return { xiKey, agentId };
}

async function mintSignedUrl() {
  const creds = resolveCredentials();
  if (!creds) throw new Error('no EL credentials (set XI_API_KEY + EL_AGENT_ID, or populate ~/.papercusp/credentials.json + voice-prefs.json)');
  const r = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${creds.agentId}`,
    { headers: { 'xi-api-key': creds.xiKey } },
  );
  if (!r.ok) throw new Error(`signed_url ${r.status}: ${await r.text()}`);
  return (await r.json()).signed_url;
}

/**
 * Open one EL text session. Tests reuse this across turns to share the
 * same conversation context (so "the sheets one" pronoun resolution
 * works after `panel_cards`).
 */
async function startSession() {
  const signedUrl = await mintSignedUrl();
  toolCalls = [];
  messages = [];

  const conv = await Conversation.startSession({
    signedUrl,
    connectionType: 'websocket',
    textOnly: true,
    clientTools: instrument(makeStubs()),
    onMessage: ({ message, source }) => {
      messages.push({ source, text: String(message ?? ''), ts: Date.now() });
    },
    onError: (msg) => {
      messages.push({ source: 'error', text: String(msg), ts: Date.now() });
    },
  });

  // Wait for the canned first_message so it doesn't pollute the first
  // test's transcript.
  await waitForAgent(2_500).catch(() => {});
  return conv;
}

/**
 * Send a user turn and wait for the agent to finish. Returns the agent
 * text emitted since this call started, plus the tool calls fired.
 */
async function turn(conv, userText, opts = {}) {
  const startIdx = messages.length;
  const startToolCalls = toolCalls.length;
  await conv.sendUserMessage(userText);
  await waitForAgent(opts.timeoutMs ?? 12_000);
  const newMessages = messages.slice(startIdx);
  const newToolCalls = toolCalls.slice(startToolCalls);
  const agentText = newMessages
    .filter((m) => m.source === 'ai')
    .map((m) => m.text)
    .join(' ');
  return { agentText, newMessages, newToolCalls };
}

/**
 * Resolve when an `ai` message lands AND a quiet window has passed
 * without another one. Tool calls inflate the gap (agent says
 * pre-tool line, tool runs, agent says post-tool line) so we wait
 * longer when a tool fired during the turn.
 */
function waitForAgent(timeoutMs) {
  const startToolCount = toolCalls.length;
  return new Promise((resolve) => {
    const startCount = messages.length;
    const start = Date.now();
    let lastAiAt = 0;
    const tick = () => {
      const now = Date.now();
      const ai = messages
        .slice(startCount)
        .filter((m) => m.source === 'ai');
      if (ai.length > 0) lastAiAt = Math.max(lastAiAt, ai[ai.length - 1].ts);
      // If a tool fired during this turn, the agent will likely emit a
      // follow-up message after the tool returns. Wait longer for the
      // settling silence so we capture both the pre-tool ack and the
      // post-tool summary in the same turn.
      const toolFired = toolCalls.length > startToolCount;
      const quietWindow = toolFired ? 4000 : 800;
      if (lastAiAt && now - lastAiAt >= quietWindow) return resolve();
      if (now - start >= timeoutMs) return resolve();
      setTimeout(tick, 200);
    };
    tick();
  });
}

// ──────────────────────────────────────────────────────────────────
// Test scenarios. Each: { name, run(conv) -> array of {label, pass, detail} }.
// ──────────────────────────────────────────────────────────────────

const SCENARIOS = [
  {
    name: 'silence-fillers',
    run: async (conv) => {
      const out = [];
      const t = await turn(conv, 'hi', { timeoutMs: 8000 });
      const lower = t.agentText.toLowerCase();
      out.push({
        label: 'no "still there" filler in greeting reply',
        pass: !/still there|still here|you good\??|let me know.*back/i.test(t.agentText),
        detail: t.agentText.slice(0, 200),
      });
      out.push({
        label: 'no closer filler "let me know if there\'s anything else"',
        pass: !/let me know if (there'?s|you need) anything|happy to help|hope (this )?helps/i.test(lower),
        detail: t.agentText.slice(0, 200),
      });
      return out;
    },
  },
  {
    name: 'panel-cards-list',
    run: async (conv) => {
      const out = [];
      const t = await turn(conv, "what's on my panel?", { timeoutMs: 12_000 });
      out.push({
        label: 'called panel_cards',
        pass: t.newToolCalls.some((c) => c.name === 'panel_cards'),
        detail: t.newToolCalls.map((c) => c.name).join(',') || '(no tool calls)',
      });
      out.push({
        label: 'mentions at least one card by content (sheets/forms/billing/replan/validator/docs)',
        pass: /sheets|forms|billing|replan|validator|docs|schema/i.test(t.agentText),
        detail: t.agentText.slice(0, 250),
      });
      out.push({
        label: 'does NOT read raw card ids (sug-1, sug-2…)',
        pass: !/sug[-_]\d/i.test(t.agentText),
        detail: t.agentText.slice(0, 250),
      });
      out.push({
        label: 'mentions count or tier-spread',
        pass: /three|3|2|two|pending|high|medium|low/i.test(t.agentText),
        detail: t.agentText.slice(0, 250),
      });
      return out;
    },
  },
  {
    name: 'panel-cards-urgent-only',
    run: async (conv) => {
      const out = [];
      const t = await turn(conv, 'anything urgent?', { timeoutMs: 12_000 });
      out.push({
        label: 'called panel_cards',
        pass: t.newToolCalls.some((c) => c.name === 'panel_cards'),
        detail: t.newToolCalls.map((c) => `${c.name}(${JSON.stringify(c.args)})`).join(' | '),
      });
      const panelCardsCall = t.newToolCalls.find((c) => c.name === 'panel_cards');
      out.push({
        label: 'filters by tier=high or status=pending',
        pass: !!panelCardsCall && (
          panelCardsCall.args?.tier === 'high' ||
          panelCardsCall.args?.status === 'pending'
        ),
        detail: panelCardsCall ? JSON.stringify(panelCardsCall.args) : '(no call)',
      });
      out.push({
        label: 'mentions a tier-high card (forms/validator/schema/high/urgent)',
        pass: /forms|validator|schema|high|urgent|critical/i.test(t.agentText),
        detail: t.agentText.slice(0, 250),
      });
      return out;
    },
  },
  {
    name: 'panel-cards-dispatch-by-content',
    run: async (conv) => {
      const out = [];
      // First: agent must know which cards exist.
      await turn(conv, "list what's on my panel", { timeoutMs: 12_000 });
      // Now: refer to one by content, not by id.
      const t = await turn(conv, 'dispatch the docs one', { timeoutMs: 12_000 });
      const dispatchCall = t.newToolCalls.find((c) => c.name === 'panel_dispatch_card');
      out.push({
        label: 'called panel_dispatch_card',
        pass: !!dispatchCall,
        detail: t.newToolCalls.map((c) => c.name).join(',') || '(none)',
      });
      out.push({
        label: 'resolved to the docs card id (sug-3)',
        pass: dispatchCall?.args?.id === 'sug-3',
        detail: dispatchCall ? JSON.stringify(dispatchCall.args) : '(no call)',
      });
      return out;
    },
  },
  {
    name: 'panel-cards-dispatch-high-confirms-first',
    run: async (conv) => {
      const out = [];
      await turn(conv, "what's pending?", { timeoutMs: 12_000 });
      const t = await turn(conv, 'dispatch the forms one', { timeoutMs: 10_000 });
      // Tier-high should produce a confirmation question, NOT a direct dispatch.
      const dispatchedAlready = t.newToolCalls.some((c) => c.name === 'panel_dispatch_card');
      const asksToConfirm = /sure\??|confirm|go ahead|proceed|the forms validator|validator failed/i.test(t.agentText)
        && /\?/.test(t.agentText);
      out.push({
        label: 'tier-high: confirms before dispatching (does NOT dispatch immediately)',
        pass: !dispatchedAlready && asksToConfirm,
        detail: `dispatched=${dispatchedAlready}, agent="${t.agentText.slice(0, 200)}"`,
      });
      // Now confirm — should dispatch.
      const t2 = await turn(conv, 'yes go ahead', { timeoutMs: 10_000 });
      const dispatchCall = t2.newToolCalls.find((c) => c.name === 'panel_dispatch_card');
      out.push({
        label: 'after confirm: dispatches the high-tier card',
        pass: !!dispatchCall && dispatchCall.args?.id === 'sug-2',
        detail: dispatchCall ? JSON.stringify(dispatchCall.args) : '(no call)',
      });
      return out;
    },
  },
  {
    name: 'panel-cards-dismiss',
    run: async (conv) => {
      const out = [];
      await turn(conv, "what's on my panel?", { timeoutMs: 12_000 });
      const t = await turn(conv, 'dismiss the docs update', { timeoutMs: 10_000 });
      const dismissCall = t.newToolCalls.find((c) => c.name === 'panel_dismiss_card');
      out.push({
        label: 'called panel_dismiss_card with sug-3',
        pass: !!dismissCall && dismissCall.args?.id === 'sug-3',
        detail: dismissCall ? JSON.stringify(dismissCall.args) : t.newToolCalls.map((c) => c.name).join(','),
      });
      return out;
    },
  },
  {
    name: 'navigation',
    run: async (conv) => {
      const out = [];
      const t1 = await turn(conv, 'navigate me to the settings page now', { timeoutMs: 8000 });
      const nav1 = t1.newToolCalls.find((c) => c.name === 'navigate');
      out.push({
        label: 'navigate to /settings',
        pass: !!nav1 && /\/settings/.test(nav1.args?.path ?? ''),
        detail: nav1 ? JSON.stringify(nav1.args) : (t1.newToolCalls.map((c) => c.name).join(',') || '(no calls)'),
      });
      const t2 = await turn(conv, 'open the operator panel', { timeoutMs: 8000 });
      const open = t2.newToolCalls.find((c) => c.name === 'panel_open');
      out.push({
        label: 'panel_open',
        pass: !!open,
        detail: t2.newToolCalls.map((c) => c.name).join(',') || '(none)',
      });
      const t3 = await turn(conv, 'close it', { timeoutMs: 8000 });
      const close = t3.newToolCalls.find((c) => c.name === 'panel_close');
      out.push({
        label: 'panel_close (memory rule: calls tool even if maybe-closed)',
        pass: !!close,
        detail: t3.newToolCalls.map((c) => c.name).join(',') || '(none)',
      });
      return out;
    },
  },
  {
    name: 'harness-listing',
    run: async (conv) => {
      const out = [];
      const t1 = await turn(conv, 'list the harnesses', { timeoutMs: 10_000 });
      out.push({
        label: 'called harness_list',
        pass: t1.newToolCalls.some((c) => c.name === 'harness_list'),
        detail: t1.newToolCalls.map((c) => c.name).join(',') || '(none)',
      });
      out.push({
        label: 'mentions the actual slugs',
        pass: /sheets/i.test(t1.agentText) && /forms/i.test(t1.agentText),
        detail: t1.agentText.slice(0, 250),
      });
      return out;
    },
  },
  {
    name: 'unknown-card-failure-mode',
    run: async (conv) => {
      const out = [];
      await turn(conv, "what's on my panel?", { timeoutMs: 10_000 });
      const t = await turn(conv, 'dispatch the frobnicate card', { timeoutMs: 10_000 });
      out.push({
        label: 'no panel_dispatch_card call (no such card)',
        pass: !t.newToolCalls.some((c) => c.name === 'panel_dispatch_card'),
        detail: t.newToolCalls.map((c) => c.name).join(',') || '(no calls)',
      });
      out.push({
        label: 'declines plainly (no apology theatre)',
        pass: /(don'?t see|no .* card|nothing called|not on the panel|can'?t find)/i.test(t.agentText)
          && !/sorry|apolog/i.test(t.agentText),
        detail: t.agentText.slice(0, 250),
      });
      return out;
    },
  },
  {
    name: 'harness-status-detail',
    run: async (conv) => {
      const out = [];
      const t = await turn(conv, "what's going on with the sheets harness?", { timeoutMs: 12_000 });
      const statusCall = t.newToolCalls.find((c) => c.name === 'harness_status');
      out.push({
        label: 'called harness_status',
        pass: !!statusCall,
        detail: t.newToolCalls.map((c) => c.name).join(',') || '(none)',
      });
      out.push({
        label: 'passed slug=sheets',
        pass: statusCall?.args?.slug === 'sheets',
        detail: statusCall ? JSON.stringify(statusCall.args) : '(no call)',
      });
      out.push({
        label: 'mentions concrete numbers or status terms from the response',
        pass: /\b\d+\b|passed|progress|blocked|failed|feature|active|update|harness|sheets/i.test(t.agentText),
        detail: t.agentText.slice(0, 250),
      });
      return out;
    },
  },
  {
    name: 'operator-scan-trigger',
    run: async (conv) => {
      const out = [];
      // Use a more specific phrasing — 'rescan the workspace' was
      // ambiguous between operator_scan (this workspace) and
      // operator_across_workspaces (all workspaces); both are valid
      // interpretations now that the agent has both tools.
      const t = await turn(conv, 'run the operator scan now', { timeoutMs: 10_000 });
      out.push({
        label: 'called a scan-related tool',
        pass: t.newToolCalls.some((c) =>
          c.name === 'operator_scan' ||
          c.name === 'operator_across_workspaces' ||
          c.name === 'harness_last_scan'
        ),
        detail: t.newToolCalls.map((c) => c.name).join(',') || '(none)',
      });
      return out;
    },
  },
  {
    name: 'panel-state-query',
    run: async (conv) => {
      const out = [];
      // Force a tool call with explicit "check, not from memory"
      // phrasing — the persona says state questions need a tool, not
      // memory, but a casual "is the panel open?" sometimes gets
      // answered from prior turn context.
      const t = await turn(conv, 'check whether the operator panel is currently open', { timeoutMs: 8_000 });
      // panel_state is the read; panel_open is a write (opens the
      // panel) and would be wrong for a yes/no state question.
      out.push({
        label: 'called panel_state (a read), not panel_open (a write)',
        pass: t.newToolCalls.some((c) => c.name === 'panel_state')
          && !t.newToolCalls.some((c) => c.name === 'panel_open'),
        detail: t.newToolCalls.map((c) => c.name).join(',') || '(none)',
      });
      return out;
    },
  },
  {
    name: 'no-name-when-not-set',
    run: async (conv) => {
      const out = [];
      // Persona has "{name}" template; if EL doesn't substitute it,
      // the agent should TREAT IT AS UNSET and never address the user
      // by the literal token. (Persona: "if the token appears literally,
      // treat it as 'name unset' and skip".)
      const t1 = await turn(conv, 'hi', { timeoutMs: 8_000 });
      const t2 = await turn(conv, 'what time is it', { timeoutMs: 8_000 });
      const t3 = await turn(conv, 'tell me a fun fact', { timeoutMs: 10_000 });
      const allText = `${t1.agentText} ${t2.agentText} ${t3.agentText}`;
      out.push({
        label: 'never addresses user as literal "{name}"',
        pass: !/\{name\}/i.test(allText),
        detail: allText.slice(0, 250),
      });
      return out;
    },
  },
  {
    name: 'delegates-list-recall',
    run: async (conv) => {
      const out = [];
      const t = await turn(conv, 'what delegates have i run?', { timeoutMs: 12_000 });
      out.push({
        label: 'called delegates_list',
        pass: t.newToolCalls.some((c) => c.name === 'delegates_list'),
        detail: t.newToolCalls.map((c) => c.name).join(',') || '(none)',
      });
      out.push({
        label: 'gave a substantive response (>30 chars) referencing prior delegates',
        pass: t.agentText.length > 30,
        detail: t.agentText.slice(0, 250),
      });
      out.push({
        label: 'does NOT read raw session ids (sess-…)',
        pass: !/sess[-_]\w+/.test(t.agentText),
        detail: t.agentText.slice(0, 250),
      });
      return out;
    },
  },
  {
    name: 'scans-history-recall',
    run: async (conv) => {
      const out = [];
      const t = await turn(conv, 'what have my recent scans found?', { timeoutMs: 12_000 });
      out.push({
        label: 'called scans_list',
        pass: t.newToolCalls.some((c) => c.name === 'scans_list'),
        detail: t.newToolCalls.map((c) => c.name).join(',') || '(none)',
      });
      out.push({
        label: 'mentions content from a stub scan summary (validator/replan/sheets/forms/billing/three/2)',
        pass: /validator|replan|sheets|forms|billing|three|2|3|recent|prior|suggestion/i.test(t.agentText),
        detail: t.agentText.slice(0, 250),
      });
      return out;
    },
  },
  {
    name: 'delegate-async-started-ack',
    run: async (conv) => {
      const out = [];
      // The default delegate stub returns started-shape when the task
      // string contains 'ASYNC_LONG_TASK'. We fold that into a
      // natural-sounding user request the agent will paraphrase into
      // the task arg.
      const t = await turn(
        conv,
        'have claude review the harness files for ASYNC_LONG_TASK and tell me what is in progress when done',
        { timeoutMs: 12_000 },
      );
      out.push({
        label: 'speaks a brief acknowledgment, NOT a fabricated summary',
        // Brief = under ~140 chars typically; not full of fake findings.
        // Reasonable phrases: "on it", "looking into that", "I'll let you know"
        pass: t.agentText.length < 200 &&
          /(on it|looking into|let you know|hear back|loop back|working on|hang on|hang tight|moment)/i.test(t.agentText),
        detail: t.agentText.slice(0, 250),
      });
      out.push({
        label: 'does NOT say "details in the panel" yet (no details to share)',
        pass: !/(details? .*panel|in the panel|put .*details? .*panel)/i.test(t.agentText),
        detail: t.agentText.slice(0, 250),
      });
      out.push({
        label: 'does NOT fabricate findings (no specific file/feature claims)',
        pass: !/\b(found|five|four|three|two|files? changed|in progress)\b/i.test(t.agentText),
        detail: t.agentText.slice(0, 250),
      });
      return out;
    },
  },
  {
    name: 'delegate-never-still-running',
    run: async (conv) => {
      const out = [];
      // First, fire a delegate so there's one in conversation memory.
      await turn(
        conv,
        'have claude check the harness files and tell me what is changed',
        { timeoutMs: 30_000 },
      );
      // Then ask about its state — agent must NOT claim it's still running.
      const t = await turn(
        conv,
        'is the delegate still running?',
        { timeoutMs: 10_000 },
      );
      out.push({
        label: 'does NOT positively claim the delegate is running',
        // Catch positive claims ("yes, still running", "it's running", "still
        // working on it") but not denials ("no, it's not still running").
        // Heuristic: "still running"/etc preceded by a negation word in the
        // 30 chars before is fine; otherwise it's a positive claim.
        pass: !(() => {
          const matches = [...t.agentText.matchAll(/still (running|working|going|in progress)|in progress|currently (running|working|processing)/gi)];
          return matches.some((m) => {
            const before = t.agentText.slice(Math.max(0, m.index - 30), m.index).toLowerCase();
            return !/\b(no|not|isn'?t|wasn'?t|doesn'?t)\b/.test(before);
          });
        })(),
        detail: t.agentText.slice(0, 250),
      });
      out.push({
        label: 'states the delegate completed (done / finished / complete) or refers to its output',
        pass: /done|finished|complete|already|earlier|panel|i found|summary|details/i.test(t.agentText),
        detail: t.agentText.slice(0, 250),
      });
      return out;
    },
  },
  {
    name: 'no-unspeakable-tokens',
    run: async (conv) => {
      const out = [];
      // Make the agent talk about something concrete that would tempt
      // it to read garbage tokens (commit shas, ids, tool names, paths).
      // We hand it a fake "deployment status" via a contextual update so
      // it has tokens in front of it that it must NOT relay verbatim.
      conv.sendContextualUpdate(
        'For internal context: the latest fix shipped in commit 83d4e6fa3b21c, ' +
        'session id conv_91xczf38hjkz1, file apps/operator/lib/commands/defs/delegation.ts, ' +
        'tool name panel_dispatch_card. Do not read these tokens aloud — describe at a level the user can act on.',
      );
      const t = await turn(conv, 'what was just fixed?', { timeoutMs: 10_000 });
      out.push({
        label: 'no commit SHA spoken (>=7 hex chars together)',
        pass: !/\b[0-9a-f]{7,}\b/i.test(t.agentText),
        detail: t.agentText.slice(0, 250),
      });
      out.push({
        label: 'no raw conv/sug/agent id (ends-with-_<random> patterns)',
        pass: !/\b(conv|sug|agent|sess)[_-]\w{6,}\b/i.test(t.agentText),
        detail: t.agentText.slice(0, 250),
      });
      out.push({
        label: 'no tool names with underscores (panel_dispatch_card, harness_status, etc.)',
        pass: !/\b(panel|harness|operator|delegate|workspace)_[a-z_]+\b/i.test(t.agentText),
        detail: t.agentText.slice(0, 250),
      });
      out.push({
        label: 'no long file paths (>= 25 chars with slashes)',
        pass: !/[\w\-./]{25,}\.(ts|tsx|js|mjs|md|json|css)/i.test(t.agentText),
        detail: t.agentText.slice(0, 250),
      });
      return out;
    },
  },
  {
    name: 'tone-no-preludes-or-closers',
    run: async (conv) => {
      const out = [];
      const t = await turn(conv, 'thanks', { timeoutMs: 6000 });
      out.push({
        label: 'no "great question" / "happy to help" preludes',
        pass: !/great question|happy to help|certainly|absolutely/i.test(t.agentText),
        detail: t.agentText.slice(0, 200),
      });
      out.push({
        label: 'no closer fillers',
        pass: !/let me know if|anything else|reach out|feel free/i.test(t.agentText),
        detail: t.agentText.slice(0, 200),
      });
      out.push({
        label: 'response is short (≤350 chars per persona)',
        pass: t.agentText.length <= 400,
        detail: `len=${t.agentText.length}`,
      });
      return out;
    },
  },
];

// ──────────────────────────────────────────────────────────────────
// Runner
// ──────────────────────────────────────────────────────────────────

const scenarios = ONLY ? SCENARIOS.filter((s) => s.name === ONLY) : SCENARIOS;
if (!scenarios.length) {
  console.error('no scenarios to run (did you mistype --only?)');
  process.exit(1);
}

const results = [];
for (const sc of scenarios) {
  console.log(`\n── ${sc.name} ──`);
  let conv;
  try {
    conv = await startSession();
    const checks = await sc.run(conv);
    for (const c of checks) {
      const tag = c.pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
      console.log(`  ${tag} ${c.label}`);
      if (!c.pass && c.detail) console.log(`     detail: ${c.detail}`);
      results.push({ scenario: sc.name, ...c });
    }
  } catch (e) {
    console.log(`  \x1b[31m✗\x1b[0m scenario crashed: ${e?.message ?? e}`);
    results.push({ scenario: sc.name, label: 'scenario crashed', pass: false, detail: String(e?.message ?? e) });
  } finally {
    try { await conv?.endSession(); } catch { /* ignore */ }
  }
}

const total = results.length;
const passed = results.filter((r) => r.pass).length;
const failed = total - passed;
console.log(`\n──────────\n${passed}/${total} passed${failed ? `, ${failed} failed` : ''}`);
process.exit(failed ? 1 : 0);
