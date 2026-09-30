/**
 * Voice transcript LOG (offsite-planner demo, BRIEFS.md B12).
 *
 * A passive, bounded ring of recent peer-utterance transcripts that an agent
 * (the rehearsed narrator "Papercup") can READ to react to spoken input —
 * WITHOUT the converse BRAIN (agent-brain.ts). The brain auto-replies, which
 * would have the narrator conversing autonomously; the demo's HONESTY RULES say
 * the narrator drives only the camera + the human-UX kickoff, never the workers,
 * so it must observe speech, not be driven by it. This module is the observe
 * seam: it just buffers transcripts for a poller to read.
 *
 * The agent-peer already produces transcript events (`onTranscript`); the brain
 * is one consumer that DROPS transcripts while it thinks. This is a second,
 * independent consumer that buffers EVERY transcript with a monotonic `seq`, so
 * a reader can ask "everything since seq N" (the coord-watermark delta pattern)
 * and react without missing utterances — or grab "the most recent N" for a
 * quick glance.
 *
 * Enabling turns the ears on (`enableVoiceAgent`) so STT actually runs — you
 * can't transcribe without listening. Disabling stops buffering + clears the
 * ring but leaves the shared ears AS-IS: the ears are a refcount-free shared
 * resource owned by `voice:agent` (enable/disable) and the brain, and yanking
 * them here could cut a concurrent consumer off. To fully stop listening, use
 * `voice:agent {op:'disable'}`.
 *
 * Seams (`TranscriptLogSeams`) make the module unit-testable without a real
 * voice channel — the defaults wire the real agent-peer.
 */
import { enableVoiceAgent, onTranscript, type VoiceTranscript } from './agent-peer';

export interface CapturedTranscript extends VoiceTranscript {
  /** Monotonic per-process sequence (never resets except in tests) — the read cursor. */
  seq: number;
}

export interface TranscriptLogSeams {
  /** Subscribe to peer transcripts; returns an unsubscribe fn. */
  onTranscript: (cb: (t: VoiceTranscript) => void) => () => void;
  /** Turn the agent's ears (STT) on/off. Default = the real agent-peer. */
  setEars: (on: boolean) => void;
}

/** Bounded memory: keep the most-recent RING_CAP utterances; evict the oldest. */
const RING_CAP = 200;

let enabled = false;
let unsub: (() => void) | null = null;
let seq = 0;
let dropped = 0; // utterances evicted from the front (lets a reader detect loss)
const ring: CapturedTranscript[] = [];

const defaultSeams: TranscriptLogSeams = { onTranscript, setEars: enableVoiceAgent };

export function transcriptCaptureEnabled(): boolean {
  return enabled;
}

/**
 * Enable/disable transcript buffering. Enabling also turns the ears on (you
 * can't transcribe without listening). `seams` is for tests — production omits it.
 */
export function enableTranscriptCapture(on: boolean, seams: TranscriptLogSeams = defaultSeams): void {
  if (on === enabled) return;
  enabled = on;
  if (on) {
    seams.setEars(true); // ears on — STT must run for transcripts to flow
    unsub = seams.onTranscript(capture);
  } else {
    unsub?.();
    unsub = null;
    ring.length = 0; // drop the buffer; leave the shared ears as-is (voice:agent owns those)
  }
}

function capture(t: VoiceTranscript): void {
  ring.push({ ...t, seq: ++seq });
  while (ring.length > RING_CAP) {
    ring.shift();
    dropped++;
  }
}

export interface TranscriptReadResult {
  entries: CapturedTranscript[];
  /** Highest seq the reader has now seen — pass back as `since` on the next read (monotonic). */
  cursor: number;
  /** True if utterances were skipped before this batch (eviction, or `limit` truncation). */
  lossy: boolean;
}

/**
 * Read buffered transcripts. `since` returns only utterances with seq > since
 * (the delta read; omit for everything retained). `limit` keeps the most-recent
 * N of the match (and flags `lossy` if it dropped older ones). The returned
 * `cursor` is monotonic — never moves backwards even if `since` is stale.
 */
export function readTranscripts(opts: { since?: number; limit?: number } = {}): TranscriptReadResult {
  const since = opts.since ?? 0;
  let entries = ring.filter((e) => e.seq > since);
  const oldestRetained = ring.length ? ring[0]!.seq : seq + 1;
  // Eviction loss: the reader asked for everything after `since`, but the
  // oldest we still hold is newer than since+1 → seqs in (since, oldest) are gone.
  let lossy = since > 0 && entries.length > 0 && oldestRetained > since + 1;
  if (opts.limit && opts.limit > 0 && entries.length > opts.limit) {
    entries = entries.slice(entries.length - opts.limit); // most-recent N
    lossy = true; // truncation skipped older matched entries
  }
  const cursor = Math.max(since, entries.length ? entries[entries.length - 1]!.seq : seq);
  return { entries, cursor, lossy };
}

export interface TranscriptLogState {
  enabled: boolean;
  /** Highest seq assigned so far (0 if nothing captured this process). */
  headSeq: number;
  /** Utterances currently buffered. */
  buffered: number;
  /** Utterances evicted from the ring over this process's lifetime. */
  dropped: number;
  capacity: number;
}

export function transcriptLogState(): TranscriptLogState {
  return { enabled, headSeq: seq, buffered: ring.length, dropped, capacity: RING_CAP };
}

/** Test-only: reset module state between cases. */
export function __resetTranscriptLogForTest(): void {
  unsub?.();
  unsub = null;
  enabled = false;
  seq = 0;
  dropped = 0;
  ring.length = 0;
}
