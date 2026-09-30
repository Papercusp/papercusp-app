/**
 * APNs + FCM credential management.
 *
 * APNs uses a stateless JWT signed with an EC P-256 key (P8 file). Tokens
 * expire after 60 minutes; we refresh every 50 minutes to leave headroom.
 *
 * FCM v1 uses a service-account JWT exchanged at the Google OAuth endpoint
 * for an access token, also valid 60 minutes; same refresh cadence.
 *
 * Refreshed tokens are cached in module state and surfaced via env-vars on
 * the *current* process so the existing dispatcher reads them transparently.
 */
import { readFileSync, existsSync } from 'node:fs';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import { createSign, createPrivateKey } from 'node:crypto';
import { dbosTimersActive } from './dbos/dbos-flags';

const APNS_KEY_PATH = process.env.APNS_KEY_PATH ?? '';        // path to AuthKey_<KEY_ID>.p8
const APNS_KEY_ID = process.env.APNS_KEY_ID ?? '';            // 10-char Key ID
const APNS_TEAM_ID = process.env.APNS_TEAM_ID ?? '';          // 10-char Team ID

const FCM_SA_PATH = process.env.FCM_SERVICE_ACCOUNT_PATH ?? '';

const REFRESH_INTERVAL_MS = 50 * 60 * 1000;                   // 50 min
const TOKEN_TTL_S = 60 * 60;                                  // 60 min

let started = false;

export function startPushCredentialRefresher(): void {
  if (started) return;
  // DBOS owns the refresh as a scheduled workflow (consolidation P-003); the
  // legacy in-process timer stands down on the SAME predicate as the
  // periodic-workflows registration, so exactly one fires.
  if (dbosTimersActive()) return;
  started = true;
  if (!APNS_KEY_PATH && !FCM_SA_PATH) {
    console.log('[push-creds] no credentials configured; dispatcher disabled');
    return;
  }
  refreshAll().catch((e) => console.error('[push-creds] initial refresh', e));
  managedSetInterval('device-push-credentials-refresh', REFRESH_INTERVAL_MS, () => {
    refreshAll().catch((e) => console.error('[push-creds] periodic refresh', e));
  }, { category: 'cache' });
}

/** One refresh pass (APNs + FCM). Called by the DBOS scheduled workflow
 *  (`pushCredentialsRefresh`, consolidation P-003) and the legacy timer. */
export async function refreshAll(): Promise<void> {
  await Promise.allSettled([refreshApns(), refreshFcm()]);
}

// ── APNs ──────────────────────────────────────────────────────────────
async function refreshApns(): Promise<void> {
  if (!APNS_KEY_PATH || !APNS_KEY_ID || !APNS_TEAM_ID) return;
  if (!existsSync(APNS_KEY_PATH)) {
    console.warn(`[push-creds] APNS_KEY_PATH does not exist: ${APNS_KEY_PATH}`);
    return;
  }
  const pem = readFileSync(APNS_KEY_PATH, 'utf8');
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: APNS_KEY_ID }));
  const payload = b64url(
    JSON.stringify({ iss: APNS_TEAM_ID, iat: now, exp: now + TOKEN_TTL_S }),
  );
  const signingInput = `${header}.${payload}`;
  const key = createPrivateKey({ key: pem, format: 'pem' });
  const sig = createSign('SHA256').update(signingInput).sign({ key, dsaEncoding: 'ieee-p1363' });
  const jwt = `${signingInput}.${b64url(sig)}`;
  process.env.APNS_AUTH_TOKEN = jwt;
  console.log(`[push-creds] APNs token refreshed (kid=${APNS_KEY_ID})`);
}

// ── FCM v1 (service account → OAuth access token) ─────────────────────
interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
  token_uri: string;
}

async function refreshFcm(): Promise<void> {
  if (!FCM_SA_PATH) return;
  if (!existsSync(FCM_SA_PATH)) {
    console.warn(`[push-creds] FCM_SERVICE_ACCOUNT_PATH does not exist: ${FCM_SA_PATH}`);
    return;
  }
  const sa: ServiceAccount = JSON.parse(readFileSync(FCM_SA_PATH, 'utf8'));
  const now = Math.floor(Date.now() / 1000);

  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: sa.token_uri,
      iat: now,
      exp: now + TOKEN_TTL_S,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const key = createPrivateKey({ key: sa.private_key, format: 'pem' });
  const sig = createSign('RSA-SHA256').update(signingInput).sign(key);
  const jwt = `${signingInput}.${b64url(sig)}`;

  // Exchange JWT for access token
  const res = await fetch(sa.token_uri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    console.warn(`[push-creds] FCM token exchange ${res.status}: ${await res.text().catch(() => '')}`);
    return;
  }
  const body = (await res.json()) as { access_token: string; expires_in: number };
  process.env.FCM_OAUTH_TOKEN = body.access_token;
  process.env.FCM_PROJECT_ID = sa.project_id;
  console.log(`[push-creds] FCM token refreshed (project=${sa.project_id})`);
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}
