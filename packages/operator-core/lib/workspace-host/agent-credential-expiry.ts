/**
 * Agent-login expiry on a live hosted workspace host (WI-10003720).
 *
 * WHY THE HOST, NOT THE OPERATOR'S COPY. The operator stores every agent-credential generation it
 * delivered, so reading `deliveredAccessExpiry()` off the bound generation looks like the cheap
 * answer. It is the wrong one: the login the host's CLI actually uses can be replaced on the host
 * after delivery — a customer's own `/login`, or a long-lived token installed straight into the
 * native home. Measured 2026-10-01 on avi-test (host-3daf37098c8096b5d9e0ac72): its bound agent
 * generation is 1 (bind-agent step, 2026-09-26 18:36Z), a refresh-stripped delivery that expired
 * within hours, yet its chat works on a setup token installed at `~/.claude/.credentials.json`
 * (WI-10001893). An operator-side check would have painted a working host red. So this reads the
 * file the CLI reads, on the host, as the same account (`papercusp-workspace`).
 *
 * NO TOKEN BYTE LEAVES THE HOST. The remote program is a POSIX `sh` script (no interpreter
 * dependency beyond coreutils + grep + sed) that prints, per agent, only: whether the login file
 * exists, whether it holds a non-empty refresh token, whether it is an API-key login, and the
 * access token's expiry as digits. The parser below accepts exactly that shape and nothing else.
 *
 * WHAT COUNTS AS EXPIRING. Only a login that CANNOT renew itself has a wall: a delivered copy
 * carries `refreshToken: ""` (projected, D-311 / WI-10001691), so its access token's expiry is the
 * end of the login. A login with a refresh token renews on next use, and an API-key login does not
 * expire; both pass without a warning, because an access token lapsing there is routine.
 */
import type { WorkspaceHostHealthCheck } from '@papercusp/deployment-driver';

import {
  buildWorkspaceHostSshInvocation,
  type GcpIapWorkspaceHostInitializationCommand,
  type WorkspaceHostSshTransportProfile,
} from './gcp-iap-initialization-operations';

/**
 * Amber window. Delivered tokens live ~6-8h, so a window that size would read amber from the
 * moment of delivery, which is noise. Two hours is eight 15-minute standing ticks of warning:
 * enough to deliver a fresh generation or have the customer sign in before the login stops.
 */
export const WORKSPACE_HOST_AGENT_CREDENTIAL_EXPIRY_WARN_MS = 2 * 3_600_000;

export const WORKSPACE_HOST_AGENT_CREDENTIAL_EXPIRY_PROTOCOL = 'PC_AGENT_CRED_EXPIRY v1';

export type WorkspaceHostAgentCredentialSlot = 'claude' | 'codex';

const SLOT_AGENT_NAME: Readonly<Record<WorkspaceHostAgentCredentialSlot, string>> = {
  claude: 'Claude',
  codex: 'Codex',
};

export type WorkspaceHostAgentCredentialSlotReading =
  | { slot: WorkspaceHostAgentCredentialSlot; kind: 'absent' }
  | { slot: WorkspaceHostAgentCredentialSlot; kind: 'api-key' }
  | { slot: WorkspaceHostAgentCredentialSlot; kind: 'self-renewing'; accessExpiresAt: string | null }
  | { slot: WorkspaceHostAgentCredentialSlot; kind: 'fixed'; accessExpiresAt: string }
  | { slot: WorkspaceHostAgentCredentialSlot; kind: 'unreadable' };

export type WorkspaceHostAgentCredentialExpiryReading =
  | { kind: 'read'; slots: WorkspaceHostAgentCredentialSlotReading[] }
  | { kind: 'transport-failure'; detail: string };

/**
 * The remote program. Written so its stdout can carry ONLY the fixed protocol header, slot names,
 * 0/1 flags and digits: every value printed is either a literal or the output of `grep -o
 * '[0-9]*$'`. Exported so a test can run it against fixture homes with the local `/bin/sh`.
 */
