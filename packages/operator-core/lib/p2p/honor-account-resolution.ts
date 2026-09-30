/**
 * p2p/honor-account-resolution.ts — HONOR-TIME account routing resolution (WI-5316).
 *
 * A delegated seat carries a gateway account SELECTION authored on the DELEGATING
 * host — `AUTO` (route through the inference gateway), a pinned pool id, or the
 * direct system login. `seatLaunchOpts` maps `AUTO`→`'auto'`, so an AUTO seat
 * reaches the member launch as `--account=auto`. But whether `auto` is
 * FULFILLABLE depends on the HONORING host: psu (correctly) refuses `--account=auto`
 * when this box's inference-gateway pool has no registered account —
 *   `--account auto could not be honored: ... Refusing to fall back to the default system login.`
 * — and the member dies silently (the honor path only saw a Terminal "open"; WI-5306
 * is the sibling binary-missing case). Observed live on the mac rig: its gateway
 * ran local-fallback (empty pool) but it HAD a valid local `claude` login, and the
 * IDENTICAL command with `--account=default` booted cleanly.
 *
 * The delegating host cannot know the honoring host's pool state, so account
 * routing must be RE-RESOLVED at honor time against THIS host's reality:
 *   - `default` (direct system login) is always fulfillable — psu skips the gateway.
 *   - `auto` needs ≥1 registered claude pool account on this host; with an empty
 *     pool it is unfulfillable, so downgrade to `default` when a local login exists
 *     (the proven workaround), else REFUSE with a federated receipt.
 *   - a PIN to a specific pool id needs that id present in this host's pool; absent,
 *     it cannot be silently substituted — REFUSE (the requester asked for a
 *     specific account).
 *
 * PURE core (`resolveHonorAccount`) + injectable I/O so it unit-tests without
 * PG/fs. The delegated-spawn honor path wires the real pool loader + local-login
 * check and calls this as Gate 4.6 (after the WI-5306 runtime probe, before the
 * atomic claim).
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { subscriptionRelayAllowed } from '../anthropic-auth-policy';

/**
 * Classify a `--account` value into its routing MODE. A faithful mirror of
 * psu-launcher's `accountRoutingMode` (apps/operator/scripts/psu-launcher.mjs) —
 * kept as a tiny local copy because the launcher is a `.mjs` outside the
 * operator-core type graph; the honor-time resolution MUST agree with what psu
 * will actually do at member boot, so a drift here is a regression (guarded by a
 * unit test that pins the exact cases).
 */
export function honorAccountRoutingMode(value: string | null | undefined): 'default' | 'auto' | 'pin' {
  const v = (value == null ? '' : String(value)).trim().toLowerCase();
  if (v === '' || v === 'default' || v === 'none' || v === 'system') return 'default';
  if (v === 'auto' || v === 'gateway') return 'auto';
  return 'pin';
}

/**
 * How strong the evidence is that this host has a usable `--account=default`
 * login (EI-19331694139523035). The DISTINCTION is the point: the old predicate
 * collapsed "I checked and it works", "a file is there", and "I did not look at
 * all" into one `true`, so a downgrade onto an unusable login was indistinguishable
 * from a downgrade onto a good one — and the requester was told `opened: 1` either
 * way.
 *
 * - `credentials-file`         — a credentials bundle exists and is not
 *                                definitively dead (unexpired, or refreshable).
 * - `credentials-file-unverifiable` — the bundle exists but could not be read or
 *                                parsed, so its validity is UNKNOWN.
 * - `assumed-darwin-keychain`  — macOS: nothing was probed at all (see below).
 * - `absent`                   — no bundle on a platform where one is required.
 * - `expired-unrefreshable`    — the bundle is present but definitively dead:
 *                                `expiresAt` is in the past AND there is no
 *                                refresh token. A member launched on this cannot
 *                                authenticate, so this is a REFUSAL, not a
 *                                downgrade target.
 *
 * ⚠ NONE of the usable values proves the login works. Measured on the Win rig
 * 2026-08-02: `~/.claude/.credentials.json` existed (599B, subscriptionType
 * "max") with `expiresAt` 45 minutes in the FUTURE, and the member still died at
 * boot with "OAuth session expired and could not be refreshed". No static probe
 * can close that gap — which is why {@link classifyHonorSpawnFailure} exists to
 * make the *failure* actionable rather than pretending the *prediction* can be
 * made exact.
 */
