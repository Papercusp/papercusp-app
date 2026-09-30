/** Shared output boundary for synchronous capability-class providers (P004).
 * The host supplies the exact pinned class schema and provenance. This helper
 * does not execute, cache or inject: the host must still apply its invocation,
 * attachment-generation and cancellation fence before consuming a value.
 */
import { z } from 'zod';
import { compileJsonSchema } from '../json-schema-validation';
import { labelExternalContent } from '../external-content';

const provenanceSchema = z.object({
  author: z.string().min(1).max(200),
  identityRef: z.string().min(1).max(240),
  providerRef: z.string().min(1).max(240),
  classRef: z.string().min(1).max(240),
}).strict();
export type IdentityProviderProvenance = z.infer<typeof provenanceSchema>;

export type IdentityProviderOutput = {
  status: 'value';
  value: unknown;
  /** A JSON data envelope: provider content cannot overwrite its outer provenance. */
  text: string;
  bytes: number;
} | {
  status: 'omitted';
  reason: 'invalid-options' | 'output-too-large' | 'invalid-json' | 'invalid-schema' | 'schema-mismatch';
};

/** Accept serialized JSON from the existing tool/worker transport, rather than
 * invoking getters/toJSON on a plugin-owned object. Check UTF-8 size BEFORE
 * parsing or validating, and count the complete provenance envelope as output.
 */
export function validateIdentityProviderOutput(input: {
  json: string;
  outputSchema: Record<string, unknown>;
  provenance: IdentityProviderProvenance;
  maxBytes: number;
}): IdentityProviderOutput {
  const omit = (reason: Extract<IdentityProviderOutput, { status: 'omitted' }>['reason']): IdentityProviderOutput =>
    ({ status: 'omitted', reason });
  const provenance = provenanceSchema.safeParse(input.provenance);
  if (!provenance.success || !Number.isInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > 65_536 ||
      typeof input.json !== 'string' || !input.outputSchema || typeof input.outputSchema !== 'object' ||
      Array.isArray(input.outputSchema)) return omit('invalid-options');
  if (Buffer.byteLength(input.json, 'utf8') > input.maxBytes) return omit('output-too-large');
  let value: unknown;
  try {
    value = JSON.parse(input.json, (_key, entry: unknown) => {
      // JSON's number grammar admits exponents outside the JS finite range;
      // stringify would otherwise change an accepted Infinity into null.
      if (typeof entry === 'number' && !Number.isFinite(entry)) throw new Error('non-finite JSON number');
      return entry;
    });
  }
  catch { return omit('invalid-json'); }
  try {
    const validate = compileJsonSchema(input.outputSchema);
    // Async schemas cannot turn a truthy Promise into an accepted value or
    // start unbounded work on a synchronous injection path.
    if ('$async' in validate && validate.$async) return omit('invalid-schema');
    if (!validate(value)) return omit('schema-mismatch');
  } catch { return omit('invalid-schema'); }
  const text = JSON.stringify({
    external: labelExternalContent({ kind: 'tool_result', tool: provenance.data.providerRef }),
    provenance: provenance.data,
    value,
  });
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > input.maxBytes) return omit('output-too-large');
  return { status: 'value', value, text, bytes };
}
