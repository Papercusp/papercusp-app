/**
 * OAuth provider registry.
 *
 * Each provider is an object describing how to:
 *   - build the authorize URL
 *   - exchange a code for tokens
 *   - refresh a token
 *   - introspect a pasted token (paste-PAT scope verification)
 *
 * Substrate platform-owners register providers at boot via
 * `~/.papercusp/oauth-apps.json` (clientId + clientSecret + scopes).
 *
 * Spec: /docs/snapshots/oauth-integration#substrate-level-provider-config.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';

import { CLAUDE_CODE_CLIENT_ID, CLAUDE_OAUTH_DEFAULTS } from '@papercusp/papercusp-shared/agent';
import { operatorApiBase } from '../operator-api-base';
import type { OAuthFlowPrivateContext } from './state';

export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  refreshUrl?: string;
  userInfoUrl?: string;
  /**
   * Token-introspection endpoint (for paste-PAT scope verification).
   * Optional — providers without one accept any pasted token.
   */
  introspectUrl?: string;
  redirectUri: string;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms when the access token expires; undefined if no expiry. */
  expiresAt?: number;
  /** Provider-reported granted scope list. */
  scopes?: string[];
}

export interface IntrospectionResult {
  /** Scopes the token actually has (may differ from what plugin requested). */
  scopes: string[];
  /** True if the token belongs to the substrate's OAuth app (vs a fine-grained PAT). */
  belongsToOurApp?: boolean;
}

export interface OAuthProvider {
  id: string;
  config: OAuthProviderConfig;
  /** Curated scopes used when the start route receives no explicit scope list. */
  defaultScopes?: readonly string[];
  /** Optional allowlist enforced by the start route before redirecting. */
  allowedScopes?: readonly string[];
  /** Create server-only state for this authorize→callback round trip. */
  createFlowContext?(): OAuthFlowPrivateContext | Promise<OAuthFlowPrivateContext>;
  buildAuthorizeUrl(scopes: string[], state: string, privateContext?: OAuthFlowPrivateContext): string;
  exchangeCode(code: string, privateContext?: OAuthFlowPrivateContext): Promise<TokenResponse>;
  refresh(refreshToken: string): Promise<TokenResponse>;
  introspect?(token: string): Promise<IntrospectionResult>;
}

/* ─── GitHub provider ─── */

export function makeGithubProvider(config: OAuthProviderConfig): OAuthProvider {
  return {
    id: 'github',
    config,
    buildAuthorizeUrl(scopes, state) {
      const u = new URL(config.authorizeUrl);
      u.searchParams.set('client_id', config.clientId);
      u.searchParams.set('redirect_uri', config.redirectUri);
      u.searchParams.set('scope', scopes.join(' '));
      u.searchParams.set('state', state);
      return u.toString();
    },
    async exchangeCode(code) {
      const res = await fetch(config.tokenUrl, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code,
          redirect_uri: config.redirectUri,
        }),
      });
      if (!res.ok) throw new Error(`github token exchange ${res.status}`);
      const j = (await res.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        scope?: string;
        error?: string;
      };
      if (j.error || !j.access_token) {
        throw new Error(`github token exchange failed: ${j.error ?? 'no access_token'}`);
      }
      return {
        accessToken: j.access_token,
        refreshToken: j.refresh_token,
        expiresAt: j.expires_in ? Date.now() + j.expires_in * 1000 : undefined,
        scopes: j.scope ? j.scope.split(/[\s,]+/).filter(Boolean) : [],
      };
    },
    async refresh(refreshToken) {
      // GitHub OAuth Apps don't issue refresh tokens by default; this
      // covers GitHub Apps + new OAuth flows that opt into refresh.
      const url = config.refreshUrl ?? config.tokenUrl;
      const res = await fetch(url, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
      });
      if (!res.ok) throw new Error(`github token refresh ${res.status}`);
      const j = (await res.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        error?: string;
      };
      if (j.error || !j.access_token) {
        throw new Error(`github token refresh failed: ${j.error ?? 'no access_token'}`);
      }
      return {
        accessToken: j.access_token,
        refreshToken: j.refresh_token ?? refreshToken,
        expiresAt: j.expires_in ? Date.now() + j.expires_in * 1000 : undefined,
      };
    },
    async introspect(token) {
      // GitHub: hit /user and read X-OAuth-Scopes header (works for any
      // token type — fine-grained PAT, classic PAT, or OAuth-app token).
      const res = await fetch('https://api.github.com/user', {
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
      });
      if (!res.ok) throw new Error(`github introspect ${res.status}`);
      const scopeHeader = res.headers.get('x-oauth-scopes') ?? '';
      const scopes = scopeHeader
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      return { scopes };
    },
  };
}

