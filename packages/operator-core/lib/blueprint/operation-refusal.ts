/** Caller-caused refusals of the blueprint operation lifecycle (P-017).
 *
 * The service and admission layer distinguish two failure classes: a REFUSAL
 * (the caller supplied a handle, key, payload or request the operation cannot
 * accept) and an internal invariant failure (canonical state disagrees with
 * itself). Public tool projections map only refusals to `invalid_input`; every
 * other error stays a `handler_error`, because it is a defect rather than a
 * caller mistake. Keeping the class in its own module lets both the service and
 * the admission layer throw it without an import cycle. */

export const BLUEPRINT_OPERATION_REFUSAL_CODES = [
  'invalid_request',
  'handle_mismatch',
  'input_conflict',
  'undeclared',
  'invalid_payload',
  'terminal',
  'stale_wait',
] as const;

export type BlueprintOperationRefusalCode = typeof BLUEPRINT_OPERATION_REFUSAL_CODES[number];

export class BlueprintOperationRefusal extends Error {
  override readonly name = 'BlueprintOperationRefusal';

  constructor(readonly code: BlueprintOperationRefusalCode, message: string) {
    super(message);
  }
}

/** Duplicate module records (tsx CJS preflight beside ESM) can split the class
 * identity, so recognise a refusal by its stable name and code as well. */
export function isBlueprintOperationRefusal(error: unknown): error is BlueprintOperationRefusal {
  if (error instanceof BlueprintOperationRefusal) return true;
  return error instanceof Error && error.name === 'BlueprintOperationRefusal' &&
    (BLUEPRINT_OPERATION_REFUSAL_CODES as readonly string[]).includes((error as { code?: unknown }).code as string);
}
