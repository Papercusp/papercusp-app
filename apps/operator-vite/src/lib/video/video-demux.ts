/**
 * Per-peer video demux — plan holepunch-video-shared-harnesses-2026-06-05 (P-005).
 *
 * Video is NOT mixed (D-001): each peer renders to its own tile. The demux owns
 * one decoder per peer, lazily created on the peer's first VID frame and torn
 * down when the peer leaves the channel (freeing the decoder's GPU memory).
 * Decoder creation is injected, so this is pure + unit-tested; the browser wires
 * createPeerDecoder (WebCodecs) as the factory.
 */
import { parseVidFrame } from './desktop-video-protocol';
import type { EncodedVideoFrame } from './video-codec';

export interface DemuxDecoder {
  decode(frame: EncodedVideoFrame): void;
  reset?(): void;
  close(): void;
}

export class VideoDemux {
  private decoders = new Map<string, DemuxDecoder>();

  constructor(private readonly createDecoder: (peerId: string) => DemuxDecoder) {}

  /**
   * Route one inbound VID frame payload to its peer's decoder, creating the
   * decoder on first sight. Returns the sender peer id, or null if malformed.
   */
  onVid(payload: Uint8Array): string | null {
    const parsed = parseVidFrame(payload);
    if (!parsed) return null;
    let dec = this.decoders.get(parsed.peerId);
    if (!dec) {
      dec = this.createDecoder(parsed.peerId);
      this.decoders.set(parsed.peerId, dec);
    }
    dec.decode(parsed.frame);
    return parsed.peerId;
  }

  /** Drop decoders for peers no longer present (call on a peer-roster change). */
  syncPeers(activeIds: Iterable<string>): void {
    const active = new Set(activeIds);
    for (const [id, dec] of [...this.decoders]) {
      if (!active.has(id)) {
        this.safeClose(dec);
        this.decoders.delete(id);
      }
    }
  }

  removePeer(peerId: string): void {
    const dec = this.decoders.get(peerId);
    if (dec) {
      this.safeClose(dec);
      this.decoders.delete(peerId);
    }
  }

  /** Peers we currently hold a decoder for (i.e. have received video from). */
  peers(): string[] {
    return [...this.decoders.keys()];
  }

  has(peerId: string): boolean {
    return this.decoders.has(peerId);
  }

  close(): void {
    for (const dec of this.decoders.values()) this.safeClose(dec);
    this.decoders.clear();
  }

  private safeClose(dec: DemuxDecoder): void {
    try {
      dec.close();
    } catch {
      /* already closed */
    }
  }
}
