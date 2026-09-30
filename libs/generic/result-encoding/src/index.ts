/**
 * @papercusp/result-encoding — token-efficient serialization for structured
 * tool results.
 *
 * Three concerns, one domain-free package:
 *   1. **encode/decode** (`encode.ts`) — render a JSON value as JSON / TOON /
 *      CSV / TSV / markdown-table, with a lossless-to-JSON guarantee for TOON.
 *   2. **eligibility** (`eligibility.ts`) — a static walk of a `data`-node
 *      JSON-Schema → the set of formats that shape can be safely rendered in.
 *   3. **format vocabulary + negotiation parsing** (`formats.ts`).
 *
 * The host (a tool framework) ties these together: compute the capability set
 * once at registration from a tool's output schema, then on each call pick a
 * format (server default or client-negotiated), intersect with the capability
 * set, and `encode`. Nothing here knows about MCP, HTTP, or Papercusp.
 */

export {
  type ResultFormat,
  type FormatRequest,
  RESULT_FORMATS,
  COMPACT_FORMATS,
  isResultFormat,
  parseFormatRequest,
  mimeForFormat,
  ResultEncodeError,
} from './formats';

export { encode, decode, encodeAuto, encodeToonChecked, isFlatObjectArray, isObjectWithArrayField, TOON_VERIFY_MAX_BYTES } from './encode';

export {
  type EligibilityResult,
  analyzeSchema,
  bestCompactFormat,
} from './eligibility';

export { encodeDelimited, decodeDelimited, encodeMarkdownTable, cellToString, quoteField, parseRows } from './csv';

export {
  type ColumnType,
  type ColumnSpec,
  type ColumnOverride,
  type ReconstructResult,
  projectReadColumns,
  projectWriteColumns,
  applyColumnOverrides,
  encodePositionalRows,
  positionalRowSchema,
  reconstructArgs,
} from './positional';

export { advertisedArgsSchema } from './advertise';

export {
  type PrePromptEntry,
  type ReadEncoding,
  type WriteEncoding,
  configurePrePromptRegistry,
  clearPrePromptRegistry,
  getPrePromptEntry,
  listPrePromptEntries,
  readPrePromptFormat,
  isPositionalReadEncoding,
  isWritePositional,
} from './registry';

export { type ToolColumnSource, type ColumnsLookup, renderWireSchemas } from './legend';
