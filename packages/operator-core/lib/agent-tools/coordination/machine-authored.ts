/**
 * machine-authored.ts — is a coord message MACHINE-authored? (WI-4537)
 *
 * WHY THIS EXISTS: `unanswered` / `unanswered_directed` (unanswered-directed.ts) is wired to
 * PREEMPT an agent's work — "a directed message awaiting YOUR answer OUTRANKS your own work".
 * A counter with that much authority must fire on messages a PEER is actually waiting on, and
 * on nothing else. Measured live before this fix, it fired on robot chatter: of 2791 unanswered
 * directed messages fleet-wide, ~490 came from synthetic senders that cannot read a reply —
 * `claim-discipline-watch` (390), `plan-clobber-watch` (47), `system:delivery-ladder` (29),
 * `system:claim-integrity-monitor` (10), … — none of which any agent will ever "answer".
 *
 * THE FLAG WAS ALREADY THERE AND UNDER-STAMPED. `extra: { auto: true }` marks a machine
 * lifecycle message, and some emitters set it (314 of the rows did) — but MOST machine senders
 * simply never bothered, so filtering on the flag alone would have missed the majority of the
 * noise (~490 unflagged vs ~314 flagged). Chasing every emitter and adding the flag by hand is
 * exactly the fix that rots: the next watchdog anyone adds forgets it again.
 *
 * SO THE ROOT FIX IS AT THE ONE CHOKEPOINT: `sendMessage` auto-stamps `auto: true` whenever the
 * SENDER is a machine identity (see messages.ts). Every current AND future system emitter is
 * flagged for free, and the flag becomes trustworthy. This module is the single source of truth
 * for "is this sender a machine", shared by:
 *   - sendMessage       (JS — stamps the flag at write time), and
 *   - unanswered-directed's SQL (the SAME pattern — a BACKSTOP that also excludes the millions
 *     of HISTORICAL rows already written without the stamp, which no write-time fix can reach).
 * One pattern, two call sites, so they can never drift.
 *
 * DELIBERATELY NOT MACHINE — the false positives that would matter most:
 *   - `pc-admin-coord-ui` — the HUMAN owner typing in the admin coord UI. Silencing that would
 *     hide the one sender whose message most deserves to preempt an agent.
 *   - `human`, agent sessions (`su-…`, `s-…`, `role-…`, bare uuids) — real correspondents.
 */

/**
 * POSIX-ERE (Postgres `~`) AND JS-compatible. Kept to the intersection of both dialects on
 * purpose: it is embedded verbatim in SQL and compiled verbatim in JS, so a pattern that only
 * one engine understands would silently make the two call sites disagree.
 *
 *   ^system[:-]                     system:delivery-ladder, system-watchdog, system:allhive-…
 *   -(watch|watchdog|sweep|monitor|digest|reaper|ladder)$
 *                                   claim-discipline-watch, plan-clobber-watch,
 *                                   stale-claim-sweep, hold-open-sweep, …-monitor, …-digest
 *   ^work-items$                    the work-item lifecycle event emitter ([event] work-item:done:…)
 */
export const MACHINE_SENDER_PATTERN =
  '^system[:-]|-(watch|watchdog|sweep|monitor|digest|reaper|ladder)$|^work-items$';

const MACHINE_SENDER_RE = new RegExp(MACHINE_SENDER_PATTERN);

/**
 * POSITIVE agent-session shape — `su-…`, `s-…`, `cup-…`, `role-…`, or a bare uuid.
 *
 * ── WHY THIS EXISTS ALONGSIDE THE NEGATIVE PATTERN, AND WHEN TO USE WHICH ────
 *
 * These two are NOT complements, and using the wrong one is a measured bug, not
 * a style choice. {@link MACHINE_SENDER_PATTERN} is CONSERVATIVE ON PURPOSE (see
 * its note): anything unrecognised is treated as a real correspondent, because
 * there its false-positive cost is silently suppressing a peer's real question.
 * That is the correct bias for SUPPRESSION decisions.
 *
 * It is the WRONG bias for a DENOMINATOR. Measured live 2026-08-03 over 24h: of
 * 2,491 senders admitted by `NOT MACHINE_SENDER_PATTERN`, about 1,738 were
 * emitters the negative pattern simply does not name — git-sync-ref-announce
 * (669), git-sync-integrator (639), intent-divergence-detector (157),
 * green-checkpoint (124), coord-probe-canary-a (96), stale-prompt-render-detector
 * (27), task-manager, live1-parity-tower, boot-migrate — every one of them with
 * ZERO sectioned messages, because they never pass through coord:send's schema
 * and CANNOT carry the field being measured. Including them deflated an adoption
 * reading from 77.2% to 23.2%: the same class of error as EI-19300252001829260,
 * reached through a different filter.
 *
 * RULE OF THUMB: suppressing/routing a message → the NEGATIVE pattern (be
 * generous about who counts as a person). Measuring a RATE whose denominator
 * must contain only senders capable of the behaviour → this POSITIVE one.
 */
