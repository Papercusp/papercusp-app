/**
 * OpenAI Realtime — full-agent engine.
 *
 * One WebRTC connection that handles STT + LLM + TTS + turn-taking +
 * interruption + tool calling. Replaces the entire `voice-mode.ts`
 * pipeline (STT engine + intent parser + TTS engine) with a single
 * conversational session.
 *
 * Intents — operator open / scan / approve / across-workspaces — become
 * function tools the model invokes naturally. No regex matching, no
 * wake-word listener, no leader election (single connection per tab;
 * leader still gates which tab opens the session).
 *
 * Pricing (May 2026): ~$0.06/min audio in + ~$0.24/min audio out.
 * Cap-trip lives in stt-spend / tts-spend infrastructure.
 */

import { RealtimeAgent, RealtimeSession, tool } from '@openai/agents-realtime';
import { OPERATOR_PERSONA_PROMPT, OPERATOR_FEW_SHOTS } from '../operator-persona';
import { OPERATOR_CONVERSE_PROMPT } from '../operator-converse-prompt';
import { readOperatorModeFromSession } from '../operator-converse-tags';

export interface RealtimeEngineCallbacks {
  onTranscript?: (text: string) => void;
  onAssistantText?: (text: string) => void;
  onError?: (err: Error) => void;
}

export interface RealtimeEngineHandle {
  /** Tear down the session. Idempotent. */
  stop(): Promise<void>;
  /** Inject a system message mid-session (e.g. context update). */
  sendSystem(text: string): void;
}

// Tool-routing instructions are static; persona + converse prompts are
// built per-session via buildInstructions() so we can read the current
// operator mode from sessionStorage at session-start time.
const TOOL_ROUTING = [
  '## Tool routing',
  '',
  'You have two kinds of tools:',
  '',
  '  REFLEXIVE — UI actions you can execute instantly. Panel toggles, navigation, scan, approve, across-workspaces summary. Call these directly when the user\'s intent maps cleanly. Don\'t narrate.',
  '',
  '  IMPORTANT: ALWAYS call the tool when the user asks for an action — even if you think you already did it. The user can change UI state manually (close the panel by clicking the X, navigate away with the back button, etc.) without you knowing. Your conversation memory is NOT the source of truth for UI state. Tool calls are idempotent — calling panel_open when already open is harmless. Calling panel_state first to check is also fine. NEVER respond "it\'s already open" or "you\'re already there" from memory; call the tool and act on the result.',
  '',
  '  EXTENDED WORK — for anything beyond reflexive UI: research, multi-step work, asking another agent, or workspace investigation, use ask_operator when available or tell the user the request needs the operator panel/full agent session. The old delegate_to_claude/delegate_to_agent tools are retired.',
  '',
  'When in doubt, do not guess. You are the low-latency voice front-end; route substantive work to the operator brain/panel instead of inventing an answer.',
  '',
  'The user may say a wake word ("hey operator") followed by a command — strip the wake word and act on the command.',
].join('\n');

/** Build the realtime agent's instructions for the current session.
 *  When the operator is in active mode, the converse prompt is layered
 *  in so the voice agent runs the continuous turn-taking loop with the
 *  same <say>/<set_mode>/<sleep> tag contract the text path uses.
 *  Passive mode keeps persona + tool routing only — operator only
 *  responds when spoken to.
 *
 *  `language` param pins the agent's reply language at the
 *  instruction layer — closes the EL audit's gap for the Realtime path
 *  (the EL Conv path uses a separate per-session override; Realtime
 *  doesn't have an equivalent override field on RealtimeSession at the
 *  SDK level we use, so we anchor it in the prompt instead). Default 'en'.
 */
function buildInstructions(language: string = 'en'): string {
  const operatorMode = readOperatorModeFromSession() ?? 'active';
  const conversePrompt = operatorMode === 'active' ? OPERATOR_CONVERSE_PROMPT : '';
  const langBlock = language
    ? `## Language\n\nRespond ONLY in language code "${language}" (BCP-47). If the STT layer mis-transcribes ambient noise as a non-${language} phrase, treat it as noise and stay silent rather than reply in the mis-detected language. NEVER switch languages mid-session even if background audio sounds like a different language.`
    : '';
  return [
    OPERATOR_PERSONA_PROMPT,
    conversePrompt,
    langBlock,
    TOOL_ROUTING,
    OPERATOR_FEW_SHOTS,
  ]
    .filter((s) => s && s.trim().length)
    .join('\n\n---\n\n');
}

