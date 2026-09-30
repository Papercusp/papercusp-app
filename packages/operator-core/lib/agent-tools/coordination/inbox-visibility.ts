/**
 * inbox-visibility.ts — the PURE "is this entry visible in a default coord:inbox
 * read?" predicates. PURE: no I/O, no PG, no tool registration.
 *
 * WHY THIS MODULE EXISTS (unread-count-truthfulness-2026-07-27 P-005, D-006).
 * These three rules used to live inside `tools/inbox.ts`, which is a
 * `defineTool` module. That was fine while `coord:inbox` was their only caller,
 * but the owner-visible unread badge (`deriveCoordState` in `adv-agent-detail.ts`,
 * reached from the sync-resolver read path) must apply the SAME rules — and
 * importing a tool-definition module from a UI read path would drag zod + tool
 * registration into it.
 *
 * They were RELOCATED here rather than copied, exactly as P-002 relocated
 * `pickUnreadCursor` into `coordination/watermarks.ts`. A second definition of
 * "what counts as ambient" would drift from the first, and a counter disagreeing
 * with the reader is the very bug this plan exists to fix. `tools/inbox.ts`
 * re-exports all three, so its public surface (and every existing importer) is
 * unchanged.
 *
 * NOT here, deliberately (D-006): the display `limit`/`boundInboxEntries` cap and
 * the OPT-IN narrowing filters (`from`, `unanswered_only`). Those are paging and
 * caller-supplied narrowing — not "what a default read shows".
 */

/** Ambient system-broadcast categories excluded from the default inbox — they
 *  are high-volume status firehoses (service up/down, rate-limit pauses, and the
 *  per-git-sync doc-freshness RE-VERIFY digest) that bury addressed work. Every
 *  one is broadcast to '*' and actionable to almost no single reader, so on a busy
 *  fleet they drown out directed messages (EI-2826/EI-2871: a doc-drift flood
 *  literally BURIED a peer's "details inside" build-blocker so it was never read).
 *  `doc-drift` earns its place here even though it's individually useful: the
 *  fan-out is to `*`, not to the doc's owner, so for ~every recipient it is pure
 *  noise — the right long-term fix is owner/subscriber targeting (EI-2826 opt c),
 *  but exclude-by-default (opt a) unburies the channel for the whole fleet NOW.
 *  Still `message`s (D-002); opt back in via include_ambient. */
const AMBIENT_CATEGORIES = new Set([
  "service-health",
  "agent-governor",
  "doc-drift",
  // P-009 (fleet-worker-lifecycle-convergence-2026-08-26): these are
  // fleet-wide/status-plane broadcasts, useful in topic/audience history but
  // too noisy for a recipient's default action inbox. The broadcast-only guard
  // below keeps a direct deploy/perf/migration/task-manager message visible.
  "deploy",
  "release-deploy",
  "deployment",
  "perf",
  "performance",
  "migration",
  "task-manager",
  // EI-386: named-resource drain/back-up templates (resource-broadcast.ts) —
  // stamped for classification consistency with the others above. In practice
  // these are always sent to specific holders/waiters, never `to: ['*']`, so
  // isAmbientBroadcast's broadcast-only guard (below) keeps them visible to
  // the recipient who must act; this entry only takes effect if a future
  // caller ever genuinely broadcasts one to '*'.
  "resource-locks",
]);

/** P-005 (fleet-member-dx-improvements-2026-07-10) pure rule: exclude peers'
 *  auto `now working on:` intent-declare messages (lifecycle:'intent') from the
 *  default read — they are presence state re-broadcast to every @plan/@fleet
 *  subscriber, and on a busy fleet they dominate the window and make
 *  `summary.total` meaningless (observed: the bulk of a 2,332-message inbox).
 *  KEPT when the caller opted in (`includeIntents`) OR passed a sender `from`
 *  filter (a sender-scoped read wants that sender's status line). Pure.
 *
 *  Note for the unread badge (D-006): these are NOT broadcasts — they fan out
 *  ADDRESSED to each subscriber, so a recipient-keyed counter counts every one.
 *  Measured 2026-07-27: 506 in 24h, and up to 68% of a single agent's counted
 *  messages over 12h. This is the larger of the two Phase-2 legs, not ambient. */
