/**
 * Tell the OWNER of a fact that the per-scope cap destroyed it (EI-19442566203468589).
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────
 * `assertFact` evicts the lowest-ranked incumbent when a scope is at its cap.
 * WI-7298 made that loud — **to the writer**, in the assert receipt. That is the
 * wrong audience, and it is the whole bug: the writer already knows they wrote.
 * The person who needs to know is the fact's AUTHOR, and they are told nothing.
 *
 * Their fact is documented as folded verbatim into every future orient UNTIL
 * RETRACTED. After an eviction it simply stops appearing. Nothing errors.
 * Nothing in their orient says why. The failure mode of a MISSING fact is
 * silence — it does not break anything, it just quietly stops informing
 * decisions, which is indistinguishable from the fact never having mattered.
 *
 * Measured 2026-08-03: `scope:harness/papercusp` was THRASHING at its cap, not
 * occasionally full — two agents evicted each other's facts within 12 minutes,
 * one of them a `confidence:'verified'` fact with ~29 days of TTL left. Both
 * evictions were discovered only because the evicting agents happened to notice
 * the receipt and messaged the owner BY HAND. This module is that hand-message,
 * made unconditional.
 *
 * ── WHY IT LIVES AT THE STORE, NOT THE TOOL ────────────────────────────────
 * `facts:assert` is only ONE of six `assertFact` callers. The others are
 * automated writers — the release-readiness routine, the gate canary sweep,
 * deprecate-learnings, bootstrap-su — and they evict exactly like anyone else.
 * Notifying from the tool layer would leave every ROUTINE-caused eviction
 * silent, which is the same defect with a smaller blast radius.
 *
 * ── DELIBERATELY NOT CATEGORISED ───────────────────────────────────────────
 * This message intentionally carries NO `category`. A categorised message is
 * treated as an ambient system broadcast and is DEFAULT-EXCLUDED from
 * `coord:inbox` — so tagging this (the obvious tidy-up) would deliver the
 * notice into a channel the owner does not read by default, silently
 * re-creating the exact invisibility this exists to remove. If you are tempted
 * to add one, that is the trap.
 */
import type { FactConfidence, FactEviction } from './store';

/**
 * EI-19449079650310753: which ranking key ACTUALLY decided this eviction.
 *
 * The cap ranks by confidence, THEN by remaining declared-TTL fraction, then
 * write-recency.
 * Reciting that ordering as the explanation is misleading in the ONLY case that
 * occurs in practice: measured 2026-08-03, EVERY scope at or near the cap held
 * exactly ONE distinct confidence tier (harness/papercusp 50/50 verified,
 * workspace 50/50 verified, harness/oddsmith 41/41 verified), so the confidence
 * key is INERT precisely where the ranking runs and the TTL decides alone.
 *
 * Telling an author "ranked by confidence first, 'verified' survives longest"
 * when their fact was ALREADY verified points them at a lever that cannot help:
 * the real lever was the TTL they declared. Measured on the same scope, evicted
 * verified facts averaged 8.9 days of TTL against 61.5 for the survivors.
 *
 * `null`/absent ⇒ undetermined, and the notice then says so rather than guessing.
 */
export interface EvictionRankingContext {
  /**
   * False ⇒ every live fact in the scope (survivors AND victims) shares one
   * confidence tier, so confidence provably separated nothing and the victim
   * lost on TTL. True ⇒ tiers genuinely differed, so confidence did rank.
   */
  confidenceDiscriminated: boolean;
  /** The single tier every fact shares, when `confidenceDiscriminated` is false. */
  prevailingConfidence: FactConfidence | null;
}

/** Best-effort: a failed notification must never fail the write that caused it. */
export interface NotifyEvictedArgs {
  evicted: readonly FactEviction[];
  /** The agent whose assert displaced these facts. */
  writerOwnerId: string;
  scope: string;
  scopeRef?: string | null;
  /** Optional: omitted ⇒ the notice reports the deciding key as undetermined. */
  ranking?: EvictionRankingContext | null;
}

/** Owners to notify, grouped — one message each, never one per evicted key. */
export function groupVictimsByOwner(
  evicted: readonly FactEviction[],
  writerOwnerId: string,
): Map<string, FactEviction[]> {
  const byOwner = new Map<string, FactEviction[]>();
  for (const e of evicted) {
    const owner = (e.createdBy ?? '').trim();
    if (!owner) continue;
    // Self-eviction needs no message: the writer already has the receipt, and
    // WI-7292 separately made a write stop evicting the row it just inserted.
    // Messaging yourself is pure noise in an inbox that is read under pressure.
    if (owner === writerOwnerId) continue;
    const list = byOwner.get(owner);
    if (list) list.push(e);
    else byOwner.set(owner, [e]);
  }
  return byOwner;
}