export const AGENT_SESSION_SENDER_PATTERN =
  '^(su-|s-|cup-|role-|[0-9a-f]{8}-[0-9a-f]{4}-)';

/**
 * Is `from` a synthetic/system identity — i.e. something that emits but can never READ a reply?
 * Conservative by design: anything unrecognised is treated as a real correspondent, because the
 * cost of a false NEGATIVE (one extra robot line in a count) is trivial next to a false POSITIVE
 * (silently suppressing a peer's — or the owner's — real question).
 */
export function isMachineAuthoredSender(from: string | null | undefined): boolean {
  if (!from) return false;
  return MACHINE_SENDER_RE.test(from.trim().toLowerCase());
}

/**
 * STAMP-ONLY machine emitters — the SECOND signal at the `sendMessage` seam, and
 * deliberately NOT part of {@link MACHINE_SENDER_PATTERN}. (WI-6768, closing the
 * P-033 (d) residue found by the 2026-08-02 audit of
 * unified-agent-state-plane-2026-07-27.)
 *
 * ── WHY A SECOND PATTERN RATHER THAN WIDENING THE FIRST ──────────────────────
 *
 * `MACHINE_SENDER_PATTERN` is embedded VERBATIM in five SQL sites
 * (unanswered-directed.ts:236, delivery-ladder-sweep.ts:378, and THREE in
 * scout/coord-health-lane.ts — loadCoordPremiseResolve, loadCoordClarifyAdoption
 * and loadCoordAuthoredAdoption; the last of these ALSO applies
 * {@link AGENT_SESSION_SENDER_PATTERN}, because a denominator needs the positive
 * test and this one alone is too permissive for that job — and, since D-095, a
 * THIRD positive filter on `expects`, because not even a correct sender pattern
 * can exclude system code emitting under a borrowed agent identity; see
 * {@link isSystemEmissionUnderAgentIdentity}).
 * Widening it there does not merely change future behaviour — it
 * retroactively changes which HISTORICAL rows those queries count as unanswered,
 * which messages.ts:288 calls out as "a separate change with its own measurement,
 * not a side effect of this one". That judgement still stands, so this pattern is
 * additive and is consumed by the write-time stamp ONLY. No SQL reads it.
 *
 * ── WHY THESE NAMES, AND WHY THEY ARE SAFE ───────────────────────────────────
 *
 * Measured, not guessed. Over the 36h AFTER the original two-signal stamp went
 * live, 845 of 2,013 coord messages (42%) still carried no `expects`, across just
 * 12 senders — and six of them account for 820 (97%):
 *
 *   git-sync-ref-announce      300     supervision-reconciler      59
 *   git-sync-integrator        294     intent-divergence-detector  55
 *   coord-probe-canary-a        97     green-checkpoint            15
 *
 * Every one is a process emitter that cannot read a reply, and none can collide
 * with the false positives the header above protects: no human sender is named
 * `*-announce` / `*-integrator` / `*-reconciler` / `*-detector`, and the two
 * prefixes are machine-minted ids. `pc-admin-coord-ui`, `human`, `su-…` and bare
 * uuids remain unmatched here exactly as they are above.
 *
 * ⚠ `intent-divergence-detector` is P-010's OWN detector, shipped by the very plan
 * that added the `expects` gate — the most direct evidence available that a
 * per-emitter convention rots, and the reason this is a seam rule rather than six
 * more hand-patched call sites.
 *
 * ⚠ `green-checkpoint` is anchored with `$` while `coord-probe-` / `release-deploy:`
 * are open PREFIXES, and the difference is deliberate: the latter two mint ids with a
 * variable suffix (`coord-probe-canary-a`, `release-deploy:<pid>:<uuid>`) so they must
 * match open, whereas an unanchored `green-checkpoint` also swallowed `green-checkpoints`
 * — caught by this module's own "NEVER stamps a human" test rather than in review.
 */
