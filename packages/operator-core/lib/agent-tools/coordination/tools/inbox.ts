/**
 * coord:inbox — read the caller's coordination inbox.
 *
 * Union scan of every agent's outbox in coord/messages/, filtered to
 * entries addressed to me (or to '*'). Sorted by ts ascending.
 * Forgiving of malformed lines.
 */

import { z } from "zod";
import { defineTool } from "@papercusp/agent-mcp";
import {
  COORD_CONVERSATIONAL_KINDS,
  COORD_EXECUTABLE_KINDS,
  type CoordKind,
} from "@papercusp/coordination/core";
import { resolveAgentIdentity } from "../identity";
import { resolveActorIdentity, actorMailboxKeys } from "../actor-identity";
import {
  readInbox,
  drainAndDeliverUserMailbox,
  getSupersededMap,
  getRemoteOriginMsgIds,
  sendMessage,
} from "../messages";
import { heartbeatPresence, getPresence } from "../presence";
import { createPresenceBeatThrottle } from "../presence-beat-throttle";
import { readWatermark, writeWatermark } from "../watermarks";
import { emptyWatermark } from "@papercusp/coordination/core";
import {
  resolvePresenceScope,
  assemblePresenceSnapshot,
  renderPresenceRebootstrapBlock,
  consumePresenceRebootstrap,
} from "../presence-snapshot";
// The default-visibility predicates, relocated out of this defineTool module so
// the unread counter can share them (P-005 / D-006 — see the re-export below).
import {
  isAmbientBroadcast,
  isDirectedDelivery,
  excludeIntentDeclares,
  coalesceRepeatedBroadcasts,
  inboxPriorityBucket,
  prioritizedInboxWindow,
} from "../inbox-visibility";
import { COORD_READ_ROLES } from "../roles";
import { renderInjection, type CoordLineSource } from "../../../coord-schema";
import { fetchPresenceFleet } from "../presence-fleet";
import type { RecipientCueScope } from "../cue-authority";
import { bodyRefWorkItemResolver, hydrateRefs } from "../ref-hydrate-resolve";
import { annotateBlockedOnStatus } from "../blocked-on-status";
import { resolveBestEffort, knownOwnerIdSet } from "../recipient-resolve";
import {
  BODY_REF_SNIPPET_CHARS,
  detectEntryBodyRefs,
  isBodyRefEligible,
  readBodyRefsOptOut,
  type HydratedRef,
} from "../ref-hydrate";
import {
  renderContextUsageLine,
  contextUsagePct,
  renderBandedContextGauge,
  CONTEXT_GAUGE_CRITICAL_PCT,
  CONTEXT_GAUGE_LOUD_PCT,
  CONTEXT_GAUGE_QUIET_PCT,
} from "./inbox-context-usage";
import { readFleetWindDownLoopEndAuthorization } from "./continuation-gate";
import { readPriorRespawnOutcome, lostRespawnAmbientLine } from "../../../carry-respawn-outcome";
import { classifyStaleClaims, renderFlushGateLine, FLUSH_GATE_PCT } from "./inbox-flush-gate";
import { currentContextTokensForOwner } from "../../../compaction-usage";
import { getContextUsage } from "../../../system-health/context-usage-cache";
import { selfCompactionAvailability } from "../../../events/await/psu-pty-discovery";
import { listActiveClaimFreshnessForOwner } from "../../../work-item-claims";
import { activeWorkspaceId } from "../../../workspace-registry";
import { cachedRead, type CachedReadCtx } from "../../../cache";
import { fetchUnansweredDirected } from "../unanswered-directed";
import { authoredFieldsMarker } from "../message-fields";
import { annotateMessageAge } from "../message-age";
import {
  DEFAULT_INBOX_LIMIT,
  INBOX_ENTRY_BUDGET,
  INBOX_TIER_DEFAULTS,
} from "./inbox-content-bounds";

/**
 * SWR backstop for the coord:inbox derive (cache-expensive-tool-reads-2026-06-22 P-008).
 * ONLY the pure readInbox() derive (the p95-heavy union-scan over coord_event_log) is
 * cached — every side effect (presence heartbeat, read-receipt watermark, offline-mailbox
 * drain, rebootstrap, injection render) stays OUTSIDE the cache and runs on every call, so
 * a cache HIT never drops coordination liveness (D-001 purity: cache only the pure part).
 * Tagged with coord_event_log, whose per-event bump is DEBOUNCED (D-006) so the storm can't
 * tank the hit-rate; this short soft TTL bounds worst-case staleness alongside the debounce.
 */
const COORD_INBOX_SOFT_TTL_MS = 5_000;

/** P-005 reply-quote hydration budget (D-004): ~200 verbatim chars per quote,
 *  at most one quote per shown injection line (default window = 8 lines). */
const RELATED_QUOTE_SNIPPET_CHARS = 200;
const RELATED_QUOTE_MAX_REFS = 8;

/** P-008 body auto-ref budget (D-004): ≤3 mentions hydrate per message
 *  (detectEntryBodyRefs' cap), ~150 chars each (BODY_REF_SNIPPET_CHARS), and a
 *  window-global distinct-id cap matching the shown-window size, newest-biased
 *  — the same overflow policy as RELATED_QUOTE_MAX_REFS above. */
const BODY_REF_MAX_TOTAL = 8;

/**
 * EI-6797: per-owner throttle for the inbox liveness heartbeat. `coord:inbox`
 * (and `coord:orient`, which wraps it) fired the HEAVY `coord_presence`
 * `INSERT ... ON CONFLICT ... DO UPDATE` upsert on EVERY call — the dominant
 * lock-manager contention source when a busy fleet loops orient on a wake
 * cadence. Coalesce it to ≤1 upsert per window per owner (the discipline the
 * sibling dispatch beat already applies). Its own throttle Map so a no-op
 * dispatch beat never suppresses the row-minting inbox beat.
 */
const inboxHeartbeatThrottle = createPresenceBeatThrottle();

// Keep the model-facing filter aligned with the canonical wire vocabulary.
// Re-listing kinds here allowed executable `yield` (and later additions such as
// handoff status events) to appear in coord:orient/injections while the inbox
// schema rejected a caller trying to narrow on that same kind.
const COORD_KINDS = [
  ...COORD_EXECUTABLE_KINDS,
  ...COORD_CONVERSATIONAL_KINDS,
] as [CoordKind, ...CoordKind[]];

const COORD_KIND_FILTER_DESCRIPTION =
  `Supported narrowing filters are \`kinds\`, \`from\`, and \`unanswered_only\` (alias \`unansweredOnly\`). ` +
  `The \`kinds\` filter accepts canonical \`CoordKind\` wire values only: ${COORD_KINDS.join(', ')}. ` +
  `\`interrupt\` is conceptual language for actionable coordination traffic, not a \`kinds\` value; ` +
  `a cooperative turn-interrupt/wrap-up is encoded as the canonical executable kind \`yield\`.`;

// The default-visibility rules (ambient exclusion, intent-declare exclusion,
// repeated-broadcast coalescing) were RELOCATED to `../inbox-visibility` so the
// owner-visible unread counter can apply the SAME rules without importing this
// defineTool module (unread-count-truthfulness-2026-07-27 P-005 / D-006).
// Imported at the top of this file; re-exported here so this module's public
// surface — and every existing importer, including the two pure test files —
// is unchanged.
export {
  excludeIntentDeclares,
  isAmbientBroadcast,
  coalesceRepeatedBroadcasts,
  inboxPriorityBucket,
  prioritizedInboxWindow,
};

/** EI-13159: per-recipient cap passed to fetchUnansweredDirected for the
 *  `unanswered_only` filter — much larger than the fleet-health display cap
 *  (UNANSWERED_NEWEST_CAP=3) since a single-recipient inbox read wants EVERY
 *  unanswered msg_id it can filter on, not just the newest few for display. */
const UNANSWERED_FILTER_CAP = 200;

const receiptEventKey = (msgId: string): string => `coord:receipt:${msgId}`;

function isDuplicateKeyError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current; depth += 1) {
    if (
      typeof current === "object" &&
      current !== null &&
      (current as { code?: unknown }).code === "23505"
    ) {
      return true;
    }
    current =
      typeof current === "object" && current !== null
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return false;
}

/**
 * Return receipt-requesting directed messages that this read shows for the
 * first time. The watermark is a timestamp cursor, so the strict comparison
 * matches the write-through guard below; repeated VIEW reads retry only when a
 * receipt emission failed before the cursor advanced.
 */
export function newlyShownReceiptEntries(
  entries: readonly Record<string, unknown>[],
  ownerId: string,
  previousShownTs: string,
): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const msgId = entry.msg_id;
    const ts = entry.ts;
    const to = entry.to;
    if (
      typeof msgId !== "string" ||
      msgId.length === 0 ||
      typeof ts !== "string" ||
      ts.length === 0 ||
      (previousShownTs.length > 0 && ts <= previousShownTs) ||
      entry.receipt !== true ||
      !Array.isArray(to) ||
      !to.includes(ownerId) ||
      to.includes("*") ||
      seen.has(msgId)
    ) {
      return false;
    }
    seen.add(msgId);
    return true;
  });
}

/**
 * EI-21949790802251298: the largest timestamp this read may claim as SEEN.
 *
 * `messages_shown_ts` is a timestamp CURSOR, and a sender reads it as proof of
 * delivery (coord:watermark `{ agent, sent_ts }` -> `seen: shown_ts >= sent_ts`,
 * documented to the sender as "they've SEEN it — ping them, don't re-route").
 * A timestamp cursor can only say "everything at or before T was shown", so it
 * is sound ONLY when the shown window has no gaps below T.
 *
 * The window has gaps by design: `prioritizedInboxWindow` sorts by priority
 * bucket BEFORE ts (P-009, so an actionable ask survives a status flood), then
 * slices. A high-priority OLDER entry is therefore kept while a lower-priority
 * NEWER one is dropped — so max(shown) routinely sits ABOVE an entry that was
 * never shown. Advancing the cursor to max(shown) tells that message's sender
 * it was seen when it was not, and the documented reaction to `seen:true` is to
 * STOP re-routing — a silently dropped message, and the sender cannot detect it.
 *
 * So: never advance past the OLDEST UNSHOWN entry. Return the newest shown ts
 * strictly below it, or null when no shown ts qualifies.
 *
 * This deliberately fails toward "not seen": the cursor can stall while an old
 * low-priority message sits outside the window, which costs the sender a needless
 * ping. The opposite error loses the message outright, so the asymmetry is the
 * point — a receipt is a claim about what the reader was SHOWN, not about how far
 * the clock has run. Entries without a usable `msg_id`/`ts` count as UNSHOWN for
 * the same reason (they cannot be proven shown).
 */
