/**
 * Compact JSON-Schema projection — the middle detail tier between shipping a
 * tool's FULL definition and not advertising it at all.
 *
 * WHY THIS EXISTS. Tool delivery used to be binary: a tool was either advertised
 * with its complete schema and guidance prose, or it was invisible. That forced
 * choice is what made a seed list a zero-sum fight — admitting one heavy tool
 * meant dropping another — and it is why high-demand heavyweights get cut.
 * A COMPACT tier removes the false choice: a compact definition still lets a
 * model form a VALID call, at a fraction of the bytes.
 *
 * THE CONTRACT, and it is the whole point: compact is NEVER A PARTIAL CONTRACT.
 * Everything a caller needs to construct an accepted argument object survives —
 * property names, types, the required set, enum members, numeric and length
 * bounds, oneOf/anyOf/allOf discriminators, nested object/array shape, and
 * $defs/$ref structure. What is dropped is PROSE ONLY: `description`, `title`,
 * `examples`/`example`, and `default`.
 *
 * ⚠ `$defs`/`$ref` STRUCTURE IS PRESERVED, NOT INLINED. `$defs` is precisely
 * what keeps a duplicated sub-schema from being paid for once per use site, so
 * inlining it would inflate exactly the budget this projection exists to cut.
 * (`schema-ref-inline.ts` in the host inlines in the OPPOSITE direction, for
 * human-facing discovery renderers where a reader cannot follow a $ref — that
 * is a different job with a different cost model. Do not reuse it here.)
 *
 * ⚠ `default` IS DROPPED AND THAT IS A DELIBERATE, NARROW BET. A default is
 * advisory to the CALLER but authoritative in the SERVER, which applies it
 * whether or not the caller ever saw it — so removing it cannot change what an
 * omitted field resolves to. It can only change what a model GUESSES an omitted
 * field will do. Anything load-bearing enough that a caller must see it belongs
 * in the required set or an enum, both of which survive.
 *
 * Domain-free by construction, and therefore here rather than in the host:
 * nothing below knows what a Papercusp tool, workspace or role is.
 */

import { summaryGuidanceDescription } from './partial-guidance';

const UTF8_ENCODER = new TextEncoder();

/**
 * Keys removed by compaction. Every one is PROSE OR ADVISORY — none of them
 * constrains whether an argument object validates.
 *
 * Deliberately NOT here, because each one does constrain validity: `required`,
 * `enum`, `const`, `type`, `properties`, `items`, `prefixItems`,
 * `additionalProperties`, `minimum`, `maximum`, `exclusiveMinimum`,
 * `exclusiveMaximum`, `multipleOf`, `minLength`, `maxLength`, `pattern`,
 * `format`, `minItems`, `maxItems`, `uniqueItems`, `minProperties`,
 * `maxProperties`, `oneOf`, `anyOf`, `allOf`, `not`, `if`/`then`/`else`,
 * `discriminator`, `$ref`, `$defs`, `definitions`, `nullable`.
 */
export const COMPACT_DROPPED_KEYS: readonly string[] = Object.freeze([
  'description',
  'title',
  'examples',
  'example',
  'default',
]);

const DROPPED = new Set<string>(COMPACT_DROPPED_KEYS);

/**
 * Schema keywords whose VALUE is a map of arbitrary, author-chosen names to
 * subschemas. A property literally named `description` or `default` is a
 * PROPERTY NAME, not a prose keyword, and must survive — dropping it would
 * silently remove a real argument from the contract, which is the one failure
 * mode that turns a compact definition into a partial one.
 */
const NAME_KEYED_CONTAINERS = new Set<string>([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
]);

function compactNode(node: unknown, inNameKeyedMap: boolean): unknown {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((entry) => compactNode(entry, false));

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    // Inside `properties` (etc.) every key is an author-chosen NAME. Keep it
    // verbatim and compact its subschema; never test it against DROPPED.
    if (inNameKeyedMap) {
      out[key] = compactNode(value, false);
      continue;
    }
    if (DROPPED.has(key)) continue;
    out[key] = compactNode(value, NAME_KEYED_CONTAINERS.has(key));
  }
  return out;
}

/**
 * Project a JSON Schema onto its compact form: same contract, prose removed.
 *
 * Pure and total — it never throws on a malformed schema, because it is used on
 * a measurement path where a single bad tool must not take down the whole
 * catalog reading. A non-object input is returned unchanged.
 */
export function compactInputSchema(schema: unknown): unknown {
  return compactNode(schema, false);
}

/** Exact UTF-8 byte length of a value's JSON serialization (0 when undefined). */
function jsonBytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? 0 : UTF8_ENCODER.encode(serialized).byteLength;
}

/** What one tool costs on the wire at each detail tier. */
export interface CompactWireBytes {
  /** Bytes for the full advertised definition (name + description + schema). */
  full: number;
  /** Bytes for the compact definition: schema compacted, description dropped. */
  compact: number;
  /** `full - compact` — the bytes compaction actually returns. */
  saved: number;
}

/**
 * Measure one tool at both tiers, using the SAME serialization shape the full
 * instrument uses so the two numbers are directly comparable.
 *
 * ⚠ This is a REGRESSION signal, not a byte-exact replica of the live endpoint:
 * it measures the in-repo projection, which skips the server's late
 * entity-enum/sanitize passes. Compare in-repo readings to in-repo readings.
 */
export function compactWireBytes(
  name: string,
  tool: { description?: string; inputSchema?: unknown },
): CompactWireBytes {
  const full = jsonBytes({
    name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema ?? {},
  });
  const compact = jsonBytes({
    name,
    // P-010: COMPACT ships a SUMMARY, not silence. This measurement and
    // `applyCompactTier` MUST stay in lockstep — if delivery ships prose that
    // measurement priced at zero, `spentBytes` becomes a fiction and the whole
    // budget is unenforceable.
    description: summaryGuidanceDescription(tool.description),
    inputSchema: compactInputSchema(tool.inputSchema ?? {}),
  });
  return { full, compact, saved: full - compact };
}