/* ─── Google Workspace installed-app provider ─── */

/** Scope required by the People API connections resource used for Contacts. */
export const GOOGLE_CONTACTS_READONLY_SCOPE = 'https://www.googleapis.com/auth/contacts.readonly';
export const GOOGLE_GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const GOOGLE_GMAIL_COMPOSE_SCOPE = 'https://www.googleapis.com/auth/gmail.compose';
export const GOOGLE_CALENDAR_READONLY_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
/** Optional Calendar write permission; requested only while the Calendar capability is enabled. */
export const GOOGLE_CALENDAR_EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

/**
 * Contacts validation must use `connections.list`. The superficially similar
 * `/v1/people/me` profile resource requires the `profile` scope and therefore
 * returns 403 for a token that correctly has only `contacts.readonly`.
 */
export const GOOGLE_CONTACTS_CONNECTIONS_ENDPOINT = 'https://people.googleapis.com/v1/people/me/connections';

export const GOOGLE_WORKSPACE_SCOPES = [
  GOOGLE_GMAIL_READONLY_SCOPE,
  GOOGLE_GMAIL_COMPOSE_SCOPE,
  GOOGLE_CALENDAR_READONLY_SCOPE,
  GOOGLE_CONTACTS_READONLY_SCOPE,
] as const;

/**
 * YouTube Data API scopes (social-platform-integrations-2026-08-23 P-015).
 *
 * `force-ssl` is the ONLY scope `comments.insert` accepts, and it also confers
 * DELETE rights on the authenticated channel's comments — which is why it is
 * requested per-capability rather than being folded into the default Workspace
 * set that every connection asks for.
 */
export const GOOGLE_YOUTUBE_READONLY_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
export const GOOGLE_YOUTUBE_FORCE_SSL_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';

/**
 * ⚠ D-019 — WHY THESE ARE HERE AND NOT IN `GOOGLE_WORKSPACE_SCOPES`.
 *
 * `GOOGLE_WORKSPACE_SCOPES` is the PRESUMED-GRANTED set: `googleGrantedScopes()`
 * falls back to it whole for any legacy connection that stored no scope
 * metadata. So a scope placed there is reported as granted for every such
 * connection whether or not the user ever consented to it — which would make an
 * ungranted YouTube capability read `connected: true`, `missingScopes: []`, and
 * fail only later with a 403 at call time, far from the cause.
 *
 * `GOOGLE_WORKSPACE_ALLOWED_SCOPES` is the set the authorize URL may REQUEST.
 * Adding a scope here lets the incremental-consent upgrade ask for it, while the
 * capability's own `requiredScopes` entry is what decides whether it was
 * actually granted. That is the same split `GOOGLE_CALENDAR_EVENTS_SCOPE`
 * already uses, and it is the reason it is not in the presumed set either.
 */
export const GOOGLE_WORKSPACE_ALLOWED_SCOPES = [
  ...GOOGLE_WORKSPACE_SCOPES,
  GOOGLE_CALENDAR_EVENTS_SCOPE,
  GOOGLE_YOUTUBE_READONLY_SCOPE,
  GOOGLE_YOUTUBE_FORCE_SSL_SCOPE,
] as const;

/**
 * The well-known Google Desktop-client JSON path, resolved when it is read
 * rather than at import, so it follows the process's current home directory.
 */
export function googleOAuthClientPath(): string {
  return join(homedir(), '.config', 'papercusp', 'google-oauth-client.json');
}

export interface GoogleDesktopClientConfig {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  redirectUri: string;
}