export async function startRealtimeSession(
  apiKey: string,
  callbacks: RealtimeEngineCallbacks = {},
): Promise<RealtimeEngineHandle> {
  const registryTools = await buildRegistryTools();
  // Pin the agent's reply language. Same default ('en') as the EL Conv
  // AI path; same VoicePrefs.agentLanguage field; same failure mode
  // (background audio mis-detected as non-English flips the response).
  // Realtime SDK doesn't expose a session-level transcription.language
  // we can write to via @openai/agents-realtime's current surface, so
  // we anchor the constraint in the system prompt instead.
  let agentLanguage = 'en';
  try {
    const r = await fetch('/api/agent-mcp/operator-voice-prefs');
    if (r.ok) {
      const p = await r.json() as { agentLanguage?: string };
      if (typeof p?.agentLanguage === 'string') {
        agentLanguage = p.agentLanguage.trim() || 'en';
      }
    }
  } catch { /* keep default 'en' */ }
  const agent = new RealtimeAgent({
    name: 'Operator',
    instructions: buildInstructions(agentLanguage),
    tools: registryTools,
  });

  const session = new RealtimeSession(agent);

  // Wire transcripts so the panel UI can show what's being heard.
  session.on('history_updated', (history) => {
    const last = history[history.length - 1];
    if (!last) return;
    if (last.type === 'message' && last.role === 'user') {
      const txt = (last.content ?? [])
        .map((c: any) => c?.transcript ?? c?.text ?? '')
        .join(' ')
        .trim();
      if (txt) callbacks.onTranscript?.(txt);
    } else if (last.type === 'message' && last.role === 'assistant') {
      const txt = (last.content ?? [])
        .map((c: any) => c?.transcript ?? c?.text ?? '')
        .join(' ')
        .trim();
      if (txt) callbacks.onAssistantText?.(txt);
    }
  });

  session.on('error', (err) => {
    callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
  });

  await session.connect({ apiKey });

  return {
    async stop(): Promise<void> {
      try { await session.close(); } catch { /* ignore */ }
    },
    sendSystem(text: string): void {
      try { session.sendMessage(text); } catch { /* ignore */ }
    },
  };
}

/**
 * Build the registry-derived tool list for the OpenAI Realtime SDK.
 * Mirrors the ElevenLabs shim — emits browser:'required' commands and
 * fast queries as in-page tools the agent can call. Keeps the registry
 * as the single source of truth across both providers.
 *
 * Reuses the legacy callback names where there's overlap (open_operator,
 * scan, approve, across_workspaces) — those four predate the registry
 * and the existing system prompt mentions them by name. Registry tools
 * are added on top with their dotted ids (panel.open, panel.close, etc.).
 */
async function buildRegistryTools() {
  const { list } = await import('../commands/registry');
  const { runCommand, runQuery } = await import('../commands/registry');
  const { z: zod } = await import('zod');
  // Side-effect import: registers all defs.
  await import('../commands/defs');

  const tools: Array<ReturnType<typeof tool>> = [];
  const commands = list({ kind: 'command', agent: 'operator', browser: ['required'] });
  for (const def of commands) {
    tools.push(
      tool({
        name: def.id.replace(/\./g, '_'),
        description: def.promptDescription ?? def.description,
        parameters: def.schema as any,
        execute: async (params: any) => {
          const ctx = makeBrowserCtx();
          const result = await runCommand(def.id, params, ctx);
          return result;
        },
      }),
    );
  }
  const queries = list({ kind: 'query', agent: 'operator' });
  for (const def of queries) {
    tools.push(
      tool({
        name: def.id.replace(/\./g, '_'),
        description: def.promptDescription ?? def.description,
        parameters: def.schema as any,
        execute: async (params: any) => {
          const ctx = makeBrowserCtx();
          const result = await runQuery(def.id, params, ctx);
          return result;
        },
      }),
    );
  }
  // Suppress unused-var warning on zod import — kept for future inline schemas.
  void zod;
  return tools;
}

function makeBrowserCtx() {
  return {
    agent: 'operator' as const,
    workspace: typeof window === 'undefined'
      ? 'default'
      : (new URL(window.location.href).searchParams.get('ws') ?? 'default'),
    sessionId: typeof window === 'undefined'
      ? undefined
      : window.sessionStorage.getItem('pc-voice-tab-id') ?? undefined,
    requestId: `or-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  };
}

/**
 * Connection test for /settings/voice. Hits the OpenAI sessions endpoint
 * to mint an ephemeral key — confirms the API key is valid + has Realtime
 * access without holding open a WebRTC connection.
 */
export async function testRealtimeConnection(apiKey: string): Promise<
  | { ok: true }
  | { ok: false; error: string }
> {
  try {
    const r = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'OpenAI-Beta': 'realtime=v1',
      },
      body: JSON.stringify({ model: 'gpt-4o-realtime-preview' }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) {
      const body = await r.text();
      return { ok: false, error: `HTTP ${r.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
