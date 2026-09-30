import type { WorkspaceHostHealthCheck, WorkspaceHostHealthStatus } from "./workspace-host-types";

/**
 * A health signal this provider WANTS but cannot measure on the current path — because no
 * producer writes the underlying observation field, or the probe has not run yet.
 *
 * Emitting the check as unmeasured is deliberately preferred over dropping it: a dropped
 * check silently shrinks the evidence set, so the attestation resolves `healthy` off the
 * checks that remain and claims more than it knows. Keeping it with `ok: null` records
 * both that the signal is required and that nobody produced it.
 */
export function unmeasuredHealthCheck(name: string, detail: string): WorkspaceHostHealthCheck {
  return { name, ok: null, detail };
}

/**
 * The single rule every provider derives its attestation status from, so no provider
 * hand-rolls a coercion of an absent measurement again.
 *
 * Precedence, strongest evidence first:
 *   1. `unreachable` — the host itself is not up; the other checks describe nothing.
 *   2. `degraded`    — something was MEASURED and is failing. A known failure outranks a
 *                      gap in coverage: if we know it is broken, say broken.
 *   3. `unknown`     — nothing measured is failing, but at least one check was never
 *                      measured, so the remaining evidence cannot support "healthy".
 *   4. `healthy`     — every check was measured AND passed.
 *
 * The load-bearing property is on step 4: `healthy` requires every check to be measured,
 * which makes it structurally impossible to attest healthy off a field nobody wrote.
 */
export function resolveWorkspaceHostHealthStatus(input: {
  reachable: boolean;
  checks: readonly WorkspaceHostHealthCheck[];
}): WorkspaceHostHealthStatus {
  if (!input.reachable) return "unreachable";
  if (input.checks.some((check) => check.ok === false)) return "degraded";
  if (input.checks.some((check) => check.ok === null)) return "unknown";
  return "healthy";
}