function googleTokenResponse(j: {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}): TokenResponse {
  if (j.error || !j.access_token) {
    throw new Error(`google oauth: ${j.error_description ?? j.error ?? 'no access_token in response'}`);
  }
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    expiresAt: j.expires_in ? Date.now() + j.expires_in * 1000 : undefined,
    scopes: j.scope ? j.scope.split(/\s+/).filter(Boolean) : undefined,
  };
}

function requireGooglePkce(privateContext?: OAuthFlowPrivateContext): string {
  const verifier = privateContext?.codeVerifier?.trim();
  if (!verifier) throw new Error('google oauth missing server-side PKCE verifier');
  return verifier;
}

/** Google Workspace OAuth for a locally installed desktop client. */
export function makeGoogleProvider(config: GoogleDesktopClientConfig): OAuthProvider {
  const cfg: OAuthProviderConfig = { ...config };
  return {
    id: 'google',
    config: cfg,
    defaultScopes: GOOGLE_WORKSPACE_SCOPES,
    allowedScopes: GOOGLE_WORKSPACE_ALLOWED_SCOPES,
    createFlowContext() {
      // 64 base64url characters, within RFC 7636's 43–128 character range.
      return { codeVerifier: b64url(randomBytes(48)) };
    },
    buildAuthorizeUrl(scopes, state, privateContext) {
      const verifier = requireGooglePkce(privateContext);
      const u = new URL(config.authorizeUrl);
      u.searchParams.set('client_id', config.clientId);
      u.searchParams.set('redirect_uri', config.redirectUri);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('access_type', 'offline');
      u.searchParams.set('include_granted_scopes', 'true');
      // Multi-account Google (D-004/P-005) depends on BOTH halves of this prompt.
      //
      // `select_account`: with no explicit prompt Google is free to reuse the
      // browser's active session and skip the account chooser entirely, so
      // "Add account" silently re-authorizes the account that is ALREADY
      // connected instead of the new one the owner meant to add.
      //
      // `consent`: access_type=offline only yields a refresh_token on the FIRST
      // authorization for a given client+account, and include_granted_scopes=true
      // turns this into an incremental-auth request that Google may satisfy with
      // no re-consent at all. Without forcing consent a re-authorized account
      // returns an access token and NO refresh token, which persists a credential
      // that dies at the first expiry with nothing to recover from.
      u.searchParams.set('prompt', 'select_account consent');
      u.searchParams.set('scope', (scopes.length ? scopes : GOOGLE_WORKSPACE_SCOPES).join(' '));
      u.searchParams.set('code_challenge', pkceChallenge(verifier));
      u.searchParams.set('code_challenge_method', 'S256');
      u.searchParams.set('state', state);
      return u.toString();
    },
    async exchangeCode(code, privateContext) {
      const verifier = requireGooglePkce(privateContext);
      const res = await fetch(config.tokenUrl, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: config.redirectUri,
          code_verifier: verifier,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as Parameters<typeof googleTokenResponse>[0];
      if (!res.ok && !j.error) throw new Error(`google oauth code exchange ${res.status}`);
      return googleTokenResponse(j);
    },
    async refresh(refreshToken) {
      const res = await fetch(config.tokenUrl, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: config.clientId,
          client_secret: config.clientSecret,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as Parameters<typeof googleTokenResponse>[0];
      if (!res.ok && !j.error) throw new Error(`google oauth token refresh ${res.status}`);
      const out = googleTokenResponse(j);
      return { ...out, refreshToken: out.refreshToken ?? refreshToken };
    },
  };
}

interface GoogleDesktopClientFile {
  installed?: {
    client_id?: string;
    client_secret?: string;
    auth_uri?: string;
    token_uri?: string;
  };
}

export function googleOAuthRedirectUri(): string {
  return (
    process.env.PAPERCUSP_GOOGLE_OAUTH_REDIRECT_URI ?? new URL('/api/oauth/callback', operatorApiBase()).toString()
  );
}

/**
 * Read the well-known Google Desktop-client JSON. Absence is an expected setup
 * wall and returns null; a present but malformed/non-Desktop credential fails
 * loudly so the operator does not silently expose an unknown provider.
 */
export async function loadGoogleProviderFromDesktopClientFile(
  path = googleOAuthClientPath(),
  redirectUri = googleOAuthRedirectUri(),
): Promise<OAuthProvider | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let parsed: GoogleDesktopClientFile;
  try {
    parsed = JSON.parse(raw) as GoogleDesktopClientFile;
  } catch {
    throw new Error(`google oauth client JSON is malformed: ${path}`);
  }
  const installed = parsed.installed;
  if (!installed?.client_id || !installed.client_secret) {
    throw new Error(`google oauth client must be a Desktop app credential: ${path}`);
  }
  const redirect = new URL(redirectUri);
  if (redirect.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname)) {
    throw new Error('google Desktop OAuth redirect must use an HTTP loopback host');
  }
  return makeGoogleProvider({
    clientId: installed.client_id,
    clientSecret: installed.client_secret,
    authorizeUrl: installed.auth_uri ?? 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: installed.token_uri ?? 'https://oauth2.googleapis.com/token',
    redirectUri: redirect.toString(),
  });
}

