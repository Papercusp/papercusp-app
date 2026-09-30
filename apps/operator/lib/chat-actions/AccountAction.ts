/**
 * ACCOUNT — which inference-gateway account this chat's session is routed
 * through, as a ChatModeAction axis (hud-chat-owner-controls-2026-08-11 P-003,
 * WI-6509).
 *
 * [owner 2026-07-27, verbatim] "add a button to the bottom of the chant to
 * change which account the chat is pinned to. deafault system account or auto
 * or any of the actual accounts."
 *
 * A PILL, not a button (plan D-005 §2): the account a session runs on is a value
 * that is currently something plus the control that changes it, which is exactly
 * what a mode-action is and what a stateless ChatAction is not. It renders in
 * ChatActionBar's `Controls` band because everything in that band changes THIS
 * session (D-009 §A) — and this one changes only the session this chat is
 * attached to (D-005 §3), never the fleet.
 *
 * ── THE THREE VALUES ARE NOT THREE OF A KIND (D-009 §C) ──
 * Verified by reading the writer (agent-tools/gateway/gateway.ts:53-107), not
 * inferred from the tool names:
 *   • a specific pool account → `accounts:pin`, LIVE. Durable, effective on the
 *     agent's next model call, no respawn and no lost context.
 *   • `auto`                  → `accounts:unpin`, LIVE. Reverts to the routing
 *     the session was launched with.
 *   • default system account  → NOT REACHABLE FROM HERE. A `--account=default`
 *     session bypasses the gateway entirely, so there is nothing to re-pin; it
 *     must be respawned. The owner named this option explicitly, so it appears
 *     in the picker as a DISABLED row carrying that reason (D-006 §A) rather
 *     than being silently dropped or offered as a click that cannot work.
 *
 * ⚠ NOT `accounts:set-session-override`. It reads like the natural setter and is
 * a FLEET-WIDE steer over which account NEW spawns get; wiring a per-chat
 * control to it would re-route the workspace (D-009 evidence block).
 *
 * ── WHAT THE PILL IS ALLOWED TO CLAIM ──
 * Never that the session IS on an account. `accounts:pin`'s default is SOFT: the
 * gateway prefers the account but yields when it is paused or exhausted (only
 * `hard:true` never fails over), and the write itself can land durably while the
 * live push fails (`appliedLive:false`). So the pill reports the PIN in force,
 * and `set` surfaces the value the setter RETURNED rather than the one the user
 * picked (D-009 §B) — a control that echoes its own input is plan D-002's silent
 * no-op in a nicer costume.
 */
import { fetchSyncQuery } from '@papercusp/sync';
import {
  accountFromArgv,
  isGatewayFreeAccount,
} from '@papercusp/operator-core/lib/agent-config-constants';
import { registerChatModeAction } from './registry';
import type { ChatActionContext, ChatModeOption } from './types';

/** Gateway AUTO routing — the absence of a dynamic pin, as a pickable value. */
const ACCOUNT_AUTO = 'auto';
/** The un-settable "default system account" row. `__`-prefixed so it can never
 *  collide with a real pool account id. */
const ACCOUNT_DEFAULT = '__default';
/** What `current()` reports when the roster says there is no dynamic pin. Not a
 *  pool account id, and `__`-prefixed for the same reason. */
const ACCOUNT_UNPINNED = '__unpinned';

/**
 * The `--account=` this session was LAUNCHED with, or null when the argv records none, or
 * `undefined` when there is no argv to read (an older roster payload — UNKNOWN, per D-005 §5).
 *
 * The same `launchArgv` the MODEL pill parses, so this costs no extra fetch. It exists because
 * a `--account=default` session BYPASSES the inference gateway, which means a dynamic pool pin
 * cannot reach it: `accounts:pin` writes the pin, returns ok, and the session keeps routing
 * exactly as before. Offering those rows as clickable was a control whose success message was
 * indistinguishable from its no-op (EI-20208335287200289).
 *
 * Exported for test.
 */