export function receiptSafeShownTs(
  shown: readonly Record<string, unknown>[],
  population: readonly Record<string, unknown>[],
): string | null {
  const shownIds = new Set<string>();
  for (const entry of shown) {
    const msgId = entry.msg_id;
    if (typeof msgId === "string" && msgId.length > 0) shownIds.add(msgId);
  }

  let oldestUnshownTs: string | null = null;
  for (const entry of population) {
    const msgId = entry.msg_id;
    const ts = entry.ts;
    if (typeof ts !== "string" || ts.length === 0) continue;
    if (typeof msgId === "string" && msgId.length > 0 && shownIds.has(msgId)) continue;
    if (oldestUnshownTs === null || ts < oldestUnshownTs) oldestUnshownTs = ts;
  }

  let safest: string | null = null;
  for (const entry of shown) {
    const ts = entry.ts;
    if (typeof ts !== "string" || ts.length === 0) continue;
    if (oldestUnshownTs !== null && ts >= oldestUnshownTs) continue;
    if (safest === null || ts > safest) safest = ts;
  }
  return safest;
}

async function emitReadReceipt(
  entry: Record<string, unknown>,
  identity: { ownerId: string; workspaceId?: string | null },
): Promise<void> {
  const msgId = entry.msg_id as string;
  const key = receiptEventKey(msgId);
  const payload = {
    msg_id: msgId,
    delivered: true,
    read: true,
    woken: 0,
  };

  // Fire the local latch first. This covers same-machine senders immediately;
  // the stable fed-event below carries the same key back to a remote origin.
  const { emitAwaitedEvent } = await import("../../../events/await/engine");
  await emitAwaitedEvent({
    key,
    payload,
    summary: `[receipt] ${msgId}`,
    source: "coord:inbox",
    workspaceId: identity.workspaceId ?? undefined,
  });

  const harnessSlug = entry.harness_slug;
  if (typeof harnessSlug !== "string" || harnessSlug.length === 0) return;

  let machine = "unknown";
  try {
    const { machineFingerprint } = await import("../../../identity/device-keychain-id");
    machine = machineFingerprint();
  } catch {
    // The receipt remains useful without an optional machine label.
  }

  try {
    await sendMessage(
      {
        ownerId: "fed-receipt",
        ownerLabel: "fed-receipt",
        source: "system",
        workspaceId: identity.workspaceId ?? undefined,
        userId: null,
      } as never,
      {
        // The event key is the replay key. A second inbox read or a projection
        // race therefore hits the fed unique index instead of duplicating the
        // receipt row; that duplicate is an already-successful receipt.
        msgId: key,
        to: [],
        summary: `[receipt] ${msgId}`,
        harnessSlug,
        extra: {
          fed_event: {
            key,
            payload: { ...payload, machine },
            source: "fed-receipt",
          },
        },
      },
    );
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
  }
}

/** context-trimming-tiers P-012: a trimmed/standard session gets TIGHTER
 *  DEFAULTS (fewer entries, shorter bodies) — explicit `limit`/`max_body_chars`
 *  args always win. An explicit per-call `payloadTier:'full'` also restores
 *  uncapped entry fields (subject to the transport result door). coord:inbox deliberately keeps its hand-rolled JSON
 *  ToolResult instead of a `{data}` + shape conversion: the cc/omp PostToolUse
 *  hooks `json.loads` the text body (a `{data}` response could serve TOON on the
 *  MCP transport and silently break them), and the hooks call WITHOUT ctx_tier
 *  so they always read full-tier defaults. The `injection` block is already
 *  server-clipped by coord-schema and stays verbatim on every tier. */
/** Keep a truncation pointer inside the text the recipient actually sees. The
 * entry-level `*_truncated` metadata is easy to miss, while a clipped message
 * otherwise looks complete until it simply stops. The pointer is deliberately
 * short enough for the normal 250/400/600-char caps; an explicitly tiny cap may
 * not have room for it, in which case the existing metadata remains authoritative. */
function truncationPointer(msgId: unknown): string | null {
  if (typeof msgId !== "string" || msgId.length === 0) return null;
  return `… [clipped; read full message: coord:read { msg_id: ${JSON.stringify(msgId)} }]`;
}

function clipWithTruncationPointer(value: string, maxChars: number, msgId: unknown): string {
  const pointer = truncationPointer(msgId);
  if (!pointer || pointer.length >= maxChars) return value.slice(0, maxChars);
  return value.slice(0, maxChars - pointer.length) + pointer;
}

/** Keep the actionable tail of a long message body visible. `body` is the
 * flattened projection of the ordered sections, and senders conventionally
 * put the request in the final section. Prefix the recovery pointer because
 * the omitted content is now the head, rather than appending it after a head
 * excerpt that would hide the request. */
function clipBodyWithTruncationPointer(value: string, maxChars: number, msgId: unknown): string {
  const pointer = truncationPointer(msgId);
  if (!pointer || pointer.length >= maxChars) return value.slice(-maxChars);
  return pointer + value.slice(-(maxChars - pointer.length));
}

/** Bound the COMBINED `text` across one entry's `sections[]` to a single shared
 *  `maxChars` budget, preserving every other section key. Returns null when there
 *  is nothing to do (not an array, or already within budget) so the caller can
 *  leave the entry object untouched.
 *
 *  The budget is shared across the whole entry rather than applied per section on
 *  purpose: a per-section cap still scales with section count, and section count
 *  is precisely what overflowed the read this fixes. Pure. */
function boundSectionsText(
  raw: unknown,
  maxChars: number,
  msgId: unknown,
): { sections: unknown[]; fullChars: number } | null {
  if (!Array.isArray(raw)) return null;
  let fullChars = 0;
  for (const s of raw) {
    const t = (s as Record<string, unknown> | null | undefined)?.["text"];
    if (typeof t === "string") fullChars += t.length;
  }
  if (fullChars <= maxChars) return null;
  // Reserve the pointer before distributing text across sections. Without this
  // reservation, a retained section could consume all but a few characters of
  // the budget and leave the clipped section with no room to identify the
  // recovery path at all.
  const pointer = truncationPointer(msgId);
  const usablePointer = pointer && pointer.length < maxChars ? pointer : null;
  const pointerChars = usablePointer?.length ?? 0;
  let remaining = maxChars - pointerChars;
  let truncated = false;
  // Spend the shared budget from the tail. A coord:send body commonly puts the
  // actionable request in its final section; front-biased allocation can leave
  // that section as an empty shell while preserving only explanatory context.
  // Keep the original array order in the result, but retain later sections
  // before earlier ones are clipped.
  const sections = raw.slice();
  for (let i = raw.length - 1; i >= 0; i -= 1) {
    const s = raw[i];
    if (!s || typeof s !== "object") continue;
    const rec = s as Record<string, unknown>;
    const t = rec["text"];
    if (typeof t !== "string") continue;
    if (truncated) {
      sections[i] = { ...rec, text: "" };
      continue;
    }
    if (t.length <= remaining) {
      remaining -= t.length;
      continue;
    }
    const kept = t.slice(0, remaining) + (usablePointer ?? "");
    remaining = 0;
    truncated = true;
    sections[i] = { ...rec, text: kept };
  }
  return { sections, fullChars };
}

/** EI-1752: truncate an inbox entry's content-bearing string fields (`summary`,
 *  `body`) to `maxChars` so a default read can't overflow the agent result cap (a
 *  few long summaries/bodies = 80KB+ in one line). Truncated fields carry a
 *  `<field>_truncated` flag; the full text stays reachable via coord:thread.
 *  `maxChars <= 0` ⇒ no truncation. Pure.
 *
 *  EI-19423034419710126: `sections[].text` is bounded too. This is not cosmetic —
 *  a multi-section body is the NORMAL shape for a substantive coord message
 *  (coord:send REFUSES a plain-string `body`), and `sections[].text` carries the
 *  SAME prose as `body`. Bounding one copy and leaving the other whole made
 *  `max_body_chars` approximately a no-op on exactly the messages that make a read
 *  expensive: a measured `max_body_chars: 1` read returned 1-char bodies beside
 *  ~3.8KB of untouched sections and blew a ~1500-token door by 35x. Because the
 *  arg is the documented lever for "read many entries cheaply", it failed in the
 *  worst direction — you reach for it when you already know the read is large.
 *
 *  The body and sections are tail-biased: the flattened body keeps its
 *  actionable suffix, while the ordered sections spend their shared budget
 *  from the final section backward. Structural keys (premises / forYouBecause /
 *  youMayNotKnow / couldNotDetermine / clarify) are PRESERVED rather than
 *  stripped: authoredFieldsMarker runs AFTER bounding and derives its marker
 *  from them, so dropping `sections` outright — the cheaper fix — would
 *  silently drop that marker instead. */
export function boundInboxEntries<T extends Record<string, unknown>>(
  entries: readonly T[],
  maxChars: number,
): Array<Record<string, unknown>> {
  if (!(maxChars > 0))
    return entries as unknown as Array<Record<string, unknown>>;
  return entries.map((e) => {
    let out: Record<string, unknown> = e;
    for (const field of ["summary", "body"] as const) {
      const v = e[field];
      if (typeof v === "string" && v.length > maxChars) {
        out = {
          ...out,
          [field]:
            field === "body"
              ? clipBodyWithTruncationPointer(v, maxChars, e["msg_id"])
              : clipWithTruncationPointer(v, maxChars, e["msg_id"]),
          [`${field}_truncated`]: true,
          [`${field}_full_chars`]: v.length,
        };
      }
    }
    const bounded = boundSectionsText(e["sections"], maxChars, e["msg_id"]);
    if (bounded) {
      out = {
        ...out,
        sections: bounded.sections,
        sections_truncated: true,
        sections_full_chars: bounded.fullChars,
      };
    }
    return out;
  });
}

/** The warning attached to a REMOTE-ORIGIN entry that asserts infrastructure
 *  state. Deliberately names the misreading it prevents AND the destructive act
 *  such alarms prescribe, because both were observed (EI-19493603840800478). */
export const REMOTE_ORIGIN_NOTE =
  "⚠ REMOTE-ORIGIN — raised on a DIFFERENT node about ITS OWN install of this slug " +
  "(slugs are identical across federated nodes). This is NOT necessarily about the tree " +
  "you are in: verify local state before acting, and never run the rescue-commit such " +
  "alarms suggest against this shared tree on the strength of another machine's fault.";

/** Does this entry ASSERT INFRASTRUCTURE STATE (a watchdog/severe-event alarm),
 *  as opposed to being ordinary peer chatter? Only these get the full warning —
 *  a remote-authored plain message is correctly just `origin:'remote'`, and
 *  warning on all of them would train the reader to skip the marker. */
function assertsInfraState(e: Record<string, unknown>): boolean {
  if (typeof e["condition_key"] === "string" && e["condition_key"]) return true;
  const category = e["category"];
  return (
    typeof category === "string" &&
    (category === "severe-event" ||
      category === "severe-event-resolved" ||
      category === "supervision")
  );
}