/* ─── Meta / Facebook provider ─── */

export const FACEBOOK_OAUTH_SCOPES = ['public_profile', 'user_posts', 'user_photos'] as const;

/**
 * Facebook PAGES scopes — allowed, never DEFAULT (D-019, D-024).
 *
 * ⚠ WHY THIS IS A SECOND CONSTANT INSTEAD OF FIVE MORE ENTRIES ABOVE. Until now
 * `defaultScopes` and `allowedScopes` on the facebook provider were THE SAME
 * ARRAY — literally the same `FACEBOOK_OAUTH_SCOPES` reference in both slots. So
 * "just add the Pages scopes to the list" would have silently added them to the
 * DEFAULT set as well, and the default set is a presumed-granted claim: a
 * connection created before Pages existed stores no scope metadata, and any
 * capability check that falls back to the default list would report those five
 * scopes as granted on it. The Pages read would then present as `connected` and
 * fail at call time instead of prompting the re-consent it actually needs.
 *
 * That is exactly the trap D-019 was written for on the Google provider, arriving
 * here through a different door — there the two lists were distinct and the
 * mistake would have been picking the wrong one; here they were the same object,
 * so there was no wrong one to pick and the only safe move is to SPLIT them.
 *
 * Every string below was resolved against the permissions REFERENCE, not the
 * getting-started tutorial, which names two scopes that do not exist (D-024).
 */
export const FACEBOOK_PAGES_OAUTH_SCOPES = [
  /** "allows your app to access the list of Pages a person manages" — required for the page-token exchange. */
  'pages_show_list',
  /** "read content (posts, photos, videos, events) posted by the Page". */
  'pages_read_engagement',
  /** "read user generated content on the Page, such as posts, comments, and ratings by users or other Pages". */
  'pages_read_user_content',
  /** "create, edit and delete your Page posts". */
  'pages_manage_posts',
  /** "create, edit and delete comments posted on the Page". */
  'pages_manage_engagement',
] as const;

/**
 * INSTAGRAM scopes — allowed, never DEFAULT, for exactly the reason above (P-017).
 *
 * ⚠ THIS LIST IS SHORTER THAN THE REGISTRY ROW'S, AND THAT IS THE POINT. The
 * `instagram` platform row names five scopes; only these three are new. The
 * other two — `pages_show_list` and `pages_read_engagement` — are already in the
 * Pages block above, because the "Instagram API with Facebook Login for
 * Business" flavor runs on a Facebook Page token and therefore inherits the Page
 * scopes rather than duplicating them. Restating them here would create two
 * sources of truth for one grant, which is how a later edit to one list silently
 * diverges from the other.
 *
 * The same inheritance answers a dependency the permissions reference states and
 * the registry row does not: `instagram_basic` depends on `pages_read_user_content`
 * (and `pages_show_list`). Both are already requestable through the Pages block,
 * so the dependency is satisfied without widening the consent surface — worth
 * recording because the natural reading of the registry row is that it is
 * missing, and the natural fix would have been to add a scope we already have.
 *
 * ⚠ D-024 FIRES ON THIS PLATFORM TOO, contrary to what the registry row said
 * until this item corrected it. The `/replies` edge reference lists
 * `page_read_engagement` — SINGULAR — among its required permissions, and no
 * such permission exists in the reference. Every string below was resolved
 * against the permissions REFERENCE, never against an endpoint's own page.
 */
