/**
 * APNs + FCM dispatcher. Sends a push to every registered device when:
 *   - A harness escalates (intervention required)
 *   - A smoke test fails
 *   - A ≥high attention item appears (needs-human / owner-gated / questions)
 *   - User-defined notification rules fire (future)
 *
 * Registered tokens live in harness_shared.mobile_push_tokens (migration 009).
 *
 * ── Credentials (mobile-apps-revival-v2-2026-07-13 P-005/P-006) ──────────────
 * Both providers now mint their auth token IN-PROCESS from a stored credential,
 * rather than expecting a pre-signed token env var refreshed by an external
 * hourly job that never existed (the pre-revival design silently no-op'd because
 * FCM_OAUTH_TOKEN / APNS_AUTH_TOKEN were never populated).
 *
 *   - FCM  (Android, LIVE): a Google service-account JSON at
 *          FCM_SERVICE_ACCOUNT_PATH (default ~/.papercusp/firebase-admin.json).
 *          google-auth-library signs a JWT → exchanges it for a short-lived
 *          OAuth access token and caches/refreshes it internally. HTTP v1 send.
 *   - APNs (iOS, DORMANT until Apple Developer enrollment — owner-gated): a P8
 *          key at APNS_KEY_PATH + APNS_KEY_ID + APNS_TEAM_ID. `jose` signs the
 *          ES256 provider JWT (cached ~50 min). Sent over HTTP/2 (APNs rejects
 *          HTTP/1.1). Absent creds ⇒ cleanly skipped, so iOS registration is
 *          harmless while push is not yet enrolled.
 *
 * Credentials stay on THIS box; payload contents are kept generic so nothing
 * sensitive traverses APNs/FCM. Push tokens themselves go through APNs/FCM by
 * definition; that's unavoidable on iOS/Android.
 */
import { connect as http2Connect } from 'node:http2';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';

/**
 * Push-routing kinds understood by the mobile app's `push-routing.ts`.
 * Keep in sync there. New kinds default to opening the Notifications screen.
 */
export type PushKind =
  | 'intervention'
  | 'smoke-fail'
  | 'operator-suggestion';

interface PushPayload {
  /** Short title shown on lock screen */
  title: string;
  /** Body shown on lock screen — kept generic to avoid leaking content via APNs */
  body: string;
  /**
   * Free-form data the app uses to route on tap. Conventional keys:
   *   kind:    one of PushKind
   *   harness: harness slug to deep-link into
   *   card_id: operator card id (for kind='operator-suggestion')
   */
  data: Record<string, string> & { kind?: PushKind };
  /** Notification category for actions (intervention | smoke-fail) */
  category?: string;
}

interface DeviceTarget {
  platform: 'apns' | 'fcm';
  token: string;
}

/** Outcome of a single provider send — surfaced for logging/tests, never thrown. */
export interface PushSendResult {
  platform: 'apns' | 'fcm';
  ok: boolean;
  /** 'skipped' when the provider is not configured (no creds). */
  status: number | 'skipped' | 'error';
  detail?: string;
  /** The provider says this TOKEN is permanently invalid (FCM `UNREGISTERED`, APNs `410
   *  Unregistered`) — the app was uninstalled, the data cleared, or the token rotated.
   *  Distinct from `ok: false`, which is usually transient (5xx, network, an unconfigured
   *  provider). Only this flag licenses deleting the row; see `isFcmTokenPermanentlyInvalid`
   *  and `isApnsTokenPermanentlyInvalid`. Optional so no existing fixture that builds a
   *  PushSendResult is stranded. */
  unregistered?: boolean;
}