/** EI-19493603840800478: mark entries authored on ANOTHER NODE.
 *
 *  A federated severe-event names only a harness slug, and slugs are identical on
 *  every node — so a peer's alarm about ITS OWN install reads as a claim about the
 *  local tree, and is locally unfalsifiable (healthy local state cannot distinguish
 *  "already recovered" from "never was about this machine"). Two agents in a row
 *  mis-attributed one such alarm to a local cause.
 *
 *  Annotating on READ rather than at the emitter is deliberate: WI-7309's `emitter`
 *  stamp can only describe the node that RAISED the alarm, and the stale peers are
 *  exactly the nodes that lack it — so `emitter:null` is ambiguous between "old
 *  code" and "remote", forever. The receiving node always knows `origin`. Pure. */
export function annotateRemoteOrigin<T extends Record<string, unknown>>(
  entries: readonly T[],
  remoteMsgIds: ReadonlySet<string>,
): Array<Record<string, unknown>> {
  if (remoteMsgIds.size === 0)
    return entries as unknown as Array<Record<string, unknown>>;
  return entries.map((e) => {
    const id = e["msg_id"];
    if (typeof id !== "string" || !remoteMsgIds.has(id)) return e;
    const marked: Record<string, unknown> = { ...e, origin: "remote" };
    if (assertsInfraState(e)) marked["remote_origin_note"] = REMOTE_ORIGIN_NOTE;
    return marked;
  }) as Array<Record<string, unknown>>;
}

/** WI-1444 severe-event condition lifecycle: annotate every entry whose
 *  `condition_key` has a STRICTLY-LATER resolution (`resolves_condition` on a
 *  later envelope — broadcastSevereEventResolved) with `resolved:true` +
 *  `resolved_at`, so an agent reading a stale stall alarm sees at a glance
 *  that the condition already cleared instead of burning a turn investigating
 *  it. Resolutions are scanned over the FULL inbox read (`all`, pre-limit) so
 *  a windowed view still resolves against everything the reader can see. Pure. */
export function annotateResolvedConditions<T extends Record<string, unknown>>(
  entries: readonly T[],
  all: readonly Record<string, unknown>[],
): Array<Record<string, unknown>> {
  // Latest resolution ts per condition key (ISO ts compare lexicographically).
  const resolvedAt = new Map<string, string>();
  const note = (key: unknown, ts: string): void => {
    if (typeof key === "string" && key) {
      const prev = resolvedAt.get(key);
      if (!prev || ts > prev) resolvedAt.set(key, ts);
    }
  };
  for (const e of all) {
    const ts = e["ts"];
    if (typeof ts !== "string") continue;
    // Singular (broadcastSevereEventResolved) + plural (broadcastSevereEventResolvedMany,
    // EI-9030b — one message superseding many conditions at once).
    note(e["resolves_condition"], ts);
    const many = e["resolves_conditions"];
    if (Array.isArray(many)) for (const k of many) note(k, ts);
  }
  if (resolvedAt.size === 0)
    return entries as unknown as Array<Record<string, unknown>>;
  return entries.map((e) => {
    const key = e["condition_key"];
    const ts = e["ts"];
    if (typeof key === "string" && typeof ts === "string") {
      const rts = resolvedAt.get(key);
      if (rts && rts > ts) return { ...e, resolved: true, resolved_at: rts };
    }
    return e;
  });
}

/** WI-7222 (plan agent-epistemics-2026-08-02, P-004's read side): mark entries whose
 *  ORIGINAL SENDER has superseded them (`coord:supersede`, migration 732) with
 *  `superseded_by` + `superseded_at`, so a reader does not act on a claim its author
 *  has already retracted.
 *
 *  MARKS, never suppresses — the opposite of `coord:retract` above, and migration 732
 *  says why: "a retraction that does not say what REPLACES it strands the reader." The
 *  forward pointer is the whole value; hiding the row would leave a reader who
 *  half-remembers it unable to find out what happened.
 *
 *  NON-MUTATING by construction, and that is load-bearing here rather than stylistic:
 *  readCoordFeed builds spread COPIES of each envelope, but `readInbox`'s slow path
 *  returns objects straight from `coordLog.readLines('messages')`, which an in-memory
 *  log hands back BY REFERENCE. Annotating in place there would write the marker into
 *  the log's own objects. Same shape as annotateResolvedConditions: map to a new object
 *  only for the entries that change, return the rest untouched.
 *
 *  Pure — the caller does the (batched, fail-soft) lookup and passes the map in, so this
 *  is unit-testable with no Postgres. */
export function annotateSuperseded<T extends Record<string, unknown>>(
  entries: readonly T[],
  marks: ReadonlyMap<string, { supersededBy: string; supersededAt: string | null }>,
): Array<Record<string, unknown>> {
  if (marks.size === 0) return entries as unknown as Array<Record<string, unknown>>;
  return entries.map((e) => {
    const id = e["msg_id"];
    if (typeof id !== "string") return e;
    const mark = marks.get(id);
    if (!mark) return e;
    return { ...e, superseded_by: mark.supersededBy, superseded_at: mark.supersededAt };
  });
}

/** EI-7018 sender filter: keep only entries SENT BY `from` (from === this ownerId). A
 *  nullish/empty `from` is a no-op (returns the input as-is). Extracted as a pure, exported
 *  helper — mirroring readCoordFeed's strict `from` filter — so the honored-not-silently-ignored
 *  behavior has a unit test. NB: the caller applies this to the DISPLAY set only; the full
 *  unfiltered read is kept for cross-entry scans (e.g. condition-resolution annotation). */
export function filterInboxBySender<T extends { from?: unknown }>(
  entries: readonly T[],
  from: string | undefined | null,
): readonly T[] {
  if (!from) return entries;
  return entries.filter((e) => e.from === from);
}

/**
 * EI-13159: keep only entries whose `msg_id` is in the caller's unanswered-
 * directed set — the exact set `fleet:assignments`' `unanswered_directed`
 * counter and `fleet:leader-brief` are built from (unanswered-directed.ts),
 * so a `coord:inbox { unanswered_only: true }` read can never disagree with
 * what those surfaces flagged. `undefined`/`null` unansweredMsgIds (the
 * filter wasn't requested) is a no-op passthrough. Pure — unit-tested without
 * PG or a live handler.
 */
export function filterInboxByUnanswered<T extends { msg_id?: unknown }>(
  entries: readonly T[],
  unansweredMsgIds: ReadonlySet<string> | undefined | null,
): readonly T[] {
  if (!unansweredMsgIds) return entries;
  return entries.filter(
    (e) => typeof e.msg_id === "string" && unansweredMsgIds.has(e.msg_id),
  );
}

/**
 * EI-12930: resolve + classify the coord:inbox `from` filter against the SAME roster
 * resolver coord:send uses, so the two verbs cannot DISAGREE on what an ownerId is. The
 * SHORT label rosters/injection lines display (`su-b0fbf`) is what an agent naturally has
 * to hand, but `filterInboxBySender` is STRICT equality against the FULL id — so a short
 * `from` matched nothing and returned `total: 0`, byte-identical to (and mistaken for) a
 * genuinely silent peer. This resolves a unique prefix/substring to the full ownerId
 * (reusing resolveBestEffort — the exact rewrite coord:send's wake path applies) and, when
 * the resolved id matches NO known agent, flags it `unmatched` so the caller can surface a
 * LOUD `from_unmatched` signal — making "the filter was malformed" distinguishable from
 * "the answer is no". PURE core (unit-tested).
 *
 * Fail-OPEN: an empty/unavailable roster yields `unmatched: false` (never a false loud
 * fail), mirroring resolveBestEffort/resolveRecipients' absent-roster discipline. A
 * nullish/empty `from` is a no-op.
 */
export function classifyInboxFromFilter(
  from: string | undefined | null,
  knownOwnerIds: readonly string[],
): { resolvedFrom: string | undefined; unmatched: boolean } {
  if (!from) return { resolvedFrom: undefined, unmatched: false };
  const resolvedFrom = resolveBestEffort([from], knownOwnerIds)[0] ?? from;
  const unmatched =
    knownOwnerIds.length > 0 && !new Set(knownOwnerIds).has(resolvedFrom);
  return { resolvedFrom, unmatched };
}

/**
 * The INTERNAL delivery floor — deliberately NOT in the agent-facing args schema
 * (plan fleet-deltas-leader-primitives-2026-07-10, decision D-013 R2).
 *
 * D-002 ratified "no `since_ts` parameter anywhere". That is a rule about what an
 * AGENT must hand-carry: a client-seeded timestamp is the WI-1600 footgun (seed it
 * to wall-clock now and every earlier message is invisible forever) and it costs
 * tokens on every call. It is NOT a rule that in-process callers may not bound
 * their own reads.
 *
 * So the agent-facing parameter is gone and `coord:inbox` is a VIEW (D-013 R1):
 * agents carry no cursor and a second read in the same turn re-shows the window
 * instead of emptying out. The DELIVERY path — `activity/hook-bundle.ts`, which
 * owns the server-side two-phase read cursor for surface `'inbox'` — is the one
 * caller that genuinely wants a delta, and it passes its committed floor through
 * here. One implementation, no fork, no parallel cursor store.
 *
 * Not agent-reachable: the MCP dispatcher validates against the args schema above,
 * which has no such field, so only in-process callers holding a real cursor can
 * set it.
 */
export interface InboxDeliveryFloor {
  /** Committed floor from the caller's OWN server-side read cursor. Never a
   *  client-reported wall-clock timestamp. */
  __deliveryFloorTs?: string | null;
}

function internalDeliveryFloor(args: unknown): string | undefined {
  const floor = (args as InboxDeliveryFloor | null | undefined)?.__deliveryFloorTs;
  return typeof floor === "string" && floor.length > 0 ? floor : undefined;
}