export type LocalLoginEvidence =
  | 'credentials-file'
  | 'credentials-file-unverifiable'
  | 'assumed-darwin-keychain'
  | 'absent'
  | 'expired-unrefreshable';

export interface LocalLoginProbe {
  /** Whether the `--account=default` route may be attempted on this host. */
  usable: boolean;
  evidence: LocalLoginEvidence;
  /** Human detail for the refusal/downgrade note — always states what was actually checked. */
  detail: string;
}

/** `true` only for evidence that came from actually looking at a credential. */
export function loginEvidenceWasProbed(evidence: LocalLoginEvidence): boolean {
  return evidence === 'credentials-file' || evidence === 'expired-unrefreshable' || evidence === 'absent';
}

/**
 * Best-effort: does THIS host have a usable local `claude` login for the
 * `--account=default` (direct system credential) route? Pure-ish + injectable.
 *
 * Linux/WSL: the `~/.claude/.credentials.json` bundle must exist AND not be
 * definitively dead. macOS: the live login is the Keychain item, NOT the disk
 * bundle (a `~/.claude/.credentials.json` on a Mac is typically a stale one-time
 * snapshot — see inference-gateway/account-resolver `localLoginCredentialRef`),
 * and probing the Keychain non-interactively from a background operator is
 * unreliable (it can prompt or fail), so we ASSUME present and SAY SO in the
 * evidence — the caller records that the downgrade rested on an unprobed
 * assumption, which is what makes the eventual failure attributable.
 */
export function probeLocalClaudeLogin(opts?: {
  platform?: NodeJS.Platform;
  home?: string;
  fileExists?: (p: string) => boolean;
  readFile?: (p: string) => string;
  nowMs?: number;
}): LocalLoginProbe {
  const platform = opts?.platform ?? process.platform;
  if (platform === 'darwin') {
    return {
      usable: true,
      evidence: 'assumed-darwin-keychain',
      detail:
        'macOS: the live login is a Keychain item that cannot be probed non-interactively from a background ' +
        'operator, so its usability was ASSUMED, not verified',
    };
  }
  const home = opts?.home ?? homedir();
  const path = join(home, '.claude', '.credentials.json');
  const fileExists = opts?.fileExists ?? existsSync;
  if (!fileExists(path)) {
    return { usable: false, evidence: 'absent', detail: `no claude credentials bundle at ${path}` };
  }

  const readFile = opts?.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  let raw: string;
  try {
    raw = readFile(path);
  } catch {
    return {
      usable: true,
      evidence: 'credentials-file-unverifiable',
      detail: `credentials bundle at ${path} exists but could not be read — validity UNKNOWN`,
    };
  }

  const parsed = parseCredentialValidity(raw, opts?.nowMs ?? Date.now());
  if (parsed == null) {
    return {
      usable: true,
      evidence: 'credentials-file-unverifiable',
      detail: `credentials bundle at ${path} exists but has no parseable expiry — validity UNKNOWN`,
    };
  }
  if (parsed.deadForSure) {
    return {
      usable: false,
      evidence: 'expired-unrefreshable',
      detail:
        `credentials bundle at ${path} is definitively dead: expired ${parsed.expiredForMin} min ago ` +
        'with no refresh token — a member launched on it cannot authenticate',
    };
  }
  return {
    usable: true,
    evidence: 'credentials-file',
    detail:
      `credentials bundle at ${path} is present and not definitively dead ` +
      `(${parsed.expired ? 'expired but holds a refresh token' : 'unexpired'}) — note this does NOT prove it authenticates`,
  };
}

/**
 * Pure: read the validity signals out of a raw credentials bundle. Returns null
 * when the shape carries no expiry we understand (⇒ UNKNOWN, never "dead").
 * Tolerates both the nested `claudeAiOauth` shape and a flat one.
 */
