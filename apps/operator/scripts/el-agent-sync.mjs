#!/usr/bin/env node
/**
 * EL Conv AI agent sync.
 *
 * Pushes our operator persona prompt + the registry-derived clientTools
 * catalog into the EL agent dashboard config, and enables prompt
 * overrides so session-start dynamic context (delegates list, backstory
 * beats) can land. One-shot script; run after agent creation or after
 * the persona / tools change.
 *
 * Without this, the agent has no tools registered and no persona — it
 * just chats with the dashboard's first_message.
 *
 *   node apps/operator/scripts/el-agent-sync.mjs
 *
 * Env:
 *   AGENT_ID — defaults to voice-prefs.json's elevenLabsAgentId
 *   XI_API_KEY — defaults to credentials.json's elevenlabs.apiKey
 */

import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const operatorRoot = path.resolve(__dirname, '..');

const DRY_RUN = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1';

const credPath = path.join(homedir(), '.papercusp', 'credentials.json');
// voice-prefs lives under the active workspace dir, not directly under
// ~/.papercusp. Default workspace is `default`.
//
// Honor PAPERCUSP_WORKSPACES_ROOT before falling back to homedir() — a bare
// homedir() here resolves to a NESTED registry when this script runs with
// HOME remapped to a per-workspace dir (P-051 spawned-child case). See
// agent-insights/workspaces-root-vs-remapped-home and the same env-first
// resolver in @papercusp/operator-core's workspace-registry.ts and this
// script's sibling, voice-stack-check.mjs.
const workspacesRoot = (process.env.PAPERCUSP_WORKSPACES_ROOT?.trim())
  || path.join(homedir(), '.papercusp-workspaces');
const workspaceId = process.env.PAPERCUSP_WORKSPACE ?? 'default';
const prefsPath = path.join(workspacesRoot, workspaceId, '.papercusp', 'system', 'operator', 'voice-prefs.json');

// Pre-flight: collect every gate failure into one report rather than
// bailing on the first error. The user gets a single actionable list
// instead of a one-line error and another run.
const preflight = { ok: true, errors: [], warnings: [] };
function fail(msg, hint) { preflight.ok = false; preflight.errors.push({ msg, hint }); }
function warn(msg, hint) { preflight.warnings.push({ msg, hint }); }

console.log('[preflight]' + (DRY_RUN ? ' (dry-run)' : ''));

// 1. credentials — try env, then ~/.papercusp/credentials.json (legacy),
//    then a loopback fetch from the running operator (post PG migration).
let xiKey = process.env.XI_API_KEY;
let agentId = process.env.AGENT_ID;

