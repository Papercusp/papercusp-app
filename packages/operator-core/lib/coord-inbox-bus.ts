/**
 * coord_inbox observer — the push side of the human-facing coord inbox (P-002 /
 * tui-workbench D-003b).
 *
 * Migration 126 fires `NOTIFY coord_inbox` for every
 * `harness_shared.coord_event_log` insert, payload `"<workspace_id>::<writer_key>"`.
 *
 * IMPORTANT — `writer_key` is NOT the recipient. For a direct `coord:send`,
 * `sendMessage` writes `appendLine('messages', writerKey = identity.ownerId, …)`
 * (the SENDER) with the recipients living in `body.to`; handoff/escalation rows
 * carry `writer_key = NULL`. Only the substrate FAN-OUT rows (`insertFanoutNotify`)
 * set `writer_key = subscriber_id`. So a row addressed to the human carries
 * `writer_key = <some sender>`, never `'human'` — you CANNOT decide
 * human-relevance from the NOTIFY payload. (The earlier producer filtered
 * `writer_key === 'human'` and therefore never woke on a real human message —
 * verified against the live DB: 7 rows with `'human'` in `to`, 0 with
 * `writer_key = 'human'`.)
 *
 * So on each notification this module PEEKS the new `coord_event_log` rows since a
 * cursor and fires a wake only when a human-relevant row landed (a message/handoff
 * with `'human'` in `body.to`, or any escalation — mirroring the
 * `/api/coord/inbox` reader's filter). One LISTEN connection + one peek query per
 * notification, fanned out to all registered handlers (today just the
 * `/api/coord/inbox/sse` route, which turns a wake into an SSE invalidate so the
 * pui TUI refetches `GET /api/coord/inbox` — no polling).
 *
 * Mirrors `pending-events-listener.ts` (single dedicated LISTEN, lazy start, max
 * 1 connection on the embedded-PG admin URL). Host-only — opens a long-lived PG
 * connection, so only the Hono host imports it (never a browser/Vite chunk).
 *
 * EI-9991: shares EI-9920's fix (createNotifyBus / pg-notify-bus.ts) for the
 * identical no-retry-on-failed-LISTEN defect — a failed `listen()` (e.g.
 * CONNECTION_DESTROYED during embedded-PG boot warmup) used to reset `started`/
 * `startPromise` and give up with no self-retry, permanently orphaning any
 * handler already registered via `onCoordInbox` (the human coord-inbox SSE push
 * would silently stay dark for the whole session). Retries with the same capped
 * exponential backoff (500ms→10s) as long as ≥1 handler is registered, cancelled
 * the instant the last handler unsubscribes. Kept as a bespoke retry (not
 * delegated to `createNotifyBus`) — this module's cursor/peek/coalescing
 * machinery (`onNotify`, `draining`/`dirty`, the human-relevance filter) has no
 * equivalent in the generic bus, so delegating would mean reshaping both
 * modules in the same change; the memoized `startPromise` + retry composition
 * below is the smaller, lower-risk fix for the actual reported defect.
 */
import postgres from "postgres";
import { getOrgPg, longLivedPoolConnectionOptions } from "@papercusp/db-org";
import { DEFAULT_COORD_WORKSPACE } from "@papercusp/coordination/event-log";
import { evaluateDataCondition, type DataCondition } from "@papercusp/rules";
import { getHarnessAdminUrl } from "./embedded-pg-discovery";
import { hubListen, listenHubEnabled } from "./pg-listen-hub";

/** A wake handler — invoked once when a human-relevant coord row lands. */
type Handler = () => void;

const WS = DEFAULT_COORD_WORKSPACE;

/** Backoff schedule for a failed LISTEN start (EI-9991, mirrors EI-9920): 500ms, 1s, 2s, 4s, capped at 10s. */
const RETRY_INITIAL_MS = 500;
const RETRY_MAX_MS = 10_000;

const handlers = new Set<Handler>();
let started = false;
let listenerSql: postgres.Sql | null = null;
/** Hub unsubscribe (set only when PAPERCUSP_LISTEN_HUB=1 routes us onto the shared connection). */
let hubUnsub: (() => void) | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelayMs = RETRY_INITIAL_MS;
/** Highest `coord_event_log.id` already considered (peek watermark). */
let cursor = 0;
/** Re-entrancy guard so overlapping NOTIFYs collapse into one peek pass. */
let draining = false;
let dirty = false;
/** Test-only peek override (see `_coordInboxTestSeam`); null = the real peek. */
let peekOverride: (() => Promise<boolean>) | null = null;
/** Memoized in-flight start, so concurrent `onCoordInbox` callers share one
 *  LISTEN and a test can await full readiness (cursor seeded + LISTEN live). */
