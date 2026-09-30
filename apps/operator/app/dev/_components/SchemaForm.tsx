'use client';

/**
 * JSON-Schema → form renderer. Covers the subset zod-to-json-schema emits
 * for our tools: object/properties/required + string/number/integer/
 * boolean/enum/array. Anything we don't recognize falls through to a
 * JSON textarea — escape hatch for complex shapes.
 */

import { Checkbox } from '@/app/harness/Checkbox';
import { Select } from '@/app/harness/Select';

interface Schema {
  type?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  enum?: unknown[];
  items?: Schema;
  default?: unknown;
  description?: string;
  minLength?: number;
  maximum?: number;
  exclusiveMinimum?: number;
}

interface Props {
  schema: Record<string, unknown>;
  value: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
}

export default function SchemaForm({ schema, value, onChange }: Props) {
  const s = schema as Schema;
  if (s.type !== 'object' || !s.properties) {
    return (
      <textarea
        className="pc-dev-input pc-dev-input-multi"
        rows={6}
        value={JSON.stringify(value, null, 2)}
        onChange={(e) => {
          try {
            onChange(JSON.parse(e.target.value));
          } catch {
            /* ignore invalid intermediate state */
          }
        }}
      />
    );
  }

  const props = s.properties;
  const required = new Set(s.required ?? []);
  const entries = Object.entries(props);

  function setField(key: string, v: unknown) {
    onChange({ ...value, [key]: v });
  }

  return (
    <div className="pc-dev-form">
      {entries.map(([key, child]) => {
        const isReq = required.has(key);
        const current = value[key];
        return (
          <label key={key} className="pc-dev-form-row">
            <span className="pc-dev-form-key">
              {key}
              {isReq && <em className="pc-dev-req">*</em>}
              {child.description && (
                <span className="pc-dev-form-hint" title={child.description}>
                  ⓘ
                </span>
              )}
            </span>
            {renderField(key, child, current, (v) => setField(key, v))}
          </label>
        );
      })}
    </div>
  );
}

function renderField(
  key: string,
  schema: Schema,
  value: unknown,
  setValue: (v: unknown) => void,
) {
  if (Array.isArray(schema.enum)) {
    const cur = ((value as string) ?? (schema.default as string) ?? '') || '_none';
    return (
      <Select
        value={cur}
        onChange={(v) => setValue(v === '_none' ? '' : v)}
        options={[
          { value: '_none', label: '(none)' },
          ...schema.enum.map((opt) => ({ value: String(opt), label: String(opt) })),
        ]}
      />
    );
  }
  if (schema.type === 'boolean') {
    return <Checkbox checked={!!value} onChange={setValue} />;
  }
  if (schema.type === 'integer' || schema.type === 'number') {
    return (
      <input
        type="number"
        className="pc-dev-input"
        value={value as number | '' ?? ''}
        onChange={(e) => {
          const n = e.target.value === '' ? undefined : Number(e.target.value);
          setValue(n);
        }}
      />
    );
  }
  if (schema.type === 'array') {
    return (
      <textarea
        className="pc-dev-input pc-dev-input-multi"
        rows={3}
        placeholder='["item", …]'
        value={Array.isArray(value) ? JSON.stringify(value) : ''}
        onChange={(e) => {
          try {
            const v = e.target.value.trim() === '' ? undefined : JSON.parse(e.target.value);
            setValue(v);
          } catch {
            /* keep typing */
          }
        }}
      />
    );
  }
  // string fallback. Multi-line for descriptions/body fields.
  const longish = /body|description|summary|content|reason|spec/.test(key);
  if (longish) {
    return (
      <textarea
        className="pc-dev-input pc-dev-input-multi"
        rows={3}
        value={(value as string) ?? ''}
        onChange={(e) => setValue(e.target.value || undefined)}
      />
    );
  }
  return (
    <input
      type="text"
      className="pc-dev-input"
      value={(value as string) ?? ''}
      onChange={(e) => setValue(e.target.value || undefined)}
    />
  );
}
