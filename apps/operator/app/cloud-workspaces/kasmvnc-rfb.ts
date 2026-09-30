/**
 * kasmvnc-rfb.ts — stock noVNC, speaking KasmVNC's PointerEvent (owner #442, WI-10002860).
 *
 * KasmVNC changed the RFB PointerEvent message and kept its message type (5). The
 * standard message is 6 bytes: type, U8 button mask, U16 x, U16 y. KasmVNC reads 11:
 * type, U16 mask, U16 x, U16 y, S16 scrollX, S16 scrollY (`common/rfb/SMsgReader.cxx`
 * `readPointerEvent` — identical at v1.3.0, v1.3.3, v1.4.0 and master). Its own client
 * is a noVNC fork that sends the 11-byte form; stock `@novnc/novnc` sends the 6-byte one.
 *
 * Fed a 6-byte event, KasmVNC reads five bytes of the NEXT message as the rest of this
 * one, so the stream is misaligned from the first mouse move on. It soon meets a byte that
 * is not a message type, throws `unknown message type` and drops the socket. Measured on
 * a hosted desktop (2026-09-24): Take control closed ~110ms after the first pointer input
 * (host->KasmVNC 1006, relay 4000 `desktop_socket_closed_1006`). Watch never sends pointer
 * input, which is the only reason it survived.
 *
 * Every other client message stock noVNC sends has the same layout on both sides, so this
 * is the one override. It is a SUBCLASS rather than a patch of the shared `RFB.messages`
 * table because `FrameVncView` speaks to x11vnc, which needs the standard 6-byte form.
 */
import type NoVncRfb from "@novnc/novnc";

type RfbClass = typeof NoVncRfb;

/** KasmVNC's PointerEvent length on the wire, message-type byte included. */
export const KASMVNC_POINTER_EVENT_BYTES = 11;

/**
 * The noVNC internals `_sendMouse` reads. Not public API, so the real class is exercised
 * against this shape in kasmvnc-rfb.test.ts: a noVNC upgrade that renames any of them
 * fails there instead of silently reverting takeover to the 6-byte form.
 */
interface NoVncMouseInternals {
  _rfbConnectionState: string;
  _viewOnly: boolean;
  _sock: { sQpushBytes(bytes: Uint8Array): void; flush(): void };
  _display: { absX(x: number): number; absY(y: number): number };
}

function clampU16(value: number): number {
  return Math.min(0xffff, Math.max(0, Math.round(value)));
}

/** Encode one PointerEvent exactly as KasmVNC's `SMsgReader::readPointerEvent` reads it. */
export function encodeKasmvncPointerEvent(input: {
  x: number;
  y: number;
  mask: number;
  scrollX?: number;
  scrollY?: number;
}): Uint8Array {
  // Same guard as noVNC's own `_sendMouse`: the top bit is never a button.
  if (input.mask & 0x8000) {
    throw new Error(`kasmvnc-rfb — illegal mouse button mask ${input.mask}`);
  }
  const bytes = new Uint8Array(KASMVNC_POINTER_EVENT_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, 5);
  view.setUint16(1, input.mask);
  view.setUint16(3, clampU16(input.x));
  view.setUint16(5, clampU16(input.y));
  view.setInt16(7, input.scrollX ?? 0);
  view.setInt16(9, input.scrollY ?? 0);
  return bytes;
}

const subclasses = new WeakMap<RfbClass, RfbClass>();

/**
 * `Base` with every pointer event sent in KasmVNC's 11-byte form.
 *
 * Throws when `Base` has no `_sendMouse`: a noVNC that routed pointer input elsewhere would
 * otherwise leave this override dead and every takeover dropping on its first mouse move,
 * with nothing on screen to say why.
 */
export function kasmvncRfbClass(Base: RfbClass): RfbClass {
  const cached = subclasses.get(Base);
  if (cached) return cached;
  const baseSendMouse = (Base.prototype as unknown as Record<string, unknown>)
    ._sendMouse;
  if (typeof baseSendMouse !== "function") {
    throw new Error(
      "kasmvnc-rfb — @novnc/novnc has no RFB.prototype._sendMouse to override, so pointer " +
        "input would go out in the 6-byte form KasmVNC drops the connection on",
    );
  }
  class KasmvncRfb extends Base {
    _sendMouse(x: number, y: number, mask: number): void {
      const self = this as unknown as NoVncMouseInternals;
      if (self._rfbConnectionState !== "connected") return;
      if (self._viewOnly) return;
      self._sock.sQpushBytes(
        encodeKasmvncPointerEvent({
          x: self._display.absX(x),
          y: self._display.absY(y),
          mask,
        }),
      );
      self._sock.flush();
    }
  }
  subclasses.set(Base, KasmvncRfb);
  return KasmvncRfb;
}
