/**
 * Pure dispatch logic for mobile voice transcripts. Extracted from
 * `device-voice-ws.ts` so it's testable without spinning up a real WS
 * server. The WS layer is just a transport — this is the brain.
 *
 * Wire: phone sends `{kind:'transcript', text, wakeWord?}` → bridge calls
 * `dispatchTranscript(claims, text, wakeWord, send)` which emits frames
 * via `send` (one per logical step).
 */
import { stripWakeWordAndPrefix } from './wake-word';
import { parseOperatorIntent, resolveApprove } from './voice-intents';
import { parseVoiceCommand } from './voice-commands';
import { readCandidates, refreshCandidates } from './operator-standing-candidates';
import { appendPreferenceEntry } from './operator-preferences';
import { touchLastSeen } from './device-store';
import { setPaused, setResumed } from './device-operator-actions';
import { fireLaunchBlueprint } from './blueprint/launch-blueprint';
import { activeWorkspaceId } from './workspace-registry';
import type { DeviceClaims } from './device-jwt';
import { operatorHomeHarnessSlug } from './harness/operator-home-harness';

/**
 * Outgoing frame shape. The phone interprets `source` for attribution
 * UI and `agentId` for per-agent labeling. `format` lets a future
 * server-side TTS path emit SSML; phone v1 strips tags.
 */
export type FrameSource = 'operator' | 'oracle' | 'agent' | 'system';

export interface OutgoingFrame {
  kind: 'speak' | 'status';
  text?: string;
  source?: FrameSource;
  agentId?: string;
  format?: 'plain' | 'ssml';
  status?: string;
  detail?: string;
}

export type SendFrame = (f: OutgoingFrame) => void;

const SELF_BASE_DEFAULT = 'http://localhost:3055';
const selfBase = () => process.env.MOBILE_SELF_BASE ?? SELF_BASE_DEFAULT;

export async function dispatchTranscript(
  claims: DeviceClaims,
  rawText: string,
  wakeWord: string,
  send: SendFrame,
): Promise<void> {
  // Touch last_seen on every transcript — best signal that the device is alive.
  touchLastSeen(claims.sub, claims.workspace_id).catch(() => { /* non-fatal */ });

  const trimmed = rawText.trim();
  if (!trimmed) return;

  const wake = stripWakeWordAndPrefix(trimmed, wakeWord);
  const utterance = wake.matched ? wake.dispatchText : trimmed;

  const intent = parseOperatorIntent(utterance);
  if (intent) return dispatchIntent(intent, send);

  const cmd = parseVoiceCommand(trimmed);
  return dispatchCommand(cmd, send);
}

export async function dispatchIntent(
  intent: NonNullable<ReturnType<typeof parseOperatorIntent>>,
  send: SendFrame,
): Promise<void> {
  switch (intent.kind) {
    case 'scan':
      await runOperatorScan(intent.query ?? '', send);
      return;
    case 'approve':
      await runStandingApprove(intent, send);
      return;
  }
}

export async function dispatchCommand(
  cmd: ReturnType<typeof parseVoiceCommand>,
  send: SendFrame,
): Promise<void> {
  switch (cmd.kind) {
    case 'cancel':
      send({ kind: 'speak', text: 'Cancelled.', source: 'operator' });
      return;
    case 'pause':
      await setPaused('mobile-voice');
      send({ kind: 'speak', text: 'Papercup paused.', source: 'operator' });
      return;
    case 'resume':
      await setResumed();
      send({ kind: 'speak', text: 'Papercup resumed.', source: 'operator' });
      return;
    case 'scan':
      await runOperatorScan(cmd.query ?? '', send);
      return;
    case 'freeform':
      send({ kind: 'status', status: 'thinking' });
      try {
        const text = await oracleAsk(cmd.text);
        send({ kind: 'speak', text, source: 'oracle' });
      } catch (e) {
        send({
          kind: 'speak',
          text: `Oracle failed: ${e instanceof Error ? e.message : String(e)}.`,
          source: 'oracle',
        });
      } finally {
        send({ kind: 'status', status: 'idle' });
      }
      return;
  }
}

