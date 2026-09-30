/**
 * Provider-safe tool-name codec at the ModelPort boundary.
 *
 * Papercusp keeps canonical projected-tool names (`capability:bash`) inside
 * the owned loop. Provider APIs accept a narrower function-name alphabet, so
 * adapters encode names on the wire and decode streamed calls back before the
 * loop, approval store, dispatcher, or UI sees them.
 */
import { createHash } from 'node:crypto';
import type { ModelToolDef } from './model-port';

const PROVIDER_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export function providerWireToolName(name: string): string {
  if (PROVIDER_TOOL_NAME_PATTERN.test(name)) return name;
  const readable = name
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 44) || 'tool';
  const digest = createHash('sha256').update(name).digest('hex').slice(0, 12);
  return `pc_${readable}_${digest}`;
}

export interface ModelToolNameCodec {
  encode(name: string): string;
  decode(name: string): string;
}

export function modelToolNameCodec(
  tools: readonly Pick<ModelToolDef, 'name'>[] | undefined,
): ModelToolNameCodec {
  const canonicalByWire = new Map<string, string>();
  for (const tool of tools ?? []) {
    canonicalByWire.set(providerWireToolName(tool.name), tool.name);
  }
  return {
    encode: providerWireToolName,
    decode: (name) => canonicalByWire.get(name) ?? name,
  };
}