export const INSTAGRAM_OAUTH_SCOPES = [
  /** "read an Instagram account profile's info and media" — depends on pages_read_user_content + pages_show_list. */
  'instagram_basic',
  /** "create organic feed photo and video posts on behalf of a business user". */
  'instagram_content_publish',
  /** "create, delete and hide comments on behalf of the Instagram account linked to a Page". */
  'instagram_manage_comments',
] as const;

/**
 * What a Facebook connection MAY request: the landed personal-vault scopes, the
 * Pages scopes, and the Instagram scopes — each granted only by an explicit
 * incremental consent, never presumed.
 */
export const FACEBOOK_ALLOWED_OAUTH_SCOPES = [
  ...FACEBOOK_OAUTH_SCOPES,
  ...FACEBOOK_PAGES_OAUTH_SCOPES,
  ...INSTAGRAM_OAUTH_SCOPES,
] as const;

/**
 * Threads scopes (P-018).
 *
 * ⚠⚠ DELIBERATELY **NOT** ADDED TO `FACEBOOK_ALLOWED_OAUTH_SCOPES` ABOVE, AND
 * THAT OMISSION IS THE POINT. Instagram's scopes belong there because the
 * Facebook-Login flavor authorizes through Facebook Login against
 * `graph.facebook.com`. Threads does not: its API host is `graph.threads.net`,
 * and its own Get Started guide describes a separate "Authorization Window" and
 * states that a Meta app configured for it has "2 app IDs and app secrets",
 * instructing you to "use the Threads app ID and its corresponding app secret".
 * Folding these strings into the Facebook consent surface would request Threads
 * permissions from the wrong authorization server under the wrong app id.
 *
 * ⚠ NO PROVIDER WIRING IS CLAIMED HERE, ON PURPOSE. P-018 verified these SCOPE
 * STRINGS against the permissions reference; it did NOT verify the Threads
 * authorization and token ENDPOINTS, because the Get Started page names neither
 * (it documents `GET /refresh_access_token` with no host and defers the rest to
 * a page not read). Declaring a `threads` provider from an unverified endpoint
 * guess is exactly the inherited-not-verified failure this plan exists to
 * avoid, and it would fail at consent time rather than at build time. The
 * remaining work is a NAMED gap — the authorization surface — rather than a
 * silent one, and the platform is owner-blocked on Meta app review regardless.
 *
 * Every string below was resolved against the permissions REFERENCE, never
 * against an endpoint page or the Threads overview — whose own scope list omits
 * `threads_read_replies` entirely.
 */
export const THREADS_OAUTH_SCOPES = [
  /** "get a user's Threads profile information and the media and text content that they posted". */
  'threads_basic',
  /** "create and publish content on behalf of a Threads profile". */
  'threads_content_publish',
  /** "create a reply on behalf of a Threads profile, hide or unhide replies to a thread". */
  'threads_manage_replies',
  /**
   * "read replies to a user's thread".
   *
   * ⚠ THE SCOPE THE THREADS OVERVIEW NEVER NAMES. Its scope callouts run
   * threads_basic / threads_content_publish / threads_manage_replies /
   * threads_delete / threads_location_tagging, so an integration built from
   * that page ships without the one permission its read path needs — and an
   * under-privileged read on this surface returns EMPTY rather than erroring
   * (D-027), so the symptom is "this profile has no replies", permanently.
   */
  'threads_read_replies',
] as const;

interface FacebookTokenBody {
  access_token?: string;
  expires_in?: number;
  error?: { message?: string };
}

function facebookToken(body: FacebookTokenBody, scopes = FACEBOOK_OAUTH_SCOPES): TokenResponse {
  const accessToken = body.access_token?.trim();
  if (!accessToken) {
    throw new Error('facebook oauth: ' + (body.error?.message ?? 'no access_token in response'));
  }
  return {
    accessToken,
    // Meta does not issue a distinct refresh token for this flow. Retaining the
    // current long-lived token in the refresh slot lets the shared token store
    // re-run the documented exchange before expiry without inventing a second
    // credential mechanism.
    refreshToken: accessToken,
    expiresAt: body.expires_in ? Date.now() + body.expires_in * 1000 : undefined,
    scopes: [...scopes],
  };
}

