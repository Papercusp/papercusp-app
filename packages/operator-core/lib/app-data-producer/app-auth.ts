/**
 * P-004 — service-to-app authentication for the platform→app data producer.
 *
 * The apps ALREADY define exactly one way to authenticate a caller, and this
 * module deliberately introduces no second one. Both verifiers are the same
 * shape (apps/sidecar/src/auth.ts in each app):
 *
 *   jwtVerify(token, <APP>_AUTH_SECRET, { audience: 'papercusp-<app>' })
 *   → ownerId = payload.sub
 *
 * So the producer mints precisely that: an HS256 JWT whose `sub` is the app
 * owner resolved through the P-003 mapping, whose `aud` is the app's audience,
 * signed with the shared secret the app itself verifies against. No new auth
 * scheme, no new endpoint, no long-lived credential handed to a background job.
 *
 * Everything here is derived from the app slug in ONE place — audience via
 * `appAudience`, secret via `appAuthSecretEnvVar` — so the platform's idea of
 * how to reach an app cannot drift from the app's idea of who it trusts.
 */
import { createRequire } from 'node:module';
import { appAudience, type ProducerApp } from './owner-mapping';

/**
 * CJS interop, matching the established idiom here (device-push-dispatcher.ts,
 * google-pubsub.ts, gcp-preflight.ts). These modules are loaded as ESM by some
 * hosts, where a bare `require` is undefined — the documented fault in WI-37482,
 * which shipped broken precisely because the affected leg was dormant.
 */
const requireCjs = createRequire(import.meta.url);

/** Default token lifetime. Short by design: a producer mints per delivery. */
export const APP_TOKEN_TTL_SECONDS = 300;

/**
 * The env var holding an app's shared signing secret.
 *
 * Derived from the slug rather than stored in a table: the secret is INJECTED
 * CONFIG, never repo or database state, so the only durable thing is the name
 * — and deriving the name means adding an app cannot silently half-register
 * (a mapping row that points at a secret nobody supplies).
 */
export function appAuthSecretEnvVar(app: ProducerApp): string {
  return `${app.toUpperCase()}_AUTH_SECRET`;
}

/**
 * Read an app's signing secret, or throw naming the variable to set.
 *
 * There is deliberately no default and no fallback. A blank or absent secret is
 * a configuration fault the operator must fix; signing with a placeholder would
 * produce tokens the app rejects with its own generic `<app>_auth_required`,
 * moving the diagnosis into the app's logs and away from the real cause.
 * The value itself is never returned in an error message.
 */
export function readAppAuthSecret(app: ProducerApp): string {
  const envVar = appAuthSecretEnvVar(app);
  const secret = process.env[envVar]?.trim() ?? '';
  if (!secret) {
    throw new Error(
      `app_auth_secret_missing:${app} — set ${envVar} to the same shared secret the ${app} app verifies with`,
    );
  }
  return secret;
}

/** True when this app's signing secret is configured — for a preflight/status read. */
export function hasAppAuthSecret(app: ProducerApp): boolean {
  return Boolean(process.env[appAuthSecretEnvVar(app)]?.trim());
}

export interface MintAppServiceTokenOptions {
  /** Lifetime in seconds; defaults to APP_TOKEN_TTL_SECONDS. */
  ttlSeconds?: number;
  /** Override the secret (tests, or a caller that already resolved it). */
  secret?: string;
}

/**
 * Mint a short-lived bearer token for one app owner.
 *
 * `sub` is the APP-side ownerId from the P-003 mapping — never a platform user
 * uuid. That distinction is the whole security property: the token names who
 * the app will scope its store to, and the platform's own identifiers have no
 * meaning inside the app.
 */
export async function mintAppServiceToken(
  app: ProducerApp,
  ownerId: string,
  options: MintAppServiceTokenOptions = {},
): Promise<string> {
  const subject = ownerId.trim();
  if (!subject) throw new Error(`app_service_token_subject_required:${app}`);

  const ttlSeconds = options.ttlSeconds ?? APP_TOKEN_TTL_SECONDS;
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error(`app_service_token_ttl_invalid:${ttlSeconds}`);
  }

  const secret = options.secret?.trim() || readAppAuthSecret(app);
  const { SignJWT } = requireCjs('jose') as typeof import('jose');
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(subject)
    .setAudience(appAudience(app))
    .setIssuer('papercusp-platform')
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(new TextEncoder().encode(secret));
}

/** The Authorization header value the app expects. */
export async function appServiceAuthHeader(
  app: ProducerApp,
  ownerId: string,
  options: MintAppServiceTokenOptions = {},
): Promise<string> {
  return `Bearer ${await mintAppServiceToken(app, ownerId, options)}`;
}
