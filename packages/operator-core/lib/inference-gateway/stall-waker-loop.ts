/**
 * stall-waker-loop — wires the {@link StallWaker} to the LIVE gateway + coord + spawned_agents and runs it
 * on a poll loop (gateway-rate-limit-stall-autowake P-003). Idempotent + `unref`'d; started lazily from the
 * spawn path when the inference gateway is on (that's exactly when bees — and thus stalls — exist).
 */
import { StallWaker, type StallEvent, type StallWakerDeps } from './stall-waker';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { gatewayPort } from './spawn-env';
import { fetchGatewayHeadroom } from './observability';
import { getOrgPg } from '@papercusp/db-org';
import { listGatewayStallsSince } from './gateway-stall-store';
import { getSpawnPg } from '../fleet/pg-stores';
import { accountStatus, type AccountStatusRow } from '../deployment/account-pool-store';
import { readRegistry } from '../workspace-registry';
import { wakeRecipients } from '../agent-tools/coordination/inbox-wake';
import { forceEndTurn } from '../agent-tools/turn/interrupt';
import { isOwnerFocusedOnDesktop } from '../desktop-window-liveness';

const POLL_MS = Number(process.env.PAPERCUSP_STALL_WAKER_POLL_MS) || 20_000;
/** A bee stream-silent this long is idle/sleeping (turn ended, waiting on its wake key) — NOT actively
 *  retrying. We only wake a CONFIRMED-idle bee, so we never interrupt one mid-recovery. */
const IDLE_SILENCE_MS = Number(process.env.PAPERCUSP_STALL_WAKER_IDLE_MS) || 30_000;
/** A turn is declared DEAD (fast-ESC-able) only after the owner's stall stream AND activity have both
 *  been quiet this long past its LATEST stall — rides out CLI 429 retry-backoff gaps, which routinely
 *  exceed IDLE_SILENCE_MS (2026-08-17 mass-interrupt root cause; see StallWakerOptions.deadQuietMs). */
const DEAD_QUIET_MS = Number(process.env.PAPERCUSP_STALL_WAKER_DEAD_QUIET_MS) || 2 * 60_000;
/** Settle window between the ESC and the wake (coord-end-turn D-003): let the bee's CLI finish ending its
 *  dead turn + re-arm its inbox-wake watch before the wake fires. */
const ENDTURN_SETTLE_MS = Number(process.env.PAPERCUSP_ENDTURN_SETTLE_MS) || 1500;

/** Per-account dedupe for the usage-wall hold log (WI-3310): capacityBack runs every poll tick for
 *  every pending stall, and a weekly wall lasts DAYS — log once per (account, wall-reset), not per 20s. */
const usageWallLoggedUntil = new Map<string, number>();

/** accountId → the workspace whose pool actually contains it (learned by findAccountRow so repeat
 *  ticks don't re-scan the whole registry). */
const accountWorkspaceCache = new Map<string, string>();

/**
 * Resolve an account's status row ACROSS workspaces (WI-3310 layer 2). The gateway's /admin/stalls
 * feed is GLOBAL (one gateway process, stalls from every workspace's bees), but this loop is a
 * module singleton bound to ONE workspaceId — whichever `ensureStallWakerLoop` call ran first, which
 * on boot-start is the registry's first entry ('default'). `accountStatus('default')` does not
 * contain another workspace's accounts, so the lookup MISSED for every real stall on this box and
 * fell into the unknown-account fallback (`return true`) — waking bees onto usage-walled accounts
 * no matter what the pool knew (the avistorewolf.com false "rate limit recovered" wakes, 2026-07-07).
 * Own workspace first, then every other registry workspace; deps injectable for unit tests.
 */
export async function findAccountRow(
  preferredWs: string,
  accountId: string,
  deps: {
    status?: (ws: string) => Promise<AccountStatusRow[]>;
    listWorkspaces?: () => string[];
    cache?: Map<string, string>;
  } = {},
): Promise<AccountStatusRow | undefined> {
  const status = deps.status ?? ((ws: string) => accountStatus(ws));
  const listWorkspaces = deps.listWorkspaces ?? (() => readRegistry().workspaces.map((w) => w.id));
  const cache = deps.cache ?? accountWorkspaceCache;
  const tryWs = async (ws: string): Promise<AccountStatusRow | undefined> =>
    (await status(ws).catch(() => [] as AccountStatusRow[])).find((x) => x.id === accountId);

  const cached = cache.get(accountId);
  if (cached) {
    const hit = await tryWs(cached);
    if (hit) return hit;
    cache.delete(accountId); // pool changed under us — fall through to the full resolution
  }
  const own = await tryWs(preferredWs);
  if (own) {
    cache.set(accountId, preferredWs);
    return own;
  }
  let workspaces: string[] = [];
  try {
    workspaces = listWorkspaces();
  } catch {
    /* registry unreadable → only the preferred workspace was checked */
  }
  for (const ws of workspaces) {
    if (ws === preferredWs) continue;
    const hit = await tryWs(ws);
    if (hit) {
      cache.set(accountId, ws);
      return hit;
    }
  }
  return undefined;
}

