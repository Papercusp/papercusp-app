/** Declarative identity context over registered cells (portable identities P-004).
 * Reuses step-program interpolation, but refuses missing paths instead of turning
 * an unavailable measurement into an empty string. The host supplies an authorized
 * cell reader: there is deliberately no fallback to the internal system reader.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { interpolate } from '@papercusp/step-program';
import type { CellRead } from '../cell-read';

const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const aliasSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/)
  .refine((value) => !forbidden.has(value));
const cellReferenceSchema = z.object({
  cell: z.string().min(1).max(120),
  subject: z.string().min(1).max(200).optional(),
}).strict();

export const IdentityStateTemplateSchema = z.object({
  template: z.string().min(1).max(32_768),
  cells: z.record(aliasSchema, cellReferenceSchema)
    .refine((cells) => Object.keys(cells).length > 0 && Object.keys(cells).length <= 32),
}).strict();
export type IdentityStateTemplate = z.infer<typeof IdentityStateTemplateSchema>;
export type IdentityTemplateCellReference = z.infer<typeof cellReferenceSchema>;
export type IdentityTemplateCellReader = (
  reference: IdentityTemplateCellReference, signal: AbortSignal,
) => Promise<CellRead>;

type ReadReceipt = {
  cell: string;
  subject?: string;
  status: CellRead['status'];
  unknownCode?: string;
};
type Omission = 'invalid-template' | 'unavailable' | 'cancelled' | 'deadline' | 'output-too-large';
export type IdentityStateTemplateResult =
  | { status: 'value'; text: string; contentHash: string; reads: ReadReceipt[] }
  | { status: 'omitted'; reason: Omission; reads: ReadReceipt[] };

/** Bounded work for ONE invocation; aggregate identity/sink budgets belong to the host.
 * No persistent cache: every invocation obtains fresh measurements. Identical cell
 * references are read once per invocation, even when several aliases use them.
 */
export async function evaluateIdentityStateTemplate(
  definition: unknown,
  options: {
    readCell: IdentityTemplateCellReader;
    signal: AbortSignal;
    timeoutMs: number;
    maxBytes: number;
  },
): Promise<IdentityStateTemplateResult> {
  const reads: ReadReceipt[] = [];
  const omit = (reason: Omission): IdentityStateTemplateResult => ({ status: 'omitted', reason, reads: [...reads] });
  const parsed = IdentityStateTemplateSchema.safeParse(definition);
  if (!parsed.success || !Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 10_000 ||
      !Number.isInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > 65_536) return omit('invalid-template');
  if (options.signal.aborted) return omit('cancelled');

  const { template, cells } = parsed.data;
  if (/\{\{\{|\}\}\}/.test(template)) return omit('invalid-template');
  const placeholders = [...template.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)];
  if (/\{\{|\}\}/.test(template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, ''))) return omit('invalid-template');
  for (const [, path] of placeholders) {
    if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/.test(path!) ||
        path!.split('.').some((part) => forbidden.has(part)) ||
        !Object.hasOwn(cells, path!.split('.')[0]!)) return omit('invalid-template');
  }
  // Unused declarations do not grant an opportunity to dispatch unrelated reads.
  const aliases = [...new Set(placeholders.map((match) => match[1]!.split('.')[0]!))];
  if (!aliases.length) return omit('invalid-template');

  const controller = new AbortController();
  let reason: 'cancelled' | 'deadline' = 'cancelled';
  let cancelled!: () => void;
  const stopped = new Promise<IdentityStateTemplateResult>((resolve) => {
    cancelled = () => {
      controller.abort();
      resolve(omit(reason));
    };
  });
  options.signal.addEventListener('abort', cancelled, { once: true });
  const timer = setTimeout(() => { reason = 'deadline'; cancelled(); }, options.timeoutMs);
  timer.unref?.();

  try {
    const work = async (): Promise<IdentityStateTemplateResult> => {
      const requests = new Map<string, IdentityTemplateCellReference>();
      const keyFor = (ref: IdentityTemplateCellReference) => JSON.stringify([ref.cell, ref.subject ?? null]);
      for (const alias of aliases) requests.set(keyFor(cells[alias]!), cells[alias]!);
      const entries = [...requests];
      const values = new Map<string, unknown>();
      let cursor = 0;
      let bytes = 0;
      let failure: Omission | undefined;
      await Promise.all(Array.from({ length: Math.min(4, entries.length) }, async () => {
        while (!controller.signal.aborted && !failure) {
          const entry = entries[cursor++];
          if (!entry) return;
          const [key, reference] = entry;
          let result: CellRead;
          try {
            result = await options.readCell(reference, controller.signal);
          } catch {
            result = { status: 'unknown', cell: reference.cell, unknown: { code: 'resolver-failed' } };
          }
          if (controller.signal.aborted) return;
          if (result.cell !== reference.cell) {
            result = { status: 'unknown', cell: reference.cell, unknown: { code: 'resolver-failed' } };
          }
          reads.push({ ...reference, status: result.status,
            ...(result.status === 'unknown' ? { unknownCode: result.unknown.code } : {}) });
          if (result.status !== 'value') { failure = 'unavailable'; return; }
          // Only JSON data enters the template scope. Resolver objects, functions,
          // prototypes and circular structures never become executable template inputs.
          try {
            const serialized = JSON.stringify(result.value, (_key, value: unknown) => {
              if (value === undefined || typeof value === 'function' || typeof value === 'symbol' ||
                  (typeof value === 'number' && !Number.isFinite(value))) throw new Error('non-JSON cell value');
              return value;
            });
            if (serialized === undefined) { failure = 'unavailable'; return; }
            bytes += Buffer.byteLength(serialized);
            if (bytes > options.maxBytes) { failure = 'output-too-large'; return; }
            values.set(key, JSON.parse(serialized));
          } catch { failure = 'unavailable'; return; }
        }
      }));
      if (controller.signal.aborted) return omit(reason);
      if (failure) return omit(failure);
      const scope = Object.fromEntries(aliases.map((alias) => [alias, values.get(keyFor(cells[alias]!))]));
      const replacements = new Map<string, string>();
      for (const [token, path] of placeholders) {
        let value: unknown = scope;
        for (const part of path!.split('.')) {
          if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) return omit('unavailable');
          value = (value as Record<string, unknown>)[part];
        }
        const interpolated = interpolate(token, scope);
        replacements.set(token, typeof interpolated === 'string' ? interpolated : JSON.stringify(interpolated));
      }
      // Bound expansion BEFORE allocating the joined output. Braces in a measured
      // value are literal data, never a second template.
      const chunks: string[] = [];
      let offset = 0;
      let outputBytes = 0;
      for (const match of placeholders) {
        const literal = template.slice(offset, match.index);
        const replacement = replacements.get(match[0])!;
        outputBytes += Buffer.byteLength(literal) + Buffer.byteLength(replacement);
        if (outputBytes > options.maxBytes) return omit('output-too-large');
        chunks.push(literal, replacement);
        offset = match.index! + match[0].length;
      }
      const tail = template.slice(offset);
      if (outputBytes + Buffer.byteLength(tail) > options.maxBytes) return omit('output-too-large');
      chunks.push(tail);
      const text = chunks.join('');
      return { status: 'value', text, contentHash: createHash('sha256').update(text).digest('hex'), reads: [...reads] };
    };
    return await Promise.race([work(), stopped]);
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', cancelled);
    controller.abort();
  }
}
