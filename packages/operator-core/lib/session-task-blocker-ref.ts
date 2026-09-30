export type SessionTaskBlockerKind = 'lock' | 'event' | 'wi' | 'plan' | 'text';

export interface ParsedSessionTaskBlockerRef {
  kind: SessionTaskBlockerKind;
  target: string;
  typed: boolean;
}

export type SessionTaskBlockerRefValidationCode =
  | 'blocker_ref_target_required'
  | 'blocker_ref_plan_invalid';

export class SessionTaskBlockerRefValidationError extends Error {
  readonly code: SessionTaskBlockerRefValidationCode;

  constructor(code: SessionTaskBlockerRefValidationCode, message: string) {
    super(message);
    this.name = 'SessionTaskBlockerRefValidationError';
    this.code = code;
  }
}

export function parseSessionTaskBlockerRef(ref: string): ParsedSessionTaskBlockerRef {
  const value = ref.trim();
  const match = /^(lock|event|wi|plan):(.*)$/s.exec(value);
  if (!match) return { kind: 'text', target: value, typed: false };
  return { kind: match[1] as SessionTaskBlockerKind, target: match[2]!.trim(), typed: true };
}

export function validateSessionTaskBlockerRef(ref: string): ParsedSessionTaskBlockerRef {
  const parsed = parseSessionTaskBlockerRef(ref);
  if (!parsed.typed) return parsed;
  if (!parsed.target) {
    throw new SessionTaskBlockerRefValidationError(
      'blocker_ref_target_required',
      `Typed blocker \`${parsed.kind}:\` requires a target.`,
    );
  }
  if (parsed.kind === 'plan' && !/^P-\d{3,}$/.test(parsed.target)) {
    throw new SessionTaskBlockerRefValidationError(
      'blocker_ref_plan_invalid',
      'A plan blocker must be written `plan:P-NNN`.',
    );
  }
  return parsed;
}