export async function runStandingApprove(
  intent: { kind: 'approve'; targetSlug: string; capability?: string },
  send: SendFrame,
): Promise<void> {
  const candidates = await refreshCandidates().catch(() => readCandidates());
  const resolution = resolveApprove(intent, candidates);
  switch (resolution.action) {
    case 'refuse-no-match':
      send({ kind: 'speak', text: `No pending standing-approval for ${resolution.targetSlug}.`, source: 'operator' });
      return;
    case 'refuse-complex-cap':
      send({ kind: 'speak', text: 'That capability has a complex name; please approve in settings.', source: 'operator' });
      return;
    case 'refuse-ambiguous':
      // `options` is `?:` on VoiceIntentResolution (voice-intents.ts) — the resolver always sets
      // it for this action, but the single-interface type can't prove that; default to [] safely.
      send({ kind: 'speak', text: `Multiple matches for ${resolution.targetSlug}: ${(resolution.options ?? []).join(', ')}. Specify one.`, source: 'operator' });
      return;
    case 'approve': {
      const today = new Date().toISOString().slice(0, 10);
      const entry = `- [OPERATOR-PROPOSED-USER-CONFIRMED-${today}] [STANDING-APPROVE]\n  capability=${resolution.capability}, target=${resolution.targetSlug}\n  pattern: ≥3 silent dispatches in 24h\n  user confirmed: ${new Date().toISOString()}`;
      await appendPreferenceEntry(entry);
      await refreshCandidates().catch(() => {});
      send({ kind: 'speak', text: `Approved standing for ${resolution.capability} on ${resolution.targetSlug}.`, source: 'operator' });
      return;
    }
  }
}

/** Mirrors seed-scan-routine.ts: the workspace the scan blueprint sweeps. */
const SCAN_SLUG = process.env.SCAN_ROUTINE_SLUG ?? operatorHomeHarnessSlug();

export async function runOperatorScan(query: string, send: SendFrame): Promise<void> {
  // D-005 (unify-agent-launches): a voice scan fires the `scan` launch
  // blueprint — same launch the cadence routine uses. Findings land as
  // work_items in the self-improvement backlog, not panel cards.
  send({ kind: 'status', status: 'scanning' });
  try {
    await fireLaunchBlueprint('scan', {
      installSlug: SCAN_SLUG,
      workspaceId: activeWorkspaceId(),
      kickoff: query
        ? `Voice-requested workspace scan: ${query}. Capture each finding via improvements:capture.`
        : 'Voice-requested workspace scan. Capture each finding via improvements:capture.',
      timeoutMs: 900_000,
    });
    send({ kind: 'speak', text: 'Started a workspace scan. Findings will land in the improvements backlog.', source: 'operator' });
  } catch (e) {
    send({
      kind: 'speak',
      text: `Scan dispatch failed: ${e instanceof Error ? e.message : String(e)}.`,
      source: 'operator',
    });
  } finally {
    send({ kind: 'status', status: 'idle' });
  }
}

/** Single-turn Oracle query. Concatenates streamed `delta` text into one string. */
export async function oracleAsk(question: string): Promise<string> {
  const res = await fetch(new URL('/api/oracle/chat', selfBase()), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: question }] }),
  });
  if (!res.ok || !res.body) throw new Error(`oracle HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let answer = '';
  let currentEvent = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nlnl: number;
    while ((nlnl = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, nlnl);
      buf = buf.slice(nlnl + 2);
      currentEvent = '';
      let dataLine = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) currentEvent = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLine = line.slice(5).trim();
      }
      if (currentEvent === 'delta' && dataLine) {
        try {
          const obj = JSON.parse(dataLine) as { text?: string };
          if (obj.text) answer += obj.text;
        } catch { /* malformed; ignore */ }
      } else if (currentEvent === 'done') {
        return answer.trim() || '(no response)';
      } else if (currentEvent === 'error' && dataLine) {
        try {
          const obj = JSON.parse(dataLine) as { message?: string };
          throw new Error(obj.message ?? 'oracle error');
        } catch (e) { throw e instanceof Error ? e : new Error(String(e)); }
      }
    }
  }
  return answer.trim() || '(no response)';
}