export default defineTool({
  name: "coord:inbox",
  description:
    "Read messages, acks, and handoffs addressed to you or broadcast. The direct bound is `limit`; `coord:orient.inboxLimit` maps to it. Returns counts by kind plus a priority-ranked (not newest-first) window (default 50). Ambient system broadcasts are excluded by default; include_ambient shows them. Repeated broadcasts collapse to one row (`repeat_count`, `first_seen_ts`); a cleared stale alarm carries `resolved:true` — do not investigate it. An entry with `superseded_by` was corrected — follow that msg_id. " +
      COORD_KIND_FILTER_DESCRIPTION +
      " `recent` mirrors `entries` as bare `msg_id`s (cross-surface alias; look up the row in `entries`)." +
      " This is a VIEW, not a delta: re-reading the same window does not empty it.",
  guidance: {
    // EI-21600823435053404: trimmed to clear the 1500-char prompt-weight HARD CAP (was 1706 —
    // a gate RED). Both cut sentences were redundant, not lost: the `limit` vs
    // `coord:orient.inboxLimit` mapping is already stated in the description above,
    // and the "OMP hook will do this once it ships" aside described unshipped work.
    // EI-21903..: trimmed AGAIN (1578 — a second gate RED) by dropping the description's
    // "Free-text `q` and time bounds (`since`) are not inbox arguments" sentence — it is now
    // fully redundant with the argRedirects.since/argRedirects.q entries below, which teach
    // the exact same redirect at ZERO prompt weight, paid only on the failure path.
    // 2026-08-31: trimmed a THIRD time (1508 — a third gate RED, ~8 over). Nothing was lost:
    // the standalone "The direct bound is `limit`; `coord:orient.inboxLimit` maps to it."
    // sentence was folded into the `limit`-window sentence that already names the default,
    // and "(alias includeAmbient)" was dropped because the arg schema already documents that
    // alias — a stale caller passing camelCase does not need to DISCOVER it from prose.
    // ⚠ This tool has now breached three times, always by ACCRETION into `description`.
    // It is the single heaviest coord tool; treat its headroom as spent. Before adding a
    // sentence here, put it in `argRedirects` (zero prompt weight, paid only on the failure
    // path) or in the returns/schema — and re-run `npx tsx scripts/tool-weight.ts`, which
    // prints this tool's exact projected weight, BEFORE committing.
    when: "At turn start; whenever you suspect another agent contacted you.",
    notWhen:
      'For agent-presence ("who is active?") — use coord:presence. For file locks — use locks:queue. To WAIT for one specific message/handoff — prefer coord:await-inbox (push/wake) over a poll.',
    // EI-21349112990078630: `since` on an inbox read is the measured recurrence —
    // filed 10+ times (EI-21250840792137976, EI-21070825753924729, EI-21191189549068493,
    // EI-21040673138977548, …) because the bare unrecognized-key rejection never named
    // where a time-bounded read lives. The absence is DELIBERATE (D-002/D-013 R1,
    // fleet-deltas-leader-primitives-2026-07-10: a client-seeded timestamp is the
    // WI-1600 footgun — seed it to wall-clock now and every earlier message is
    // invisible forever; coord:inbox is a VIEW bounded by `limit`). Costs zero prompt
    // weight (not rendered into the description); paid only on that failure path.
    argRedirects: {
      since: {
        tool: 'coord:feed',
        args: { since: '<ISO-timestamp>', owner: '<your ownerId>' },
        note: 'coord:inbox has NO time filter by ratified decision (D-002: agents never hand-carry read cursors — the WI-1600 seed-to-now footgun); it is a VIEW bounded by `limit`. A time-bounded read of your own traffic is coord:feed { since, owner } (owner = a literal ownerId; feed does not resolve "self")',
      },
      // EI-21901625037175266: coord:inbox has no free-text search by the same
      // ratified decision as `since` above (it is a bounded VIEW, not a query
      // surface) — but the bare unrecognized-key rejection never named where a
      // text-bounded read lives, same failure shape `since` used to have.
      q: {
        tool: 'coord:feed',
        args: { q: '<substring>' },
        note: 'coord:inbox has no free-text search — it is a VIEW bounded by `limit`, not a query surface. coord:feed { q } searches summary/body/from/to/plan_slug across the whole coordination stream (add owner/since to scope it to your own recent traffic).',
      },
      // EI-22006638872999372: retracted-message history belongs to the
      // forensic coord:feed surface, not the bounded coord:inbox VIEW.
      include_retracted: {
        tool: 'coord:feed',
        args: { include_retracted: true },
        note: 'coord:inbox does not accept include_retracted; use coord:feed { include_retracted: true } for the forensic/audit view that includes messages withdrawn via coord:retract.',
      },
      // P-001 (tool-contract-repair-2026-09-05). The `since` entry above proved the
      // mechanism: `since` filings ran ~20/day until argRedirects.since landed
      // 2026-08-24 and ~3/day after. These are the clusters that entry did NOT cover,
      // measured over all 511 coord:inbox probation filings by rejected key.
      //
      // READ/UNREAD (64 filings: unreadOnly 21, includeRead 21, unread 8, unread_only 7,
      // include_read 6, includeHandled 1) — the largest uncovered cluster. This is a
      // BETTER-ERROR, not an alias, and the distinction is the point: coord:inbox holds
      // no per-reader read state at all (D-002 — agents never hand-carry read cursors),
      // so there is nothing for `unreadOnly` to mean. `unanswered_only` is the real
      // attention filter but is NOT a synonym — a message you have READ but not answered
      // is included, and an unread broadcast is not. Aliasing these would silently answer
      // a different question than the caller asked, which is exactly the fusion the plan's
      // ALIAS-vs-BETTER-ERROR rule forbids; so each names the real capability AND the
      // semantic difference, letting the caller decide rather than guessing for them.
      unreadOnly: {
        tool: 'coord:inbox',
        args: { unanswered_only: true },
        note: 'coord:inbox has no read/unread state — it is a VIEW, not a delta, and re-reading the same window does not empty it (D-002: agents never hand-carry read cursors). The attention filter is `unanswered_only`, which is NOT a synonym for unread: it keeps DIRECTED messages still awaiting your reply (a message you already read but never answered IS included; an unread broadcast is NOT). For "addressed to me, answered or not" use `directed: true`',
      },
      unread_only: {
        tool: 'coord:inbox',
        args: { unanswered_only: true },
        note: 'coord:inbox has no read/unread state (D-002: it is a bounded VIEW, not a delta). `unanswered_only` keeps DIRECTED messages still awaiting your reply — read-but-unanswered IS kept, an unread broadcast is not; `directed: true` is the looser "addressed to me" filter',
      },
      unread: {
        tool: 'coord:inbox',
        args: { unanswered_only: true },
        note: 'coord:inbox has no read/unread state (D-002: it is a bounded VIEW, not a delta). `unanswered_only` keeps DIRECTED messages still awaiting your reply — read-but-unanswered IS kept, an unread broadcast is not; `directed: true` is the looser "addressed to me" filter',
      },
      includeRead: {
        tool: 'coord:inbox',
        args: { unanswered_only: true },
        note: 'there is no read/unread state to include or exclude — coord:inbox always returns the whole bounded VIEW (D-002). You do not need to opt already-read messages back IN; narrow the other way instead, with `unanswered_only: true` (still awaiting your reply) or `directed: true` (addressed to you, answered or not)',
      },
      include_read: {
        tool: 'coord:inbox',
        args: { unanswered_only: true },
        note: 'there is no read/unread state to include or exclude — coord:inbox always returns the whole bounded VIEW (D-002). Narrow with `unanswered_only: true` (still awaiting your reply) or `directed: true` (addressed to you, answered or not)',
      },
      includeHandled: {
        tool: 'coord:inbox',
        args: { unanswered_only: true },
        note: 'coord:inbox tracks no handled/unhandled state (D-002). `unanswered_only: true` is the closest real filter — DIRECTED messages still awaiting your reply; invert it by simply omitting it, since the unfiltered read already includes everything',
      },
      // TIME BOUNDS not spelled `since` (7 filings) — same ratified absence, same remedy;
      // the exact-key match on `since` above could not reach either spelling.
      since_ts: {
        tool: 'coord:feed',
        args: { since: '<ISO-timestamp>', owner: '<your ownerId>' },
        note: 'coord:inbox has NO time filter under any spelling (D-002: a client-seeded timestamp is the WI-1600 footgun — seed it to wall-clock now and every earlier message is invisible forever); it is a VIEW bounded by `limit`. coord:feed takes an ISO-8601 `since`, not epoch millis',
      },
      after: {
        tool: 'coord:feed',
        args: { since: '<ISO-timestamp>', owner: '<your ownerId>' },
        note: 'coord:inbox has NO time filter by ratified decision (D-002); it is a VIEW bounded by `limit`. A time-bounded read of your own traffic is coord:feed { since, owner } — the argument is named `since`, not `after`',
      },
      // TRANSPORT SCOPE (23 filings: harness 21, workspace 1, scope 1). Your inbox is
      // scoped to YOU by the transport that carries the call; there is no scope selector
      // to pass, so the remedy is to DROP the key rather than relocate it.
      harness: {
        tool: 'coord:inbox',
        args: { limit: 50 },
        note: 'coord:inbox is scoped to YOU, not to a harness — the outer transport scope already carries workspace/harness, so there is no scope selector to pass and no wider inbox to open. Drop the key. To read a DIFFERENT agent\'s traffic (which is not an inbox operation) use coord:feed { owner }',
      },
      workspace: {
        tool: 'coord:inbox',
        args: { limit: 50 },
        note: 'coord:inbox is scoped to YOU by the transport that carries the call; workspace is not a selectable argument. Drop the key',
      },
      scope: {
        tool: 'coord:inbox',
        args: { limit: 50 },
        note: 'coord:inbox has no scope selector — it returns YOUR mailbox, bounded by `limit`. Narrow with kinds/from/directed/unanswered_only instead; for another agent\'s traffic use coord:feed { owner }',
      },
      // BODY INCLUSION (15 filings: includeBody 6, includeBodies 4, include_body 3,
      // bodyChars 1, truncateChars 1). Not an alias: these read as booleans and the real
      // knob is a numeric budget, so accepting them would coerce a boolean into a char cap.
      includeBody: {
        tool: 'coord:inbox',
        args: { max_body_chars: 0 },
        note: 'bodies are ALWAYS included — there is no boolean to turn them on. They are TRUNCATED to a dynamic ~15KB budget so a default read cannot overflow the result cap; `max_body_chars` is that budget as a number (0 = no truncation). A truncated entry carries *_truncated:true and its full body is at coord:read { msg_id }',
      },
      includeBodies: {
        tool: 'coord:inbox',
        args: { max_body_chars: 0 },
        note: 'bodies are ALWAYS included — there is no boolean to turn them on; they are truncated to a dynamic budget. `max_body_chars` is that budget as a number (0 = no truncation); the full body of a truncated entry is at coord:read { msg_id }',
      },
      include_body: {
        tool: 'coord:inbox',
        args: { max_body_chars: 0 },
        note: 'bodies are ALWAYS included — there is no boolean to turn them on; they are truncated to a dynamic budget. `max_body_chars` is that budget as a number (0 = no truncation); the full body of a truncated entry is at coord:read { msg_id }',
      },
      bodyChars: 'max_body_chars',
      truncateChars: 'max_body_chars',
      // ANOTHER AGENT'S TRAFFIC (3 filings). An inbox is first-person by construction.
      owner: {
        tool: 'coord:feed',
        args: { owner: '<agent-id>' },
        note: 'coord:inbox reads YOUR OWN mailbox and takes no owner selector — reading another agent\'s traffic is a feed operation, not an inbox one. Use `from` to filter YOUR inbox to what a specific peer sent you',
      },
      sender: 'from',
      // AMBIENT/NOTIFY (2 filings). `notify` is both a kind and ambient-categorized, so
      // narrowing to it needs the ambient opt-in as well — a `kinds` filter alone silently
      // returns nothing, which reads exactly like "there are no notifications".
      include_notify: {
        tool: 'coord:inbox',
        args: { include_ambient: true, kinds: ['notify'] },
        note: 'there is no include_notify flag. `notify` is a canonical `kinds` value AND ambient-categorized, so it is excluded by default: pass include_ambient:true to opt ambient back in, and add kinds:["notify"] to narrow to it. kinds alone returns an empty window, which looks like "no notifications" rather than a suppressed one',
      },
    },
  },
  capability: "coord:read",
  requirePrincipal: false,
  agentRoles: [...COORD_READ_ROLES],
  // EI-20191127558336928: coord:inbox owns its coordination/admin reads and
  // does not use ctx.tx. Do not keep the dispatcher's ambient org-app
  // transaction open while mailbox, presence, watermark, and enrichment
  // awaits run; under fleet load that reservation can starve the coordination
  // read itself behind the 45s app-pool acquisition deadline.
  skipWorkspaceTx: true,
  // EI-20243434212359053: coord:inbox returns a hand-built JSON text body that
  // the OMP/Codex coordination hooks parse programmatically. If the generic
  // result door splices its truncation footer into that body, those consumers
  // receive an invalid JSON prefix even when the inbox arguments are bounded.
  // The handler already bounds entry content; keep the transport body intact
  // for its machine-readable callers.
  skipResultDoor: "programmatic-caller",
  args: z.object({
    kinds: z.array(z.enum(COORD_KINDS)).optional(),
    from: z
      .string()
      .optional()
      .describe(
        "Restrict to entries SENT BY this ownerId (from === this) — e.g. filter to just your leader's messages amid broadcast/doc-drift noise, or confirm a specific peer wrote to you. Applied after the ambient filter; the summary counts reflect it. (EI-7018)",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe(
        `Max entries returned (most-recent kept). Default ${DEFAULT_INBOX_LIMIT}.`,
      ),
    include_ambient: z
      .boolean()
      .optional()
      .describe(
        "Include ambient system broadcasts (service-health, agent-governor, doc-drift) excluded by default.",
      ),
    includeAmbient: z
      .boolean()
      .optional()
      .describe(
        "Compatibility alias for include_ambient; prefer the canonical snake_case key. If both are supplied, include_ambient wins.",
      ),
    include_intents: z
      .boolean()
      .optional()
      .describe(
        "Include peers' auto `now working on:` intent-declare messages (lifecycle:'intent'), excluded from the default read like ambient — they are presence state, re-broadcast to every plan/fleet subscriber, and on a busy fleet they dominate the window (P-005 fleet-member-dx: 2,300+ of one member's inbox). summary.intent_excluded counts them. A `from`-filtered read keeps them regardless (a sender-scoped read wants that sender's status).",
      ),
    max_body_chars: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Truncate each entry's body/summary/sections text to this many chars in the result (default dynamically budgets to roughly 15KB across entries) so a default read never overflows the agent result cap; truncated entries carry *_truncated:true and the full body is reachable via coord:read { msg_id } (or coord:thread). 0 = no truncation. An explicit payloadTier:'full' request also disables this field-level cap unless max_body_chars is supplied.",
      ),
    unanswered_only: z
      .boolean()
      .optional()
      .describe(
        "EI-13159: narrow to exactly the DIRECTED messages still awaiting your reply — the same unanswered-directed definition fleet:assignments' `unanswered_directed` counter and fleet:leader-brief use (a real correspondent's message, sender explicitly expects a reply, no ack/reply from you yet; excludes broadcasts, machine chatter, and reply-to-your-own-reply ping-pong). Applied after the ambient/intent/sender filters; summary.total reflects it. A lookup failure returns zero entries (never silently falls back to the unfiltered inbox) and sets summary.unanswered_lookup_failed:true.",
      ),
    unansweredOnly: z
      .boolean()
      .optional()
      .describe(
        "Compatibility alias for `unanswered_only`; prefer the canonical snake_case key. If both are supplied, `unanswered_only` wins.",
      ),
    unanswered: z
      .boolean()
      .optional()
      .describe(
        "Compatibility alias for `unanswered_only`; prefer the canonical snake_case key. If several are supplied, `unanswered_only` wins.",
      ),
    directed: z
      .boolean()
      .optional()
      .describe(
        "Narrow to entries addressed to a SPECIFIC recipient — i.e. drop entries broadcast to everyone (`to:['*']`); mixed `['*', you]` delivery counts as directed. Weaker than `unanswered_only`, which additionally requires that the sender expects a reply you have not sent: use `directed` for \"who wrote to ME\" (including messages you have already answered) and `unanswered_only` for \"what still needs my reply\". Applied after the ambient/intent/sender filters; summary.total reflects it and summary.broadcast_excluded counts what it dropped.",
      ),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    // D-013 R2: agents supply no floor (the parameter is gone); only the
    // cursor-owning delivery path does.
    const deliveryFloorTs = internalDeliveryFloor(args);
    const inboxContext = ctx as {
      contextTier?: keyof typeof INBOX_TIER_DEFAULTS;
      payloadTierOverride?: keyof typeof INBOX_TIER_DEFAULTS;
    };
    const sessionTier = inboxContext.contextTier;
    const explicitFullRequest = inboxContext.payloadTierOverride === "full";
    const tierDefaults =
      (sessionTier && INBOX_TIER_DEFAULTS[sessionTier]) ??
      INBOX_TIER_DEFAULTS.full;
    const limit = args.limit ?? tierDefaults.limit;
    // EI-20224620909324295: older model-facing surfaces emitted camelCase for
    // this option. Keep the snake_case key canonical while accepting the
    // explicitly-declared compatibility alias; an explicitly supplied
    // include_ambient value wins when both are present.
    const includeAmbient = args.include_ambient ?? args.includeAmbient ?? false;
    // EI-21374977511049906: older model-facing surfaces used camelCase for this
    // filter. Keep the snake_case spelling canonical while accepting the explicit
    // compatibility alias; an explicitly supplied `unanswered_only` wins.
    // P-001: `unanswered` joins `unansweredOnly` as a compatibility alias (16 filings).
    // Canonical snake_case still wins when several are supplied.
    const unansweredOnly =
      args.unanswered_only ?? args.unansweredOnly ?? args.unanswered ?? false;
    // P-001: hoisted above the derive because it participates in the windowing
    // decision below, not just the post-read filtering.
    const directedOnly = args.directed === true;
    // EI-12930: resolve a SHORT ownerId/label `from` (`su-b0fbf`) to the FULL ownerId via
    // the SAME roster resolver coord:send uses — so a filter that SUCCESSFULLY sent can't
    // then silently FAIL to find the reply — and flag `from_unmatched` when it matches NO
    // known agent, so a mistyped filter is never mistaken for a silent peer. One memoized
    // roster read; only runs when a `from` filter is passed; fail-open on an empty roster.
    let resolvedFrom = args.from ?? undefined;
    let fromUnmatched = false;
    if (args.from) {
      const known = await knownOwnerIdSet(identity.workspaceId).catch(() => null);
      ({ resolvedFrom, unmatched: fromUnmatched } = classifyInboxFromFilter(
        args.from,
        known ? [...known] : [],
      ));
    }
    // Offline-member mailbox (shared-hive-collaboration P-016): before the read,
    // deliver any `@user:`-parked assignment waiting for THIS member into their
    // live inbox, so a returning member sees it in this very response. The drain
    // matches the member's full actorUserKey ladder (resolveActorIdentity adds the
    // async gh id; cached). Best-effort — a drain hiccup must never break the read;
    // a fully-online member with no parked mail is a single cheap no-op UPDATE.
    await resolveActorIdentity(ctx)
      .then((actor) =>
        drainAndDeliverUserMailbox(actorMailboxKeys(actor), actor.ownerId),
      )
      .catch(() => {});
    // Piggyback liveness: reading your inbox IS a heartbeat. Keeps a fresh
    // coord:presence row for every active agent (the read hook runs every
    // tool call) without clobbering a declared intent. Best-effort, and run
    // concurrently with the read so it adds no latency.
    // EI-6797: coalesce the heavy heartbeat UPSERT to ≤1 per window per owner —
    // an inbox-per-tool-call storm was the dominant coord_presence lock-manager
    // contention source fleet-wide. Skipped calls stay fresh via the sibling
    // dispatch beat + the next past-window inbox read.
    // The watermark is read concurrently too — the P-010 re-bootstrap flag rides
    // it (snapshot_rebootstrap_pending), so the common no-flag path adds only one
    // cheap PK read and no extra latency.
    const [, all, wm] = await Promise.all([
      inboxHeartbeatThrottle.shouldBeat(identity.ownerId)
        ? heartbeatPresence(identity).catch(() => {})
        : Promise.resolve(),
      // Cache ONLY the pure derive (P-008). Keyed on the OWNER (principal-scoped — never
      // leak one agent's inbox to another), since_ts + kinds. The side effects above/below
      // run unconditionally. The VITEST bypass keeps existing coord:inbox tests unchanged.
      cachedRead(
        ctx as CachedReadCtx,
        {
          tool: "coord:inbox",
          key: {
            owner: identity.ownerId,
            since_ts: deliveryFloorTs ?? null,
            kinds: args.kinds ?? null,
            // WI-6939: the derive is now WINDOWED, so how much it reads depends on
            // `limit` and on whether the narrowing filters force the full read.
            // These MUST be in the key — without them a cached 15-entry window
            // would be served to a caller asking for 500.
            limit,
            bounded: !resolvedFrom && !unansweredOnly && !directedOnly,
            ambient: includeAmbient,
            intents: !!args.include_intents,
          },
          tags: ["coord_event_log"],
          softTtlMs: COORD_INBOX_SOFT_TTL_MS,
        },
        () =>
          // WI-6939: the unbounded readInbox matches ~99.8% BROADCAST rows — ~20k
          // rows / ~10MB transferred per call to return `limit` (15-50) entries.
          // Each such call seq-scans coord_event_log, sorts ~20k rows and launches
          // 3 extra parallel workers; with a `since_ts` bound the same query costs
          // 11.6ms against 220ms — a 20x gap explained entirely by the WINDOW, not
          // the predicate.
          //
          // ⚠ ATTRIBUTION: the 491,954-call / 30.1-hour figure on that statement is
          // the total across ALL of readInbox's callers, NOT this tool's share.
          // coord:inbox is only ~38k invocations over the same period (and some are
          // served from the cache below), so it is a MINORITY of them. Which caller
          // dominates is NOT established — a pg_stat_statements figure is per-STATEMENT
          // and cannot be split by call site. Do not read this comment as "coord:inbox
          // costs 30 hours", and do not substitute another call site into that claim
          // without measuring it.
          //
          // So read a bounded newest-first window, paging backwards only while THIS
          // tool's own filters have not yet yielded `limit` visible entries. The
          // stopping rule has to live here rather than inside readInbox because the
          // genuinely selective filters are this tool's: pushing readInbox's own
          // options down shrinks the set by 0.08% (broadcasts pass them all), while
          // a live read here excludes 7,651 ambient rows and coalesces 11,564
          // repeats out of ~20k. A bare LIMIT would be probable, not sound.
          //
          // `from` / `unanswered_only` / `directed` keep the FULL read: all are rare and
          // far more selective than the default pipeline, so windowing them would page to
          // exhaustion in many small queries instead of one large one. `directed` must be
          // in this set for CORRECTNESS as well as cost (P-001): the paging stopping rule
          // below counts entries the DEFAULT pipeline keeps, and it cannot see a filter
          // applied after the read — so a bounded directed read would stop as soon as the
          // window held `limit` mostly-BROADCAST rows and then filter nearly all of them
          // away, silently under-returning rather than paging on.
          //
          // NOTE: `ambient_excluded` and the resolution scan consequently count over
          // the window read, not all history — the intended trade, and it matches
          // what the caller is actually shown (`truncated` reports the boundary).
          // Resolutions stay correct for the same reason retraction markers do: a
          // resolution is always NEWER than its alarm, so a newest-first window
          // containing the alarm also contains the resolution.
          readInbox(
            identity.ownerId,
            { since_ts: deliveryFloorTs, kinds: args.kinds },
            !resolvedFrom && !unansweredOnly && !directedOnly
              ? {
                  enough: (entries) => {
                    const afterAmbient = includeAmbient
                      ? entries
                      : entries.filter(
                          (e) => !isAmbientBroadcast(e as unknown as Record<string, unknown>),
                        );
                    const { kept } = excludeIntentDeclares(
                      afterAmbient as unknown as Array<Record<string, unknown>>,
                      { includeIntents: args.include_intents, from: resolvedFrom },
                    ) as unknown as { kept: Array<Record<string, unknown>> };
                    return prioritizedInboxWindow(
                      coalesceRepeatedBroadcasts(kept),
                      limit,
                    ).length >= limit;
                  },
                }
              : undefined,
          ),
      ),
      readWatermark(identity.ownerId).catch(() => emptyWatermark()),
    ]);

    const ambientExcluded = includeAmbient
      ? 0
      : all.filter(isAmbientBroadcast).length;
    const ambientFiltered = includeAmbient
      ? all
      : all.filter((e) => !isAmbientBroadcast(e));
    // P-005 (fleet-member-dx): excluded by default like ambient, counted as
    // `intent_excluded` — see excludeIntentDeclares (the pure rule).
    const keepIntents = !!args.include_intents || !!args.from;
    const { kept: intentFiltered, excluded: intentExcluded } = excludeIntentDeclares(
      ambientFiltered as unknown as Array<Record<string, unknown>>,
      { includeIntents: args.include_intents, from: resolvedFrom },
    ) as unknown as { kept: typeof ambientFiltered; excluded: number };
    // EI-7018: honor a strict sender-only `from` filter instead of silently ignoring it (the
    // silent-ignore looked like a hit-less filtered read). Applied post-cache/in-memory so it
    // never collides with the owner-keyed derive cache; it scopes the returned window + the
    // summary counts (byKind/total below run on `filtered`). `all` stays unfiltered for the
    // resolution scan (annotateResolvedConditions).
    const bySender = filterInboxBySender(intentFiltered, resolvedFrom);

    // P-001 (tool-contract-repair-2026-09-05): `directed` — drop entries broadcast to
    // everyone, keeping only what was addressed to a specific recipient. The ambient
    // filter above suppresses only CATEGORIZED system broadcasts, so an ordinary peer
    // `to:['*']` message still reaches the default window and "who actually wrote to
    // ME" was previously inexpressible. Applied here, after the ambient/intent/sender
    // filters and BEFORE the unanswered narrowing, so the two compose in the order the
    // arg descriptions promise and the summary counts below see the final set.
    const directedInput = bySender as unknown as Array<Record<string, unknown>>;
    const broadcastExcluded = directedOnly
      ? directedInput.filter((e) => !isDirectedDelivery(e)).length
      : 0;
    const byDelivery = directedOnly
      ? (directedInput.filter((e) => isDirectedDelivery(e)) as unknown as typeof bySender)
      : bySender;

    // EI-13159: unanswered_only — narrow to exactly the msg_ids fleet:assignments'
    // `unanswered_directed` counter / fleet:leader-brief flag, via the SAME shared
    // primitive (unanswered-directed.ts) so coord:inbox can never disagree with what
    // those surfaces already told the caller was outstanding. Fail-SAFE, not fail-open:
    // a lookup failure filters to NOTHING (never silently falls back to the unfiltered
    // inbox, which would look like "unanswered_only had no effect" and hide the failure).
    let unansweredMsgIds: Set<string> | undefined;
    let unansweredLookupFailed = false;
    if (unansweredOnly) {
      try {
        const unansweredMap = await fetchUnansweredDirected([identity.ownerId], {
          perRecipientCap: UNANSWERED_FILTER_CAP,
        });
        unansweredMsgIds = new Set(
          (unansweredMap.get(identity.ownerId)?.newest ?? []).map((e) => e.msgId),
        );
      } catch {
        unansweredMsgIds = new Set();
        unansweredLookupFailed = true;
      }
    }
    const filtered = filterInboxByUnanswered(byDelivery, unansweredMsgIds);

    // EI-6144: fold repeated categorized broadcasts into one ×N row BEFORE the
    // limit slice, so the returned window carries distinct signal instead of a
    // watchdog line repeated `limit` times. Read-time only; ascending preserved.
    const coalesced = coalesceRepeatedBroadcasts(
      filtered as unknown as Array<Record<string, unknown>>,
    );
    const coalescedDupes = filtered.length - coalesced.length;

    // P-009: order by priority BEFORE slicing, so actionable asks survive a
    // low-priority flood even when they are older than the newest status rows.
    const entries = prioritizedInboxWindow(
      coalesced as unknown as Array<Record<string, unknown>>,
      limit,
    ) as unknown as typeof filtered;
    const truncated = Math.max(0, coalesced.length - entries.length);

    const byKind: Record<string, number> = {};
    for (const e of filtered) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;

    const summary = {
      total: filtered.length,
      returned: entries.length,
      truncated,
      // P-012: mark a tier-tightened read so the cap is never silent (D-004) —
      // pass an explicit `limit`/`max_body_chars` (or payloadTier:"full") for more.
      ...(sessionTier && sessionTier !== "full"
        ? { payload_tier: sessionTier }
        : {}),
      ambient_excluded: ambientExcluded,
      // P-005 (fleet-member-dx): auto intent-declares excluded from the default
      // read — presence state, not messages; include_intents opts back in.
      intent_excluded: intentExcluded,
      // EI-6144: rows folded into a ×N representative (repeat_count on the row).
      coalesced_dupes: coalescedDupes,
      // P-001: echo what `directed` dropped. Emitted only when the filter RAN, so a
      // zero here always means "the filter ran and excluded nothing" rather than the
      // ambiguous "either it excluded nothing or you never asked for it".
      ...(directedOnly ? { directed: true, broadcast_excluded: broadcastExcluded } : {}),
      // EI-12930: when a `from` filter is passed, echo the FULL ownerId it resolved to
      // (a short prefix/label is rewritten via the same resolver coord:send uses) and flag
      // `from_unmatched` when it matches NO known agent — so an empty result from a mistyped
      // filter is loudly distinct from a genuinely silent peer.
      ...(args.from
        ? { from_resolved: resolvedFrom, from_unmatched: fromUnmatched }
        : {}),
      // EI-13159: echo whether the unanswered_only filter ran and whether its
      // lookup succeeded — a lookup failure filters to zero entries, and this
      // flag is what distinguishes that from "you genuinely have none".
      ...(unansweredOnly
        ? { unanswered_only: true, unanswered_lookup_failed: unansweredLookupFailed }
        : {}),
      by_kind: byKind,
      oldest_returned_ts: entries.length
        ? entries.reduce<string | null>((min, entry) => {
            const ts = typeof entry.ts === "string" ? entry.ts : null;
            return ts && (!min || ts < min) ? ts : min;
          }, null)
        : null,
      newest_ts: entries.length
        ? entries.reduce<string | null>((max, entry) => {
            const ts = typeof entry.ts === "string" ? entry.ts : null;
            return ts && (!max || ts > max) ? ts : max;
          }, null)
        : null,
      // EI-21949790802251298: `newest_ts` is a max over the RETURNED window, and
      // that window is selected by PRIORITY before ts (prioritizedInboxWindow,
      // P-009) — so whenever `truncated > 0` it is NOT the newest of the filtered
      // set, and entries newer than it were withheld. `total` already describes
      // the full set, so an unmarked window-max reads as the set's newest and a
      // bounded read becomes indistinguishable from a complete one. The repo rule
      // is that a caller's `limit` bounds ROW LISTS ONLY, never an aggregate — and
      // where it does bound one, the RESULT must say so ON the aggregate.
      ...(truncated > 0
        ? {
            newest_ts_scope: "returned-window",
            newest_ts_total: filtered.reduce<string | null>((max, entry) => {
              const ts = typeof entry.ts === "string" ? entry.ts : null;
              return ts && (!max || ts > max) ? ts : max;
            }, null),
          }
        : {}),
    };

    // P-005 (fleet-member-dx, D-003): intents stay IN the mid-turn `[coord+N]`
    // injection — a peer's `>` status line is a designed ambient-awareness glyph —
    // only the RETURNED entries/summary exclude them. The injection window is
    // therefore built from the intent-INCLUSIVE list, and `newest_ts` must cover
    // it (the cc/omp hooks advance their cursor from newest_ts — a newest_ts that
    // lags an injected intent would re-inject the same line every read).
    let injectionEntries = entries;
    // EI-21949790802251298: the receipt cursor below must compare the SHOWN set
    // against the population it was sliced from, which is the intent-inclusive
    // list whenever the injection window is rebuilt just below.
    let injectionPopulation = coalesced as unknown as Array<Record<string, unknown>>;
    if (!keepIntents && intentExcluded > 0) {
      const withIntents = coalesceRepeatedBroadcasts(
        filterInboxByUnanswered(
          filterInboxBySender(ambientFiltered, resolvedFrom),
          unansweredMsgIds,
        ) as unknown as Array<Record<string, unknown>>,
      );
      injectionPopulation = withIntents;
      injectionEntries = prioritizedInboxWindow(withIntents, limit) as unknown as typeof entries;
      const injNewest = injectionEntries.length
        ? injectionEntries.reduce<string | null>((max, entry) => {
            const ts = typeof entry.ts === "string" ? entry.ts : null;
            return ts && (!max || ts > max) ? ts : max;
          }, null)
        : null;
      if (injNewest && (!summary.newest_ts || injNewest > summary.newest_ts)) {
        summary.newest_ts = injNewest;
      }
    }

    // EI-213057 READ-RECEIPT: emit receipts for newly SHOWN directed messages before
    // advancing this agent's `messages_shown_ts` cursor. The watermark is the sender's
    // read proof, so a failed receipt must leave it untouched; the next VIEW read then
    // retries the same stable `coord:receipt:<msg_id>` event instead of falsely claiming
    // the sender can observe a receipt that was never persisted.
    const newlyShownReceipts = newlyShownReceiptEntries(
      injectionEntries as unknown as Array<Record<string, unknown>>,
      identity.ownerId,
      wm.messages_shown_ts,
    );
    const receiptResults = await Promise.allSettled(
      newlyShownReceipts.map((entry) => emitReadReceipt(entry, identity)),
    );
    const receiptsEmitted = receiptResults.every((result) => result.status === "fulfilled");

    // EI-2042 READ-RECEIPT: advance this agent's `messages_shown_ts` cursor to the newest
    // entry just SHOWN to them — DETERMINISTICALLY here in tool code (the moment the
    // `[coord+N]` block is assembled for the agent), NOT via the LLM/turn-end hook. This
    // is the per-agent read-watermark a SENDER checks (surfaced as coord:presence
    // `read_through_ts`) to distinguish "read it + working" from "hasn't seen it yet" —
    // distinct from `messages_since_ts`, which advances at turn-END (so an aborted turn
    // re-delivers). Monotonic by guard (only ever forward — you can't un-see a message;
    // writeWatermark itself is last-write-wins, so the guard is what keeps shown_ts from
    // moving backward) + best-effort (a write failure must never break the inbox read).
    //
    // EI-21949790802251298: advance to the receipt-SAFE ts, NOT summary.newest_ts.
    // newest_ts is a max over the priority-selected window, which can sit above an
    // entry that window skipped — writing it would tell that message's sender it was
    // seen when it never was. receiptSafeShownTs() stops below the oldest unshown
    // entry; the monotonic guard is unchanged.
    const safeShownTs = receiptSafeShownTs(
      injectionEntries as unknown as Array<Record<string, unknown>>,
      injectionPopulation,
    );
    if (receiptsEmitted && safeShownTs && safeShownTs > wm.messages_shown_ts) {
      await writeWatermark(identity.ownerId, {
        messages_shown_ts: safeShownTs,
      }).catch(() => {});
    }

    // Server-side injection render (token-efficient-coord-injection P-005): the
    // ready-to-inject positional `[coord+N]` block, computed ONCE here from the
    // single-source `coord-schema` so the cc + omp hooks are dumb pipes (they
    // echo `injection` + advance the cursor from `summary.newest_ts`). The
    // cursor/summary metadata stays OUT of the injection body, alongside it.
    //
    // coord-authority-hardening P-003 (H1, EI-9501): resolve the READER's live
    // fleet membership so the renderer can demote a fleet-scoped control cue the
    // reader is not in scope of ("OUT-OF-SCOPE … NOT binding" — never dropped).
    // Best-effort: a failed membership read ⇒ cueScope undefined ⇒ plain tags
    // (mis-demoting a real member is worse than not demoting); a SUCCESSFUL read
    // with no fleet ⇒ fleetSlugs [] ⇒ every fleet-scoped cue demotes — exactly
    // the EI-9501 bystander case. Live-at-read, so membership drift since send
    // (TOCTOU) resolves to current truth.
    let cueScope: RecipientCueScope | undefined;
    try {
      const fleet = (await fetchPresenceFleet([identity.ownerId])).get(identity.ownerId);
      cueScope = {
        recipientId: identity.ownerId,
        fleetSlugs: fleet?.fleetSlug ? [fleet.fleetSlug] : [],
      };
    } catch {
      cueScope = undefined;
    }
    // coord-authority-hardening P-005: hydrate related_msg_id (replies +
    // escalation resolutions) into a compact VERBATIM quote of the REFERENCED
    // message — sender, ts, ~200 chars — so the receiver reads the exchange
    // without a fetch, even when they compacted the original away. Zero
    // sender-side change: the back-reference is the canonical envelope field
    // senders already set. This is the IO half (the renderer stays pure);
    // best-effort BY CONTRACT — any failure ⇒ undefined map ⇒ plain lines.
    // Acks are skipped (a pure receipt glyph — quoting what was acked is
    // noise); a dangling ref still renders, marked unresolved (visible, not
    // papered over). Capped to the shown-window size, newest-biased to match
    // renderInjection's newest-kept overflow policy.
    let relatedQuotes: Map<string, HydratedRef> | undefined;
    try {
      const relatedIds = [
        ...new Set(
          (injectionEntries as unknown as Array<Record<string, unknown>>)
            .filter(
              (en) =>
                en.kind !== "ack" &&
                typeof en.related_msg_id === "string" &&
                en.related_msg_id,
            )
            .map((en) => en.related_msg_id as string),
        ),
      ].slice(-RELATED_QUOTE_MAX_REFS);
      if (relatedIds.length) {
        const hydrated = await hydrateRefs(
          relatedIds.map((id) => ({ kind: "msg" as const, id })),
          { budget: { snippetChars: RELATED_QUOTE_SNIPPET_CHARS, maxRefs: relatedIds.length } },
        );
        relatedQuotes = new Map(
          hydrated.flatMap((h) => (h.ref.kind === "msg" ? [[h.ref.id, h] as const] : [])),
        );
      }
    } catch {
      relatedQuotes = undefined;
    }
    // coord-authority-hardening P-008: auto-detect WI-/EI- ids loose in the
    // shown FREE-PROSE lines and hydrate each distinct id ONCE into a one-line
    // status + title + checkpoint-tail suffix at delivery — the receiver stops
    // re-fetching or half-remembering cited items. Same IO-half contract as the
    // P-005 block above: best-effort BY CONTRACT (any failure ⇒ undefined map ⇒
    // plain lines). Machine-stamped lifecycle / plan-event / ack lines are
    // excluded (their ids are structural, not citations — isBodyRefEligible),
    // and a sender's noBodyRefs opt-out is honored here (no lookups) and again
    // at render. A local miss stays SILENT — unlike a declared ref, an
    // auto-detected mention carries no promise this store can resolve it (a
    // federated peer's id, prose that merely looks like an id); the id still
    // travels verbatim in the prose. Newest-biased global cap, like P-005.
    let bodyRefs: Map<string, HydratedRef> | undefined;
    try {
      const ids = [
        ...new Set(
          (injectionEntries as unknown as Array<Record<string, unknown>>)
            .filter((en) => isBodyRefEligible(en) && !readBodyRefsOptOut(en))
            .flatMap((en) =>
              detectEntryBodyRefs(en).flatMap((r) => (r.kind === "work-item" ? [r.id] : [])),
            ),
        ),
      ].slice(-BODY_REF_MAX_TOTAL);
      if (ids.length) {
        const hydrated = await hydrateRefs(
          ids.map((id) => ({ kind: "work-item" as const, id })),
          {
            budget: { snippetChars: BODY_REF_SNIPPET_CHARS, maxRefs: ids.length },
            resolvers: { "work-item": bodyRefWorkItemResolver },
          },
        );
        bodyRefs = new Map(
          hydrated.flatMap((h) => (h.ref.kind === "work-item" ? [[h.ref.id, h] as const] : [])),
        );
      }
    } catch {
      bodyRefs = undefined;
    }
    const coordInjection = renderInjection(
      injectionEntries as unknown as CoordLineSource[],
      { cueScope, relatedQuotes, bodyRefs },
    );

    // P-010 re-bootstrap-on-compaction (D-007): on the first read after a fresh
    // context / resume (a session-lifecycle start set snapshot_rebootstrap_pending),
    // the agent's cached roster baseline is gone but this cursor advanced — so
    // PREPEND a fresh presence snapshot to the injection ONCE (then the flag is
    // cleared), and the agent never coordinates off a stale baseline. Best-effort:
    // a failure leaves the flag set to retry and never breaks the inbox read. It
    // rides the same dumb-pipe `injection` echo, so no hook change is needed.
    let rebootstrap: string | null = null;
    try {
      const c = (ctx ?? {}) as {
        workspaceId?: string | null;
        harnessSlug?: string | null;
      };
      rebootstrap = await consumePresenceRebootstrap(
        identity.ownerId,
        wm,
        async () => {
          const resolved = await resolvePresenceScope(c);
          const snap = await assemblePresenceSnapshot(resolved);
          return renderPresenceRebootstrapBlock(snap);
        },
      );
    } catch {
      rebootstrap = null;
    }
    // agent-managed-compaction (P-007): prepend the cached context-usage signal so the
    // agent self-manages its own compaction. Cheap single-row PK read; best-effort — a
    // failure/absence just omits the line, never breaks the inbox. The watchdog (P-009)
    // refreshes context_tokens on a cadence, off this hot path.
    let usageLine: string | null = null;
    let flushLine: string | null = null;
    // agent-managed-compaction P-015: the LOUD-band (≥80%) banded gauge, server-rendered
    // so the PostToolUse hook stays a dumb pipe. Unlike `usageLine` (which rides the
    // `injection` echo only when new coord entries exist), the hook injects THIS even on an
    // empty inbox — closing the heads-down / zero-new-mail gap (EI-6597). One renderer
    // source (renderBandedContextGauge) shared with the P-013 result-annotator.
    let contextGauge: string | null = null;
    let respawnLine: string | null = null;
    try {
      const pres = await getPresence(identity.ownerId);
      // WI-4154: derive the usage from the transcript's CURRENT state (anchored
      // incremental read — cost is the append delta), never from the watchdog's
      // point-in-time cache, which went stale across every compaction boundary and
      // served false 126%/87% post-compaction alarms. The presence value remains
      // only as the fallback for owners whose transcript can't be read here (the
      // same sessions it was the only source for before).
      const live = await currentContextTokensForOwner(identity.ownerId);
      const tokens = live ?? pres?.contextTokens;
      // WI-2143463: the watchdog mirrors the gateway's route-bound lowest
      // observed prompt into the existing hot cache. It is evidence about the
      // fixed-prefix ceiling / conservative usable runway, never a replacement
      // for the total-prompt percent that still drives compaction.
      const cachedUsage = getContextUsage(identity.ownerId);
      const pct = contextUsagePct(tokens, pres?.compactionLimit);
      // EI-20210946042796988: the ambient affordance must agree with the actual
      // request-compaction predicate. Headless/autonomous members have no supported
      // psu-pty host, so prescribing the call would spend their last turn on a
      // guaranteed `no_live_pty_host` refusal.
      const selfCompactionAvailable =
        pct != null && pct >= CONTEXT_GAUGE_LOUD_PCT
          ? selfCompactionAvailability(identity.ownerId).available
          : null;
      let fleetWindDownLoopEndAuthorized: boolean | null = null;
      const authorizationWorkspaceId =
        (ctx as { workspaceId?: string | null } | undefined)?.workspaceId ?? identity.workspaceId;
      if (
        pct != null &&
        pct >= CONTEXT_GAUGE_CRITICAL_PCT &&
        selfCompactionAvailable === false &&
        authorizationWorkspaceId
      ) {
        fleetWindDownLoopEndAuthorized = await readFleetWindDownLoopEndAuthorization({
          ownerId: identity.ownerId,
          workspaceId: authorizationWorkspaceId,
        });
      }
      usageLine = renderContextUsageLine(
        tokens,
        pres?.compactionLimit,
        selfCompactionAvailable,
        fleetWindDownLoopEndAuthorized,
        cachedUsage?.observedPromptFloor ?? null,
      );
      // flush-to-proceed-stretch-discipline-2026-07-04 P-002: near a compaction boundary,
      // surface any work-item claim whose checkpoint is stale (unflushed state) and NAME the
      // action (work_items:checkpoint) — the flush invariant enforced on the ONE surface in
      // front of the agent at the moment it matters. The claims read fires ONLY at/above the
      // gate pct, so normal low-% turns pay nothing extra. Best-effort: any failure omits the
      // line and never breaks the inbox read.
      if (pct != null && pct >= CONTEXT_GAUGE_LOUD_PCT) {
        contextGauge = renderBandedContextGauge(
          tokens,
          pres?.compactionLimit,
          selfCompactionAvailable,
          fleetWindDownLoopEndAuthorized,
          cachedUsage?.observedPromptFloor ?? null,
        );
      }
      if (pct != null && pct >= FLUSH_GATE_PCT) {
        // EI-20218251557859818: the armed loop's carry-note obligation is read here too,
        // so this PRE-boundary line covers the SAME population the boundary gate refuses
        // on. Without it an agent whose item checkpoints were all fresh saw nothing at
        // 75/80/85% and first learned the loop:checkpoint prerequisite from a REFUSED
        // session:request-compaction — spending the boundary call on discovering the rule.
        // The condition is NOT re-derived here: armedLoopNeedsCarryNote is the same
        // predicate detectFlushTripwires uses, so warning and refusal cannot drift apart.
        // Its OWN try/catch on purpose — a loop-read failure must not suppress the claims
        // half (and vice-versa below). Fails OPEN: readFailed is never read as "no note".
        let loopNeedingCarryNote: string | null = null;
        try {
          const [{ getLoopStatus }, { getLoopCarryNoteWithMeta }, { armedLoopNeedsCarryNote }] =
            await Promise.all([
              import("../../../harness/routines/loop"),
              import("../../../carry-note"),
              import("../../../enforcement-gate"),
            ]);
          const loop = await getLoopStatus(identity.ownerId);
          if (loop?.active) {
            const meta = await getLoopCarryNoteWithMeta({
              harness: loop.harnessSlug,
              ownerId: identity.ownerId,
            });
            if (
              !meta.readFailed &&
              armedLoopNeedsCarryNote({
                active: Boolean(loop.active),
                carry: loop.carry,
                carryNote: meta.note,
              })
            ) {
              loopNeedingCarryNote = loop.harnessSlug;
            }
          }
        } catch {
          loopNeedingCarryNote = null;
        }
        try {
          const ws =
            (ctx as { workspaceId?: string | null } | undefined)?.workspaceId ??
            activeWorkspaceId();
          const fresh = await listActiveClaimFreshnessForOwner(ws, identity.ownerId);
          flushLine = renderFlushGateLine(pct, classifyStaleClaims(fresh, Date.now()), {
            loopNeedingCarryNote,
          });
        } catch {
          // The claims read failed; still surface the loop half if we resolved it.
          flushLine = renderFlushGateLine(pct, [], { loopNeedingCarryNote });
        }
      }
      // EI-19326331501849713 (owner-directed 2026-08-09): a carry-respawn that was
      // ACKNOWLEDGED but never cut is otherwise invisible — the host writes
      // `respawn-carry-dropped` to its per-owner event log and the only surface that
      // reads it is the NEXT session:request-compaction reply, which a settled agent
      // has no reason to call. Surfacing it here reaches the agent on its next TURN.
      //
      // P-009 (fleet-lead-instrumentation-audit-2026-08-09) widened this from
      // `dropped` to LOST: an attempt pre-empted mid-flight (internal claude re-exec,
      // host restart) never gets a verdict row at all, so it sat `pending` forever and
      // this line stayed silent — the exact "acked but never performed" case it was
      // built for, on the one path where the host records nothing to quote.
      //
      // Gated on the same quiet band as the gauge, for cost AND correctness: a dropped
      // respawn means the session is at/over its soft limit by construction, so a
      // low-% turn cannot have an actionable one — and low-% turns keep paying nothing
      // extra, the discipline the flush-gate read above already follows.
      if (pct != null && pct >= CONTEXT_GAUGE_QUIET_PCT) {
        try {
          respawnLine = lostRespawnAmbientLine(await readPriorRespawnOutcome(identity.ownerId));
        } catch {
          respawnLine = null;
        }
      }
    } catch {
      usageLine = null;
    }
    // respawnLine leads: "the compaction you are waiting for is not coming" reframes
    // every line below it, including the usage percent it explains.
    const injection = [respawnLine, usageLine, flushLine, rebootstrap, coordInjection]
      .filter(Boolean)
      .join('\n');

    // EI-1752: bound each entry's large content fields so an inbox read can't overflow
    // the agent result cap. The `max_body_chars` schema arg existed but was NEVER
    // applied. Agents put the message in `summary` (optionally `body`) — both are bound;
    // full text stays reachable via coord:thread. The compact `injection` block agents
    // consume is left intact (coord-schema already clips it); only raw `entries` are bound.
    // su-707ed (EI-1752 review): an EXPLICIT max_body_chars is honored exactly, but the
    // DEFAULT scales with `limit` — a flat 600 × up-to-500 entries would still be ~300KB.
    // min(600, floor(BUDGET/n)) keeps the content-bearing part of the entries payload
    // bounded at ANY limit; at the default 50-row read this now caps fields at 300 chars.
    // context-trimming-tiers P-012: the per-entry default cap follows the
    // session tier (250/400/600); an explicit max_body_chars still wins.
    // A raw ToolResult bypasses generic applyPayloadTier, so the framework
    // threads the explicit override separately from the ambient session tier;
    // only that explicit `full` request disables this local field cap.
    const effectiveCap =
      args.max_body_chars !== undefined
        ? args.max_body_chars
        : explicitFullRequest
          ? 0
        : entries.length > 0
          ? Math.min(
              tierDefaults.bodyChars,
              Math.floor(INBOX_ENTRY_BUDGET / entries.length),
            )
          : tierDefaults.bodyChars;
    // WI-1444: mark superseded condition alarms (resolved:true) before bounding,
    // scanning resolutions over the FULL read (`all`) so the annotation sees
    // resolutions even when the alarm+resolution straddle the `limit` window.
    const annotatedEntries = annotateResolvedConditions(
      entries as unknown as Array<Record<string, unknown>>,
      all as unknown as Array<Record<string, unknown>>,
    );
    const boundEntries = boundInboxEntries(annotatedEntries, effectiveCap).map((entry) => {
      // P-033 (e): mark which entries carry AUTHORED structure (premises /
      // forYouBecause / youMayNotKnow / couldNotDetermine / clarify). Derived AFTER
      // bounding on purpose: bounding truncates the TEXT of `summary`/`body`/
      // `sections[].text` but preserves every structural key, so the marker sees the
      // same authored fields either way — while deriving here guarantees it survives
      // to the returned row. (EI-19423034419710126 added the `sections[].text` bound;
      // that key preservation is exactly why it truncates sections instead of
      // dropping them, which would silently cost this marker.)
      //
      // The compact marker, not the full projection: this surface budgets its entries
      // to ~15KB total and scales the per-entry cap DOWN as `limit` rises, so a full
      // per-section block per row is exactly what that budget exists to prevent.
      // `coord:read <msg_id>` shows the structure in full.
      const authored = authoredFieldsMarker(entry);
      return authored ? { ...entry, authored } : entry;
    });

    // WI-7222: mark messages the sender has SUPERSEDED. Done last, over the bounded
    // page only, so the lookup is one keyed query over at most `limit` ids rather
    // than the full pre-limit read. Fail-soft and non-mutating — see
    // annotateSuperseded: losing the marker must never cost the caller their inbox,
    // and these entries can be live references into an in-memory coord log.
    let entriesOut: Array<Record<string, unknown>> = boundEntries as Array<Record<string, unknown>>;
    try {
      const ids = entriesOut
        .map((e) => e["msg_id"])
        .filter((id): id is string => typeof id === "string");
      if (ids.length > 0) entriesOut = annotateSuperseded(entriesOut, await getSupersededMap(ids));
    } catch {
      // Unmarked, but complete.
    }

    // coord-derived-fields-2026-08-31 P-005: diff each entry's AUTHORED
    // blockedOn refs against live state — the mechanism the field's own
    // doc-comment promised ("can be shown to have gone stale"). Same shape and
    // rationale as the supersession marker above: one keyed query per ledger
    // over the bounded page, fail-soft, non-mutating. A "cleared since send"
    // verdict is exactly the news a waiting reader needs; an undeterminable
    // ref gets NO verdict, never a guess.
    try {
      entriesOut = await annotateBlockedOnStatus(entriesOut, {
        workspaceId: identity.workspaceId ?? '',
      });
    } catch {
      // Unmarked, but complete.
    }

    // EI-19493603840800478: mark entries authored on ANOTHER NODE. Same shape and
    // rationale as the supersession marker above — one keyed query over the bounded
    // page, fail-soft, non-mutating. Without it a peer's "git-sync FAULTING on
    // <slug>" reads as a statement about THIS tree (slugs are identical across
    // nodes) and is locally unfalsifiable; it also prescribes a rescue-commit
    // against a shared tree. Cannot be fixed emitter-side: see annotateRemoteOrigin.
    try {
      const ids = entriesOut
        .map((e) => e["msg_id"])
        .filter((id): id is string => typeof id === "string");
      if (ids.length > 0)
        entriesOut = annotateRemoteOrigin(entriesOut, await getRemoteOriginMsgIds(ids));
    } catch {
      // Unmarked, but complete.
    }

    // EI-20261012762389206: stamp `age` on rows old enough that a time-relative
    // body ("sweeping in ~74s") has decayed into a false claim. This surface
    // DOES render an absolute `ts`, which is exactly why the marker is still
    // needed: the measured incident had the reader difference a 09:39Z stamp
    // against a "now" it mis-estimated and act on a 5.6h-old countdown as live.
    // Pure and last — no query, no failure mode, so unlike its siblings above
    // it needs no try/catch.
    entriesOut = annotateMessageAge(entriesOut, Date.now());

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            owner_id: identity.ownerId,
            summary,
            entries: entriesOut,
            // EI-18667514339699744: coord:orient folds this SAME rows under `recent`
            // (its own key name for "the most-recent bounded entries"), so a caller
            // who reads either tool's key name off THIS result must find something
            // real rather than a silent [] on a cross-surface accessor mismatch.
            // EI-21902920583326819: `recent` used to be a SECOND full copy of
            // `entries` (identical bodies/sections/premises), doubling the wire
            // bytes of every inbox read for a key nothing in this codebase actually
            // consumes as full rows (orient.ts's own `call('coord:inbox', ...)`
            // reads only `.entries`). It is now a cheap id-only pointer INTO
            // `entries` — a caller that reads `.recent` and needs a row's content
            // looks it up by `msg_id` in `entries`, same as it always could.
            recent: entriesOut.map((e) => e["msg_id"]),
            injection,
            // P-015: the ≥80% loud gauge, exposed OUT of `injection` so the PostToolUse
            // hook can inject it even when there are no new entries (empty-inbox turns).
            context_gauge: contextGauge,
          }),
        },
      ],
    };
  },
});