/**
 * ⚠ `-health$` added 2026-08-02 (EI-19315474516256070), same methodology: MEASURED, not
 * guessed. Over the 24h AFTER the WI-6768 stamp went live, the stamp is working exactly as
 * designed on the senders it matches — `git-sync-ref-announce` 41/41 and `git-sync-integrator`
 * 21/21 of post-deploy messages carry `fieldProvenance.expects = 'system-emitter-derived'`.
 * The residue was a sender matching NEITHER pattern: `service-health` sent 40 messages of
 * which 38 still carried no `expects` at all, plus `hive-owner-key-health`. Both are health
 * probes — process emitters that cannot read a reply — and no human or agent identity is
 * plausibly named `*-health` (the protected senders remain `pc-admin-coord-ui`, `human`,
 * `su-…`/`s-…`/`role-…` and bare uuids, none of which this suffix can reach).
 *
 * NOT added, deliberately: `inference-gateway` (1 message in the same window). One sample is
 * below the evidentiary bar this module holds itself to, and an unanchored guess is how a
 * pattern starts swallowing names nobody measured — the `green-checkpoint`/`green-checkpoints`
 * near-miss recorded above. Re-measure and add it if the volume ever justifies it.
 */
export const MACHINE_EMITTER_STAMP_PATTERN =
  '-(announce|integrator|reconciler|detector|health)$|^green-checkpoint$|^(coord-probe-|release-deploy:)';

const MACHINE_EMITTER_STAMP_RE = new RegExp(MACHINE_EMITTER_STAMP_PATTERN);

/**
 * Should the `sendMessage` seam stamp machine defaults (`auto`, `expects:'none'`)
 * for this sender? True for {@link isMachineAuthoredSender} OR the stamp-only
 * emitters above. Never consulted by SQL — see the rationale on the pattern.
 */
export function isMachineEmitterForStamping(from: string | null | undefined): boolean {
  if (!from) return false;
  const s = from.trim().toLowerCase();
  return MACHINE_SENDER_RE.test(s) || MACHINE_EMITTER_STAMP_RE.test(s);
}

const AGENT_SESSION_SENDER_RE = new RegExp(AGENT_SESSION_SENDER_PATTERN);

/**
 * Is `from` an AGENT SESSION identity — `su-…`, `s-…`, `cup-…`, `role-…`, or a
 * bare uuid? The POSITIVE test, exported so callers share one definition of the
 * shape rather than re-compiling {@link AGENT_SESSION_SENDER_PATTERN} locally.
 *
 * ⚠ READ THE RULE OF THUMB ON {@link AGENT_SESSION_SENDER_PATTERN} BEFORE
 * REACHING FOR THIS. It is NOT the complement of
 * {@link isMachineAuthoredSender}: use the negative test to SUPPRESS or ROUTE (be
 * generous about who counts as a person), and this one when the question is
 * "could this sender exhibit the behaviour at all" — a denominator, or a
 * derivation that only makes sense for a real agent session.
 *
 * ⚠ IT CANNOT, ALONE, TELL YOU A HUMAN OR AGENT AUTHORED THE MESSAGE. System
 * code emitting under a borrowed agent identity matches this too, by
 * construction — see {@link isSystemEmissionUnderAgentIdentity}, which needs the
 * ENVELOPE to separate them.
 */
export function isAgentSessionSender(from: string | null | undefined): boolean {
  if (!from) return false;
  return AGENT_SESSION_SENDER_RE.test(from.trim().toLowerCase());
}

/**
 * ESCALATION-ONLY machine emitters — a name-keyed signal consumed by the attention
 * tiering + reconcile sweeps (`attention/adapters.ts` `isOperationalEscalation`)
 * and by nothing else. WI-2140594 (the corrected fix for WI-2140576).
 *
 * ── WHY A DERIVED PREDICATE REPLACED A HAND LIST ────────────────────────────
 *
 * An option-less escalation was classified OPERATIONAL (system status: alert tier,
 * 48h auto-reconcile) only when its sender was `system[:…]` or a member of a
 * hand-maintained `AUTOMATED_INFRA_EMITTERS` set. Every watchdog added after that
 * set was written landed OUTSIDE it, and each one's escalations then read as a
 * human-shaped ask: tiered as an owner decision and reaped only by the 7d
 * dead-author sweep. Measured 2026-09-01 on the live papercusp-workspace backlog
 * (783 open rows): wall-lapse-watchdog 74, unservable-critical-watchdog 24,
 * goal-owner-report-watchdog 23, intent-divergence-detector 19,
 * goal-liveness-watchdog 7, embed-latency-watchdog 6 — none in the set. A name
 * list restating what the sender's own shape already says is the
 * derived-truth-ladder failure; this is the DERIVE rung for it.
 *
 * ── WHAT THE SHAPE IS, AND WHAT IT CAN NEVER REACH ───────────────────────────
 *
 * A process emitter is named for what it DOES (`…-watchdog`, `…-sweep`, `…-pulse`,
 * `…-lease`, `…-alarm`, `…-gateway`, plus the two patterns above); a correspondent
 * is named for WHO it is (`human`, `pc-admin-coord-ui`, `su-…`, `s-…`, `cup-…`,
 * `role-…`, a bare uuid). The agent-session test is applied FIRST and wins, so an
 * agent whose role name happens to end in `-watchdog` (`role-x-watchdog`) stays a
 * real correspondent — adapters.ts's rule that a bee's escalation can be a genuine
 * ask holds by construction, not by anyone remembering it.
 *
 * ⚠ Widens ONLY escalation classification. Deliberately NOT folded into
 * {@link MACHINE_SENDER_PATTERN} (embedded in five SQL sites with historical-row
 * semantics — see the stamp pattern's rationale) nor into
 * {@link MACHINE_EMITTER_STAMP_PATTERN} (which holds itself to a per-suffix
 * message-volume bar this escalation data does not speak to).
 */