/** Facebook Login with an immediate server-side long-lived token exchange. */
export function makeFacebookProvider(config: OAuthProviderConfig): OAuthProvider {
  const exchangeLongLived = async (token: string): Promise<TokenResponse> => {
    const url = new URL(config.refreshUrl ?? config.tokenUrl);
    url.searchParams.set('grant_type', 'fb_exchange_token');
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('client_secret', config.clientSecret);
    url.searchParams.set('fb_exchange_token', token);
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    const body = (await response.json().catch(() => ({}))) as FacebookTokenBody;
    if (!response.ok && !body.error) throw new Error('facebook long-lived token exchange ' + response.status);
    return facebookToken(body);
  };
  return {
    id: 'facebook',
    config,
    // D-019: the DEFAULT set stays exactly what the landed personal-vault
    // connection already had. The Pages scopes are ALLOWED — requestable by an
    // explicit incremental consent — and never presumed granted.
    defaultScopes: FACEBOOK_OAUTH_SCOPES,
    allowedScopes: FACEBOOK_ALLOWED_OAUTH_SCOPES,
    buildAuthorizeUrl(scopes, state) {
      const url = new URL(config.authorizeUrl);
      url.searchParams.set('client_id', config.clientId);
      url.searchParams.set('redirect_uri', config.redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', (scopes.length ? scopes : FACEBOOK_OAUTH_SCOPES).join(','));
      url.searchParams.set('state', state);
      return url.toString();
    },
    async exchangeCode(code) {
      const url = new URL(config.tokenUrl);
      url.searchParams.set('client_id', config.clientId);
      url.searchParams.set('client_secret', config.clientSecret);
      url.searchParams.set('redirect_uri', config.redirectUri);
      url.searchParams.set('code', code);
      const response = await fetch(url, { headers: { accept: 'application/json' } });
      const body = (await response.json().catch(() => ({}))) as FacebookTokenBody;
      if (!response.ok && !body.error) throw new Error('facebook token exchange ' + response.status);
      const shortLived = facebookToken(body);
      return exchangeLongLived(shortLived.accessToken);
    },
    refresh(refreshToken) {
      return exchangeLongLived(refreshToken);
    },
  };
}

/* ─── Claude (Anthropic subscription) provider ─── */

/**
 * The well-known PUBLIC Claude Code OAuth client (PKCE; no client secret) + its endpoints,
 * used here to mint + refresh per-account `.credentials.json` bundles for the hive inference
 * gateway (hive-inference-gateway-2026-06-09 P-003/P-004). The values — and the EI-553 record
 * of how they were verified against the live `claude` CLI — live at the LEAF
 * (`@papercusp/papercusp-shared/agent` → `claude-oauth.ts`), because the stateless
 * `anthropic-direct` transport there refreshes the same bundle on an upstream rejection and
 * papercusp-shared cannot import operator-core. Re-exported here so this module stays the
 * name every existing consumer imports — one definition, no second copy to go stale the way
 * EI-553's did.
 */
export { CLAUDE_CODE_CLIENT_ID, CLAUDE_OAUTH_DEFAULTS };

export interface ClaudeProviderConfig {
  clientId?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  redirectUri?: string;
  /** The PKCE code_verifier for THIS authorize→exchange round-trip (login flow, P-004). */
  codeVerifier?: string;
}

/** base64url (no padding) of a buffer — the PKCE encoding. */
function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Derive the S256 PKCE code_challenge from a verifier. */
export function pkceChallenge(verifier: string): string {
  return b64url(createHash('sha256').update(verifier).digest());
}

function claudeTokenResponse(j: {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}): TokenResponse {
  if (j.error || !j.access_token) {
    throw new Error(`claude oauth: ${j.error_description ?? j.error ?? 'no access_token in response'}`);
  }
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    expiresAt: j.expires_in ? Date.now() + j.expires_in * 1000 : undefined,
    scopes: j.scope ? j.scope.split(/\s+/).filter(Boolean) : undefined,
  };
}

