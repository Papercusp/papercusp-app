/**
 * Host-held service credentials for integration providers
 * (generalized-integrations D-018.1).
 *
 * Some provider work needs an identity that is not the source's user account:
 * Gmail push reaches Google Pub/Sub, which a mailbox OAuth token cannot call.
 * A provider declares such credentials BY REFERENCE in its descriptor
 * (`serviceCredentials: [{ ref, hosts }]`). The host resolves each ref here:
 *
 * - `params()` returns non-secret strings the provider receives on
 *   `ProviderSyncRequest.services[ref]` / `ProviderInvokeRequest.services[ref]`,
 *   or null when the credential is not configured on this host (the ref is then
 *   omitted and the provider skips the work that needs it);
 * - `accessToken()` mints the bearer token host.fetch injects for a request to
 *   one of the ref's declared hosts. The provider never sees it.
 *
 * The host owns credential minting for every provider (OAuth refresh for
 * source accounts, this registry for service identities), so a new service
 * credential is one more resolver here, never a provider-specific host path.
 */
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { pinModuleState } from '@papercusp/module-singleton';
import type { ProviderServiceCredential, ProviderServices } from '@papercusp/plugin-sdk';

export interface ServiceCredentialResolver {
  /** Non-secret parameters for the provider, or null when not configured here. Must not mint a token. */
  params(): Promise<Record<string, string> | null>;
  /** A fresh bearer token. Throws when the credential is configured but cannot be minted. */
  accessToken(): Promise<string>;
}

const state = pinModuleState('@papercusp/operator-core.integrations.service-credentials', () => ({
  resolvers: new Map<string, ServiceCredentialResolver>(),
}));

export function registerServiceCredential(ref: string, resolver: ServiceCredentialResolver): void {
  state.resolvers.set(ref, resolver);
}

/** Test seam: drop a registration (restores the built-in on next lookup for built-in refs). */
export function unregisterServiceCredential(ref: string): void {
  state.resolvers.delete(ref);
}

export function serviceCredentialResolver(ref: string): ServiceCredentialResolver | null {
  const registered = state.resolvers.get(ref);
  if (registered) return registered;
  const builtin = BUILTIN_RESOLVERS[ref];
  return builtin ? builtin() : null;
}

/**
 * The `services` map for one provider request: every declared ref that is
 * configured on this host, keyed by ref. A resolver that throws is treated as
 * not configured, so a broken service credential degrades the work that needs
 * it instead of failing the sync or invoke that carries it.
 */
export async function resolveProviderServices(
  declared: readonly ProviderServiceCredential[] | undefined,
): Promise<ProviderServices | undefined> {
  if (!declared || declared.length === 0) return undefined;
  const services: ProviderServices = {};
  for (const { ref } of declared) {
    const resolver = serviceCredentialResolver(ref);
    if (!resolver) continue;
    try {
      const params = await resolver.params();
      if (params) services[ref] = params;
    } catch {
      // Not configured or unreadable: omit the ref (D-018.1).
    }
  }
  return Object.keys(services).length > 0 ? services : undefined;
}

/** The declared service credential whose hosts include `hostname`, if any. */
export function serviceCredentialForHost(
  declared: readonly ProviderServiceCredential[] | undefined,
  hostname: string,
): ProviderServiceCredential | null {
  const host = hostname.toLowerCase();
  for (const credential of declared ?? []) {
    if (credential.hosts.some((h) => h.toLowerCase() === host)) return credential;
  }
  return null;
}

/* ─── google-pubsub: the GCP service account used for Gmail push ─── */

export const GOOGLE_PUBSUB_SERVICE_CREDENTIAL = 'google-pubsub';
export const GOOGLE_PUBSUB_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
export const GOOGLE_GMAIL_PUSH_TOPIC_ID = 'papercusp-gmail-push';

/**
 * Pub/Sub uses its own key-path variable before ADC: bg-host deliberately
 * unsets GOOGLE_APPLICATION_CREDENTIALS for callers that must refuse a key, and
 * that hardening must not strand Gmail push (WI-474688).
 */
export function googlePubSubServiceAccountPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const path = env.PAPERCUSP_GOOGLE_PUBSUB_SERVICE_ACCOUNT_PATH?.trim() || env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  return path || null;
}

interface GoogleServiceAccountKey {
  project_id?: string;
  client_email?: string;
}

const requireCjs = createRequire(import.meta.url);

const googleState = pinModuleState('@papercusp/operator-core.integrations.service-credentials.google', () => ({
  clients: new Map<string, { getAccessToken(): Promise<{ token?: string | null }> }>(),
}));

export interface GooglePubSubResolverDeps {
  env?: NodeJS.ProcessEnv;
  readFile?: (path: string) => Promise<string>;
  mintToken?: (keyPath: string) => Promise<string>;
}

async function mintGoogleToken(keyPath: string): Promise<string> {
  let client = googleState.clients.get(keyPath);
  if (!client) {
    // Lazy CJS interop keeps google-auth-library out of processes that never need it.
    const { GoogleAuth } = requireCjs('google-auth-library') as typeof import('google-auth-library');
    const auth = new GoogleAuth({ keyFilename: keyPath, scopes: [GOOGLE_PUBSUB_SCOPE] });
    client = await auth.getClient();
    googleState.clients.set(keyPath, client);
  }
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('google_pubsub_access_token_empty');
  return token;
}

/**
 * `params`: `{ projectId, topicName, principal }` from the key file, where
 * topicName is the shared Gmail push topic in that project. Null when no key
 * path is configured or the key names no project.
 */
export function googlePubSubResolver(deps: GooglePubSubResolverDeps = {}): ServiceCredentialResolver {
  const readFile = deps.readFile ?? ((path: string) => fs.readFile(path, 'utf8'));
  const keyPath = () => googlePubSubServiceAccountPath(deps.env ?? process.env);
  return {
    async params() {
      const path = keyPath();
      if (!path) return null;
      const key = JSON.parse(await readFile(path)) as GoogleServiceAccountKey;
      const projectId = key.project_id?.trim();
      if (!projectId) return null;
      const params: Record<string, string> = {
        projectId,
        topicName: `projects/${projectId}/topics/${GOOGLE_GMAIL_PUSH_TOPIC_ID}`,
      };
      const principal = key.client_email?.trim();
      if (principal) params.principal = principal;
      return params;
    },
    async accessToken() {
      const path = keyPath();
      if (!path) throw new Error('google_pubsub_service_account_path_required');
      return (deps.mintToken ?? mintGoogleToken)(path);
    },
  };
}

const BUILTIN_RESOLVERS: Record<string, () => ServiceCredentialResolver> = {
  [GOOGLE_PUBSUB_SERVICE_CREDENTIAL]: () => googlePubSubResolver(),
};
