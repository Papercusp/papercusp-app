/**
 * Voice agent BRAIN (holepunch-voice-channels-2026-06-05 P-011, D-007).
 *
 * The remaining P-011 slice: close the loop between the agent-peer's ears and
 * mouth with the operator brain in the middle —
 *
 *   onTranscript(peer utterance) → operator:converse turn → parseOperatorTurn
 *   → <say> text → voiceAgentSay() (TTS → the agent's own channel track).
 *
 * The agent IS the local operator node speaking as a peer (not an SFU bot): it
 * listens to the decoded channel mix (agent-peer STT), thinks with the same
 * `operator:converse` brain that powers text + EL voice (one brain, D-007), and
 * speaks its `<say>` back into the channel.
 *
 * Seams (`BrainSeams`) make the loop unit-testable without spawning a real brain
 * subprocess: `converse` (messages → say|null), `say` (text → frames), and
 * `onTranscript` (subscribe) are all injectable; the defaults wire the real
 * operator:converse tool + the agent-peer.
 *
 * Turns are SERIALIZED — one converse+speak in flight at a time; transcripts
 * that arrive mid-turn are dropped (not queued) so a backlog can't pile up while
 * the brain thinks. A rolling in-memory history (capped) gives conversational
 * context without a persisted conversation for v1.
 */
import {
  dispatchProjectedToolStream,
  lookupByMcpName,
  type UnifiedToolContext,
} from '@papercusp/agent-mcp';
import { parseOperatorTurn } from '../operator-converse-tags';
import { activeWorkspaceId } from '../workspace-registry';
import { enableVoiceAgent, onTranscript, voiceAgentSay, type VoiceTranscript } from './agent-peer';
import { setVoiceAgentSpeaking } from './manager';

export interface ConverseMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface BrainSeams {
  /** Run one operator-converse turn for the given history; resolve the <say> text (or null to stay silent). */
  converse: (messages: ConverseMessage[]) => Promise<string | null>;
  /** Speak text into the active channel; resolves the number of frames spoken. */
  say: (text: string) => Promise<number>;
  /** Subscribe to peer transcripts; returns an unsubscribe fn. */
  onTranscript: (cb: (t: VoiceTranscript) => void) => () => void;
}

const HISTORY_CAP = 20; // user+assistant turns kept for context

let brainEnabled = false;
let busy = false;
let speaking = false;
let unsub: (() => void) | null = null;
const history: ConverseMessage[] = [];

export function voiceAgentBrainEnabled(): boolean {
  return brainEnabled;
}

/** True while the agent is actively speaking a reply into the channel. */
export function voiceAgentSpeaking(): boolean {
  return speaking;
}

/**
 * Enable/disable the brain. Enabling also turns the agent's ears on (you can't
 * converse without listening). `seams` is for tests — production omits it.
 */
export function enableVoiceAgentBrain(on: boolean, seams: BrainSeams = defaultSeams): void {
  if (on === brainEnabled) return;
  brainEnabled = on;
  if (on) {
    enableVoiceAgent(true); // ears on
    unsub = seams.onTranscript((t) => {
      void handleTranscript(t, seams);
    });
  } else {
    unsub?.();
    unsub = null;
    busy = false;
    speaking = false;
    history.length = 0;
  }
}

function trimHistory(): void {
  if (history.length > HISTORY_CAP) history.splice(0, history.length - HISTORY_CAP);
}

async function handleTranscript(t: VoiceTranscript, seams: BrainSeams): Promise<void> {
  if (!brainEnabled || busy || !t.text.trim()) return;
  busy = true; // serialize: one turn in flight; drop transcripts meanwhile
  try {
    const userMsg: ConverseMessage = { role: 'user', content: t.text };
    const say = await seams.converse([...history, userMsg]);
    if (!brainEnabled) return; // disabled mid-turn
    if (say && say.trim()) {
      // Commit the exchange as a user+assistant PAIR so history stays strictly
      // alternating; a silent turn (no say) records neither side, so a dangling
      // user turn can never accumulate and break the next turn's alternation.
      history.push(userMsg, { role: 'assistant', content: say });
      trimHistory();
      speaking = true;
      setVoiceAgentSpeaking(true); // broadcast to voice clients (pui indicator)
      try {
        await seams.say(say);
      } finally {
        speaking = false;
        setVoiceAgentSpeaking(false);
      }
    }
  } catch (err) {
    console.error('[voice-agent-brain] turn failed:', err instanceof Error ? err.message : err);
  } finally {
    busy = false;
  }
}

/**
 * Default `converse` seam: run the real `operator:converse` tool in-process
 * (the same dispatch the device/EL routes use) and return its `<say>`.
 */
async function runConverseTurn(messages: ConverseMessage[]): Promise<string | null> {
  const tool = lookupByMcpName('operator:converse');
  if (!tool) throw new Error('voice-agent-brain: operator:converse tool not registered');
  const ctrl = new AbortController();
  const ctx: UnifiedToolContext = {
    log: (msg) => {
      console.log(`[voice-agent-brain][tool] ${msg}`);
    },
    signal: ctrl.signal,
    progress: () => {},
    emit: () => {
      /* installed by dispatchProjectedToolStream */
    },
    workspaceId: activeWorkspaceId(),
    role: 'operator',
    runId: globalThis.crypto.randomUUID(),
    spawnId: globalThis.crypto.randomUUID(),
    transport: 'in_process',
    uiClientId: null,
  };
  let assembled = '';
  for await (const ev of dispatchProjectedToolStream(
    tool,
    'operator:converse',
    { messages, trigger: 'user_message', modality: 'voice', surface: 'tui' },
    ctx,
    {},
  )) {
    if (ev.kind === 'done') {
      try {
        const text = (ev.result.content[0] as { text?: string })?.text ?? '{}';
        assembled = (JSON.parse(text) as { assembled?: string }).assembled ?? '';
      } catch {
        /* leave assembled empty → no say */
      }
    } else if (ev.kind === 'error') {
      throw ev.error;
    }
  }
  return parseOperatorTurn(assembled).say;
}

const defaultSeams: BrainSeams = {
  converse: runConverseTurn,
  say: voiceAgentSay,
  onTranscript,
};

/** Test-only: reset module state between cases. */
export function __resetVoiceAgentBrainForTest(): void {
  brainEnabled = false;
  busy = false;
  speaking = false;
  unsub?.();
  unsub = null;
  history.length = 0;
}