export const MACHINE_ESCALATION_EMITTER_PATTERN = '-(watchdog|sweep|pulse|lease|alarm|gateway)$';

const MACHINE_ESCALATION_EMITTER_RE = new RegExp(MACHINE_ESCALATION_EMITTER_PATTERN);

/**
 * Is `from` a process emitter for ESCALATION purposes — something that OPENS an
 * escalation but can never consume its resolution? The union of every name-keyed
 * machine signal in this module plus the escalation-only shape above, gated so an
 * agent-session identity (and the human / owner-GUI identities) can never match.
 */
export function isMachineEscalationEmitter(from: string | null | undefined): boolean {
  if (!from) return false;
  const s = from.trim().toLowerCase();
  if (!s || AGENT_SESSION_SENDER_RE.test(s)) return false;
  return MACHINE_SENDER_RE.test(s) || MACHINE_EMITTER_STAMP_RE.test(s) || MACHINE_ESCALATION_EMITTER_RE.test(s);
}

/**
 * The FOURTH signal, and the only one keyed on the ENVELOPE rather than the name:
 * system code emitting under a BORROWED AGENT IDENTITY (D-095).
 *
 * Every pattern above asks "is this sender named like a machine". That question
 * cannot reach this population by construction, because `from` IS a real agent's
 * ownerId — the emitter is library code running inside an agent's tool call and
 * passing that agent's identity straight through to `sendMessage`. Measured 36h,
 * 2026-08-03: 36 such messages, none of them prose a human or agent wrote —
 * fleet-scope admission blocks (25, scheduler/fleet-scope-admission.ts:441/483),
 * take-leadership demotion notices (9, fleet_registry/take-leadership-core.ts:145),
 * a fed-event probe, and a typed control cue. All 36 counted as HAND-AUTHORED in
 * the P-001 adoption denominator, and all 36 counted as directed mail a peer was
 * expected to answer.
 *
 * ── THE ENVELOPE ANSWERS WHAT THE NAME CANNOT ────────────────────────────────
 *
 * `coord:send` REQUIRES `expects` — no default, refused at the arg schema
 * (tools/send.ts: `expectsArg`, and the preprocess gate that names it). So for a
 * sender that IS an agent session, a MISSING `expects` is positive evidence the
 * message never came through the agent-callable tool, i.e. code sent it. That is
 * a property of the send PATH, which is exactly what this population differs by
 * and exactly what a name-based pattern is blind to.
 *
 * ⚠ THE AGENT-SESSION TEST IS LOAD-BEARING, NOT DECORATION — it is what keeps the
 * header's protected senders protected. Without it this would read "anything with
 * no `expects`", which would sweep in `pc-admin-coord-ui` and `human` the moment
 * either sent through a path that omits the field, and silently suppressing the
 * owner's own question is the one false positive this module exists to prevent.
 * Restricting to `su-…`/`s-…`/`cup-…`/`role-…`/bare-uuid means only an identity
 * the SYSTEM minted can ever match.
 *
 * ⚠ AND IT CANNOT REACH THE OWNER'S GUI REPLY, which is the near-miss worth
 * recording: `inbox-reply.ts` deliberately calls `sendMessage` directly rather
 * than through the tool (so an agent cannot forge its `coord-inject:owner`
 * provenance) — the one hand-authored route that bypasses the schema on purpose.
 * It is safe here only because it passes `extra.expects` EXPLICITLY (and
 * `extra.sections` with it). Verified before this shipped, not assumed. If a
 * future authored route omits `expects`, this stamp WILL misclassify it — so the
 * rule for adding one is: set `expects`, as both existing authored routes do.
 */
export function isSystemEmissionUnderAgentIdentity(
  from: string | null | undefined,
  hasExpects: boolean,
): boolean {
  if (!from || hasExpects) return false;
  return AGENT_SESSION_SENDER_RE.test(from.trim().toLowerCase());
}