/**
 * PURE: does this FCM v1 failure mean the TOKEN is permanently dead rather than the send
 * being transiently unlucky?
 *
 * FCM's documented contract is explicit that the caller must stop using such a token: a
 * `404` carrying `errorCode: "UNREGISTERED"` (equivalently the legacy `NotRegistered`) is
 * returned when the app was uninstalled, its data cleared, or the token rotated — it will
 * NEVER succeed again. We never acted on it, so a dead token stayed registered forever and
 * every subsequent push re-404'd against it.
 *
 * Measured 2026-08-09 (harness_shared.attention_notifications, the WI-36644 receipt):
 * **0 of 141 mobile pushes succeeded** in the entire audited window. The papercusp-workspace
 * rows are three non-revoked FCM tokens registered 2026-07-15/16/17 whose devices were last
 * seen 2026-07-19 — three weeks of urgent owner pages (including "6 reachable agents were
 * disarmed", 08:07:07Z) attempting delivery to phones that had been gone for weeks, while
 * `pushTargetsForWorkspace` kept reporting three live targets.
 *
 * ⚠ Deliberately NARROW, and the narrowness is the point: this authorises a DELETE. A 5xx, a
 * network error, an expired service-account credential and an unconfigured provider
 * (`status: 'skipped'`) are all `ok: false` too, and pruning on any of those would silently
 * unregister a device that is perfectly alive the next time the provider hiccups — trading a
 * rail that is dead-but-visible for one that deletes itself. So both the status AND the
 * provider's own error code must agree, and anything unparseable answers `false` (fail-CLOSED
 * on deletion, which is the safe direction for an irreversible write).
 */
export function isFcmTokenPermanentlyInvalid(status: number | 'skipped' | 'error', body: string): boolean {
  if (status !== 404) return false;
  return /"errorCode"\s*:\s*"UNREGISTERED"/.test(body) || /"message"\s*:\s*"NotRegistered"/.test(body);
}

/**
 * PURE: the APNs half of the same contract — and deliberately NARROWER than the error list a
 * reader would expect, for a reason worth stating.
 *
 * Apple documents exactly one response meaning "this token is dead, stop sending": HTTP **410**
 * carrying `reason: "Unregistered"`. That is the only case accepted here, mirroring the
 * fail-CLOSED stance above, because the two codes that LOOK equally terminal are not:
 *
 *   - `400 BadDeviceToken` is returned when a PRODUCTION token is sent to the sandbox host or
 *     the reverse — i.e. when `APNS_HOST` is wrong. Configuration, not a dead device.
 *   - `400 DeviceTokenNotForTopic` is returned when `APNS_BUNDLE_ID` does not match the token's
 *     app. Also configuration, not a dead device.
 *
 * Both are FLEET-WIDE conditions: one wrong env var makes EVERY live iOS token report them on
 * the very next send. Reaping on either would turn a one-line config typo into the irreversible
 * deletion of every paired iPhone's only address — the "deletes itself" failure the comment
 * above warns about, at maximum blast radius and with no way back. So they are excluded by
 * construction: a misconfigured host keeps a rail that is dead-but-VISIBLE, which is the
 * recoverable direction.
 *
 * NOTE the asymmetry with FCM: there the terminal status is 404, here it is 410. A 404 from
 * APNs means the `:path` was malformed, NOT that the token is dead — so the statuses must not
 * be shared between the two classifiers.
 */
export function isApnsTokenPermanentlyInvalid(status: number | 'skipped' | 'error', body: string): boolean {
  if (status !== 410) return false;
  return /"reason"\s*:\s*"Unregistered"/.test(body);
}

/**
 * PURE: which targets should be REAPED, given the results of dispatching to them?
 *
 * Kept pure and exported because it authorises an irreversible DELETE, so it deserves to be
 * falsifiable on its own — the safety property ("a transient failure is never reaped") is a
 * statement about this function, not about the network path that happens to call it.
 *
 * Index correspondence is the contract it relies on: `dispatchPush` maps EVERY branch through
 * `settled.map((s, i) => …)`, including the rejected one, so `results[i]` always describes
 * `targets[i]`. A defensive length check makes a future divergence fail closed (reap nothing)
 * rather than reap by a shifted index — deleting the WRONG live device's token would be a
 * strictly worse outcome than leaving a dead one registered.
 */
export function tokensToReap(
  targets: readonly DeviceTarget[],
  results: readonly PushSendResult[],
): DeviceTarget[] {
  if (results.length !== targets.length) return [];
  return targets.filter((_, i) => results[i]?.unregistered === true);
}