/** The body an owner receives. Exported so a test pins the wording's substance. */
export function renderEvictionNotice(
  victims: readonly FactEviction[],
  args: {
    writerOwnerId: string;
    scope: string;
    scopeRef?: string | null;
    ranking?: EvictionRankingContext | null;
  },
): { summary: string; body: string } {
  const scopeLabel = args.scopeRef ? `${args.scope}/${args.scopeRef}` : args.scope;
  const n = victims.length;
  const keys = victims.map((v) => v.key);
  const summary =
    `Your standing fact${n === 1 ? '' : 's'} ${keys.map((k) => `\`${k}\``).join(', ')} ` +
    `${n === 1 ? 'was' : 'were'} EVICTED by the ${scopeLabel} fact cap — not expired, not retracted by you.`;

  const lines = victims.map((v) => {
    const conf = v.confidence ? `confidence:${v.confidence}` : 'confidence:unset';
    return `  • \`${v.key}\` (${conf}, TTL ran to ${v.expiresAt})`;
  });

  const body =
    `The per-scope fact cap on \`${scopeLabel}\` destroyed ${n === 1 ? 'a fact' : 'facts'} you asserted:\n` +
    `${lines.join('\n')}\n\n` +
    `This was NOT an expiry and NOT a retraction by you. My assert into the same scope ` +
    `displaced ${n === 1 ? 'it' : 'them'} because the scope was at its cap.\n\n` +
    `WHY YOU ARE BEING TOLD: a fact is documented as folded into every future orient until ` +
    `retracted, so without this message ${n === 1 ? 'it' : 'they'} would simply stop appearing ` +
    `in your folds with nothing anywhere saying why. A missing fact does not error — it just ` +
    `quietly stops informing your decisions.\n\n` +
    `WHAT TO DO: if ${n === 1 ? 'it' : 'any of them'} still matters, re-assert it. Note that ` +
    `re-asserting will itself evict the next-lowest-ranked fact while the scope stays full, ` +
    `so prefer re-asserting only what is still load-bearing.\n\n` +
    `HOW VICTIMS ARE CHOSEN (so this is predictable rather than mysterious): the cap keeps the ` +
    `most valuable and drops the tail, ranked by confidence first ('verified' survives longest, ` +
    `'suspected' dies first), then by the remaining fraction of your declared TTL, then ` +
    `write-recency. A long absolute TTL does not automatically survive: a fact near the end ` +
    `of its own life can rank below a shorter-lived fact that was asserted recently.\n\n` +
    decidingKeyParagraph(args.ranking);

  return { summary, body };
}

/**
 * EI-19449079650310753: name the key that ACTUALLY decided, so the reader is not
 * sent after a lever that cannot move.
 *
 * Reciting the full ranking (above) is accurate but, on its own, actively
 * misleading: in every scope measured at cap, confidence held ONE tier, so the
 * "ranked by confidence first" sentence describes a comparison that never
 * happened. An author whose fact was already `verified` reads it and concludes
 * either that their fact was somehow low-confidence or that raising confidence
 * would have saved it. Neither is true, and the lever that WOULD have — a longer
 * declared TTL — is the one the sentence relegates to second place.
 */
function decidingKeyParagraph(ranking?: EvictionRankingContext | null): string {
  if (!ranking) {
    return (
      `WHICH KEY DECIDED YOURS: not determined for this eviction. Do not assume it was ` +
      `confidence — see below for why that is usually the wrong lever.`
    );
  }
  if (ranking.confidenceDiscriminated) {
    return (
      `WHICH KEY DECIDED YOURS: confidence. This scope holds a genuine MIX of confidence ` +
      `tiers, so the ranking's first key did separate facts here and your fact was ranked ` +
      `below a higher-confidence one. Raising confidence — honestly — is a real lever in ` +
      `this scope.`
    );
  }
  // `prevailingConfidence` is null when the tiers RANK equally but are not the
  // same literal value — unset and 'provisional' both rank 1, so naming one of
  // them as "the tier everything shares" would be a false statement about the
  // data. Say what is actually true in that case instead.
  const sameness = ranking.prevailingConfidence
    ? `carries the SAME confidence tier (\`${ranking.prevailingConfidence}\`)`
    : `ranks EQUALLY on confidence (an unset confidence and 'provisional' rank the same)`;
  return (
    `WHICH KEY DECIDED YOURS: the TTL, NOT confidence — and this is the case that ` +
    `matters, so do not act on the ranking sentence above alone. Every live fact in this ` +
    `scope ${sameness}, so the confidence key separated ` +
    `nothing at all: it is inert precisely where the cap runs. Your fact was dropped ` +
    `because its declared TTL was the shortest of the tail, and for no other reason.\n` +
    `So re-asserting at a HIGHER CONFIDENCE cannot help — it is already the same tier as ` +
    `everything else here. An absolute LONGER TTL is not a guaranteed lever under this ` +
    `fraction-based ranking; retract something in this scope you no longer need. Note the ` +
    `perverse consequence, stated ` +
    `plainly rather than left for you to discover: a SHORT TTL is how an author says ` +
    `"urgent, and this stops being true soon", and it is exactly what this cap destroys ` +
    `first.`
  );
}

