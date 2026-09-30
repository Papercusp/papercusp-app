/**
 * Production dependencies for the Sentinel proactive sweep. The I/O boundary
 * that binds the pure sweep engine (sentinel-proactive-sweep.ts) to the real
 * operator infrastructure:
 *
 *   flagEnabled          → getFlag(FLAGS.PAPERCUP_PROACTIVE) (DEFAULT OFF)
 *   isSilenced           → voice prefs `silenceVoice` (the Sentinel DND lever)
 *   isPaused             → the global operator pause sentinel
 *   proactiveTicksEnabled→ voice prefs `proactiveTicksEnabled`
 *   overBudget           → checkBudget() (the converse-gate precondition)
 *   gatherFleetStatus    → gatherSentinelContext + renderSentinelContext (P-020)
 *   runSentinelScan      → a role:'sentinel' converse turn, trigger 'sentinel_scan'
 *   speakIntoSession     → synthesize() → WAV→PCM → broadcastOpVoice(OPV_RESPONSE_AUDIO)
 *   pushAttention        → notifyAttention (importance-gated, P-021)
 *   notifyHindsight      → notifyOperatorHindsight ("[While you were away]", P-021)
 *
 * Lazy imports keep the heavy legs (PG, EL synth, the converse brain) off the
 * voice-host module-load path until a sweep actually needs them; the common
 * flag-off tick only pays for the flag read. The engine itself is pure + unit-
 * tested with fakes, so this module stays declarative.
 */
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { dispatchProjectedToolStream, lookupByMcpName, type UnifiedToolContext } from '@papercusp/agent-mcp';
import '../agent-tools/index'; // register papercup:converse so lookupByMcpName resolves
import { activeWorkspaceId } from '../workspace-registry';
import { loadVoicePrefs } from '../voice-prefs';
import { isPaused } from '../device-operator-actions';
import { checkBudget } from '../operator-budget';
import { getOrCreateActiveConversation } from '../operator-conversations';
import { parseOperatorTurn } from '../operator-converse-tags';
import { synthesize } from '../endpoint-route/routes/agent-mcp/operator-tts';
import { encodeResponseAudio } from '../voice-node/operator-voice-bus';
import { decodeWavPcm16, resamplePcm16 } from '../voice-node/wav';
import {
  gatherSentinelContext,
  renderSentinelContext,
  buildSentinelContextDeps,
  sentinelScopeLabel,
} from './papercup-context';
import { isWorkspaceCoordinationOn } from '../workspace-brain-scope';
import type { SentinelSweepDeps, SentinelFleetStatus } from './papercup-proactive-sweep';

/** The EL input PCM rate the voice-session bus speaks (mirrors the EL `audio`
 *  fan-out in operator-voice-session.ts: format 'pcm_s16le' @ 16k). */
const SWEEP_PCM_RATE = 16000;

/**
 * Gather + render the FLEET-STATUS (P-020). Reuses gatherSentinelContext (the same
 * ready-made digests the papercup:converse persona reads) so the proactive surface
 * is FLEET-status — curation:feed + Overwatch anomalies + change-feed — NOT the old
 * operator workspace-suggestions flow. `salient` is the voice-OFF importance gate:
 * true iff a CRITICAL anomaly or an URGENT signal is present.
 */
export async function gatherFleetStatus(workspaceId: string, potSlug: string): Promise<SentinelFleetStatus> {
  const scopeLabel = sentinelScopeLabel(workspaceId, potSlug || workspaceId, await isWorkspaceCoordinationOn());
  const ctx = await gatherSentinelContext(buildSentinelContextDeps(workspaceId, potSlug), { potSlug: scopeLabel });
  const criticalAnomaly = (ctx.anomalies ?? []).find((a) => a.severity === 'critical') ?? null;
  const urgentSignal = (ctx.signals ?? []).find((s) => s.urgent || s.severity === 'blocker') ?? null;
  const salient = criticalAnomaly != null || urgentSignal != null;
  const headline = criticalAnomaly
    ? `${criticalAnomaly.subject}: ${criticalAnomaly.detail}`.trim()
    : urgentSignal
      ? urgentSignal.title
      : (ctx.headline ?? null);
  return { context: renderSentinelContext(ctx), salient, headline };
}

/**
 * Run a role:'sentinel' converse turn over the FLEET-STATUS context with trigger
 * 'sentinel_scan' (P-019). Returns the clean spoken `<say>` body, or null when the
 * Sentinel chose silence (empty/no <say>). Mirrors the verified in-process brain path
 * the voice host's `askOperator` uses (dispatchProjectedToolStream).
 */