/**
 * Claude/Anthropic subscription OAuth provider. `refresh()` is the P-003 deliverable —
 * a plain `grant_type=refresh_token` form post that `getOAuthToken` drives on near-expiry;
 * `buildAuthorizeUrl`/`exchangeCode` are the PKCE login round-trip (P-004), which needs the
 * `codeVerifier` set on the config for that one flow.
 */
export function makeClaudeProvider(config: ClaudeProviderConfig = {}): OAuthProvider {
  const clientId = config.clientId ?? process.env.CLAUDE_OAUTH_CLIENT_ID ?? CLAUDE_OAUTH_DEFAULTS.clientId;
  const authorizeUrl =
    config.authorizeUrl ?? process.env.CLAUDE_OAUTH_AUTHORIZE_URL ?? CLAUDE_OAUTH_DEFAULTS.authorizeUrl;
  const tokenUrl = config.tokenUrl ?? process.env.CLAUDE_OAUTH_TOKEN_URL ?? CLAUDE_OAUTH_DEFAULTS.tokenUrl;
  const redirectUri = config.redirectUri ?? process.env.CLAUDE_OAUTH_REDIRECT_URI ?? CLAUDE_OAUTH_DEFAULTS.redirectUri;
  const cfg: OAuthProviderConfig = { clientId, clientSecret: '', authorizeUrl, tokenUrl, redirectUri };

  return {
    id: 'claude',
    config: cfg,
    buildAuthorizeUrl(scopes, state) {
      const u = new URL(authorizeUrl);
      u.searchParams.set('code', 'true');
      u.searchParams.set('client_id', clientId);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('redirect_uri', redirectUri);
      u.searchParams.set('scope', (scopes.length ? scopes : [...CLAUDE_OAUTH_DEFAULTS.scopes]).join(' '));
      if (config.codeVerifier) {
        u.searchParams.set('code_challenge', pkceChallenge(config.codeVerifier));
        u.searchParams.set('code_challenge_method', 'S256');
      }
      u.searchParams.set('state', state);
      return u.toString();
    },
    async exchangeCode(code) {
      // claude.ai presents the code as `code#state`; the token endpoint wants them split.
      const [rawCode, stateFromCode] = code.split('#');
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: rawCode,
        redirect_uri: redirectUri,
        client_id: clientId,
      });
      if (stateFromCode) body.set('state', stateFromCode);
      if (config.codeVerifier) body.set('code_verifier', config.codeVerifier);
      const res = await fetch(tokenUrl, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
      const j = (await res.json().catch(() => ({}))) as Parameters<typeof claudeTokenResponse>[0];
      if (!res.ok && !j.error) throw new Error(`claude oauth code exchange ${res.status}`);
      return claudeTokenResponse(j);
    },
    async refresh(refreshToken) {
      const res = await fetch(tokenUrl, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientId,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as Parameters<typeof claudeTokenResponse>[0];
      if (!res.ok && !j.error) throw new Error(`claude oauth token refresh ${res.status}`);
      const out = claudeTokenResponse(j);
      // Anthropic ROTATES the refresh token on use; fall back to the old one only if the
      // response omits a new one (so we never persist an empty refresh token).
      return { ...out, refreshToken: out.refreshToken ?? refreshToken };
    },
  };
}

/* ─── Registry ─── */

const registry = new Map<string, OAuthProvider>();

export function registerProvider(provider: OAuthProvider): void {
  registry.set(provider.id, provider);
}

export function getProvider(id: string): OAuthProvider | null {
  return registry.get(id) ?? null;
}

export function listProviderIds(): string[] {
  return [...registry.keys()];
}

/* ─── Bootstrap from disk ─── */

interface OAuthAppsFile {
  [providerId: string]: {
    clientId: string;
    clientSecret?: string;
    clientSecretFile?: string;
    authorizeUrl?: string;
    tokenUrl?: string;
    refreshUrl?: string;
    userInfoUrl?: string;
    introspectUrl?: string;
    redirectUri: string;
  };
}

const DEFAULT_GITHUB_ENDPOINTS = {
  authorizeUrl: 'https://github.com/login/oauth/authorize',
  tokenUrl: 'https://github.com/login/oauth/access_token',
  userInfoUrl: 'https://api.github.com/user',
};

