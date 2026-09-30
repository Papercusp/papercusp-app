/**
 * voice.* — set voice mode / engine + read current prefs.
 *
 * Reflexive controls so the user can say "stop listening" / "switch to
 * always-on" without leaving the conversation.
 */
import { z } from 'zod';
import { register } from '../registry';
import type { CommandDef, QueryDef } from '../types';
import { loadVoiceControls } from '../voice-control-bridge';

function baseUrl(): string {
  if (typeof window !== 'undefined') return '';
  const port = process.env.PORT ?? process.env.NEXT_PUBLIC_PORT ?? '3155';
  return `http://127.0.0.1:${port}`;
}

const SetModeArgs = z.object({
  mode: z.enum(['off', 'push-to-talk', 'always-on']).describe('Voice mode.'),
});

const voiceSetMode: CommandDef<z.infer<typeof SetModeArgs>> = {
  id: 'voice.set-mode',
  kind: 'command',
  description: 'Change voice mode: off / push-to-talk / always-on.',
  promptDescription:
    'Use when the user says "stop listening" → mode:off, "go always on" → ' +
    'mode:always-on, etc. Takes effect immediately in this tab.',
  schema: SetModeArgs,
  agents: ['oracle', 'operator', 'palette', 'shortcut'],
  browser: 'required',
  concurrent: 'allow',
  tier: 'reflexive',
  handler: async ({ mode }) => {
    if (typeof window === 'undefined') throw new Error('voice.set-mode must run in browser');
    // Browser-only: voice.set-mode is browser:'required'. The concrete browser
    // voice engine lives in the UI app; core stays UI-free by reaching it
    // through the registered loader (see commands/voice-control-bridge.ts).
    const { setVoiceMode } = await loadVoiceControls();
    setVoiceMode(mode);
    return { mode };
  },
};

const PrefsArgs = z.object({});

const voicePrefs: QueryDef<z.infer<typeof PrefsArgs>> = {
  id: 'voice.prefs',
  kind: 'query',
  description: 'Read current voice prefs (mode, engines, wake word, output behavior).',
  promptDescription:
    'Returns the user\'s current voice settings — STT engine, TTS engine, full-agent ' +
    'engine, wake word config. Use to answer "what\'s my wake word" / "which engine ' +
    'am I on?"',
  schema: PrefsArgs,
  agents: ['oracle', 'operator'],
  audit: 'none',
  tier: 'fast-query',
  handler: async () => {
    const r = await fetch(`${baseUrl()}/api/agent-mcp/operator-voice-prefs`);
    if (!r.ok) throw new Error(`voice.prefs failed: HTTP ${r.status}`);
    return await r.json();
  },
};

register(voiceSetMode);
register(voicePrefs);