export async function runSentinelScan(context: string): Promise<string | null> {
  const tool = lookupByMcpName('papercup:converse');
  if (!tool) throw new Error('papercup:converse tool not registered');

  const conversationId = (await getOrCreateActiveConversation().catch(() => null))?.id ?? undefined;
  // The FLEET-STATUS is the Sentinel's situational context; the trigger tells the
  // prompt to decide-to-speak over it (surface ONE thing or stay silent).
  const messages = [{ role: 'system' as const, content: context }];

  const ctxBase: UnifiedToolContext = {
    log: (msg) => console.log(`[sentinel-sweep][brain] ${msg}`),
    signal: AbortSignal.timeout(120_000),
    progress: () => {},
    emit: () => {},
    workspaceId: activeWorkspaceId(),
    role: 'papercup' as UnifiedToolContext['role'],
    runId: globalThis.crypto.randomUUID(),
    spawnId: globalThis.crypto.randomUUID(),
    transport: 'in_process',
    uiClientId: null,
  };

  let assembled = '';
  for await (const ev of dispatchProjectedToolStream(
    tool,
    'papercup:converse',
    { messages, trigger: 'sentinel_scan', modality: 'voice', conversationId, role: 'papercup' },
    ctxBase,
    {},
  )) {
    if (ev.kind === 'done') {
      try {
        const t = (ev.result.content[0] as { text?: string })?.text ?? '{}';
        assembled = (JSON.parse(t) as { assembled?: string }).assembled ?? '';
      } catch {
        /* leave assembled empty → silence */
      }
    } else if (ev.kind === 'error') {
      throw ev.error;
    }
  }

  const say = parseOperatorTurn(assembled).say?.trim();
  return say && say.length > 0 ? say : null;
}

/**
 * TTS `text` and push it out-of-band into the live voice session via
 * broadcastOpVoice → OPV_RESPONSE_AUDIO (P-019). Reuses the voiceAgentSay
 * synth→WAV→PCM pattern, only the SINK differs: the operator-voice bus
 * (every attached desktop/tui client renders it) instead of the P2P channel.
 * Returns true on a successful push. `broadcast` is supplied by the caller (the
 * local-audio-socket's broadcastOpVoice).
 */
export async function speakIntoSession(text: string, broadcast: (frame: Uint8Array) => void): Promise<boolean> {
  try {
    const prefs = await loadVoicePrefs();
    const engine = prefs.ttsEngine === 'browser' ? 'kokoro' : prefs.ttsEngine;
    const synth = await synthesize(engine, text, undefined, prefs, { container: 'wav' });
    if (!synth.ok || !synth.audio) return false;
    if (!(synth.contentType ?? '').includes('wav')) {
      console.error(`[sentinel-sweep] unsupported TTS content-type ${synth.contentType} for engine ${engine}`);
      return false;
    }
    const decoded = decodeWavPcm16(new Uint8Array(synth.audio));
    const pcm = resamplePcm16(decoded.samples, decoded.sampleRate, SWEEP_PCM_RATE);
    // One framed OPV_RESPONSE_AUDIO carrying the whole utterance (the bus already
    // chunks the EL audio fan-out the same way; clients buffer + render).
    broadcast(
      encodeResponseAudio({
        format: 'pcm_s16le',
        sampleRate: SWEEP_PCM_RATE,
        audio: new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength),
      }),
    );
    return true;
  } catch (err) {
    console.warn('[sentinel-sweep] speakIntoSession failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

/** Voice-OFF salient alert (P-021): the importance-gated attention push. Producers
 *  own the importance gate (notifyAttention does not re-gate); the sweep only calls
 *  this when status.salient is true, so the post is at ≥high by construction. */
export async function pushAttention(headline: string): Promise<void> {
  const { notifyAttention } = await import('../attention-notify');
  await notifyAttention({
    kind: 'needs-human',
    title: 'Sentinel',
    body: headline,
    importance: 'high',
    data: { source: 'sentinel-proactive-sweep' },
  }).catch(() => {});
}

/** Voice-OFF hindsight (P-021): the next-session "[While you were away]" note. */
export async function notifyHindsight(headline: string): Promise<void> {
  const { notifyOperatorHindsight } = await import('../operator-hindsight');
  await notifyOperatorHindsight(headline, 'sentinel-scan').catch(() => {});
}

/**
 * Build the production sweep dep set. `broadcast` is the local-audio-socket's
 * broadcastOpVoice (the same sink the voice host fans EL audio through).
 */
export function buildSentinelSweepDeps(broadcast: (frame: Uint8Array) => void): SentinelSweepDeps {
  const potSlug = ''; // workspace-default scope; the digests are workspace-wide.
  return {
    flagEnabled: () => getFlag(FLAGS.PAPERCUP_PROACTIVE, 'system'),
    isSilenced: async () => (await loadVoicePrefs().catch(() => null))?.silenceVoice ?? false,
    isPaused: () => isPaused().catch(() => false),
    proactiveTicksEnabled: async () => (await loadVoicePrefs().catch(() => null))?.proactiveTicksEnabled ?? true,
    overBudget: async () => {
      const b = await checkBudget().catch(() => null);
      return !!(b && b.state && b.exceeded);
    },
    gatherFleetStatus: () => gatherFleetStatus(activeWorkspaceId(), potSlug),
    runSentinelScan,
    speakIntoSession: (text) => speakIntoSession(text, broadcast),
    pushAttention,
    notifyHindsight,
    now: () => Date.now(),
    log: (msg, extra) => console.log(`[sentinel-sweep] ${msg}`, extra ?? ''),
  };
}