async function tryLoopbackCreds() {
  const port = process.env.OPERATOR_PORT ?? '3070';
  for (const p of [port, '3070', '3055']) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/api/agent-mcp/el-admin-creds`);
      if (!r.ok) continue;
      const d = await r.json();
      return { apiKey: d.apiKey ?? null, agentId: d.agentId ?? null };
    } catch { /* try next port */ }
  }
  return null;
}

if (!xiKey) {
  if (fs.existsSync(credPath)) {
    try {
      const creds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
      xiKey = creds?.elevenlabs?.apiKey;
    } catch { /* fall through */ }
  }
  if (!xiKey) {
    const loop = await tryLoopbackCreds();
    if (loop?.apiKey) xiKey = loop.apiKey;
    if (loop?.agentId && !agentId) agentId = loop.agentId;
  }
  if (!xiKey) fail('XI_API_KEY missing — no env, no credentials.json, no loopback', 'Set XI_API_KEY env var, or save ElevenLabs key via /settings/api-keys, or start the operator app on :3070 so this script can read PG via loopback.');
}

if (!agentId) {
  if (fs.existsSync(prefsPath)) {
    try {
      agentId = JSON.parse(fs.readFileSync(prefsPath, 'utf8'))?.elevenLabsAgentId;
    } catch { /* fall through */ }
  }
  if (!agentId) {
    const loop = await tryLoopbackCreds();
    if (loop?.agentId) agentId = loop.agentId;
  }
  if (!agentId) fail('AGENT_ID missing — no env, no voice-prefs.json, no loopback', 'Set AGENT_ID env var, or save the agent id via /settings/voice, or start the operator app so this script can read PG via loopback.');
}

// 3. persona file present + non-trivial.
// In shell mode (default since 2026-05-10), EL becomes the voice
// transport and delegates every turn to the local omp brain via the
// ask_operator tool. The persona/character lives on the local brain;
// EL only needs the shell prompt. To run EL with its own LLM as the
// brain (legacy mode), set OPERATOR_EL_BRAIN=1.
const useShellMode = process.env.OPERATOR_EL_BRAIN !== '1';
const personaFile = useShellMode ? 'operator.shell.md' : 'operator.persona.md';
const personaPath = path.join(operatorRoot, 'prompts', personaFile);
let persona = '';
if (!fs.existsSync(personaPath)) {
  fail(`${personaFile} missing at ${personaPath}`, 'Re-checkout the operator scaffold or restore from git.');
} else {
  persona = fs.readFileSync(personaPath, 'utf8');
  if (persona.length < 500) {
    fail(`${personaFile} is suspiciously short (${persona.length} chars)`, 'Expected at least 500 chars. Did the file get truncated?');
  }
}

// 4. xi-api-key shape sanity (don't hit /v1/user — many BYO keys have
// convai scope only and 401 there even though convai endpoints work).
// The real auth check is the agent fetch below.
if (xiKey && !/^sk_[a-f0-9]{40,}$/i.test(xiKey)) {
  warn(`xi-api-key doesn't match the EL key shape (sk_ + 40+ hex chars)`, 'May still work; the agent fetch will tell us.');
}

