/**
 * Recover the target-argument record carried through `tools:invoke`.
 *
 * Some MCP clients serialize that one nested boundary before transport, and
 * deeply nested payloads have been observed with more than one encoding layer.
 * Keep this decoder shared by the transport's reserved-argument forwarders and
 * the tool's schema preprocessing so both stages interpret the same wire shape.
 * Only the wrapper value is decoded; strings inside the target args are never
 * inspected.
 */
export function decodeToolsInvokeArgs(value: unknown): unknown {
  let current = value;
  for (let i = 0; i < 5 && typeof current === 'string'; i += 1) {
    try {
      current = JSON.parse(current);
    } catch {
      break;
    }
  }
  return current;
}
