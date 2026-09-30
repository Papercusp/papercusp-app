/**
 * Hosted-profile secret REFERENCE resolver.
 *
 * The hosted control plane (`endpoint-route/hosted-runtime.ts`) and the narrow
 * hosted-auth runtime (`endpoint-route/hosted-auth-runtime.ts`) read their
 * `*_REF` configuration as REFERENCES and dereference them only at the point of
 * use. The generic egress resolver (`inference-gateway/egress-providers/secret-ref.ts`)
 * understands `env:NAME` and `file:<path>`; this wrapper adds the ONE extra kind
 * a hosted deployment actually needs:
 *
 *   `integration:NAME` — read NAME from the encrypted
 *   `harness_shared.operator_integration_credentials` store (the surface
 *   `setup:save_integration_key` writes and `operator:credentials_status` probes).
 *
 * That is what lets a WorkOS API key / cookie password / webhook secret live ONLY
 * in the approved encrypted store — never in a systemd unit, an env var, or a
 * plaintext file on the host — while the unit carries just the reference
 * (unified-web-portal-2026-08-29 D-037: "approved encrypted references
 * resolvable by that profile").
 *
 * Errors name the REFERENCE, never the value.
 */
import { readIntegrationKey } from '../../integration-credentials';
import { resolveSecretRef } from '../../inference-gateway/egress-providers/secret-ref';

export const HOSTED_INTEGRATION_SECRET_REF_PREFIX = 'integration:';

/** Same shape `setup:save_integration_key` enforces for a stored name. */
const INTEGRATION_NAME = /^[A-Z][A-Z0-9_]{2,63}$/;

export type HostedSecretRefResolver = (reference: string) => Promise<string>;

export interface HostedSecretRefDependencies {
  /** Store reader — injectable so composition tests never touch Postgres. */
  readonly readIntegrationKey?: (name: string) => Promise<string | undefined>;
  /** Resolver for every non-`integration:` reference (default: env:/file:). */
  readonly resolveOther?: HostedSecretRefResolver;
}

export function createHostedSecretRefResolver(
  dependencies: HostedSecretRefDependencies = {},
): HostedSecretRefResolver {
  const readKey = dependencies.readIntegrationKey ?? readIntegrationKey;
  const resolveOther = dependencies.resolveOther ?? resolveSecretRef;
  return async function resolveHostedSecretRef(reference: string): Promise<string> {
    const trimmed = reference.trim();
    if (!trimmed.startsWith(HOSTED_INTEGRATION_SECRET_REF_PREFIX)) return resolveOther(trimmed);
    const name = trimmed.slice(HOSTED_INTEGRATION_SECRET_REF_PREFIX.length).trim();
    if (!INTEGRATION_NAME.test(name)) {
      throw new Error(`hosted_secret_ref_malformed:${trimmed} (expected integration:SCREAMING_SNAKE_NAME)`);
    }
    const value = await readKey(name);
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(
        `hosted_secret_ref_missing:${HOSTED_INTEGRATION_SECRET_REF_PREFIX}${name} ` +
          `(no value stored under '${name}' — setup:save_integration_key { name:'${name}' } provisions it)`,
      );
    }
    return value.trim();
  };
}

/** Default resolver: env:/file: via the egress resolver, plus integration:NAME via the encrypted store. */
export const resolveHostedSecretRef: HostedSecretRefResolver = createHostedSecretRefResolver();