export function readLaunchAccount(ctx: ChatActionContext): string | null | undefined {
  const argv = (ctx as { launchArgv?: unknown }).launchArgv;
  if (argv === undefined) return undefined;
  /* An EMPTY argv is UNKNOWN, not "no --account" — adv-roster's active tier is
     `launchArgv: adv?.launchArgv ?? []`, so a session with no launch record at all arrives as
     `[]` and carries no evidence either way. Same reading as readModelSpec, deliberately. */
  if (Array.isArray(argv) && argv.length === 0) return undefined;
  return accountFromArgv(argv);
}

/** The pin as the roster row carries it (adv-roster's `accountPin`). */
export interface CtxAccountPin {
  account: string;
  hard: boolean;
}

/**
 * Read the dynamic pin off the context, distinguishing the two absences.
 *
 * `undefined` — the roster payload has no `accountPin` field at all (an older
 * operator, or a mid-deploy SSE push). The value is UNKNOWN, and D-005 §5 is
 * explicit that an unknown value means NO PILL rather than a plausible guess.
 * `null` — the roster answered, and the answer is "no dynamic pin".
 *
 * Exported for test.
 */
export function readAccountPin(ctx: ChatActionContext): CtxAccountPin | null | undefined {
  const raw = ctx.accountPin;
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'object') return undefined;
  const account = (raw as { account?: unknown }).account;
  if (typeof account !== 'string' || account.length === 0) return undefined;
  return { account, hard: (raw as { hard?: unknown }).hard === true };
}

/** One row of the `accounts.pool` sync query, narrowed to what this menu reads
 *  (account-pool-store.ts's AccountStatusRow). */
interface AccountPoolRow {
  id: string;
  label?: string;
  provider?: string;
  available?: boolean;
}

/** POST one account pin/unpin through the admin proxy route
 *  (endpoint-route/routes/admin/accounts-pin.ts). Exported for tests.
 *
 *  Returns the tool's own reply so the caller can tell a pin that is IN FORCE
 *  from one that is merely durable (`appliedLive:false`) — the accepted-but-
 *  modified case D-008/D-009 §B require every one of these controls to model. */
