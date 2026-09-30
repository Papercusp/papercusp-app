/**
 * Hosted control-plane REFERENCE gate (unified-web-portal-2026-08-29 P-028).
 *
 * `deploy-hosted-control-plane.sh --check-env` is the documented cut-over gate:
 * D-037/D-044 say never publish a half-configured profile behind
 * app.papercusp.com. A bare `[[ -n "$NAME" ]]` test cannot enforce that for the
 * `*_REF` names, because their value is the NAME of a secret to look up — so
 * `set` meant only "a pointer string is present", never "the reference
 * resolves". Filling the one owner-provided literal (WORKOS_CLIENT_ID) would
 * have flipped that gate to exit 0 with the WorkOS secrets still absent, and
 * nothing dereferences the refs at boot (the resolver is injected per-request
 * in bin/hosted-handler.ts), so the unit would have started clean and passed
 * /api/health while failing every real request. See WI-2141402.
 *
 * This entrypoint closes that gap by dereferencing each reference through
 * `resolveHostedSecretRef` — the SAME resolver the runtime uses at point of use
 * — so the gate exercises the real path instead of a parallel lookup.
 *
 * It reports PRESENCE ONLY. A resolved value is never printed, never logged,
 * and never included in an error; failure detail is limited to a fixed code
 * plus the reference string (which is non-secret by construction — the hosted
 * env file holds no secrets).
 *
 * Fails CLOSED: any name that is unset, malformed, unresolvable, or that fails
 * for an unexpected reason exits non-zero.
 */
import { resolveHostedSecretRef, type HostedSecretRefResolver } from '@papercusp/operator-core/lib/auth/hosted/secret-ref';

export type ReferenceCheckStatus = 'resolved' | 'UNSET' | 'UNRESOLVED' | 'absent-optional';

export interface ReferenceCheckRow {
  readonly name: string;
  readonly status: ReferenceCheckStatus;
  /** Fixed code plus the (non-secret) reference. Never a resolved value. */
  readonly detail?: string;
}

export interface CheckReferencesOptions {
  /** Names that MUST be present and MUST resolve. */
  readonly required: readonly string[];
  /** Names that are dereferenced only when set. */
  readonly optional?: readonly string[];
  /** Env source (default: process.env). */
  readonly env?: Record<string, string | undefined>;
  /** Resolver (default: the runtime's own resolveHostedSecretRef). */
  readonly resolve?: HostedSecretRefResolver;
}

/**
 * Classify a resolver failure into a fixed, value-safe code.
 *
 * The resolver's own errors name the reference and never the value, so their
 * prefix is safe to surface. Anything else — a database connection failure in
 * particular, whose message can embed a connection string WITH its password —
 * collapses to a bare code. Never interpolate an unknown error message here.
 */
function classifyFailure(error: unknown, reference: string): string {
  const message = error instanceof Error ? error.message : '';
  if (message.startsWith('hosted_secret_ref_missing:')) return `no_value_stored\t${reference}`;
  if (message.startsWith('hosted_secret_ref_malformed:')) return `malformed_reference\t${reference}`;
  return `resolution_error\t${reference}`;
}

export async function checkReferences(options: CheckReferencesOptions): Promise<ReferenceCheckRow[]> {
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const resolve = options.resolve ?? resolveHostedSecretRef;
  const rows: ReferenceCheckRow[] = [];

  const check = async (name: string, required: boolean): Promise<void> => {
    const reference = (env[name] ?? '').trim();
    if (reference.length === 0) {
      rows.push({ name, status: required ? 'UNSET' : 'absent-optional' });
      return;
    }
    try {
      const value = await resolve(reference);
      if (typeof value !== 'string' || value.trim().length === 0) {
        // Defensive: a resolver that returns empty must not read as success.
        rows.push({ name, status: 'UNRESOLVED', detail: `empty_value\t${reference}` });
        return;
      }
      rows.push({ name, status: 'resolved' });
    } catch (error) {
      rows.push({ name, status: 'UNRESOLVED', detail: classifyFailure(error, reference) });
    }
  };

  for (const name of options.required) await check(name, true);
  for (const name of options.optional ?? []) await check(name, false);
  return rows;
}

/** A row is a failure unless it resolved or was an absent optional. */
export function rowsAreComplete(rows: readonly ReferenceCheckRow[]): boolean {
  return rows.every((row) => row.status === 'resolved' || row.status === 'absent-optional');
}

export function formatRow(row: ReferenceCheckRow): string {
  return row.detail ? `${row.name}\t${row.status}\t${row.detail}` : `${row.name}\t${row.status}`;
}

function parseArgv(argv: readonly string[]): { required: string[]; optional: string[] } {
  const required: string[] = [];
  const optional: string[] = [];
  let bucket = required;
  for (const arg of argv) {
    if (arg === '--required') { bucket = required; continue; }
    if (arg === '--optional') { bucket = optional; continue; }
    bucket.push(arg);
  }
  return { required, optional };
}

async function main(): Promise<void> {
  const { required, optional } = parseArgv(process.argv.slice(2));
  if (required.length === 0) {
    process.stderr.write('usage: hosted-check-refs.ts [--required] NAME... [--optional NAME...]\n');
    process.exit(2);
  }
  const rows = await checkReferences({ required, optional });
  for (const row of rows) process.stdout.write(`${formatRow(row)}\n`);
  process.exit(rowsAreComplete(rows) ? 0 : 1);
}

// Run only as a CLI, so the module stays importable by its test.
if (process.argv[1] && /hosted-check-refs\.ts$/.test(process.argv[1])) {
  main().catch((error: unknown) => {
    // Fail closed, and never surface an unknown error's message.
    process.stderr.write(`hosted_check_refs_failed:${error instanceof Error ? error.name : 'unknown'}\n`);
    process.exit(1);
  });
}
