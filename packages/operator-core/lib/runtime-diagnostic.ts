/**
 * Shared runtime-diagnostic contract.
 *
 * Runtime tools used to expose their truth under unrelated field names (`config`,
 * `fleet`, `services`, `status`, `reason`, ...). An agent first had to learn each
 * tool's private shape before it could answer the same five questions. This
 * additive envelope gives every migrated diagnostic one stable scan path while
 * preserving its domain-specific fields for existing consumers.
 */
export interface RuntimeDiagnostic<
  TConfigured = unknown,
  TEffective = unknown,
  TEvidence = unknown,
  TRootCause = unknown,
> {
  /** What policy/config says should be true. */
  configured: TConfigured;
  /** What the running system is actually doing now. */
  effective: TEffective;
  /** Concrete observations supporting `effective` / `rootCause`. */
  evidence: TEvidence;
  /** The first actionable causal leaf; null means no fault was found. */
  rootCause: TRootCause | null;
  /** Exact next platform verb to call; null means no follow-up is required. */
  nextVerb: string | null;
}

export function runtimeDiagnostic<TConfigured, TEffective, TEvidence, TRootCause>(
  fields: RuntimeDiagnostic<TConfigured, TEffective, TEvidence, TRootCause>,
): RuntimeDiagnostic<TConfigured, TEffective, TEvidence, TRootCause> {
  return fields;
}