export async function postAccountPin(
  verb: 'pin' | 'unpin',
  body: Record<string, unknown>,
): Promise<{ ok?: boolean; appliedLive?: boolean; warn?: string; error?: string; cleared?: boolean }> {
  const r = await fetch(`/api/admin/accounts/${verb}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`accounts:${verb} → ${r.status}: ${text.slice(0, 200)}`);
  let parsed: { ok?: boolean; appliedLive?: boolean; warn?: string; error?: string; cleared?: boolean } = {};
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    /* tolerate a non-JSON 200 — treated as success with nothing to report */
  }
  if (parsed.ok === false) throw new Error(`accounts:${verb} → ${parsed.error ?? 'unknown error'}`);
  return parsed;
}

/** The menu, given the live pool. Pure — exported so the row set is testable
 *  without a fetch. */
export function accountOptions(pool: AccountPoolRow[], launchAccount?: string | null): ChatModeOption[] {
  const accounts = [...pool].sort((a, b) => (a.label ?? a.id).localeCompare(b.label ?? b.id));
  /* A `--account=default` session bypasses the gateway, so NOTHING routed through the gateway can
     re-route it: both the pool rows and Auto are guaranteed no-ops for it. They stay VISIBLE with
     the real reason rather than being hidden — a menu that silently drops rows misreports what the
     control does, and the owner needs to learn that a respawn is the lever. `undefined`
     (unknown argv) is deliberately NOT treated as gateway-free: disabling the whole menu on an
     absence would be the same unsourced guess D-005 §5 forbids in the other direction. */
  /* WI-42439: ASK THE SHARED PREDICATE, never `=== 'default'`. `default` is the spelling psu's
     grammar documents, but `resolveAccountPin` routes `none` and `system` around the gateway
     too — and this line tested only the first, so 25 live `--account=system` sessions rendered
     every pool row as a clickable pin whose click writes durably, returns ok, and re-routes
     nothing. The failure was invisible precisely because the enabled rows LOOK correct. */
  const gatewayFree = isGatewayFreeAccount(launchAccount);
  const gatewayFreeHint = `This session was launched --account=${launchAccount}, which bypasses the inference gateway — a live pin cannot reach it. Respawn it to change accounts.`;
  return [
    {
      id: ACCOUNT_AUTO,
      label: 'Auto (gateway routing)',
      ...(gatewayFree ? { disabled: true } : {}),
      hint: gatewayFree
        ? gatewayFreeHint
        : 'The gateway picks an available account for each call and fails over when one is rate-limited. Clears any pin on this session.',
    },
    {
      id: ACCOUNT_DEFAULT,
      label: 'Default system account',
      /* PRESENT BUT NOT SETTABLE (D-006 §A). The owner named this option, so it
         is here; a `--account=default` session bypasses the gateway and has no
         pin to change, so it cannot be applied by click. The reason rides the
         hint because a disabled row without one is just a dead end. */
      disabled: true,
      hint: 'Not settable here — the default account bypasses the gateway, so a session must be RESPAWNED on it rather than re-pinned live.',
    },
    ...accounts.map((a) => ({
      id: a.id,
      label: a.label ?? a.id,
      ...(gatewayFree ? { disabled: true } : {}),
      /* `available:false` is a live capacity fact, not a reason to hide the
         account: pinning to a rate-paused account is a legitimate thing to
         choose (it recovers), and a menu that silently drops accounts would
         misreport the pool. Say it instead. */
      hint:
        (gatewayFree
          ? [gatewayFreeHint]
          : [a.provider, a.available === false ? 'rate-limited or usage-walled right now' : null]
        )
          .filter(Boolean)
          .join(' · ') || undefined,
    })),
  ];
}

registerChatModeAction({
  id: 'mode-account',
  cap: 'ACCT',
  /* The three owner-requested session-config controls (token limit, account,
     model+effort) cluster together, AFTER the posture pills: posture says what
     the agent IS, these say what it RUNS ON. */
  group: 'config',
  /* UNKNOWN ⇒ no pill (D-005 §5), except while the roster read is still in
     flight. During that window the absent field means "not answered yet", not
     "this control does not apply"; the loading pill makes that distinction
     visible without guessing an account. Once the read resolves, the existing
     field predicate resumes and a genuinely unknown/partial row stays hidden. */
  available: (ctx) =>
    Boolean(ctx.sessionOwnerId) &&
    (ctx.rosterReadState === 'loading' || readAccountPin(ctx) !== undefined),
  /* PURE + sync (D-005 §6): read straight off the roster row the surface already
     rendered from. The authoritative live read is `gateway:owner_report`, a
     per-agent fetch — putting that behind this function would cost a gateway
     round trip on every popup open and could disagree with the rest of the
     popup. Sourcing the pin ONTO the roster row is what makes this possible
     (adv-roster.ts `accountPin`). */
  current: (ctx) => {
    if (ctx.rosterReadState === 'loading') {
      return {
        value: 'loading…',
        on: false,
        loading: true,
        title: 'Loading this session\'s account routing…',
      };
    }
    const pin = readAccountPin(ctx);
    if (!pin) {
      /* Still not claiming "this session is on auto" — no DYNAMIC pin is all `accountPin` can say.
         But the STATIC spawn pin is no longer unknowable: it is in the launch argv already on this
         same ctx. Reporting it is the difference between a control that says "I cannot read this"
         and one that reads it — and for `--account=default` it is the difference between offering
         a pin that cannot take effect and saying why. */
      const launched = readLaunchAccount(ctx);
      const title =
        /* WI-42439: same predicate as `gatewayFree`, for the same reason. Testing `=== 'default'`
           here sent a `--account=system` session down the LAST branch, which told the owner
           "pinning here overrides that routing for this session" — the exact opposite of the
           truth for a session that never reaches the gateway. */
        isGatewayFreeAccount(launched)
          ? `Launched --account=${launched} — this session bypasses the inference gateway entirely, so it cannot be re-pinned live. Respawn it to change accounts.`
          : launched === 'auto'
            ? 'Launched --account=auto and carries no pin — the gateway picks an available account per call and fails over.'
            : launched
              ? `Launched --account=${launched} (a static spawn pin) and carries no DYNAMIC pin — pinning here overrides that routing for this session.`
              : /* null (no --account recorded) or undefined (no argv to read) collapse here: in
                   neither case do we know the launch routing, so the tooltip claims nothing. */
                'No account pin on this session — it uses the routing it was launched with (gateway auto, or a static --account= pin set at spawn that this session recorded no argv for).';
      /* The VALUE is the at-a-glance reading, and it must not contradict the title.
         Hardcoding 'auto' here asserted gateway-routed-with-failover for EVERY unpinned
         session — including a `--account=default` one, whose routing is the exact
         opposite (gateway BYPASSED). Live-measured on the rig: a --account=default
         session rendered "ACCT auto" while its own menu rows explained it bypasses the
         gateway. `launched` already carries the honest reading on every branch above;
         when it is unknown, say so rather than defaulting to a routing claim. */
      const value = launched ?? 'unpinned';
      return { value, optionId: ACCOUNT_UNPINNED, on: false, title };
    }
    return {
      value: pin.account,
      optionId: pin.account,
      on: true,
      title: pin.hard
        ? `Pinned HARD to ${pin.account} — the gateway never fails over off it, so calls wait or 429 when it is exhausted.`
        : `Pinned to ${pin.account} (soft) — the gateway prefers it but yields to another account when it is paused or exhausted, so this is a preference, not a guarantee.`,
    };
  },
  /* The pool grows without limit and a workspace can hold a dozen accounts, so
     the menu scrolls and filters rather than being a fixed short list
     (D-005 §4). */
  searchable: true,
  searchPlaceholder: 'Search accounts…',
  /* Async + LAZY: resolved by the bar on menu open, so a popup nobody re-routes
     pays no `accounts.pool` query (types.ts's `options` doc). */
  options: async (ctx) =>
    accountOptions(
      await fetchSyncQuery<AccountPoolRow>({ queryName: 'accounts.pool', args: {} }),
      readLaunchAccount(ctx),
    ),
  set: async (ctx, optionId) => {
    const agent = ctx.sessionOwnerId;
    /* Belt and braces with the bar's own `disabled` handling: the un-settable
       row can still be reached by a keyboard/test path, and failing loudly with
       the real reason beats a write that silently does nothing. */
    if (optionId === ACCOUNT_DEFAULT) {
      throw new Error(
        'The default system account bypasses the inference gateway, so a running session cannot be re-pinned onto it — respawn the session with --account=default instead.',
      );
    }
    if (optionId === ACCOUNT_UNPINNED) return; // already the current state
    /* Same belt-and-braces for the gateway-free case, and here it is load-bearing rather than
       defensive: `accounts:pin` WOULD return ok for a --account=default session (the durable pin
       really is written) while the session keeps bypassing the gateway. Refusing loudly is the
       only way this control can avoid reporting a success that changes nothing. */
    const launchedAccount = readLaunchAccount(ctx);
    /* WI-42439: the third `=== 'default'` site. This one is the LAST line of defence — it is what
       stops a keyboard/test path from posting a pin that `accounts:pin` will happily persist for a
       session the gateway never sees, so narrowing it to one spelling defeated the whole guard. */
    if (isGatewayFreeAccount(launchedAccount)) {
      throw new Error(
        `This session was launched --account=${launchedAccount}, which bypasses the inference gateway — a pin would be saved but could never take effect. Respawn the session to change its account.`,
      );
    }
    if (optionId === ACCOUNT_AUTO) {
      await postAccountPin('unpin', { agent });
      return;
    }
    /* Soft by design. `hard:true` means the gateway NEVER fails over off the
       account, which turns a rate-limited account into a stalled session — not
       something a one-click pill should be able to do silently. The standing
       account mandate (D-006 §E) points the same way: pinning is offered,
       never-fail-over pinning is not. */
    const r = await postAccountPin('pin', { agent, account: optionId });
    /* ACCEPTED-BUT-MODIFIED (D-009 §B), CONFIRMED in the writer: the durable
       write can succeed while the live push to the running gateway fails, and
       the tool still returns ok. Reading a bare ok as "pinned" would report a
       pin that is not yet in force. */
    if (r.appliedLive === false) {
      throw new Error(
        `Pinned to ${optionId} durably, but the running gateway did not accept it live — it takes effect on the gateway's next poll or restart, not on this session's next call.`,
      );
    }
  },
});