let startPromise: Promise<void> | null = null;

/**
 * True if a `coord_event_log` row is something the HUMAN inbox surfaces — a
 * message or handoff addressed to `'human'`, or any escalation row. This is the
 * push-side mirror of the `/api/coord/inbox` reader's filter
 * (`coord/index.ts`: messages/handoffs with `'human'` in `to`; escalations shown
 * while open — any escalation insert/resolution is worth a refresh). PURE so it
 * is unit-testable without a database. NB: keys off `to`, never `writer_key`.
 *
 * Expressed declaratively as a `@papercusp/rules` `DataCondition`
 * (adopt-event-rules-engines D-003): any escalation, OR a message/handoff whose
 * `to` array `contains` `'human'`. The reader's `Array.isArray(to)` guard is the
 * consumer's coercion (the rules lib is pure over data): a non-array `to` is
 * normalized to `[]` so the `contains` test can't substring-match a stray string.
 */
const HUMAN_RELEVANT_ROW: DataCondition = {
  any: [
    { surface: { equals: "escalations" } },
    {
      all: [
        { surface: { in: ["messages", "handoffs"] } },
        { to: { contains: "human" } },
      ],
    },
  ],
};

export function isHumanRelevantRow(surface: string, to: unknown): boolean {
  const toArray = Array.isArray(to) ? to : [];
  return evaluateDataCondition(HUMAN_RELEVANT_ROW, { surface, to: toArray });
}

/** Normalize a jsonb `to` value (postgres-js may hand back a string or array). */
function parseToArray(v: unknown): unknown {
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }
  return v;
}

/** Register a wake handler; lazily starts the single LISTEN. Returns unsubscribe. */
export function onCoordInbox(handler: Handler): () => void {
  handlers.add(handler);
  void ensureStarted();
  return () => {
    handlers.delete(handler);
    void maybeCloseListener();
  };
}

function clearRetry(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  retryDelayMs = RETRY_INITIAL_MS;
}

/** Schedule a retry of `ensureStarted` with capped exponential backoff, as long
 *  as a handler is still registered (EI-9991). */
function scheduleRetry(): void {
  if (retryTimer || handlers.size === 0) return;
  const delay = retryDelayMs;
  retryDelayMs = Math.min(retryDelayMs * 2, RETRY_MAX_MS);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void ensureStarted();
  }, delay);
  retryTimer.unref?.();
}

/** Close the listener if there are no handlers left (cleanup to avoid listener leak). */
async function maybeCloseListener(): Promise<void> {
  if (handlers.size !== 0) return;
  // No subscribers left — cancel any pending retry even if we never actually
  // got a live connection (started === false), or it would fire into an empty
  // bus and leak a connection nobody asked for.
  clearRetry();
  if (!started) return;
  if (hubUnsub) {
    hubUnsub();
    hubUnsub = null;
    started = false;
    startPromise = null;
    return;
  }
  if (listenerSql) {
    try {
      await listenerSql.end({ timeout: 5 }).catch(() => {});
    } catch {
      // Ignore errors during close
    }
    listenerSql = null;
    started = false;
    startPromise = null;
  }
}

/** Seed the cursor at the current max id so existing history isn't replayed as
 *  wakes — a freshly-connected client seeds its own inbox via the reader. */
async function initCursor(): Promise<void> {
  try {
    const rows = await getOrgPg().sql<{ max_id: string | null }[]>`
      SELECT COALESCE(MAX(id), 0)::text AS max_id
        FROM harness_shared.coord_event_log
       WHERE workspace_id = ${WS}
    `;
    cursor = Number(rows[0]?.max_id ?? 0) || 0;
  } catch (err) {
    console.error("[coord-inbox-bus] cursor init failed:", err);
    cursor = 0;
  }
}

/** Read rows newer than the cursor, advance it, and report whether any of them
 *  is human-relevant. Indexed `id > cursor` scan — usually one row per NOTIFY. */
async function peekHumanRelevant(): Promise<boolean> {
  const rows = await getOrgPg().sql<
    { id: string; surface: string; to_json: unknown }[]
  >`
    SELECT id::text AS id, surface, body->'to' AS to_json
      FROM harness_shared.coord_event_log
     WHERE workspace_id = ${WS} AND id > ${cursor}
     ORDER BY id ASC
  `;
  let human = false;
  for (const r of rows) {
    const id = Number(r.id) || 0;
    if (id > cursor) cursor = id;
    if (isHumanRelevantRow(r.surface, parseToArray(r.to_json))) human = true;
  }
  return human;
}