export const WORKSPACE_HOST_AGENT_CREDENTIAL_EXPIRY_SCRIPT = String.raw`printf '%s\n' 'PC_AGENT_CRED_EXPIRY v1'
one() {
  slot=$1; file=$2; refresh_key=$3; unit=$4; apikey_key=$5
  if [ ! -r "$file" ]; then printf '%s present=0\n' "$slot"; return 0; fi
  body=$(tr -d '\n\r' < "$file" 2>/dev/null)
  refresh=0; apikey=0; exp=''
  if printf '%s' "$body" | grep -q "\"$refresh_key\"[[:space:]]*:[[:space:]]*\"[^\"]"; then refresh=1; fi
  if [ -n "$apikey_key" ] && printf '%s' "$body" | grep -q "\"$apikey_key\"[[:space:]]*:[[:space:]]*\"[^\"]"; then apikey=1; fi
  if [ "$unit" = ms ]; then
    exp=$(printf '%s' "$body" | grep -o '"expiresAt"[[:space:]]*:[[:space:]]*[0-9][0-9]*' | head -n 1 | grep -o '[0-9]*$')
  else
    payload=$(printf '%s' "$body" | grep -o '"access_token"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1 | sed 's/^.*:[[:space:]]*"//; s/"$//' | cut -d. -f2 | tr '_-' '/+')
    len=$(printf '%s' "$payload" | wc -c | tr -d ' ')
    case $((len % 4)) in 2) payload="$payload==" ;; 3) payload="$payload=" ;; esac
    exp=$(printf '%s' "$payload" | base64 -d 2>/dev/null | tr -d '\n\r' | grep -o '"exp"[[:space:]]*:[[:space:]]*[0-9][0-9]*' | head -n 1 | grep -o '[0-9]*$')
  fi
  printf '%s present=1 refresh=%s apikey=%s exp=%s\n' "$slot" "$refresh" "$apikey" "$exp"
}
one claude "$HOME/.claude/.credentials.json" refreshToken ms ''
one codex "$HOME/.codex/auth.json" refresh_token s OPENAI_API_KEY
`;

/** The probe invocation, over the SAME pinned transport as the reach probe and initialization. */
export function buildWorkspaceHostAgentCredentialExpiryProbe(
  profile: WorkspaceHostSshTransportProfile,
): GcpIapWorkspaceHostInitializationCommand {
  return buildWorkspaceHostSshInvocation(profile, {
    entrypoint: '/bin/sh',
    entrypointLabel: 'POSIX sh',
    args: ['-c', WORKSPACE_HOST_AGENT_CREDENTIAL_EXPIRY_SCRIPT],
    stdin: '',
  });
}

const SLOT_LINE =
  /^(claude|codex) present=(?:0|1 refresh=([01]) apikey=([01]) exp=([0-9]{0,16}))$/;