/** Build the real deps: gateway HTTP (stalls), spawned_agents (idle), account-pool (capacity), coord (wake). */
export function createStallWakerDeps(workspaceId: string): StallWakerDeps {
  const base = () => `http://127.0.0.1:${gatewayPort()}`;
  return {
    fetchStalls: async (since) => {
      let now = Date.now();
      let httpStalls: StallEvent[] = [];
      try {
        const r = await fetch(`${base()}/admin/stalls?since=${since}`, { signal: AbortSignal.timeout(5000) });
        if (r.ok) {
          const body = (await r.json()) as { now: number; stalls: StallEvent[] };
          httpStalls = body.stalls;
          now = body.now;
        }
      } catch {
        // Gateway unreachable (e.g. mid-restart) — fall through to the PG-durable source below
        // rather than losing the whole tick; a stall recorded just before a restart is exactly
        // the case this durability path exists for (EI-2431).
      }
      // DURABILITY (EI-2431): the gateway's in-memory ring buffer is wiped by a restart. Merge in
      // anything durably recorded to PG by recordStall() that the ring might have lost — a stall
      // recorded in the window between the write and a gateway crash/restart still survives here.
      // Best-effort: a DB hiccup degrades to the HTTP-only source, never breaks the tick.
      let pgStalls: StallEvent[] = [];
      try {
        pgStalls = await listGatewayStallsSince(since);
      } catch {
        // non-fatal — HTTP-sourced stalls (if any) still serve this tick
      }
      if (pgStalls.length === 0) return { now, stalls: httpStalls };
      const seen = new Set(httpStalls.map((s) => `${s.ownerId}:${s.at}`));
      const merged = [...httpStalls, ...pgStalls.filter((s) => !seen.has(`${s.ownerId}:${s.at}`))];
      return { now, stalls: merged };
    },
    ownerLastActivityAt: async (ownerId) => {
      // ROLE-AGNOSTIC activity read (2026-06-22, timestamp-ified 2026-08-17): the max across every liveness
      // source, so the waker can compare activity AGAINST THE STALL rather than against bare wall-clock
      // silence (the 2026-08-17 mass-interrupt root cause — see StallWakerDeps.ownerLastActivityAt):
      //   (a) the bee nursery's stream output (only a bee has a spawned_agents row);
      //   (b) coord presence's last_active_at (EVERY coord agent has one, any role);
      //   (c) the gateway's per-owner ledger lastRequestAt (/admin/owner-report) — bumped when EVERY request
      //       STARTS, retries included, so a CLI in 429 retry-backoff reads as ALIVE here even while (a)+(b)
      //       are silent. Do not use the mixed outcome timestamp (`lastAt`): a request that began BEFORE the
      //       stall can finish/cancel after it and otherwise masquerade as post-stall recovery (WI-2054656).
      //       Best-effort: a down gateway degrades to (a)+(b), never fails the read.
      const sql = getOrgPg().sql;
      const node = await getSpawnPg(sql, workspaceId, ownerId).catch(() => null);
      const beeOut = node?.lastOutputAt ? new Date(node.lastOutputAt).getTime() : 0;
      const presence = await sql<{ last_active_at: string | null }[]>`
        SELECT last_active_at FROM harness_shared.coord_presence WHERE owner_id = ${ownerId} LIMIT 1`.catch(
        () => [] as { last_active_at: string | null }[],
      );
      const coordAct = presence[0]?.last_active_at ? new Date(presence[0].last_active_at).getTime() : 0;
      let gatewayAct = 0;
      try {
        const r = await fetch(`${base()}/admin/owner-report?owner=${encodeURIComponent(ownerId)}`, {
          signal: AbortSignal.timeout(3000),
        });
        if (r.ok) {
          const body = (await r.json()) as GatewayOwnerActivityReport;
          gatewayAct = gatewayOwnerRequestActivityAt(body);
        }
      } catch {
        // gateway unreachable — (a)+(b) still serve
      }
      return Math.max(beeOut, coordAct, gatewayAct);
    },
    capacityBack: async (accountId, soonestResetAt) => {
      // H5 (inference-gateway-audit-2026-06-23): don't wake a stalled bee back onto a still-throttled pool.
      // (1) Honor the soonestResetAt the gateway computed — the arg used to be silently DROPPED. For an
      //     egress-class stall the gateway records a fabricated now+30s reset, so this is a real floor: never
      //     wake before it.
      if (soonestResetAt && Date.now() < soonestResetAt) return false;
      // (1b) Resolve the account row FIRST — it names the PROVIDER, so the pool-wide check below
      //     reads the right lane. WI-2038027: with the default (claude) projection, a CODEX stall
      //     was gated on the CLAUDE pool's paused/rejected state — wrong pool both ways (a walled
      //     claude pool held codex wakes; a healthy one waved them through blind). For codex the
      //     projection carries no pool-wide paused/rejected fields, so that check no-ops and the
      //     per-account usage-wall verdict below is the real gate — which is correct: codex
      //     capacity IS tracked per account (x-codex windows, WI-38582).
      const a = await findAccountRow(workspaceId, accountId);
      // (2) The gateway pool must NOT be wholesale-throttled. The old check only read the ACCOUNT's pausedUntil,
      //     so a fabricated 30s reset would wake the bee straight back into an all-accounts storm → re-stall →
      //     wake-cap burn → bee abandoned. The gateway /stats is the shared capacity oracle; unreachable ⇒ fall
      //     back to the per-account verdict (never strand a wake on a missing signal).
      const gw = await fetchGatewayHeadroom({
        timeoutMs: 1000,
        provider: a?.provider === 'codex' ? 'codex' : 'claude',
      }).catch(() => null);
      if (gw?.reachable && (gw.paused || gw.rejected)) return false; // whole pool throttled → keep waiting
      // (3) ...and the account itself must be able to SERVE: pause clear AND usage headroom.
      //     `available` is usage-aware as of WI-3310 (`!accountFull`): a weekly-usage-exhausted
      //     account whose bounded (≤6h) rate pause lapsed used to read available:true here, so the
      //     waker fired "rate limit recovered on avistorewolf.com" wakes for DAYS while the 7d
      //     window sat at 100% — the rate limit and the usage limit are different meters, and pause
      //     expiry is not usage recovery. When the account is usage-walled we log the REAL reset
      //     (once per account per wall, not per 20s tick) so the multi-day hold is visible, and hold.
      //     The lookup is CROSS-WORKSPACE (findAccountRow): /admin/stalls is global while this loop
      //     is pinned to one workspaceId, so a same-workspace-only read used to miss the account
      //     entirely and the unknown-account fallback waived the whole check (WI-3310 layer 2).
      //     (`a` was resolved at (1b) above — it now also drives the provider selection.)
      if (a?.usageWalled) {
        const until = a.usageResetAt;
        if ((usageWallLoggedUntil.get(accountId) ?? 0) !== (until ?? -1)) {
          usageWallLoggedUntil.set(accountId, until ?? -1);
          console.log(
            `[stall-waker] '${accountId}' is USAGE-walled (window exhausted${until ? `, resets ${new Date(until).toISOString()}` : ''}) — holding wakes until the usage window resets (a lapsed rate-limit pause is NOT usage recovery)`,
          );
        }
        return false;
      }
      return a ? a.available === true : true; // unknown account → trust the reset time we already waited out
    },
    unwedge: async (ownerId) => {
      // FAST UN-WEDGE (owner-requested 2026-06-23): ESC ONLY (no wake) — end the turn that died on a gateway
      // error so the wedged CLI re-arms its inbox-wake watch and can receive messages again immediately,
      // without waiting for the account's capacity to return.
      //
      // Root-cause fix (2026-07-01, gateway-mass-outage-storm-guard): forceEndTurn NEVER throws — a refusal
      // (storm-guard rate_limited) or a missing live session comes back as `{ok:false, error:...}`, a normal
      // return value. This used to be discarded (`await forceEndTurn(...)` with no result check), so
      // StallWaker.tick() always treated the attempt as a success even when NOTHING was delivered — exactly
      // what happened to every owner past the storm guard's per-actor cap during a correlated gateway outage.
      // Surface the real outcome so tick() can tell the difference and log it instead of lying about it.
      // FOCUS GUARD (gateway-rayobyte-hardening P-006): NEVER inject keystrokes into the session the
      // human is focused on right now — in the Claude Code TUI a stray Esc at the prompt (twice) opens
      // the rewind/restore picker (the 2026-07-01 accidental-conversation-restore). A focused human can
      // press Esc themselves; background/fleet windows stay auto-recoverable. Best-effort → false, so a
      // headless box behaves exactly as before.
      if (await isOwnerFocusedOnDesktop(ownerId).catch(() => false)) {
        console.log(
          `[stall-waker] unwedge(${ownerId}) skipped: session is the FOCUSED desktop window (human present — not injecting Esc)`,
        );
        return { ok: false, expected: true };
      }
      const r = await forceEndTurn({
        actor: 'stall-waker',
        workspaceId,
        owner: ownerId,
        reason: 'gateway error — ESC to re-arm (un-wedge)',
      });
      // `no_live_session` is the EXPECTED outcome (owner idle / already ended its turn — not wedged): non-
      // actionable and it recurs every cooldown, so surface it as `expected` and DON'T warn. A genuine refusal
      // (storm-guard rate-limit, SIGINT failure, etc.) still warns — a human may need to act on that.
      const expected = r.code === 'no_live_session';
      if (!r.ok && !expected) {
        console.warn(
          `[stall-waker] unwedge(${ownerId}) refused/failed: ${r.error ?? 'unknown'}${r.reason ? ` — ${r.reason}` : ''}`,
        );
      }
      return { ok: r.ok, expected };
    },
    wake: async (ownerId, summary) => {
      // ESC-THEN-WAKE (coord-end-turn P-003): a bee whose turn DIED on a rate limit is stuck mid-errored —
      // NOT sleeping on its inbox-wake key — so a bare wake lands woken:0. Force-ESC ends the dead turn first
      // (the CLI returns to idle + re-arms its watch), settle, THEN wake → a real fresh turn resumes on the
      // now-recovered account. Best-effort; the wake proceeds even if the ESC found no live pty.
      try {
        // FOCUS GUARD (P-006, same as unwedge): the coord wake MESSAGE below is always safe; only the
        // pre-wake Esc keystroke is withheld from the human's focused window.
        if (!(await isOwnerFocusedOnDesktop(ownerId).catch(() => false))) {
          await forceEndTurn({ actor: 'stall-waker', workspaceId, owner: ownerId, reason: summary });
          await new Promise((r) => setTimeout(r, ENDTURN_SETTLE_MS));
        }
      } catch {
        /* no live turn to end (already idle) → just wake */
      }
      const r = await wakeRecipients([ownerId], { summary, source: 'stall-waker', workspaceId });
      return { woken: r.woken };
    },
    now: () => Date.now(),
    log: (level, msg) => (level === 'warn' ? console.warn : console.log)(`[stall-waker] ${msg}`),
  };
}

