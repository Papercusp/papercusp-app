/**
 * Declarative display contract for datatype_registry rows (work-on-everything
 * P-024 / D-005). Renderers consume this data; registry entries never carry
 * executable UI code.
 */
import { z } from 'zod';

export const DATATYPE_DISPLAY_WIDGETS = [
  'text',
  'textarea',
  'markdown',
  'number',
  'toggle',
  'select',
  'tags',
  'date',
  'list',
  'record',
  'ref-picker',
] as const;

export type DatatypeDisplayWidget = (typeof DATATYPE_DISPLAY_WIDGETS)[number];

export const DATATYPE_REF_PICKER_REGISTRY = {
  plan: {
    searchTool: 'plans:list',
    idFields: ['harness', 'slug'],
    labelField: 'title',
    valueShape: 'plan:<harness>/<slug>',
  },
  goal: {
    searchTool: 'goals:list',
    idFields: ['id'],
    labelField: 'title',
    valueShape: '<id>',
  },
  'work-item': {
    searchTool: 'work_items:list',
    idFields: ['id'],
    labelField: 'title',
    valueShape: '<id>',
  },
  harness: {
    searchTool: 'harness:list',
    idFields: ['slug'],
    labelField: 'name',
    valueShape: '<slug>',
  },
  datatype: {
    searchTool: 'datatypes:list',
    idFields: ['id'],
    labelField: 'title',
    valueShape: '<id>',
  },
} as const;

export type DatatypeRefKind = keyof typeof DATATYPE_REF_PICKER_REGISTRY;

const shortText = z.string().max(500);
const datatypeRefSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-z][a-z0-9-]*$/, 'datatype refs must be kebab slugs');

export const datatypeSummaryTemplateSchema = z
  .string()
  .min(1)
  .max(500)
  .superRefine((template, ctx) => {
    const remainder = template.replace(/\{\{\s*[A-Za-z_$][A-Za-z0-9_$-]*(?:\.[A-Za-z0-9_$-]+)*\s*\}\}/g, '');
    if (remainder.includes('{{') || remainder.includes('}}')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'summary placeholders must use {{field.path}} syntax',
      });
    }
  });

const textParams = z
  .object({ placeholder: shortText.optional(), minLength: z.number().int().nonnegative().optional(), maxLength: z.number().int().positive().optional() })
  .strict();
const textareaParams = textParams.extend({ rows: z.number().int().min(2).max(40).optional() }).strict();
const numberParams = z
  .object({ min: z.number().optional(), max: z.number().optional(), step: z.number().positive().optional(), unit: z.string().max(40).optional() })
  .strict();
const toggleParams = z.object({ trueLabel: z.string().max(80).optional(), falseLabel: z.string().max(80).optional() }).strict();
const selectParams = z
  .object({
    options: z.array(z.object({ value: z.union([z.string(), z.number(), z.boolean()]), label: z.string().min(1).max(160) }).strict()).min(1).max(200),
  })
  .strict();
const tagsParams = z
  .object({ suggestions: z.array(z.string().max(160)).max(200).optional(), allowCustom: z.boolean().optional(), maxItems: z.number().int().positive().optional() })
  .strict();
const dateParams = z.object({ includeTime: z.boolean().optional(), min: z.string().optional(), max: z.string().optional() }).strict();
const listParams = z
  .object({ itemDatatype: datatypeRefSchema.optional(), minItems: z.number().int().nonnegative().optional(), maxItems: z.number().int().positive().optional() })
  .strict();
const recordParams = z
  .object({
    fields: z
      .array(
        z
          .object({
            name: z.string().min(1).max(120),
            datatype: datatypeRefSchema,
            label: z.string().min(1).max(160).optional(),
            description: z.string().max(500).optional(),
            required: z.boolean().optional(),
          })
          .strict(),
      )
      .max(100)
      .optional(),
  })
  .strict();
const refPickerParams = z.object({ kind: z.enum(Object.keys(DATATYPE_REF_PICKER_REGISTRY) as [DatatypeRefKind, ...DatatypeRefKind[]]) }).strict();

