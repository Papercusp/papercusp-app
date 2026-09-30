/** Non-secret configuration and late-bound secret resolution for WorkOS AuthKit. */

export const WORKOS_HOSTED_IDENTITY_PROVIDER_ID = 'workos';
export const WORKOS_COOKIE_PASSWORD_MIN_BYTES = 32;

/**
 * Persistable WorkOS configuration. Values are opaque references, never the
 * API key or cookie-encryption password themselves.
 */
export interface WorkOSHostedIdentityConfiguration {
  clientId: string;
  apiKeyRef: string;
  cookiePasswordRef: string;
}

export type WorkOSHostedIdentitySecret = 'api-key' | 'cookie-password';

/** Reuse the caller's injected-config/secret plane rather than reading env here. */
export type WorkOSHostedIdentitySecretResolver = (
  reference: string,
  context: {
    providerId: typeof WORKOS_HOSTED_IDENTITY_PROVIDER_ID;
    secret: WorkOSHostedIdentitySecret;
  },
) => Promise<string | undefined>;

export type WorkOSHostedIdentityConfigurationErrorCode =
  | 'workos_configuration_invalid'
  | 'workos_secret_unavailable';

export class WorkOSHostedIdentityConfigurationError extends Error {
  readonly name = 'WorkOSHostedIdentityConfigurationError';

  constructor(readonly code: WorkOSHostedIdentityConfigurationErrorCode) {
    super('WorkOS hosted identity configuration is unavailable.');
  }
}

/** @internal Contains resolved secrets; keep it inside one provider operation. */
export interface ResolvedWorkOSHostedIdentityConfiguration {
  clientId: string;
  apiKey: string;
  cookiePassword: string;
}

function requiredReference(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 1_024) {
    throw new WorkOSHostedIdentityConfigurationError('workos_configuration_invalid');
  }
  return value.trim();
}

function requiredClientId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 512) {
    throw new WorkOSHostedIdentityConfigurationError('workos_configuration_invalid');
  }
  return value.trim();
}

async function resolveRequiredSecret(
  resolveSecret: WorkOSHostedIdentitySecretResolver,
  reference: string,
  secret: WorkOSHostedIdentitySecret,
): Promise<string> {
  let value: string | undefined;
  try {
    value = await resolveSecret(reference, {
      providerId: WORKOS_HOSTED_IDENTITY_PROVIDER_ID,
      secret,
    });
  } catch {
    throw new WorkOSHostedIdentityConfigurationError('workos_secret_unavailable');
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new WorkOSHostedIdentityConfigurationError('workos_secret_unavailable');
  }
  return value;
}

export async function resolveWorkOSHostedIdentityConfiguration(
  configuration: WorkOSHostedIdentityConfiguration,
  resolveSecret: WorkOSHostedIdentitySecretResolver,
): Promise<ResolvedWorkOSHostedIdentityConfiguration> {
  const clientId = requiredClientId(configuration.clientId);
  const apiKeyRef = requiredReference(configuration.apiKeyRef);
  const cookiePasswordRef = requiredReference(configuration.cookiePasswordRef);
  const [apiKey, cookiePassword] = await Promise.all([
    resolveRequiredSecret(resolveSecret, apiKeyRef, 'api-key'),
    resolveRequiredSecret(resolveSecret, cookiePasswordRef, 'cookie-password'),
  ]);

  if (Buffer.byteLength(cookiePassword, 'utf8') < WORKOS_COOKIE_PASSWORD_MIN_BYTES) {
    throw new WorkOSHostedIdentityConfigurationError('workos_configuration_invalid');
  }

  return { clientId, apiKey, cookiePassword };
}