export interface GatewayOwnerActivityReport {
  ledger?: { lastRequestAt?: number; lastAt?: number } | null;
}

/** Request-start activity for the stall false-positive guard. `lastAt` is a rolling-deploy fallback
 *  for an older gateway that has not yet learned `lastRequestAt`; once the gateway is current, late
 *  outcomes can no longer make pre-stall work look like post-stall recovery. */
export function gatewayOwnerRequestActivityAt(report: GatewayOwnerActivityReport): number {
  return report.ledger?.lastRequestAt ?? report.ledger?.lastAt ?? 0;
}

let timer: ManagedHandle | null = null;
let waker: StallWaker | null = null;

// EI-2432: the loop's only prior signal was `console.log` buried in the operator's
// stdout — an agent (even su, full access) could not confirm it was running,
// its poll cadence, or its recent activity without grepping host logs. Track a
// small in-process summary and expose it via {@link getStallWakerStatus}.
//
// EI-22054545312178322: the claim this comment used to make — "this loop lives in
// the OPERATOR process — same process as every agent-tool handler — so a `dev:*`
// tool reads it directly, no cross-process hop needed" — is FALSE under the
// dedicated-bg-host topology. `ensureStallWakerLoop` boot-starts ONLY on the host
// with `PAPERCUSP_BACKGROUND_WORKERS=1` (host-bootstrap.ts), which today is
// `papercup-bg-host` alone — :3070/:3170 are both request-only and never boot-start
// it. An agent-tool call is served by :3070/:3170, a SEPARATE process from bg-host,
// so THIS module-scope state answers only "is the loop running IN WHATEVER PROCESS
// HANDLED THIS CALL" — reading it directly from a request-only host silently
// reports `running:false` while bg-host's copy is genuinely ticking (WI-2054656).
// `dev:stall_waker_status`'s handler is the one that knows how to read this
// correctly (it federates to bg-host when the local copy is not running) — this
// function itself stays a pure, honest LOCAL read; do not "fix" it by reaching
// across processes from in here.
let startedAt: number | null = null;
let boundWorkspaceId: string | null = null;
let tickCount = 0;
let lastTickAt: number | null = null;
let lastTickOk = true;
let lastTickError: string | null = null;
let wokenTotal = 0;
let droppedTotal = 0;
let unwedgedTotal = 0;