const displayVariant = <W extends DatatypeDisplayWidget, S extends z.ZodTypeAny>(widget: W, params: S) =>
  z.object({ widget: z.literal(widget), params: params.optional(), summary: datatypeSummaryTemplateSchema }).strict();

export const datatypeDisplaySchema = z.discriminatedUnion('widget', [
  displayVariant('text', textParams),
  displayVariant('textarea', textareaParams),
  displayVariant('markdown', textareaParams),
  displayVariant('number', numberParams),
  displayVariant('toggle', toggleParams),
  displayVariant('select', selectParams),
  displayVariant('tags', tagsParams),
  displayVariant('date', dateParams),
  displayVariant('list', listParams),
  displayVariant('record', recordParams),
  displayVariant('ref-picker', refPickerParams),
]);

export type DatatypeDisplaySpec = z.infer<typeof datatypeDisplaySchema>;

export function parseDatatypeDisplay(input: unknown):
  | { ok: true; value: DatatypeDisplaySpec }
  | { ok: false; issues: string[] } {
  const parsed = datatypeDisplaySchema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'display'}: ${issue.message}`),
  };
}

function stringField(row: Record<string, unknown>, ...names: string[]): string | null {
  for (const name of names) {
    const value = row[name];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/** Serialize a picker result through the ONE kind registry. Plans always use D-004's qualified form. */
export function serializeDatatypeReference(kind: DatatypeRefKind, row: Record<string, unknown>): string | null {
  switch (kind) {
    case 'plan': {
      const harness = stringField(row, 'harness', 'harnessSlug', 'harness_slug');
      const slug = stringField(row, 'slug');
      return harness && slug ? `plan:${harness}/${slug}` : null;
    }
    case 'goal':
    case 'work-item':
      return stringField(row, 'id');
    case 'harness':
      return stringField(row, 'slug');
    case 'datatype':
      return stringField(row, 'id');
  }
}

function resolvePath(root: unknown, path: string): unknown {
  let value = root;
  for (const part of path.split('.')) {
    if (value == null || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function compactValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Safe interpolation shared by cards and agent-facing property-delta lines. */
export function renderDatatypeSummary(display: Pick<DatatypeDisplaySpec, 'summary'>, value: unknown): string {
  const context =
    value != null && typeof value === 'object' && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>), value }
      : { value, ...(Array.isArray(value) ? { length: value.length } : {}) };
  return display.summary.replace(/\{\{\s*([A-Za-z_$][A-Za-z0-9_$-]*(?:\.[A-Za-z0-9_$-]+)*)\s*\}\}/g, (_match, path: string) =>
    compactValue(resolvePath(context, path)),
  );
}

export const BUILTIN_DATATYPE_SPECS = [
  { id: 'string', title: 'String', payloadSchema: { type: 'string' }, display: { widget: 'text', summary: '{{value}}' } },
  { id: 'number', title: 'Number', payloadSchema: { type: 'number' }, display: { widget: 'number', summary: '{{value}}' } },
  { id: 'boolean', title: 'Boolean', payloadSchema: { type: 'boolean' }, display: { widget: 'toggle', summary: '{{value}}' } },
  { id: 'list', title: 'List', payloadSchema: { type: 'array' }, display: { widget: 'list', summary: '{{length}} items' } },
  { id: 'record', title: 'Record', payloadSchema: { type: 'object' }, display: { widget: 'record', summary: '{{value}}' } },
] as const satisfies ReadonlyArray<{
  id: string;
  title: string;
  payloadSchema: Record<string, unknown>;
  display: DatatypeDisplaySpec;
}>;

export type BuiltinDatatypeId = (typeof BUILTIN_DATATYPE_SPECS)[number]['id'];

export function isBuiltinDatatypeId(id: string): id is BuiltinDatatypeId {
  return BUILTIN_DATATYPE_SPECS.some((datatype) => datatype.id === id);
}

export function getBuiltinDatatype(id: string) {
  return BUILTIN_DATATYPE_SPECS.find((datatype) => datatype.id === id) ?? null;
}
