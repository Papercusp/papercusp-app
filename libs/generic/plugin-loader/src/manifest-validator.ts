/**
 * Generic JSON-Schema manifest validator.
 *
 * A plugin host hands this a JSON Schema (its manifest contract) and gets
 * back a validator that turns ajv's raw errors into `{ path, message }`
 * issues with stable field paths — so callers can render precise,
 * author-friendly load/lint errors.
 *
 * The engine is domain-free: it knows nothing about *which* fields a
 * manifest has. The one built-in nicety it applies is rewriting an
 * `additionalProperties:false` violation into a "unknown property — typo?"
 * message (a near-universal want for strict manifests). Host-specific
 * message rewrites (e.g. "plugin id must match <regex>") inject through
 * `options.customizeMessage`.
 *
 * Edge-runtime safe: pulls only `ajv`, no `node:*`. The host is expected
 * to pass the schema as an object (e.g. an ESM JSON import inlined at
 * build time) so the schema becomes part of the dependency graph rather
 * than a runtime `readFileSync`.
 */
import Ajv, { type ErrorObject } from 'ajv';

/** Re-exported so a host can type its `customizeMessage` without a direct ajv import. */
export type AjvErrorObject = ErrorObject;

export interface ManifestValidationIssue {
  path: string;
  message: string;
}

export interface ManifestValidationResult {
  ok: boolean;
  issues: ManifestValidationIssue[];
}

export interface ManifestValidatorOptions {
  /**
   * ajv constructor options, merged over the defaults
   * `{ allErrors: true, strict: false }`.
   */
  ajvOptions?: ConstructorParameters<typeof Ajv>[0];
  /**
   * Host hook to rewrite a single error's message. Receives the raw ajv
   * error plus the manifest being validated; return a string to override,
   * or `undefined` to keep the default message. Use it for domain-specific
   * phrasing (id-regex hints, semver hints, etc.).
   */
  customizeMessage?: (err: ErrorObject, manifest: unknown) => string | undefined;
}

export interface ManifestValidator {
  /** Validate a parsed manifest; returns ok + field-pathed issues. */
  validate(manifest: unknown): ManifestValidationResult;
  /** Throw on invalid manifest with all issues concatenated (load-time use). */
  assertValid(manifest: unknown, sourceLabel?: string): void;
}

/**
 * Build a manifest validator bound to one JSON Schema. The compiled ajv
 * validator is created lazily on first use and cached for the validator's
 * lifetime.
 */
export function createManifestValidator(
  schema: object,
  options: ManifestValidatorOptions = {},
): ManifestValidator {
  let _validator: ReturnType<Ajv['compile']> | null = null;
  function getValidator() {
    if (_validator) return _validator;
    const ajv = new Ajv({ allErrors: true, strict: false, ...(options.ajvOptions ?? {}) });
    _validator = ajv.compile(schema);
    return _validator;
  }

  function defaultMessage(e: ErrorObject): string {
    let message = e.message ?? 'invalid';
    if (e.keyword === 'additionalProperties' && e.params && 'additionalProperty' in e.params) {
      message = `unknown property "${(e.params as { additionalProperty: string }).additionalProperty}" — typo? (additionalProperties:false)`;
    }
    return message;
  }

  function validate(manifest: unknown): ManifestValidationResult {
    const v = getValidator();
    const ok = v(manifest);
    if (ok) return { ok: true, issues: [] };
    const issues: ManifestValidationIssue[] = (v.errors ?? []).map((e: ErrorObject) => {
      const path = e.instancePath || '/';
      const custom = options.customizeMessage?.(e, manifest);
      return { path, message: custom ?? defaultMessage(e) };
    });
    return { ok: false, issues };
  }

  function assertValid(manifest: unknown, sourceLabel = 'manifest'): void {
    const r = validate(manifest);
    if (r.ok) return;
    const lines = r.issues.map((i) => `  ${i.path} — ${i.message}`).join('\n');
    throw new Error(`${sourceLabel} is invalid:\n${lines}`);
  }

  return { validate, assertValid };
}