/** Handle one (or a coalesced burst of) `coord_inbox` notification(s). */
async function onNotify(): Promise<void> {
  if (handlers.size === 0) return; // nobody listening — skip the peek (catch up on next connect via the reader seed)
  if (draining) {
    dirty = true;
    return;
  }
  draining = true;
  try {
    do {
      dirty = false;
      let human = false;
      try {
        human = await (peekOverride ?? peekHumanRelevant)();
      } catch (err) {
        console.error("[coord-inbox-bus] peek failed:", err);
      }
      if (human) {
        for (const h of handlers) {
          try {
            h();
          } catch (err) {
            console.error("[coord-inbox-bus] handler threw:", err);
          }
        }
      }
    } while (dirty);
  } finally {
    draining = false;
  }
}

async function ensureStarted(): Promise<void> {
  if (started) return;
  if (!startPromise) {
    // Memoize: a concurrent second caller awaits the SAME start instead of
    // opening a second LISTEN. `started` flips true only once the LISTEN is live.
    startPromise = (async () => {
      await initCursor();
      // The peek QUERY runs on getOrgPg().sql (see initCursor/peekHumanRelevant),
      // never on this connection — so when the hub is on, the hub connection is
      // LISTEN-only, exactly as the hub requires.
      if (listenHubEnabled()) {
        hubUnsub = await hubListen("coord_inbox", () => {
          void onNotify();
        });
      } else {
        listenerSql = postgres(getHarnessAdminUrl(), {
          ...longLivedPoolConnectionOptions("coord-inbox-bus"),
          max: 1,
          // LISTEN: idle by design — never reap for idleness (would drop the subscription).
          idle_timeout: 0,
        });
        await listenerSql.listen("coord_inbox", () => {
          void onNotify();
        });
      }
      started = true;
      clearRetry();
      // WI-10004194: the last handler may have left while this start was in
      // flight; that close saw started=false and did nothing, so close now or
      // the LISTEN stays open with nobody to wake.
      if (handlers.size === 0) await maybeCloseListener();
    })().catch((err) => {
      console.error("[coord-inbox-bus] failed to start (will retry):", err);
      started = false;
      listenerSql = null;
      hubUnsub = null;
      startPromise = null; // allow a later retry
      scheduleRetry();
    });
  }
  return startPromise;
}

export async function _stopForTests(): Promise<void> {
  clearRetry();
  if (hubUnsub) {
    hubUnsub();
    hubUnsub = null;
  }
  if (listenerSql) {
    await listenerSql.end({ timeout: 5 }).catch(() => {});
  }
  listenerSql = null;
  started = false;
  startPromise = null;
  handlers.clear();
  cursor = 0;
  draining = false;
  dirty = false;
  peekOverride = null;
}

/**
 * Test-only seam (mirrors `_stopForTests`). The wake decision + the
 * `draining`/`dirty` re-entrancy live in module state that a real NOTIFY drives
 * non-deterministically; this exposes the notification pump, an awaitable
 * startup, a peek stub, and a state snapshot so the coalescing + empty-handler
 * skip paths are testable WITHOUT racing PG. Inert in production — nothing
 * imports it there.
 */
export const _coordInboxTestSeam = {
  /** Run the single-notification pump once (the LISTEN callback target). */
  pump: onNotify,
  /** Await full startup (cursor seeded + LISTEN established) after `onCoordInbox`. */
  ready: ensureStarted,
  /** Register a wake handler directly, WITHOUT starting a LISTEN (unit paths). */
  addHandler: (h: Handler): void => {
    handlers.add(h);
  },
  /** Replace the human-relevance peek with a stub; pass null to restore the real one. */
  setPeek: (fn: (() => Promise<boolean>) | null): void => {
    peekOverride = fn;
  },
  /** Force the peek watermark (to assert it is / isn't advanced). */
  setCursor: (v: number): void => {
    cursor = v;
  },
  /** Snapshot of the observer state machine. */
  state: (): {
    cursor: number;
    draining: boolean;
    dirty: boolean;
    handlerCount: number;
    started: boolean;
  } => ({
    cursor,
    draining,
    dirty,
    handlerCount: handlers.size,
    started,
  }),
};