/** `scope[/scopeRef]`, for log lines — the same label `renderEvictionNotice` shows the owner. */
function scopeLabel(scope: string, scopeRef?: string | null): string {
  return scopeRef ? `${scope}/${scopeRef}` : scope;
}

/** Keep a bounded, single-line stack for the best-effort failure log. */
function errorDetails(error: unknown): string {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  return detail.replace(/\s*\r?\n\s*/g, ' | ').slice(0, 2_000);
}

/**
 * Notify each evicted fact's author. NEVER throws and never rejects — an
 * eviction notice failing must not turn a successful `facts:assert` into an
 * error. Returns the owners actually messaged (for tests/telemetry).
 *
 * ── WI-2142302: THREE PATHS USED TO FAIL SILENTLY ──────────────────────────
 * Before this fix, a totally dead notifier (coord plane down, `sendMessage`
 * always throwing) was byte-for-byte indistinguishable from a healthy one:
 * both returned `[]` or a partial list with NOTHING logged, so "does this
 * still work" could only be answered by querying `coord_event_log` for the
 * notices it should have produced — a presence check that a silently-broken
 * notifier trivially passes (zero rows either way). Every catch below now
 * logs before it swallows, so a dead notifier is loud in the operator logs
 * even though it still (correctly) never fails the write that triggered it.
 * The RETURN CONTRACT is unchanged — still `string[]`, still never throws —
 * so this is pure additive observability, not a behavior change callers or
 * existing tests need to react to.
 */
export async function notifyEvictedFactOwners(args: NotifyEvictedArgs): Promise<string[]> {
  const label = scopeLabel(args.scope, args.scopeRef);
  try {
    const byOwner = groupVictimsByOwner(args.evicted, args.writerOwnerId);
    if (byOwner.size === 0) {
      // Two DIFFERENT reasons collapse to the same empty map, and they are not
      // equally benign. "Every victim was the writer's own fact" is expected
      // and needs no notice (the writer already has the assert receipt).
      // "A victim's `createdBy` is blank" means a fact was just destroyed and
      // there is NO ONE this module can tell — a genuine, silent gap, not a
      // no-op. Distinguish them so the second case is at least loud in logs.
      const unresolvable = args.evicted.filter(
        (e) => !(e.createdBy ?? '').trim() && e.createdBy !== args.writerOwnerId,
      );
      if (unresolvable.length > 0) {
        console.warn(
          `[notify-evicted] ${unresolvable.length} evicted fact(s) in ${label} have no resolvable ` +
            `owner (blank createdBy) and cannot be notified: ${unresolvable.map((e) => e.key).join(', ')}`,
        );
      }
      return [];
    }

    // Lazy import: the store is a low-level module and the coord message seam
    // pulls in a large graph. Importing it statically here would couple every
    // fact write to the coordination plane's module graph.
    const { sendMessage } = await import('../agent-tools/coordination/messages');

    const notified: string[] = [];
    const failedOwners: string[] = [];
    for (const [owner, victims] of byOwner) {
      const { summary, body } = renderEvictionNotice(victims, args);
      try {
        await sendMessage(
          {
            ownerId: args.writerOwnerId,
            ownerLabel: args.writerOwnerId,
            source: 'static-client',
            workspaceId: null,
            userId: null,
          } as Parameters<typeof sendMessage>[0],
          {
            to: [owner],
            summary,
            body,
            // NO `category` — see the module header. A categorised message is
            // default-excluded from coord:inbox as ambient.
            extra: { auto: true, factEviction: { keys: victims.map((v) => v.key), scope: args.scope } },
          },
        );
        notified.push(owner);
      } catch (err) {
        // One owner's delivery failing must not block the others — but it
        // must not be invisible either. Loud here is the whole fix.
        failedOwners.push(owner);
        console.warn(
          `[notify-evicted] failed to notify ${owner} of ${victims.length} eviction(s) in ${label}: ` +
            errorDetails(err),
        );
      }
    }
    // One summary line naming the WRITER, so an agent whose own write caused
    // evictions has a queryable trail even though they are (deliberately) not
    // messaged directly — the discoverability gap named in WI-2142302: an
    // evicting agent otherwise sees no evidence it destroyed anything short of
    // parsing the raw assert receipt, and one prior incident manually
    // broadcast a redundant warning because of exactly that.
    console.log(
      `[notify-evicted] writer=${args.writerOwnerId} evicted ${args.evicted.length} fact(s) in ${label}; ` +
        `notified=[${notified.join(', ')}]${failedOwners.length ? `; FAILED=[${failedOwners.join(', ')}]` : ''}`,
    );
    return notified;
  } catch (err) {
    // Defensive length read: the very thing that made the try block throw can
    // be `args.evicted` itself (e.g. non-iterable), and a handler that throws
    // WHILE reporting a failure would break the never-throws contract this
    // function exists to uphold.
    const evictedCount = Array.isArray(args.evicted) ? args.evicted.length : '?';
    console.error(
      `[notify-evicted] eviction-notice pipeline threw for ${evictedCount} evicted fact(s) in ` +
        `${label} — NO owner was notified: ${errorDetails(err)}`,
    );
    return [];
  }
}