const DEFAULT_FACEBOOK_ENDPOINTS = {
  authorizeUrl: 'https://www.facebook.com/dialog/oauth',
  tokenUrl: 'https://graph.facebook.com/oauth/access_token',
};

async function readClientSecret(entry: OAuthAppsFile[string]): Promise<string> {
  if (entry.clientSecret) return entry.clientSecret;
  if (entry.clientSecretFile) {
    const raw = await fs.readFile(entry.clientSecretFile, 'utf8');
    return raw.trim();
  }
  throw new Error('OAuth provider missing clientSecret / clientSecretFile');
}

/**
 * Load oauth-apps.json from `$PAPERCUSP_HOME` (or `~/.papercusp`) and
 * register each provider. Idempotent — calling again replaces existing
 * registrations.
 */
export async function loadAndRegisterProvidersFromDisk(
  rootDir?: string,
  googleClientPath: string | null = googleOAuthClientPath(),
): Promise<string[]> {
  const { papercuspRoot } = await import('../papercusp-root');
  const root = rootDir ?? papercuspRoot();
  const path = join(root, 'oauth-apps.json');
  let raw: string | null = null;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch {
    // No legacy provider file configured. Google has its own well-known path.
  }
  const registered: string[] = [];
  let parsed: OAuthAppsFile = {};
  if (raw !== null) {
    try {
      parsed = JSON.parse(raw) as OAuthAppsFile;
    } catch {
      parsed = {};
    }
    for (const [id, entry] of Object.entries(parsed)) {
      let clientSecret: string;
      try {
        clientSecret = await readClientSecret(entry);
      } catch {
        continue;
      }
      if (id === 'github') {
        const cfg: OAuthProviderConfig = {
          clientId: entry.clientId,
          clientSecret,
          authorizeUrl: entry.authorizeUrl ?? DEFAULT_GITHUB_ENDPOINTS.authorizeUrl,
          tokenUrl: entry.tokenUrl ?? DEFAULT_GITHUB_ENDPOINTS.tokenUrl,
          refreshUrl: entry.refreshUrl,
          userInfoUrl: entry.userInfoUrl ?? DEFAULT_GITHUB_ENDPOINTS.userInfoUrl,
          introspectUrl: entry.introspectUrl,
          redirectUri: entry.redirectUri,
        };
        registerProvider(makeGithubProvider(cfg));
        registered.push('github');
      }
      if (id === 'facebook') {
        const cfg: OAuthProviderConfig = {
          clientId: entry.clientId,
          clientSecret,
          authorizeUrl: entry.authorizeUrl ?? DEFAULT_FACEBOOK_ENDPOINTS.authorizeUrl,
          tokenUrl: entry.tokenUrl ?? DEFAULT_FACEBOOK_ENDPOINTS.tokenUrl,
          refreshUrl: entry.refreshUrl ?? entry.tokenUrl ?? DEFAULT_FACEBOOK_ENDPOINTS.tokenUrl,
          userInfoUrl: entry.userInfoUrl ?? 'https://graph.facebook.com/me',
          redirectUri: entry.redirectUri,
        };
        registerProvider(makeFacebookProvider(cfg));
        registered.push('facebook');
      }
      // V2: slack, linear, notion, jira providers.
    }
  }
  if (googleClientPath !== null) {
    const google = await loadGoogleProviderFromDesktopClientFile(googleClientPath);
    if (google) {
      registerProvider(google);
      registered.push('google');
    }
  }
  return registered;
}

/** Test-only: clear the registry. */
export function __resetRegistryForTest(): void {
  registry.clear();
}

/* ─── Scope verification ─── */

export type ScopeVerificationOutcome =
  | { kind: 'exact' }
  | { kind: 'superset'; extra: string[] }
  | { kind: 'subset'; missing: string[] };

export function compareScopes(granted: string[], required: string[]): ScopeVerificationOutcome {
  const g = new Set(granted);
  const missing = required.filter((s) => !g.has(s));
  if (missing.length > 0) return { kind: 'subset', missing };
  const r = new Set(required);
  const extra = granted.filter((s) => !r.has(s));
  if (extra.length > 0) return { kind: 'superset', extra };
  return { kind: 'exact' };
}