export function excludeIntentDeclares<T extends Record<string, unknown>>(
  entries: readonly T[],
  opts: { includeIntents?: boolean; from?: string | null },
): { kept: T[]; excluded: number } {
  if (opts.includeIntents || opts.from) return { kept: [...entries], excluded: 0 };
  // Only machine-authored lifecycle projections are presence noise. A directed,
  // contextual message must never disappear merely because a producer reused the
  // `intent` lifecycle label; `auto:true` is the authoritative projection stamp.
  const kept = entries.filter(
    (e) => !(e["lifecycle"] === "intent" && e["auto"] === true),
  );
  return { kept, excluded: entries.length - kept.length };
}

/** Ambient suppression is intentionally broadcast-only. Category labels describe
 * content, not delivery importance; a system or peer may send the same category
 * directly to one agent, and that addressed traffic must remain visible. Mixed
 * `['*', owner]` delivery is also treated as directed. */
export function isAmbientBroadcast(e: Record<string, unknown>): boolean {
  const category = e["category"];
  const recipients = e["to"];
  return (
    typeof category === "string" &&
    AMBIENT_CATEGORIES.has(category) &&
    Array.isArray(recipients) &&
    recipients.length > 0 &&
    recipients.every((recipient) => recipient === "*")
  );
}

/**
 * Is this entry addressed to a SPECIFIC reader rather than broadcast to everyone?
 *
 * P-001 (tool-contract-repair-2026-09-05): `coord:inbox { directed: true }` is the
 * "messages actually addressed to me" filter — the question the tool exists to
 * answer, and until now the one narrowing it could not express. The ambient filter
 * suppresses only CATEGORIZED system broadcasts, so an ordinary peer `to:['*']`
 * broadcast still lands in the default window; `unanswered_only` is stricter in the
 * other direction (it also requires an expected, still-missing reply).
 *
 * The delivery predicate is deliberately the SAME one `isAmbientBroadcast` applies
 * above — all-'*' is broadcast, and mixed `['*', owner]` counts as directed — so the
 * two filters cannot drift into disagreeing about what "directed" means. An entry
 * with no usable `to` array is treated as directed: it reached this reader's inbox
 * somehow, and silently hiding it would make the filter lossy in the one direction
 * an inbox filter must never be.
 */
export function isDirectedDelivery(e: Record<string, unknown>): boolean {
  const recipients = e["to"];
  if (!Array.isArray(recipients) || recipients.length === 0) return true;
  return !recipients.every((recipient) => recipient === "*");
}

/** EI-6144 ambient/broadcast coalescing: collapse REPEATED categorized system
 *  broadcasts — same sender, kind, category, and summary (modulo embedded
 *  ISO-8601 instants, see VOLATILE_TIMESTAMP_RE), addressed to
 *  '*' — into ONE row (the newest of the group), annotated `repeat_count` +
 *  `first_seen_ts`. Watchdog/status firehoses re-emit the same line for hours;
 *  without this they fill the `limit` window with repetition and crowd distinct
 *  signal out. Only categorized broadcasts coalesce: direct messages (a peer
 *  legitimately saying the same thing twice) and uncategorized rows pass
 *  through untouched. Read-time only — the log keeps every row. Ascending
 *  order is preserved (each group's newest keeps its original position). Pure. */
/** An embedded ISO-8601 instant is pure restatement of ONE condition, so it must
 *  not split a coalescing group. Same class as escalations.ts' VOLATILE_DURATION_RE
 *  (which neutralises `12m` / `3h` in a dedup key, after that bug recurred four
 *  times); this is its timestamp sibling, and it is applied to the KEY ONLY — the
 *  surviving row still displays its own verbatim summary, which is the newest of
 *  the group, so the reader sees the LATEST instant rather than a placeholder.
 *
 *  MEASURED on 24h of live ambient broadcasts (2026-08-03): 4 groups / 111 rows
 *  recovered, every one a rate-limit pause — `bucket "anthropic:haiku" paused
 *  until <ts>` alone was 60 separate rows for a single ongoing condition.
 *
 *  DELIBERATELY NARROW: bare integers are PRESERVED. Blanking all digits instead
 *  would have scored higher (18 groups / 161 rows) by folding together messages
 *  that genuinely differ — `deploy stale: … N commits behind` is a different
 *  signal at 3 commits than at 40, and collapsing those loses information rather
 *  than repetition. A count is signal; an instant is noise. */
const VOLATILE_TIMESTAMP_RE =
  /\d{4}-\d{2}-\d{2}[T ][\d:]{5,8}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;