/** Start the poll loop if not already running (idempotent — safe to call on every spawn). */
export function ensureStallWakerLoop(workspaceId: string): void {
  if (timer) return;
  waker = new StallWaker(createStallWakerDeps(workspaceId), {
    idleSilenceMs: IDLE_SILENCE_MS,
    deadQuietMs: DEAD_QUIET_MS,
  });
  startedAt = Date.now();
  boundWorkspaceId = workspaceId;
  timer = managedSetInterval(
    'stall-waker-loop',
    POLL_MS,
    () =>
      void waker!
        .tick()
        .then((r) => {
          tickCount++;
          lastTickAt = Date.now();
          lastTickOk = true;
          lastTickError = null;
          wokenTotal += r.woken.length;
          droppedTotal += r.dropped.length;
          unwedgedTotal += r.unwedged.length;
        })
        .catch((e: unknown) => {
          // tick() itself is documented never to throw (each step is guarded) — this catch is a
          // backstop so a genuinely unexpected throw still surfaces as `lastTickOk:false` instead
          // of silently freezing lastTickAt with no visible signal.
          tickCount++;
          lastTickAt = Date.now();
          lastTickOk = false;
          lastTickError = e instanceof Error ? e.message : String(e);
        }),
    { category: 'global-sweep' },
  );
  console.log(`[stall-waker] started (poll ${POLL_MS}ms, idle ${IDLE_SILENCE_MS}ms) for ${workspaceId}`);
}

