/**
 * End-to-end Noise channel for BYOC hosted-relay content.
 *
 * The control plane transports `ByocSealedPacket` values but never receives a
 * Noise key. `contentType` deliberately remains outside the sealed box: the
 * relay needs that one control-metadata field to enforce channel-kind and
 * controller/observer policy. The decrypted frame repeats the type and a
 * mismatch is terminal, so a relay cannot relabel ciphertext into another
 * allowlisted operation.
 */
import { timingSafeEqual } from 'node:crypto';
import SecretStream from '@hyperswarm/secret-stream';
import { Duplex } from 'node:stream';

export const BYOC_SEALED_PROTOCOL = 'papercusp-byoc-noise-xx.v1' as const;

export interface ByocSealedPacket {
  type: 'sealed.packet';
  protocol: typeof BYOC_SEALED_PROTOCOL;
  /** The application frame type; control metadata, never content. */
  contentType: string | null;
  /** One ordered fragment of the Noise XX + secretstream wire. */
  packet: string;
}

export interface ByocSealedChannelOptions {
  initiator: boolean;
  localKeyPair: { publicKey: Buffer; secretKey: Buffer };
  expectedRemotePublicKey: Buffer;
  sendPacket: (packet: ByocSealedPacket) => void;
  onFrame: (frame: Record<string, unknown>) => void;
  onError?: (error: Error) => void;
}

function canonicalKey(value: Buffer, name: string): Buffer {
  if (!Buffer.isBuffer(value) || value.length !== 32) {
    throw new Error(`${name} must be a 32-byte Noise public key`);
  }
  return Buffer.from(value);
}

function frameType(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && type.length > 0 ? type : null;
}

function decodePacket(value: string): Buffer {
  if (typeof value !== 'string' || value.length === 0) throw new Error('sealed packet must be base64');
  const packet = Buffer.from(value, 'base64');
  if (packet.length === 0 || packet.toString('base64') !== value) {
    throw new Error('sealed packet must be canonical base64');
  }
  return packet;
}

/** Raw byte transport underneath SecretStream, projected onto relay packets. */
class RelayPacketDuplex extends Duplex {
  contentType: string | null = null;

  constructor(private readonly emitPacket: (packet: Buffer, contentType: string | null) => void) {
    super();
  }

  override _read(_size: number): void {}

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try {
      this.emitPacket(Buffer.from(chunk), this.contentType);
      callback(null);
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  receive(packet: Buffer): void {
    if (!this.destroyed) this.push(packet);
  }
}

/**
 * A pinned-static-key Noise XX session over ordered hosted-relay packets.
 *
 * Callers must serialize `send` calls (the method does this internally). Noise
 * handshake fragments use `contentType:null`; application fragments carry the
 * clear type solely for relay policy. `opened` rejects a key mismatch before
 * any application frame is delivered.
 */
export class ByocSealedChannel {
  readonly opened: Promise<void>;
  private readonly raw: RelayPacketDuplex;
  private readonly noise: InstanceType<typeof SecretStream>;
  private readonly expectedRemotePublicKey: Buffer;
  private pendingType: string | null = null;
  private sendChain: Promise<void> = Promise.resolve();
  private receiveBuffer = '';
  private closed = false;

  constructor(private readonly options: ByocSealedChannelOptions) {
    this.expectedRemotePublicKey = canonicalKey(options.expectedRemotePublicKey, 'expected remote public key');
    canonicalKey(options.localKeyPair.publicKey, 'local public key');
    if (!Buffer.isBuffer(options.localKeyPair.secretKey) || options.localKeyPair.secretKey.length !== 64) {
      throw new Error('local Noise secret key must be 64 bytes');
    }
    this.raw = new RelayPacketDuplex((packet, contentType) => {
      options.sendPacket({
        type: 'sealed.packet',
        protocol: BYOC_SEALED_PROTOCOL,
        contentType,
        packet: packet.toString('base64'),
      });
    });
    this.noise = new SecretStream(options.initiator, this.raw, {
      keyPair: options.localKeyPair,
      remotePublicKey: this.expectedRemotePublicKey,
    });
    this.noise.on('data', (data: Buffer) => this.acceptPlaintext(data));
    this.noise.on('error', (error: Error) => this.fail(error));
    this.raw.on('error', (error: Error) => this.fail(error));
    this.opened = this.noise.opened.then((ok) => {
      if (!ok || !this.noise.remotePublicKey ||
          !timingSafeEqual(Buffer.from(this.noise.remotePublicKey), this.expectedRemotePublicKey)) {
        throw new Error('BYOC sealed channel remote key mismatch');
      }
    });
  }

  /** Encrypt one JSON frame. Newline framing is inside the ciphertext. */
  send(frame: Record<string, unknown>): Promise<void> {
    const type = frameType(frame);
    if (!type) return Promise.reject(new Error('sealed frame requires a non-empty type'));
    const task = this.sendChain.then(async () => {
      await this.opened;
      if (this.closed) throw new Error('BYOC sealed channel is closed');
      this.pendingType = type;
      this.raw.contentType = type;
      try {
        this.noise.write(Buffer.from(JSON.stringify(frame) + '\n'));
        await this.noise.flush();
      } finally {
        this.raw.contentType = null;
        this.pendingType = null;
      }
    });
    this.sendChain = task.catch(() => {});
    return task;
  }

  /** Feed one packet received from the untrusted control-plane relay. */
  receive(value: ByocSealedPacket): void {
    if (this.closed || value.type !== 'sealed.packet' || value.protocol !== BYOC_SEALED_PROTOCOL) return;
    if (value.contentType !== null && (typeof value.contentType !== 'string' || value.contentType.length === 0)) {
      this.fail(new Error('sealed packet content type is invalid'));
      return;
    }
    this.pendingType = value.contentType;
    try {
      this.raw.receive(decodePacket(value.packet));
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.noise.destroy();
    this.raw.destroy();
  }

  private acceptPlaintext(data: Buffer): void {
    this.receiveBuffer += data.toString('utf8');
    while (true) {
      const newline = this.receiveBuffer.indexOf('\n');
      if (newline < 0) return;
      const raw = this.receiveBuffer.slice(0, newline);
      this.receiveBuffer = this.receiveBuffer.slice(newline + 1);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        this.fail(new Error('sealed channel produced invalid JSON'));
        return;
      }
      const decryptedType = frameType(parsed);
      if (!decryptedType || (this.pendingType !== null && decryptedType !== this.pendingType)) {
        this.fail(new Error('sealed channel content type mismatch'));
        return;
      }
      this.options.onFrame(parsed as Record<string, unknown>);
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.options.onError?.(error);
    this.noise.destroy(error);
    this.raw.destroy(error);
  }
}

export function isByocSealedPacket(value: unknown): value is ByocSealedPacket {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const packet = value as Partial<ByocSealedPacket>;
  return packet.type === 'sealed.packet' && packet.protocol === BYOC_SEALED_PROTOCOL &&
    (packet.contentType === null || typeof packet.contentType === 'string') && typeof packet.packet === 'string';
}

/** The policy-visible type without decrypting content. */
export function byocSealedContentType(value: unknown): string | null {
  return isByocSealedPacket(value) && typeof value.contentType === 'string' ? value.contentType : null;
}
