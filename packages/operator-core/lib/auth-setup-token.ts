/**
 * First-password-setup token (EI-347).
 *
 * `/auth/change-password` is `auth: 'loopback'` (not a strict session gate) so the
 * cookie-less desktop webview can reach it (EI-338). `changePassword()` is "safe"
 * against a caller who already HAS a password (it verifies `current` before
 * allowing a change) — but the freshly-seeded `default` user boots with
 * `password_hash = NULL`, and the current-password check is skipped entirely in
 * that state (`if (current_hash !== null)`). Any process that can reach the
 * loopback HTTP port — not just the legitimate desktop app — can therefore POST
 * `{current: null, next: "theirs"}` and permanently claim the unconfigured
 * account before the real owner ever sets a password. Loopback binding narrows
 * this to LOCAL callers, but "local process" and "the app's own operator" are not
 * the same trust boundary (a sibling process, a compromised script, another OS
 * user on a shared box, all reach 127.0.0.1 too).
 *
 * Fix (this item's own "correct-state sketch" option (b), the same pattern
 * Jupyter/Grafana use for first-run credential bootstrap): generate ONE random
 * token per process lifetime, print it to the operator's own console/log at
 * boot, and require it — in addition to the existing loopback+CSRF gates — on
 * any `/auth/change-password` call that targets a password-less account. A
 * caller with only network reachability to the loopback port cannot read the
 * operator's own log; a caller who genuinely owns/runs the process can. Once a
 * password is set the token stops mattering (current_hash is no longer null,
 * so the normal current-password check takes back over for that account) — no
 * separate invalidation/expiry is needed.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Env var carrying the PRIMARY's token to each forked request worker.
 *
 * WI-10001497: `cachedToken` below is module state, so it is per-PROCESS. The
 * host sets `reusePort: true` and `cluster-fork.ts` forks N request workers, so
 * the kernel load-balances the change-password POST onto an ARBITRARY worker —
 * one that minted its own, DIFFERENT token. A code the operator copied was
 * therefore accepted only when the request happened to land on the worker that
 * printed it (~1/N). Same shape as WI-38448's split MOBILE_JWT_SECRET and the
 * split OAuth state key in `oauth/state.ts`.
 *
 * The mobile-JWT fix needed a DURABLE secret (a pairing issued before a restart
 * must still verify after it). This one deliberately must NOT be durable: EI-347
 * wants the token to rotate every boot, and it only has to be consistent across
 * the fan-out WITHIN one boot. So it is minted once in the primary and handed to
 * workers through the fork env (`pinSetupTokenForCluster`) instead of being
 * persisted — which also keeps the token off disk entirely, unlike a key file.
 */
const SETUP_TOKEN_ENV = 'PAPERCUSP_SETUP_TOKEN';

let cachedToken: string | null = null;
let printed = false;
/** True when `cachedToken` was adopted from the primary via the fork env. */
let inherited = false;

/** Test-only: force a fresh token + reset the "already printed"/"inherited" latches. */
export function __resetSetupTokenForTests(): void {
  cachedToken = null;
  printed = false;
  inherited = false;
}

/**
 * The boot-lifetime setup token. Resolution order:
 *
 *   1. `PAPERCUSP_SETUP_TOKEN` from the fork env — a request worker adopts the
 *      PRIMARY's token, so every worker verifies the same code.
 *   2. A fresh `randomBytes(18)` — single-process hosts (desktop, `:3170`) and
 *      tests, which have no primary to inherit from.
 *
 * Printed to console exactly once per process, with a banner explaining what
 * it's for — the ONLY place this token is ever surfaced. There is deliberately
 * no HTTP/IPC route that returns it: exposing it over the same loopback surface
 * it's meant to gate would defeat the whole point. A worker that INHERITED the
 * token does not re-print it: the primary already did, and N identical banners
 * would only obscure which code is live.
 */
export function getSetupToken(): string {
  if (cachedToken === null) {
    const injected = process.env[SETUP_TOKEN_ENV]?.trim();
    inherited = Boolean(injected);
    cachedToken = injected || randomBytes(18).toString('base64url');
  }
  if (!printed && !inherited) {
    printed = true;
    // Deliberate: this IS the delivery channel (EI-347) — the token is never served
    // over HTTP/IPC, only printed here for a local operator to read.
    console.log(
      '\n' +
        '================================================================\n' +
        '  Papercusp first-time setup code (needed to set your password):\n' +
        `    ${cachedToken}\n` +
        '  Paste this into Settings > User the first time you add a\n' +
        '  password. It is only required while the account has none.\n' +
        '================================================================\n',
    );
  }
  return cachedToken;
}

/**
 * Mint + print the token in the PRIMARY at boot, and return the fork-env
 * fragment that shares it with every request worker. Call BEFORE `startCluster`
 * forks, alongside `pinSubstrateSocketForCluster` / `pinSpawnerSocketForCluster`,
 * and spread the result into `workerEnv` — which `cluster-fork.ts` also replays
 * on RESPAWN, so a recycled worker keeps the same code.
 *
 * Minting HERE rather than lazily on first verify is the second half of
 * WI-10001497. Nothing called `getSetupToken()` at boot, so the code this
 * module's own doc promised "at boot" was in fact minted and printed by the
 * FAILING request that needed it — from whichever worker lost the coin flip.
 * Booting prints it once, up front, in every mode.
 *
 * Returns `{}` in single-process mode: there is no fork, so this process's own
 * cached token already IS the one that will verify.
 */
export function pinSetupTokenForCluster(clusterWorkers: number): Record<string, string> {
  const token = getSetupToken();
  if (!Number.isFinite(clusterWorkers) || clusterWorkers <= 1) return {};
  return { [SETUP_TOKEN_ENV]: token };
}

/** Timing-safe compare against the current setup token. `null`/empty never matches. */
export function verifySetupToken(candidate: string | null | undefined): boolean {
  if (!candidate) return false;
  const expected = getSetupToken();
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