// 5. agent exists on EL — only if we have key + id
let cfg = null;
if (xiKey && agentId && preflight.ok) {
  try {
    const cfgResp = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${agentId}`, {
      headers: { 'xi-api-key': xiKey },
    });
    if (!cfgResp.ok) {
      const body = await cfgResp.text().catch(() => '');
      if (cfgResp.status === 404) {
        fail(`agent ${agentId} not found on ElevenLabs (404)`, 'The id is wrong, the agent was deleted, or it lives in another workspace.');
      } else if (cfgResp.status === 403) {
        fail(`xi-api-key lacks permission for agent ${agentId} (403)`, 'Use a key with convai:write scope from the agent\'s workspace.');
      } else {
        fail(`agent fetch returned ${cfgResp.status}: ${body.slice(0, 200)}`, 'Check ElevenLabs status + your network.');
      }
    } else {
      cfg = await cfgResp.json();
      console.log(`  agent: ok (${cfg.name ?? '(no name)'}, llm=${cfg.conversation_config?.agent?.prompt?.llm ?? 'unset'})`);

      // C4 of the active-mode audit — drift detection. Warn loudly
      // if the live agent's `turn` config diverges from the values
      // this script intends to set. Catches the case where someone
      // edits the agent from the EL dashboard after a sync and
      // surprises voice-side silence-ladder behavior.
      const liveTurn = cfg.conversation_config?.turn ?? {};
      const expectedTurnTimeout = 10;
      const expectedTurnEagerness = 'patient';
      if (liveTurn.turn_timeout !== undefined && liveTurn.turn_timeout !== expectedTurnTimeout) {
        console.warn(
          `  ⚠ DRIFT: live turn_timeout=${liveTurn.turn_timeout}, expected ${expectedTurnTimeout}. ` +
          `This script will overwrite it. If the dashboard value is intentional, ` +
          `update scripts/el-agent-sync.mjs before re-running.`,
        );
      }
      if (liveTurn.turn_eagerness !== undefined && liveTurn.turn_eagerness !== expectedTurnEagerness) {
        console.warn(
          `  ⚠ DRIFT: live turn_eagerness=${liveTurn.turn_eagerness}, expected '${expectedTurnEagerness}'. ` +
          `This script will overwrite it.`,
        );
      }
      // Drift on first_message: the operator-as-voice-shell design
      // demands first_message=false (the operator brain emits the
      // opener via ask_operator with trigger=open_canvas). A
      // dashboard edit re-enabling it would bypass the brain.
      const liveFirstMsg = cfg.conversation_config?.agent?.first_message;
      if (liveFirstMsg !== undefined && liveFirstMsg !== '' && liveFirstMsg !== false && liveFirstMsg !== null) {
        console.warn(
          `  ⚠ DRIFT: live first_message is set to "${String(liveFirstMsg).slice(0, 60)}". ` +
          `Active-mode design requires first_message=false (opener comes from operator brain ` +
          `via ask_operator + trigger=open_canvas). This script will overwrite it.`,
        );
      }
    }
  } catch (e) {
    fail(`agent fetch failed: ${e?.message ?? e}`, 'Network or DNS issue.');
  }
}

// 6. Static drift check between TOOLS list (this file) and the
// commands registry (lib/commands/defs/*.ts). Catches the
// "Client tool not defined on client" runtime crash class — the
// TOOLS array pushes type:'client' tools to the agent's dashboard,
// but those handlers only exist in-page when the registry def is
// agents:['operator',...] AND (kind=='command' implies
// browser=='required'). If a TOOLS entry doesn't have a matching
// registry def, the agent will call it and the page will crash.
try {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('node', [path.join(__dirname, 'el-tools-check.mjs')], {
    cwd: operatorRoot,
    encoding: 'utf8',
  });
  // Always print whatever the checker said (warnings or errors).
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status === 1) {
    // Hard drift errors — abort sync.
    fail(
      'el-tools-check found drift between TOOLS list and registry',
      'See el-tools-check output above. Fix the registry def or remove the TOOLS entry, then re-run.',
    );
  }
} catch (e) {
  warn(`el-tools-check could not run: ${e?.message ?? e}`, 'Drift check skipped; manual verification recommended.');
}

// Report
for (const w of preflight.warnings) {
  console.log(`  ⚠ ${w.msg}`);
  if (w.hint) console.log(`    → ${w.hint}`);
}
if (!preflight.ok) {
  console.error('');
  console.error('[preflight] FAILED:');
  for (const e of preflight.errors) {
    console.error(`  ✗ ${e.msg}`);
    if (e.hint) console.error(`    → ${e.hint}`);
  }
  console.error('');
  console.error('Fix the items above and re-run. Pass --dry-run to skip the live PATCH.');
  process.exit(1);
}
console.log('  ✓ all preflight checks passed');
if (DRY_RUN) {
  console.log('');
  console.log('[dry-run] preflight green; not running tool registration or agent PATCH.');
  console.log('  Persona length: ' + persona.length + ' chars');
  console.log('  Existing tools on agent: ' + (cfg?.conversation_config?.agent?.prompt?.tool_ids?.length ?? 0));
  process.exit(0);
}

console.log('[1/4] reading persona prompt — ' + persona.length + ' chars');
console.log('[2/4] current agent config — ' + (cfg?.conversation_config?.agent?.prompt?.tool_ids?.length ?? 0) + ' tools attached');

console.log('[3/4] composing patch');

// Tool catalog — registry's browser:'required' commands + queries that
// the operator (voice) is tagged for. Hand-curated subset for now since
// importing the TS registry from a node script is non-trivial.
// EL requires every parameter property to have a `description`.
// Helper makes the per-property shape explicit so we can't forget.
const prop = (type, description, extra = {}) => ({ type, description, ...extra });

// (panel_* + operator_across_workspaces tools were retired with the
// operator-card panel — unify-agent-launches D-005. Don't re-add them
// without re-registering browser:'required' defs first.)

// IMPORTANT: every entry below with type:'client' MUST correspond to a
// registry CommandDef registered with `agents: ['operator', ...]` AND
// `browser: 'required'`. Otherwise EL pushes the tool to the agent's
// dashboard, the agent calls it, and the page crashes at runtime with:
//   "ElevenLabs runtime error: Client tool with name X is not defined on client"
// because buildClientTools (lib/voice-engines/elevenlabs-conv.ts) only
// exposes browser:'required' commands as client tools.
//
// To add a new client-side tool: 1) register the def with browser:'required',
// 2) add an entry here, 3) re-run this script.
const TOOLS = [
  {
    name: 'ask_operator', type: 'client', expects_response: true,
    description: 'Send the user\'s exact words to the local operator brain (omp + Claude Max + gitnexus). Returns the operator\'s reply as a string. Call this for every user turn that needs a substantive answer; speak the returned text VERBATIM. Do not paraphrase or generate your own response. If the user says "ready" / "next" / "what now", pass trigger="user_says_ready" and an empty text — the brain will return concrete suggestions to speak.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: "The user's verbatim utterance — pass through unchanged. Empty string when this is a silence-triggered turn." },
        trigger: { type: 'string', description: 'Reason for this turn. Use "user_says_ready" when the user says "ready" / "next" / "what now". Default: "user_message".', enum: ['user_message', 'silence_after_question', 'quiet_wait_resume', 'open_canvas', 'user_says_ready'] },
      },
      required: ['text'],
      description: 'Delegate input.',
    },
  },
  {
    name: 'operator_scan', type: 'client', expects_response: true,
    description: 'Fire a workspace scan (the `scan` launch blueprint) with an optional query. Findings land as work_items in the self-improvement backlog.',
    parameters: {
      type: 'object',
      properties: { query: prop('string', 'Optional natural-language query to seed the scan.') },
      required: [],
      description: 'Scan request shape.',
    },
  },
  {
    name: 'operator_approve_pending', type: 'client', expects_response: true,
    description: 'Approve a pending capability for a harness.',
    parameters: {
      type: 'object',
      properties: {
        slug: prop('string', 'Harness slug, e.g. "sheets" or "forms".'),
        capability: prop('string', 'Optional capability id; omit if there is exactly one pending.'),
      },
      required: ['slug'],
      description: 'Approval target.',
    },
  },
  {
    name: 'navigate', type: 'client', expects_response: true,
    description: 'Navigate the user to a path within the app. Common: /harness, /marketplace, /settings, /docs.',
    parameters: {
      type: 'object',
      properties: { path: prop('string', 'Path starting with /, e.g. /harness or /settings/voice.') },
      required: ['path'],
      description: 'Navigation target.',
    },
  },
  {
    name: 'workspace_list', type: 'client', expects_response: true,
    description: 'List the workspaces available to the user.',
    parameters: { type: 'object', properties: {}, required: [], description: 'No parameters.' },
  },
  {
    name: 'harness_list', type: 'client', expects_response: true,
    description: 'List harnesses (projects) in the current workspace.',
    parameters: { type: 'object', properties: {}, required: [], description: 'No parameters.' },
  },
  {
    name: 'harness_status', type: 'client', expects_response: true,
    description: 'Get a status snapshot for a harness: feature counts, recent features, summary excerpt.',
    parameters: {
      type: 'object',
      properties: { slug: prop('string', 'Harness slug.') },
      required: ['slug'],
      description: 'Harness target.',
    },
  },
  {
    name: 'harness_list_features', type: 'client', expects_response: true,
    description:
      'List features in a harness queue. Filterable by status (passed, in-progress, ' +
      'failed, blocked). Use after the user asks "what failed in sheets?" / "what is ' +
      'in progress?" / "what features are blocked?" — match by status.',
    parameters: {
      type: 'object',
      properties: {
        slug: prop('string', 'Harness slug.'),
        status: prop('string', 'Optional status filter.', { enum: ['passed', 'in-progress', 'failed', 'blocked'] }),
        limit: prop('integer', 'Max features to return (default 50, cap 200).'),
      },
      required: ['slug'],
      description: 'Feature listing args.',
    },
  },
  // (harness_last_scan / harness_recent_suggestions removed with the scanner
  // card stream — unify-agent-launches D-005. "What did the scanner find?"
  // reads the self-improvement backlog now.)
  {
    name: 'agents_across_workspace', type: 'client', expects_response: true,
    description:
      'List role-scoped agents with recent chat activity across the workspace. Returns ' +
      '[{slug, role, chat_count, last_active}], recency-sorted. Use to answer "which ' +
      'agents are working on X?" or to find the most-active matching role before ' +
      'delegating. Pass slug to restrict to one harness.',
    parameters: {
      type: 'object',
      properties: {
        slug: prop('string', 'Optional harness slug to restrict the query.'),
      },
      required: [],
      description: 'Cross-workspace agent enumeration.',
    },
  },
  {
    name: 'chat_list', type: 'client', expects_response: true,
    description:
      'List recent agent chats in a harness, optionally filtered by role. Returns ' +
      '[{id, role, title, feature_id, message_count, updated_at}], recency-sorted. ' +
      'Use to find a chatId before chat_open_pane.',
    parameters: {
      type: 'object',
      properties: {
        slug: prop('string', 'Harness slug.'),
        role: prop('string', 'Optional role filter (e.g. architect, orchestrator, scoper).'),
        limit: prop('integer', 'Max chats to return (default 20, cap 100).'),
      },
      required: ['slug'],
      description: 'Chat listing args.',
    },
  },
  {
    name: 'chat_open_pane', type: 'client', expects_response: true,
    description:
      "Open the chat panel in the harness dashboard at a specific chatId. Use after " +
      "chat_list to navigate the user to a specific conversation. Don't use to start " +
      "a new chat.",
    parameters: {
      type: 'object',
      properties: {
        slug: prop('string', 'Harness slug.'),
        chatId: prop('string', 'Chat id from chat_list.'),
      },
      required: ['slug', 'chatId'],
      description: 'Chat to open.',
    },
  },
  {
    name: 'voice_set_mode', type: 'client', expects_response: true,
    description:
      'Change voice mode: off / push-to-talk / always-on. Use when user says "stop ' +
      'listening" (off), "go push-to-talk", or "go always-on". Takes effect immediately ' +
      'in this tab.',
    parameters: {
      type: 'object',
      properties: {
        mode: prop('string', 'Target mode.', { enum: ['off', 'push-to-talk', 'always-on'] }),
      },
      required: ['mode'],
      description: 'Voice mode change.',
    },
  },
  {
    name: 'voice_prefs', type: 'client', expects_response: true,
    description:
      'Read current voice prefs (mode, STT/TTS engines, full-agent engine, wake word ' +
      'config). Use to answer "what\'s my wake word?" or "which engine am I on?". For ' +
      'changing the mode, use voice_set_mode.',
    parameters: { type: 'object', properties: {}, required: [], description: 'No parameters.' },
  },
  {
    name: 'workspace_switch', type: 'client', expects_response: true,
    description:
      'Switch the active workspace and reload the page. Use after workspace_list to ' +
      'find the id. Confirm with the user before calling — switching reloads.',
    parameters: {
      type: 'object',
      properties: { id: prop('string', 'Workspace id from workspace_list.') },
      required: ['id'],
      description: 'Target workspace.',
    },
  },
  {
    name: 'issues_list', type: 'client', expects_response: true,
    description:
      'List open issues / features needing human review. Two modes: pass slug for ' +
      "that harness's pending issues, omit for cross-harness needs-human-review list. " +
      'Returns {count, issues: [{id, title, severity, harness_slug?, status}, ...]}. ' +
      'Use to answer "any open issues?", "issues on sheets?", or "what needs my approval?".',
    parameters: {
      type: 'object',
      properties: {
        slug: prop('string', 'Optional harness slug. Omit for cross-harness list.'),
        limit: prop('integer', 'Max issues (default 20, cap 50).'),
      },
      required: [],
      description: 'Filter args.',
    },
  },
  {
    name: 'escalations_get', type: 'client', expects_response: true,
    description:
      'Get escalation + supervisor notes for a harness. Returns ' +
      '{hasEscalation, escalation, supervisorNotes, mtimeMs}. If hasEscalation is false, ' +
      'say so plainly. Otherwise paraphrase the headline — do NOT read the full text aloud. ' +
      'Use for "any escalations?" or "what\'s wrong with the sheets harness?".',
    parameters: {
      type: 'object',
      properties: { slug: prop('string', 'Harness slug.') },
      required: ['slug'],
      description: 'Harness target.',
    },
  },
  {
    name: 'pending_reviews_list', type: 'client', expects_response: true,
    description:
      'List pending reviews (capability approvals, plan reviews) for a harness. ' +
      'Returns {count, reviews: [{id, kind, title, ts, ...}, ...]}. ' +
      'Pair with operator_approve_pending when the user says "approve it" — find the id ' +
      'here, then call operator_approve_pending with slug+capability.',
    parameters: {
      type: 'object',
      properties: {
        slug: prop('string', 'Harness slug.'),
        limit: prop('integer', 'Max reviews (default 20).'),
      },
      required: ['slug'],
      description: 'Listing args.',
    },
  },
  {
    name: 'harness_health', type: 'client', expects_response: true,
    description:
      'Fast health snapshot for a harness. Returns {slug, alive, escalated, feature_counts, ' +
      'lastRunMs}. Single call instead of harness_status + escalations_get. ' +
      'Use for "is sheets healthy?" / "is the harness running?". Mention escalated/failing ' +
      'if either is non-zero.',
    parameters: {
      type: 'object',
      properties: { slug: prop('string', 'Harness slug.') },
      required: ['slug'],
      description: 'Harness target.',
    },
  },
  {
    name: 'actions_recent', type: 'client', expects_response: true,
    description:
      'List recent long-running user-initiated actions for a harness (replan, cleanup, ' +
      'snapshot). Returns {count, actions: [{kind, status, summary, started_at, ...}, ...]}. ' +
      'Use for "what was that long action?" / "did the cleanup finish?". ' +
      'Paraphrase by kind+status, never recite raw ids.',
    parameters: {
      type: 'object',
      properties: {
        slug: prop('string', 'Harness slug.'),
        limit: prop('integer', 'Max actions (default 20).'),
      },
      required: ['slug'],
      description: 'Listing args.',
    },
  },
  {
    name: 'notifications_recent', type: 'client', expects_response: true,
    description:
      'List recent toast notifications (errors, warnings, info, success) shown anywhere in the app. ' +
      'Returns {count, notifications: [{level, message, description?, harness_slug?, created_at}, ...]}. ' +
      'Use for "any errors recently?" / "what just popped up?" / "what\'s the bell showing?". ' +
      'Always pair the level word with the message so context survives.',
    parameters: {
      type: 'object',
      properties: {
        level: prop('string', "Filter: 'error', 'warning', 'info', 'success', or 'all' (default).", { enum: ['error','warning','info','success','all'] }),
        limit: prop('integer', 'Max notifications (default 20).'),
      },
      required: [],
      description: 'Listing args.',
    },
  },
  // (scans_list / scans_get / scans_search removed with the scan-history
  // surface — unify-agent-launches D-005. Scan findings are work_items in
  // the self-improvement backlog now.)
  {
    name: 'delegates_list', type: 'client', expects_response: true,
    description:
      'List retired delegate conversation sessions the user has run. ' +
      'Returns [{id, title, summary, lastActiveAt, turnCount, agentSessionId, status}, ...]. ' +
      "IMPORTANT: status='open' means 'available to resume', NOT 'currently running'. " +
      "Delegate launch/resume is retired. Use this only when the user asks about historical " +
      "delegate records. Default returns open; pass status:'all' or 'archived'.",
    parameters: {
      type: 'object',
      properties: {
        status: prop('string', "Filter: 'open' (default), 'archived', or 'all'.", {
          enum: ['open', 'archived', 'all'],
        }),
        limit: prop('integer', 'Max sessions to return (default 20, cap 50).'),
      },
      required: [],
      description: 'Listing filters.',
    },
  },
  {
    name: 'delegates_get', type: 'client', expects_response: true,
    description:
      'Get full metadata for a single delegate session by id (numeric or agent_session_id UUID). ' +
      'Returns the title, summary, last-activity, and full transcript. Use only to answer questions ' +
      'about historical delegate records. Do not read the transcript verbatim aloud.',
    parameters: {
      type: 'object',
      properties: { id: prop('string', 'Session id (numeric or agent_session_id UUID).') },
      required: ['id'],
      description: 'Session to fetch.',
    },
  },
  {
    name: 'delegates_search', type: 'client', expects_response: true,
    description:
      'Search past delegate sessions by free-text. Matches against title, summary, and the ' +
      "kickoff message. Use only when the user asks about historical delegate records. " +
      "Delegate launch/resume is retired.",
    parameters: {
      type: 'object',
      properties: {
        query: prop('string', 'Free-text needle.'),
        limit: prop('integer', 'Max sessions to return (default 10, cap 50).'),
      },
      required: ['query'],
      description: 'Search filters.',
    },
  },
  {
    name: 'end_conversation', type: 'client', expects_response: false,
    description:
      "End the current voice session. Call this AFTER giving a definitive answer that doesn't " +
      "invite follow-up — e.g. confirmations ('marked done'), single-fact answers ('the time is 3:14'), " +
      "successful tool completions where no further interaction is needed. Do NOT call after asking " +
      "a question, leaving the user mid-thought, or in continuous-mode conversational flows. " +
      "The dynamic_variable {{voice_mode}} indicates when this is appropriate: " +
      "'single-utterance' = always call after one reply; " +
      "'hybrid' = call after definitive answers; " +
      "'continuous' = NEVER call, let the user end the session.",
    parameters: { type: 'object', properties: {}, required: [], description: 'No parameters.' },
  },
];

// Operator voice + TTS knobs. EL Conv AI for English agents accepts
// only `eleven_turbo_v2` or `eleven_flash_v2` as model_id (v2_5/v3
// are gated behind plan tier and language). turbo_v2 has better
// prosody than flash; flash has lower latency. Default: turbo_v2.
//
// To audition voices: https://elevenlabs.io/app/voice-library — copy
// the voice id from any voice's URL or "Add to my voices" panel.
//
// To audition voice/model combinations against the operator persona:
// node apps/operator/scripts/el-voice-preview.mjs <voice_id> [model_id]
//
// To swap the TTS-preview default (single-utterance + fallback engines)
// to match, also update apps/operator/app/api/agent-mcp/operator-tts-
// preview/route.ts so user-triggered previews and live conversation
// sound the same.
const OPERATOR_VOICE = {
  voice_id: 'ROMJ9yK1NAMuu1ggrjDW',
  model_id: 'eleven_turbo_v2',
  stability: 0.5,                    // 0..1; higher = more consistent, less expressive
  similarity_boost: 0.8,             // 0..1; how closely to clone the source
  speed: 1.0,                        // 0.5..2.0; playback speed
};

const patch = {
  conversation_config: {
    agent: {
      prompt: {
        prompt: persona,
        tools: TOOLS,
      },
    },
    tts: {
      voice_id: OPERATOR_VOICE.voice_id,
      model_id: OPERATOR_VOICE.model_id,
      stability: OPERATOR_VOICE.stability,
      similarity_boost: OPERATOR_VOICE.similarity_boost,
      speed: OPERATOR_VOICE.speed,
    },
    // 2026-05-11 silence-redesign: turn_timeout = -1 (disabled). The
    // EL agent NEVER forces a turn from dead air. The provider-side
    // single-nudge logic (silence_after_question, 30s, fires once
    // when the assistant's last turn was a question) is the source of
    // truth for nudges, and it generates context-specific follow-ups
    // — not "still with me?" filler. EL was burning credits + annoying
    // users with periodic auto-turns; this kills both. Voice paths
    // that want to nudge ride on the same provider state machine via
    // the chat-sidebar mounted in the desktop chrome.
    //
    // turn_eagerness 'patient' keeps the mid-utterance "I'm thinking"
    // trip-wire long.
    turn: {
      turn_timeout: -1,
      turn_eagerness: 'patient',
    },
  },
  platform_settings: {
    overrides: {
      conversation_config_override: {
        agent: {
          prompt: {
            prompt: true,
            tool_ids: false,
          },
          first_message: false,
          // Allow runtime per-session language pin. With this enabled,
          // lib/voice-engines/elevenlabs-conv.ts passes `language: <code>`
          // (from VoicePrefs.agentLanguage, default 'en') in the session
          // overrides — stops EL's STT auto-detect from flipping when
          // background music or ambient noise has speech-like timbre.
          language: true,
        },
        conversation: { text_only: true },
        tts: { voice_id: false, stability: false, speed: false, similarity_boost: false },
      },
    },
  },
};

console.log('   patch size:', JSON.stringify(patch).length, 'bytes');
console.log('   tool count:', TOOLS.length);

console.log('[4/5] registering tools globally + collecting ids');
// EL workspace tools are registered separately and referenced by id.
// First: list existing operator-* tools so we can update vs create.
const existingResp = await fetch('https://api.elevenlabs.io/v1/convai/tools', {
  headers: { 'xi-api-key': xiKey },
});
const existing = existingResp.ok ? (await existingResp.json()).tools ?? [] : [];
const byName = new Map(existing.map((t) => [t.tool_config?.name ?? t.name, t]));
console.log('   existing workspace tools:', existing.length);

const toolIds = [];
for (const tool of TOOLS) {
  const existingTool = byName.get(tool.name);
  const body = { tool_config: tool };
  let resp;
  if (existingTool) {
    const id = existingTool.id ?? existingTool.tool_id;
    resp = await fetch(`https://api.elevenlabs.io/v1/convai/tools/${id}`, {
      method: 'PATCH',
      headers: { 'xi-api-key': xiKey, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (resp.ok) {
      toolIds.push(id);
      console.log('   ✓ updated', tool.name, '→', id);
    } else {
      console.error('   ✗ update', tool.name, ':', resp.status, (await resp.text()).slice(0, 200));
    }
  } else {
    resp = await fetch('https://api.elevenlabs.io/v1/convai/tools', {
      method: 'POST',
      headers: { 'xi-api-key': xiKey, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (resp.ok) {
      const created = await resp.json();
      const id = created.id ?? created.tool_id;
      toolIds.push(id);
      console.log('   ✓ created', tool.name, '→', id);
    } else {
      console.error('   ✗ create', tool.name, ':', resp.status, (await resp.text()).slice(0, 200));
    }
  }
}

// Re-issue the PATCH with tool_ids instead of inline tools.
patch.conversation_config.agent.prompt.tool_ids = toolIds;
delete patch.conversation_config.agent.prompt.tools;

console.log('[5/5] PATCHing agent config (with', toolIds.length, 'tool ids)');
const pr = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${agentId}`, {
  method: 'PATCH',
  headers: { 'xi-api-key': xiKey, 'content-type': 'application/json' },
  body: JSON.stringify(patch),
});
if (!pr.ok) {
  console.error('   PATCH failed:', pr.status, await pr.text());
  process.exit(1);
}
const updated = await pr.json();
console.log('   ok — tool_ids attached:', (updated.conversation_config?.agent?.prompt?.tool_ids ?? []).length);
const ovrAfter = updated.platform_settings?.overrides?.conversation_config_override?.agent?.prompt;
console.log('   prompt-override allowed:', ovrAfter?.prompt);
console.log('done');
console.log('');
console.log('Next: enable the persona-drift audit by configuring the post-call');
console.log('webhook on the ElevenLabs dashboard:');
console.log('  Workspace → Settings → Webhooks → Post-call');
console.log('  URL: <your-public-url>/api/elevenlabs/post-call');
console.log('Without this, the weekly drift audit only sees legacy-path');
console.log('utterances, not the live EL Conv AI sessions.');
