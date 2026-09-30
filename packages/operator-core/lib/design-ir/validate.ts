/**
 * UI IR validator — JSON Schema check via ajv.
 *
 * Schema check only ("is this valid IR?"). Anti-pattern checks live
 * in ./lint.ts ("is this *good* IR?"). Both run on every submitted spec.
 */
import Ajv2020 from 'ajv/dist/2020';
import type { ErrorObject } from 'ajv';
import { uiIrSchema, type UiIr } from './schema';

let cachedAjv: Ajv2020 | null = null;
let cachedValidate: ((data: unknown) => boolean) | null = null;

function getValidator() {
  if (cachedValidate) return cachedValidate;
  cachedAjv = new Ajv2020({ allErrors: true, strict: false });
  cachedValidate = cachedAjv.compile(uiIrSchema as unknown as object);
  return cachedValidate;
}

export interface ValidationError {
  path: string;
  message: string;
  keyword: string;
  params: Record<string, unknown>;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
  /** When ok=true, the input narrowed to UiIr. */
  spec?: UiIr;
}

function formatErrors(errors: readonly ErrorObject[] | null | undefined): ValidationError[] {
  if (!errors) return [];
  return errors.map((e) => ({
    path: e.instancePath || '/',
    message: e.message ?? 'invalid',
    keyword: e.keyword,
    params: e.params as Record<string, unknown>,
  }));
}

/**
 * Validate an IR document against the v0.1 schema. Returns a structured
 * result; never throws on bad input (callers can branch on `ok`).
 */
export function validateIr(input: unknown): ValidationResult {
  const validate = getValidator();
  const ok = validate(input);
  if (ok) {
    return { ok: true, errors: [], spec: input as UiIr };
  }
  return {
    ok: false,
    errors: formatErrors((validate as unknown as { errors: ErrorObject[] | null }).errors),
  };
}

/** Throwing variant for code paths that prefer exceptions. */
export class IrValidationError extends Error {
  readonly errors: ValidationError[];
  constructor(errors: ValidationError[]) {
    super(`IR validation failed: ${errors.length} error(s)`);
    this.name = 'IrValidationError';
    this.errors = errors;
  }
}

export function assertValidIr(input: unknown): asserts input is UiIr {
  const r = validateIr(input);
  if (!r.ok) throw new IrValidationError(r.errors);
}