export function stopStallWakerLoop(): void {
  if (timer) timer.stop();
  timer = null;
  waker = null;
  startedAt = null;
  boundWorkspaceId = null;
}

/** The shape {@link getStallWakerStatus} returns — named + exported (EI-22054545312178322)
 *  so a cross-process reader (schedule-federation.ts's sibling probe, the `/internal/managed-timers`
 *  route, `dev:stall_waker_status`'s handler) can type a REMOTE process's snapshot the same way as
 *  a local one, instead of re-declaring this shape by hand at every call site. */
export interface StallWakerStatus {
  running: boolean;
  workspaceId: string | null;
  startedAt: number | null;
  pollMs: number;
  idleSilenceMs: number;
  tickCount: number;
  lastTickAt: number | null;
  lastTickOk: boolean;
  lastTickError: string | null;
  pendingCount: number;
  breadcrumbCount: number;
  wokenTotal: number;
  droppedTotal: number;
  unwedgedTotal: number;
}

/** Observability snapshot (EI-2432) — running?, since when, poll cadence, last-tick health, and the
 *  waker's live counters, without grepping operator stdout. `running:false` when the loop was never
 *  started (gateway off / no spawn yet) or was stopped; every other field is `null`/0 in that case.
 *  LOCAL to whichever process calls it — see the file-header note above `startedAt` for why a
 *  request-only host's own reading of this function is not production truth. */
export function getStallWakerStatus(): StallWakerStatus {
  return {
    running: timer !== null,
    workspaceId: boundWorkspaceId,
    startedAt,
    pollMs: POLL_MS,
    idleSilenceMs: IDLE_SILENCE_MS,
    tickCount,
    lastTickAt,
    lastTickOk,
    lastTickError,
    pendingCount: waker?.pendingCount ?? 0,
    breadcrumbCount: waker?.breadcrumbCount ?? 0,
    wokenTotal,
    droppedTotal,
    unwedgedTotal,
  };
}