function epochToIso(digits: string, slot: WorkspaceHostAgentCredentialSlot): string | null {
  if (digits.length === 0) return null;
  const value = Number(digits);
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  const ms = slot === 'claude' ? value : value * 1000;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/**
 * Parse the probe's stdout. Strict on purpose: an unexpected line means the remote program is not
 * the one this controller shipped, and a reading from it must not be trusted, so it throws.
 */
export function parseWorkspaceHostAgentCredentialExpiryOutput(
  stdout: string,
): WorkspaceHostAgentCredentialSlotReading[] {
  const lines = stdout.split('\n').map((line) => line.trimEnd()).filter((line) => line.length > 0);
  if (lines[0] !== WORKSPACE_HOST_AGENT_CREDENTIAL_EXPIRY_PROTOCOL) {
    throw new Error('agent-credential expiry probe returned an unrecognized header');
  }
  const slots: WorkspaceHostAgentCredentialSlotReading[] = [];
  const seen = new Set<string>();
  for (const line of lines.slice(1)) {
    const match = SLOT_LINE.exec(line);
    if (!match) throw new Error('agent-credential expiry probe returned an unrecognized line');
    const slot = match[1] as WorkspaceHostAgentCredentialSlot;
    if (seen.has(slot)) throw new Error(`agent-credential expiry probe reported '${slot}' twice`);
    seen.add(slot);
    if (match[2] === undefined) {
      slots.push({ slot, kind: 'absent' });
      continue;
    }
    const accessExpiresAt = epochToIso(match[4] ?? '', slot);
    if (match[3] === '1') slots.push({ slot, kind: 'api-key' });
    else if (match[2] === '1') slots.push({ slot, kind: 'self-renewing', accessExpiresAt });
    else if (accessExpiresAt !== null) slots.push({ slot, kind: 'fixed', accessExpiresAt });
    else slots.push({ slot, kind: 'unreadable' });
  }
  if (!seen.has('claude') || !seen.has('codex')) {
    throw new Error('agent-credential expiry probe did not report both claude and codex');
  }
  return slots;
}

function remedy(agent: string): string {
  return (
    `It cannot renew on the host (no refresh token), so the ${agent} CLI there fails with 401 ` +
    'once it lapses. Remedy: the customer signs in on the host, or deliver fresh material at a ' +
    'new generation (POST /api/workspace-hosts/<id>/agent-credentials).'
  );
}

function hoursUntil(atMs: number, nowMs: number): number {
  return Math.round(((atMs - nowMs) / 3_600_000) * 10) / 10;
}

/**
 * Turn a reading into health checks: one `agent-credential:<slot>` check per login PRESENT on the
 * host. An absent login emits nothing — nothing there can expire, and a check that passes over an
 * absence would be vacuous. A failed read emits one `ok: null` check, so "not measured" stays
 * visible instead of silently passing.
 */
export function workspaceHostAgentCredentialChecks(
  reading: WorkspaceHostAgentCredentialExpiryReading,
  now: Date,
  warnMs: number = WORKSPACE_HOST_AGENT_CREDENTIAL_EXPIRY_WARN_MS,
): WorkspaceHostHealthCheck[] {
  if (reading.kind === 'transport-failure') {
    return [{ name: 'agent-credentials', ok: null, detail: `not measured: ${reading.detail}` }];
  }
  const nowMs = now.getTime();
  const checks: WorkspaceHostHealthCheck[] = [];
  for (const slot of reading.slots) {
    const name = `agent-credential:${slot.slot}`;
    const agent = SLOT_AGENT_NAME[slot.slot];
    switch (slot.kind) {
      case 'absent':
        break;
      case 'api-key':
        checks.push({ name, ok: true, detail: `${agent} uses an API-key login, which does not expire.` });
        break;
      case 'self-renewing':
        checks.push({
          name,
          ok: true,
          detail:
            `${agent} login renews itself (refresh token present)` +
            (slot.accessExpiresAt ? `; current access token valid until ${slot.accessExpiresAt}.` : '.'),
        });
        break;
      case 'unreadable':
        checks.push({
          name,
          ok: null,
          detail: `a ${agent} login file is present but its expiry could not be read.`,
        });
        break;
      case 'fixed': {
        const atMs = Date.parse(slot.accessExpiresAt);
        if (atMs <= nowMs) {
          checks.push({
            name,
            ok: false,
            detail: `${agent} access token EXPIRED at ${slot.accessExpiresAt}. ${remedy(agent)}`,
          });
        } else if (atMs - nowMs <= warnMs) {
          checks.push({
            name,
            ok: true,
            warn: true,
            detail:
              `${agent} access token EXPIRES at ${slot.accessExpiresAt} (in ~${hoursUntil(atMs, nowMs)}h). ` +
              remedy(agent),
          });
        } else {
          checks.push({
            name,
            ok: true,
            detail: `${agent} access token valid until ${slot.accessExpiresAt} (cannot renew on the host).`,
          });
        }
        break;
      }
    }
  }
  return checks;
}
