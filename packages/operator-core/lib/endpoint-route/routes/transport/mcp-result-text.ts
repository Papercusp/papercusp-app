/** Parse the compact text representation emitted by MCP tool results. */
import { decode, type ResultFormat } from '@papercusp/result-encoding';

export function parseMcpToolText(text: string): unknown {
  const marker = /^format: (\w+)\n/.exec(text);
  if (!marker) return JSON.parse(text);
  return decode(text.slice(marker[0].length), marker[1] as ResultFormat);
}
