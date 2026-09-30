/**
 * Voice utterance audit log writer.
 *
 * Used by the legacy route /api/agent-mcp/voice-utterance-log and the
 * MCP tool `operator:voice_utterance_log`. Append-only audit; degrades
 * silently when the table doesn't exist (best-effort).
 */

import { withWorkspace } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';

const ALLOWED_SOURCES = new Set(['legacy', 'elevenlabs-conv', 'realtime']);

export interface VoiceUtteranceLogInput {
  source?: string;
  mode?: string;
  lengthChars?: number;
  nameUsed?: boolean;
  hadBackstory?: boolean;
  modifications?: unknown[];
}

export interface VoiceUtteranceLogResult {
  ok: boolean;
  degraded?: boolean;
  error?: string;
  detail?: string;
}

export async function logVoiceUtterance(input: VoiceUtteranceLogInput): Promise<VoiceUtteranceLogResult> {
  const source = typeof input.source === 'string' && ALLOWED_SOURCES.has(input.source)
    ? input.source
    : 'legacy';
  const workspace = activeWorkspaceId();
  try {
    await withWorkspace(workspace, async (tx) => {
      await tx`
        INSERT INTO harness_shared.voice_utterances (
          workspace_id, source, mode, length_chars, name_used, had_backstory, modifications
        ) VALUES (
          ${workspace},
          ${source},
          ${typeof input.mode === 'string' ? input.mode : null},
          ${typeof input.lengthChars === 'number' ? input.lengthChars : null},
          ${input.nameUsed === true},
          ${input.hadBackstory === true},
          ${JSON.stringify(input.modifications ?? [])}::text::jsonb
        )
      `;
    });
  } catch (e: unknown) {
    const msg = (e as Error)?.message ?? String(e);
    if (/relation .*voice_utterances.* does not exist/i.test(msg)) {
      return { ok: true, degraded: true };
    }
    return { ok: false, error: 'db-error', detail: msg.slice(0, 200) };
  }
  return { ok: true };
}
