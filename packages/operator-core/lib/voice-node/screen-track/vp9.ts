/**
 * VP9 keyframe detection from the uncompressed frame header
 * (`hive-frame-desktops-live-view-2026-06-06` P-012).
 *
 * The IVF container carries no keyframe flag, but the video-channel wire
 * (`encodeVideoPayload({ key })`) needs one — the receiving KeyframeGate drops
 * deltas until a keyframe. The VP9 bitstream's first bits tell us:
 *
 *   frame_marker        2 bits  (must be 0b10)
 *   profile_low_bit     1 bit
 *   profile_high_bit    1 bit
 *   [reserved_zero      1 bit — only when profile == 3]
 *   show_existing_frame 1 bit   (1 = repeat of a stored frame — never a key)
 *   frame_type          1 bit   (0 = KEY_FRAME)
 *
 * (VP9 Bitstream & Decoding Process Specification §6.2 — uncompressed header.)
 */
export function vp9IsKeyframe(data: Uint8Array): boolean {
  if (data.length === 0) return false;
  const b = data[0];
  let pos = 0;
  const bit = () => (b >> (7 - pos++)) & 1;
  const frameMarker = (bit() << 1) | bit();
  if (frameMarker !== 0b10) return false; // not a VP9 frame header
  const profile = (bit() << 1) | bit(); // high bit first? — see note below
  // Spec order is profile_low_bit THEN profile_high_bit; we read two bits
  // either way, but profile==3 (both set) is what gates the reserved bit, and
  // that's order-independent.
  if (profile === 3) pos += 1; // reserved_zero
  const showExisting = bit();
  if (showExisting === 1) return false;
  const frameType = bit();
  return frameType === 0; // 0 = KEY_FRAME
}