export async function dispatchPush(
  targets: DeviceTarget[],
  payload: PushPayload,
): Promise<PushSendResult[]> {
  const settled = await Promise.allSettled(
    targets.map((t) =>
      t.platform === 'apns' ? sendApns(t.token, payload) : sendFcm(t.token, payload),
    ),
  );
  return settled.map((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      : { platform: targets[i].platform, ok: false, status: 'error', detail: String(s.reason) },
  );
}

// ── FCM (Android) ────────────────────────────────────────────────────────────

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

interface FcmCreds {
  getAccessToken: () => Promise<string>;
  projectId: string;
}
let _fcm: FcmCreds | null | undefined; // undefined = not resolved yet; null = unavailable

/**
 * WHY `_fcm` is null. `null` used to mean only "unconfigured", and every caller rendered it as
 * `status: 'skipped'` — a benign, expected no-op. That conflation hid a total outage for the
 * whole audited window (WI-37482): **91 of 141 mobile pushes reported `fcm:skipped` while the
 * service account was present and perfectly valid**, because `resolveFcmCreds` threw
 * `require is not defined` and the catch below flattened a hard failure into the same `null`
 * that "no push configured on this host" produces.
 *
 * A genuinely absent credential file (ENOENT) IS a skip — most hosts never configure push, and
 * that must stay silent. Anything else is a FAULT and now says so, so the next breakage of this
 * kind surfaces as an error instead of looking like a host that simply has no phone paired.
 */
let _fcmFailure: string | null = null;

/** CJS interop: this module is loaded as ESM by the hosts that serve pushes (bg-host runs it
 *  through tsx straight from the tree), where a bare `require` is NOT defined — that is the
 *  exact fault above. `createRequire` is the established idiom here (native-addon-preflight.ts,
 *  boot-integrity-preflight.ts, plugin-host-runtime.ts). */
const requireCjs = createRequire(import.meta.url);

/**
 * Resolve (once) the FCM service-account credential + a token minter.
 * Uses google-auth-library's JWT client, which signs a service-account JWT and
 * caches/refreshes the OAuth access token internally. Returns null (memoized)
 * when no service account is configured or the file can't be read.
 */
export function resolveFcmCreds(): FcmCreds | null {
  if (_fcm !== undefined) return _fcm;
  const path =
    process.env.FCM_SERVICE_ACCOUNT_PATH ?? `${homedir()}/.papercusp/firebase-admin.json`;
  try {
    const raw = readFileSync(path, 'utf8');
    const sa = JSON.parse(raw) as {
      client_email?: string;
      private_key?: string;
      project_id?: string;
    };
    if (!sa.client_email || !sa.private_key || !sa.project_id) {
      console.warn(`[push] FCM service account at ${path} is missing required fields; skipping FCM`);
      _fcmFailure = `service account at ${path} is missing required fields`;
      _fcm = null;
      return _fcm;
    }
    // Lazy require so the (heavy) auth lib only loads when push is actually configured.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { JWT } = requireCjs('google-auth-library') as typeof import('google-auth-library');
    const client = new JWT({
      email: sa.client_email,
      key: sa.private_key,
      scopes: [FCM_SCOPE],
    });
    _fcmFailure = null; // resolved cleanly — clear any prior fault before memoizing success
    _fcm = {
      projectId: sa.project_id,
      getAccessToken: async () => {
        const { token } = await client.getAccessToken();
        if (!token) throw new Error('FCM getAccessToken returned empty token');
        return token;
      },
    };
    return _fcm;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // ENOENT = push was simply never configured on this host: the expected, silent case.
    // Anything else is a FAULT wearing the same `null` — record it so it REPORTS as one.
    const unconfigured = (e as NodeJS.ErrnoException)?.code === 'ENOENT';
    _fcmFailure = unconfigured ? null : `${path}: ${msg}`;
    console.warn(
      unconfigured
        ? `[push] no FCM service account at ${path}; skipping FCM`
        : `[push] FCM service account NOT USABLE (${path}): ${msg} — this is a FAULT, not an unconfigured host`,
    );
    _fcm = null;
    return _fcm;
  }
}

/** Test-only: reset the memoized FCM creds so a test can re-resolve with new env. */
export function __resetPushCredsForTest(): void {
  _fcm = undefined;
  _fcmFailure = null;
  _apnsJwt = null;
}

/** Build the FCM v1 request body for a device token + payload (pure; unit-tested). */
export function buildFcmMessage(deviceToken: string, payload: PushPayload) {
  return {
    message: {
      token: deviceToken,
      notification: { title: payload.title, body: payload.body },
      // FCM data values MUST be strings.
      data: payload.data,
      android: { priority: 'HIGH' as const },
    },
  };
}

async function sendFcm(deviceToken: string, payload: PushPayload): Promise<PushSendResult> {
  const creds = resolveFcmCreds();
  if (!creds) {
    // A configured-but-broken provider is an ERROR, not a skip (WI-37482).
    return _fcmFailure
      ? { platform: 'fcm', ok: false, status: 'error', detail: _fcmFailure }
      : { platform: 'fcm', ok: false, status: 'skipped' };
  }
  let accessToken: string;
  try {
    accessToken = await creds.getAccessToken();
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.warn(`[push] fcm token mint failed: ${detail}`);
    return { platform: 'fcm', ok: false, status: 'error', detail };
  }
  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${creds.projectId}/messages:send`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(buildFcmMessage(deviceToken, payload)),
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.warn(`[push] fcm ${res.status}: ${detail}`);
    const unregistered = isFcmTokenPermanentlyInvalid(res.status, detail);
    return { platform: 'fcm', ok: false, status: res.status, detail, ...(unregistered ? { unregistered } : {}) };
  }
  return { platform: 'fcm', ok: true, status: res.status };
}

// ── APNs (iOS) — dormant until Apple Developer enrollment (owner-gated) ───────

interface ApnsJwt {
  jwt: string;
  mintedAtMs: number;
}
let _apnsJwt: ApnsJwt | null = null;
const APNS_JWT_TTL_MS = 50 * 60 * 1000; // Apple recommends refreshing < 60 min.

/**
 * Mint (and cache ~50 min) the APNs provider JWT (ES256) from the .p8 key.
 * Returns null when APNs is not configured. An explicit APNS_AUTH_TOKEN (a
 * pre-signed JWT) short-circuits and is used verbatim — handy for a smoke test.
 */
async function resolveApnsJwt(): Promise<string | null> {
  const override = process.env.APNS_AUTH_TOKEN;
  if (override) return override;
  const keyPath = process.env.APNS_KEY_PATH;
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  if (!keyPath || !keyId || !teamId) return null; // dormant — not enrolled yet
  const now = Date.now();
  if (_apnsJwt && now - _apnsJwt.mintedAtMs < APNS_JWT_TTL_MS) return _apnsJwt.jwt;
  const p8 = readFileSync(keyPath, 'utf8');
  // Lazy require so jose only loads when APNs is actually configured.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  // Same ESM fault as the FCM leg (WI-37482) — a bare `require` is not defined in the hosts
  // that serve pushes. Dormant today (APNs waits on Apple enrollment), which is exactly why it
  // would otherwise have shipped broken and only surfaced when iOS was switched on.
  const { SignJWT, importPKCS8 } = requireCjs('jose') as typeof import('jose');
  const key = await importPKCS8(p8, 'ES256');
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: keyId })
    .setIssuedAt()
    .setIssuer(teamId)
    .sign(key);
  _apnsJwt = { jwt, mintedAtMs: now };
  return jwt;
}

async function sendApns(deviceToken: string, payload: PushPayload): Promise<PushSendResult> {
  const jwt = await resolveApnsJwt();
  if (!jwt) return { platform: 'apns', ok: false, status: 'skipped' };
  const bundleId = process.env.APNS_BUNDLE_ID ?? 'com.papercuspai.operator.mobile';
  const host = process.env.APNS_HOST ?? 'https://api.push.apple.com'; // sandbox: api.sandbox.push.apple.com
  const body = JSON.stringify({
    aps: {
      alert: { title: payload.title, body: payload.body },
      sound: 'default',
      category: payload.category,
      'mutable-content': 1,
    },
    ...payload.data,
  });
  // APNs is HTTP/2 only. Open a short-lived session per send (low volume).
  return await new Promise<PushSendResult>((resolve) => {
    const client = http2Connect(host);
    let settled = false;
    const done = (r: PushSendResult) => {
      if (settled) return;
      settled = true;
      client.close();
      resolve(r);
    };
    client.on('error', (e) => done({ platform: 'apns', ok: false, status: 'error', detail: String(e) }));
    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      'apns-topic': bundleId,
      'apns-push-type': 'alert',
      authorization: `bearer ${jwt}`,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    });
    let status = 0;
    let detail = '';
    req.on('response', (h) => {
      status = Number(h[':status'] ?? 0);
    });
    req.setEncoding('utf8');
    req.on('data', (c) => (detail += c));
    req.on('end', () => {
      const unregistered = isApnsTokenPermanentlyInvalid(status || 'error', detail);
      if (!(status > 0 && status < 300)) console.warn(`[push] apns ${status || 'error'}: ${detail}`);
      done({
        platform: 'apns',
        ok: status > 0 && status < 300,
        status: status || 'error',
        detail: detail || undefined,
        ...(unregistered ? { unregistered } : {}),
      });
    });
    req.on('error', (e) => done({ platform: 'apns', ok: false, status: 'error', detail: String(e) }));
    req.write(body);
    req.end();
  });
}

/** True when at least one push provider is actually configured on this host. */
export function pushEnabled(): { fcm: boolean; apns: boolean } {
  const fcm = !!resolveFcmCreds();
  const apns =
    !!process.env.APNS_AUTH_TOKEN ||
    (!!process.env.APNS_KEY_PATH && !!process.env.APNS_KEY_ID && !!process.env.APNS_TEAM_ID);
  return { fcm, apns };
}

/** Convenience: load registered tokens for a workspace + dispatch a push.
 *
 *  Also REAPS tokens the provider has declared permanently invalid. This is the only place
 *  that can: `dispatchPush` is deliberately store-free (it takes targets and returns results,
 *  which is what makes it unit-testable without a database), while this function already
 *  holds both the workspace and the target list. `dispatchPush` preserves index
 *  correspondence with `targets` — every branch maps through `settled.map((s, i) => …)` — so
 *  zipping result[i] back to targets[i] is sound, not incidental.
 *
 *  Reaping is best-effort and swallowed: this helper sits under `notifyAttention`, whose
 *  entire contract is that a delivery problem must never propagate into the producer's write
 *  path. A prune that fails just means the dead token is retried next time — the status quo. */
export async function notifyWorkspace(
  workspaceId: string,
  payload: PushPayload,
  deps?: { dispatch?: (t: DeviceTarget[], p: PushPayload) => Promise<PushSendResult[]> },
): Promise<PushSendResult[]> {
  const { pushTargetsForWorkspace } = await import('./device-store');
  const targets = await pushTargetsForWorkspace(workspaceId);
  if (targets.length === 0) return [];
  const results = await (deps?.dispatch ?? dispatchPush)(targets, payload);

  const dead = tokensToReap(targets, results);
  if (dead.length > 0) {
    try {
      const { deletePushToken } = await import('./device-store');
      for (const t of dead) {
        await deletePushToken(workspaceId, t.token);
        console.warn(
          `[push] reaped ${t.platform} token …${t.token.slice(-8)} in ${workspaceId} — the provider ` +
            `reports it UNREGISTERED (app uninstalled / data cleared / token rotated), so it can never ` +
            `succeed again. The device must re-register to receive pushes.`,
        );
      }
    } catch (e) {
      console.warn(`[push] token reap failed (${dead.length} dead): ${e instanceof Error ? e.message : e}`);
    }
  }
  return results;
}