export function coalesceRepeatedBroadcasts<T extends Record<string, unknown>>(
  entries: readonly T[],
): Array<Record<string, unknown>> {
  type Group = { lastIdx: number; count: number; firstTs: string };
  const groups = new Map<string, Group>();
  const keyOf = (e: Record<string, unknown>): string | null => {
    const category = e["category"];
    const summary = e["summary"];
    const to = e["to"];
    if (typeof category !== "string" || !category) return null;
    if (typeof summary !== "string" || !summary) return null;
    if (!Array.isArray(to) || !to.includes("*")) return null;
    const summaryKey = summary.replace(VOLATILE_TIMESTAMP_RE, "<ts>");
    return `${String(e["from"] ?? "")}\x00${String(e["kind"] ?? "")}\x00${category}\x00${summaryKey}`;
  };
  entries.forEach((e, i) => {
    const key = keyOf(e);
    if (key === null) return;
    const ts = typeof e["ts"] === "string" ? (e["ts"] as string) : "";
    const g = groups.get(key);
    if (!g) groups.set(key, { lastIdx: i, count: 1, firstTs: ts });
    else {
      g.count += 1;
      g.lastIdx = i; // entries are ascending — the latest index is the newest
      if (ts && (!g.firstTs || ts < g.firstTs)) g.firstTs = ts;
    }
  });
  if (![...groups.values()].some((g) => g.count > 1))
    return entries as unknown as Array<Record<string, unknown>>;
  const out: Array<Record<string, unknown>> = [];
  entries.forEach((e, i) => {
    const key = keyOf(e);
    if (key === null) {
      out.push(e);
      return;
    }
    const g = groups.get(key)!;
    if (i !== g.lastIdx) return; // an older duplicate — folded into the newest
    out.push(
      g.count > 1 ? { ...e, repeat_count: g.count, first_seen_ts: g.firstTs } : e,
    );
  });
  return out;
}

const ACTION_EXPECTS = new Set(["action", "answer"]);
const SECONDARY_LIFECYCLES = new Set(["claim", "dependency", "handoff"]);
const SECONDARY_CATEGORIES = new Set(["claim", "dependency", "work-item-claim"]);

function hasFleetAudience(e: Record<string, unknown>): boolean {
  const audience = e["audience"];
  const to = e["to"];
  const hasFleet = (v: unknown) => typeof v === "string" && v.startsWith("@fleet:");
  if (hasFleet(audience)) return true;
  if (Array.isArray(audience) && audience.some(hasFleet)) return true;
  return Array.isArray(to) && to.some(hasFleet);
}

/** P-009 priority bucket for a default inbox read. Lower is more urgent.
 *
 * Bucket 0: directed actionable asks (`expects:'action'|'answer'`, including
 * the legacy `expectsReply:true` stamp).
 * Bucket 1: claim/dependency/handoff/same-fleet traffic — useful coordination
 * state, but below explicit asks.
 * Bucket 2: everything else.
 *
 * Pure/read-time only: coord_event_log history remains append-only and feed /
 * catch-up readers can still use their own ordering. */
export function inboxPriorityBucket(e: Record<string, unknown>): number {
  const expects = e["expects"];
  if ((typeof expects === "string" && ACTION_EXPECTS.has(expects)) || e["expectsReply"] === true) {
    return 0;
  }
  const lifecycle = e["lifecycle"];
  const category = e["category"];
  if (
    (typeof lifecycle === "string" && SECONDARY_LIFECYCLES.has(lifecycle)) ||
    (typeof category === "string" && SECONDARY_CATEGORIES.has(category)) ||
    hasFleetAudience(e)
  ) {
    return 1;
  }
  return 2;
}

/** Select + order the visible inbox window by P-009 priority before applying
 * the caller's display limit. Rows within a bucket are newest-first so a flood
 * of low-priority broadcasts cannot crowd an older actionable ask out of a
 * bounded default read. */
export function prioritizedInboxWindow<T extends Record<string, unknown>>(
  entries: readonly T[],
  limit: number,
): T[] {
  if (limit <= 0) return [];
  return [...entries]
    .sort((a, b) => {
      const bucket = inboxPriorityBucket(a) - inboxPriorityBucket(b);
      if (bucket !== 0) return bucket;
      const ats = String(a["ts"] ?? "");
      const bts = String(b["ts"] ?? "");
      if (ats !== bts) return bts.localeCompare(ats);
      return String(b["msg_id"] ?? "").localeCompare(String(a["msg_id"] ?? ""));
    })
    .slice(0, limit);
}
