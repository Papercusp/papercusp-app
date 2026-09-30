/**
 * EL Conv AI agent voice configuration helpers.
 *
 * Used by both the legacy /api/agent-mcp/operator-conv-voice route and
 * the operator:conv_voice MCP tool so they agree on a single API.
 *
 * `setConvVoice` handles the "voice not yet in your library" case by
 * looking it up in the shared library and copying it to the account
 * before patching the agent (same dance el-agent-sync.mjs does).
 */

import { readElevenLabsKey } from './voice-credentials';
import { loadVoicePrefs } from './voice-prefs';

export interface ConvVoiceConfig {
  voiceId?: string;
  voiceName: string | null;
  modelId?: string;
  agentId: string;
}

export interface ConvVoiceErrorResult {
  ok: false;
  status: number;
  error: string;
}

export interface ConvVoiceReadResult extends ConvVoiceConfig {
  ok: true;
}

export interface ConvVoiceWriteResult {
  ok: true;
  voiceId: string;
  voiceName: string;
  modelId?: string;
}

async function ensureVoiceInLibrary(
  xiKey: string,
  voiceId: string,
): Promise<{ ok: true; name: string } | { ok: false; status: number; error: string }> {
  const have = await fetch(`https://api.elevenlabs.io/v1/voices/${voiceId}`, {
    headers: { 'xi-api-key': xiKey },
  });
  if (have.ok) {
    const v = await have.json();
    return { ok: true, name: v?.name ?? '(unnamed)' };
  }
  const shared = await fetch(
    `https://api.elevenlabs.io/v1/shared-voices?search=${encodeURIComponent(voiceId)}`,
    { headers: { 'xi-api-key': xiKey } },
  );
  if (!shared.ok) {
    return { ok: false, status: 404, error: `voice ${voiceId} not in library and shared-voices lookup failed (${shared.status})` };
  }
  const data = await shared.json();
  const hit = (data?.voices ?? []).find((v: { voice_id: string }) => v.voice_id === voiceId);
  if (!hit) {
    return {
      ok: false,
      status: 404,
      error: `voice ${voiceId} not in your library and not in the shared library — paste a valid voice_id from elevenlabs.io/app/voice-library`,
    };
  }
  const owner = hit.public_owner_id;
  const name = hit.name ?? 'Operator voice';
  const add = await fetch(`https://api.elevenlabs.io/v1/voices/add/${owner}/${voiceId}`, {
    method: 'POST',
    headers: { 'xi-api-key': xiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ new_name: name }),
  });
  if (!add.ok) {
    const body = await add.text().catch(() => '');
    return { ok: false, status: add.status, error: `couldn't add public voice: ${add.status} ${body.slice(0, 200)}` };
  }
  return { ok: true, name };
}

async function loadAgentContext(): Promise<
  { ok: true; xiKey: string; agentId: string }
  | { ok: false; status: number; error: string }
> {
  const xiKey = await readElevenLabsKey();
  if (!xiKey) return { ok: false, status: 400, error: 'no EL API key configured' };
  const prefs = await loadVoicePrefs();
  const agentId = prefs?.elevenLabsAgentId;
  if (!agentId) return { ok: false, status: 400, error: 'no EL agent id configured' };
  return { ok: true, xiKey, agentId };
}

export async function readConvVoice(): Promise<ConvVoiceReadResult | ConvVoiceErrorResult> {
  const ctx = await loadAgentContext();
  if (!ctx.ok) return ctx;
  const r = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${ctx.agentId}`, {
    headers: { 'xi-api-key': ctx.xiKey },
  });
  if (!r.ok) return { ok: false, status: r.status, error: `agent fetch ${r.status}` };
  const cfg = await r.json();
  const tts = cfg?.conversation_config?.tts ?? {};
  const voiceId = tts.voice_id;
  const modelId = tts.model_id;
  let voiceName: string | null = null;
  if (voiceId) {
    const v = await fetch(`https://api.elevenlabs.io/v1/voices/${voiceId}`, {
      headers: { 'xi-api-key': ctx.xiKey },
    });
    if (v.ok) voiceName = (await v.json())?.name ?? null;
  }
  return { ok: true, voiceId, voiceName, modelId, agentId: ctx.agentId };
}

export async function setConvVoice(input: {
  voiceId: string;
  modelId?: string;
}): Promise<ConvVoiceWriteResult | ConvVoiceErrorResult> {
  const ctx = await loadAgentContext();
  if (!ctx.ok) return ctx;
  const voiceId = input.voiceId.trim();
  if (!/^[A-Za-z0-9]{15,30}$/.test(voiceId)) {
    return { ok: false, status: 400, error: 'voiceId must be a 15-30 char alphanumeric ElevenLabs voice id' };
  }
  const modelId = input.modelId?.trim() || undefined;

  const ensure = await ensureVoiceInLibrary(ctx.xiKey, voiceId);
  if (!ensure.ok) return ensure;

  const ttsPatch: Record<string, unknown> = { voice_id: voiceId };
  if (modelId) ttsPatch.model_id = modelId;
  const patch = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${ctx.agentId}`, {
    method: 'PATCH',
    headers: { 'xi-api-key': ctx.xiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ conversation_config: { tts: ttsPatch } }),
  });
  if (!patch.ok) {
    const t = await patch.text().catch(() => '');
    return { ok: false, status: patch.status, error: `agent PATCH ${patch.status}: ${t.slice(0, 300)}` };
  }
  return { ok: true, voiceId, voiceName: ensure.name, modelId };
}
