declare const Buffer: { from(input: Uint8Array | string, enc?: string): { toString(enc: string): string } };

export function b64uEncode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  const b64 =
    typeof btoa === 'function'
      ? btoa(bin)
      : Buffer.from(bytes).toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64uDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const buf = Buffer.from(b64, 'base64') as unknown as Uint8Array;
  return new Uint8Array(buf);
}

export function b64uEncodeString(s: string): string {
  return b64uEncode(new TextEncoder().encode(s));
}

export function b64uDecodeString(s: string): string {
  return new TextDecoder().decode(b64uDecode(s));
}