function parseCredentialValidity(
  raw: string,
  nowMs: number,
): { expired: boolean; deadForSure: boolean; expiredForMin: number } | null {
  let doc: any;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  const node = doc?.claudeAiOauth ?? doc;
  const expiresAt = Number(node?.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return null;
  const expired = expiresAt <= nowMs;
  const hasRefresh = typeof node?.refreshToken === 'string' && node.refreshToken.trim().length > 0;
  return {
    expired,
    deadForSure: expired && !hasRefresh,
    expiredForMin: expired ? Math.round((nowMs - expiresAt) / 60000) : 0,
  };
}

export type HonorAccountResolution =
  | {
      ok: true;
      account: string;
      downgradedFrom?: 'auto';
      note?: string;
      /** Present whenever the resolution RESTED on the local-login probe — i.e. on
       *  a downgrade. Carried so a later boot failure can be attributed to the
       *  substitution instead of surfacing as a generic `spawn_failed`. */
      loginEvidence?: LocalLoginEvidence;
    }
  | { ok: false; code: 'account_unfulfillable'; detail: string };

export interface ResolveHonorAccountDeps {
  /** The claude pool account ids REGISTERED on this host (excludes the `local`
   *  fallback — an empty list means psu's gateway auto/pin route is unfulfillable). */
  listPoolAccountIds: () => Promise<string[]>;
  /** Probe the direct-login (`--account=default`) route on this host. Returns the
   *  EVIDENCE, not a bare boolean — see {@link LocalLoginEvidence}. */
  probeLocalLogin: () => LocalLoginProbe;
  /** Environment for the D-005 subscription-relay policy (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
}

/**
 * PURE (given the injected I/O): resolve the account this host should actually
 * launch the delegated member with, or refuse if unfulfillable.
 */
export async function resolveHonorAccount(
  requestedAccount: string | null | undefined,
  deps: ResolveHonorAccountDeps,
): Promise<HonorAccountResolution> {
  const mode = honorAccountRoutingMode(requestedAccount);

  // `default` skips the gateway and uses the box's own login — always fulfillable
  // at the routing layer (a genuinely logged-out box is a separate, rare failure
  // psu surfaces at boot; it never REFUSES the default route the way it refuses auto/pin).
  if (mode === 'default') return { ok: true, account: 'default' };

  // D-005 (open-source-release-2026-09-29): a public build does not honor a peer's request
  // to run on a pooled Claude.ai subscription — the delegated member runs on this host's
  // own login unless its user opted in for their own accounts.
  if (!subscriptionRelayAllowed('honor-account', deps.env)) {
    return {
      ok: true,
      account: 'default',
      note: `public build: --account=${requestedAccount} served by this host's own login (D-005 subscription-relay policy)`,
    };
  }

  if (mode === 'auto') {
    const ids = await deps.listPoolAccountIds();
    if (ids.length > 0) return { ok: true, account: 'auto' };
    // Empty pool ⇒ psu will refuse `--account=auto` at boot. Downgrade to the
    // direct login when one is usable (the live-proven workaround); else refuse
    // LOUDLY. The probe's EVIDENCE rides along on the resolution so a later boot
    // failure can name the substitution instead of reporting a bare spawn_failed
    // (EI-19331694139523035).
    const probe = deps.probeLocalLogin();
    if (probe.usable) {
      return {
        ok: true,
        account: 'default',
        downgradedFrom: 'auto',
        loginEvidence: probe.evidence,
        note:
          'downgraded --account=auto → default: this host has no registered claude pool account (gateway would refuse auto), ' +
          `using the local system login instead — ${probe.detail}`,
      };
    }
    return {
      ok: false,
      code: 'account_unfulfillable',
      detail:
        'seat requests --account=auto but this host has no registered claude pool account AND no usable local login — ' +
        `the member cannot authenticate (${probe.detail}). Seed this host's gateway pool (accounts:register) or ` +
        'delegate a seat pinned to an account this host has.',
    };
  }

  // mode === 'pin' — a specific pool account. It cannot be silently substituted.
  const wanted = String(requestedAccount).trim();
  const ids = await deps.listPoolAccountIds();
  if (ids.includes(wanted)) return { ok: true, account: wanted };
  return {
    ok: false,
    code: 'account_unfulfillable',
    detail:
      `seat pins --account=${wanted} but that account is not in this host's claude pool ` +
      `(${ids.length ? `available: ${ids.join(', ')}` : 'pool is empty'}). A pinned account cannot be substituted — ` +
      'register it on this host or delegate a seat this host can fulfill.',
  };
}

/**
 * The agent-side signatures of an authentication failure, as they appear in a
 * member's boot log (which the boot-receipt scan folds into the spawn error —
 * console-spawn `spawnHeadless`, EI-19311623077693508). Both live rig failures
 * are covered:
 *   mac → "Your organization has disabled Claude subscription access for Claude Code"
 *   win → "Failed to authenticate: OAuth session expired and could not be refreshed"
 *   mac, Claude Code 2.x (EI-24635529006243850) → "Please run /login · API Error: 401
 *     OAuth access token has been revoked." and "Login expired · Please run /login"
 *     (the normalized log can drop the spaces: "Pleaserun/login")
 */
const AUTH_FAILURE_RE =
  /(OAuth session expired|could not be refreshed|disabled Claude subscription access|failed to authenticate|authentication[ _-]?error|invalid api key|not logged in|please run .{0,12}claude (login|setup-token)|please ?run ?\/login|login expired|OAuth access token has been|API Error: 401|credit balance is too low|--account \S+ could not be honored)/i;

/**
 * EI-24635529006243850: the auth-failure line (plus its continuation — the CLI wraps
 * "…has been" / "revoked.") from a member's boot log, ANSI-stripped and bounded, or
 * null when the log carries no auth signature. The classification detail is
 * federated in a receipt, so a caller passes this excerpt, never a whole log tail.
 */
export function extractAuthFailureExcerpt(log: string): string | null {
  // eslint-disable-next-line no-control-regex
  const lines = log.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split(/\r?\n/);
  const i = lines.findIndex((l) => AUTH_FAILURE_RE.test(l));
  if (i < 0) return null;
  return lines
    .slice(i, i + 2)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

export interface HonorSpawnFailureClassification {
  code: 'account_unfulfillable' | 'spawn_failed';
  detail: string;
}

/**
 * Classify a delegated spawn that opened ZERO members (EI-19331694139523035).
 *
 * WHY THIS EXISTS: honor cannot statically predict whether a local login works —
 * the Win rig proves it (a bundle whose `expiresAt` was still 45 min in the
 * future, whose member nonetheless died on "OAuth session expired"). So instead
 * of pretending the PREDICTION can be exact, make the FAILURE attributable: when
 * the member's own boot log carries an auth signature, refuse with
 * `account_unfulfillable` — the code the requester can act on — rather than a
 * generic `spawn_failed` that says nothing about which knob to turn.
 *
 * HONESTY RULE: a boot death that followed an auto→default substitution is NOT
 * automatically an account failure, so it is not reported as one. It stays
 * `spawn_failed`, with the substitution named in the detail as the prime suspect.
 * Manufacturing a cause we did not observe is exactly the failure mode this whole
 * work-item is about.
 */
export function classifyHonorSpawnFailure(args: {
  count: number;
  firstError?: string | null;
  /** The successful account resolution this spawn ran under. */
  resolved: { account: string; downgradedFrom?: 'auto'; loginEvidence?: LocalLoginEvidence };
}): HonorSpawnFailureClassification {
  const err = (args.firstError ?? '').trim();
  const where = `all ${args.count} member spawn(s) failed on the honoring host${err ? `: ${err}` : ''}`;
  const substitution =
    args.resolved.downgradedFrom === 'auto'
      ? ` The seat asked for --account=auto and this host SUBSTITUTED its local system login ` +
        `(evidence: ${args.resolved.loginEvidence ?? 'unknown'}` +
        `${args.resolved.loginEvidence && !loginEvidenceWasProbed(args.resolved.loginEvidence) ? ', which was ASSUMED rather than verified' : ''}).`
      : '';

  if (err && AUTH_FAILURE_RE.test(err)) {
    return {
      code: 'account_unfulfillable',
      detail:
        `${where} — the member booted but could not AUTHENTICATE under --account=${args.resolved.account}.` +
        substitution +
        ' Remedy on the honoring host: re-authenticate the local login, or register a gateway pool account ' +
        '(accounts:link-start / accounts:register) so --account=auto is fulfillable and the local credential stops being load-bearing.',
    };
  }

  return {
    code: 'spawn_failed',
    detail:
      where +
      (substitution
        ? `${substitution} That substitution is the prime suspect but was NOT confirmed by the boot log — ` +
          'check the member log on the honoring host before concluding it is an account problem.'
        : ''),
  };
}
