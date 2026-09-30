/**
 * machine-surface-catalogue.ts — THE curated list of un-enrollable machine
 * surfaces recorded as `user` turns, and the ONE predicate over it.
 *
 * ── Why this file exists (owner-visibility-provenance-2026-08-11 P-003) ──────
 *
 * Some machine text lands in a session's `user` rows with NO turn-origin
 * envelope and no injector that could ever mint one: the CLI itself authored it
 * (its compaction preamble, its interrupt marker, its slash-command wrappers),
 * so there is no papercusp seam to enrol. `turn-ref.ts` already recorded that
 * population as *"unenrollable — no injector"* and already carried a curated
 * catalogue for it.
 *
 * The catalogue was module-private, so the OWNER'S CHAT PANE — which faces the
 * same population — could not reach it. That filter's un-enveloped branch
 * therefore fell through to SHOW, and rendered the CLI's own plumbing as things
 * the owner had apparently said (EI-20135573616431912). The measured leak was
 * 1,051 of 1,809 shown user-turns over 7 days; 487 of those matched a pattern
 * that was sitting RIGHT HERE, uncallable. **The defect was a missing CALL, not
 * a missing pattern.**
 *
 * ⛔ So the fix is NOT a second copy of these shapes next to the pane. Four
 * private pattern lists already exist in this repo and they disagree with each
 * other; a fifth is how this bug class reproduces (plan D-004, and the
 * leak-hunt pattern in `human-turn-tail.ts`). Anything that needs to recognise
 * an un-enrolled machine surface imports FROM HERE.
 *
 * ── Zero imports, on purpose ─────────────────────────────────────────────────
 *
 * The consumers do not share a dependency floor: `turn-ref.ts` is a Node module
 * (it reads transcripts off disk via `node:fs/promises`), while
 * `agent-tools/coordination/owner-chat-turn.ts` is a deliberate import-free leaf
 * because the BROWSER-side chat pane imports it across the
 * `@papercusp/operator-core/lib/...` seam. A shared list can only live in a
 * module that is safe for both, which means this one holds pure data and pure
 * functions and imports nothing. Keep it that way — adding a Node import here
 * silently breaks the client bundle, which is the seam that forced the
 * duplication in the first place.
 *
 * ── These are HEURISTICS; the bound is what makes them safe ──────────────────
 *
 * Adopted from `memory/human-turn-tail.ts`, which learned it expensively:
 * *the filters are heuristics, the cap is arithmetic.* Most patterns here are
 * HEAD-ANCHORED and tested against a bounded head, so an owner QUOTING one of
 * these shapes mid-sentence keeps their turn. Three deliberate exceptions are
 * unanchored: the bracketed SYSTEM NOTIFICATION shape is self-identifying; the
 * self-compaction marker follows the `/compact ` wrapper; and the compaction UI
 * status line is captured after a leading quote/newline. The census-backed
 * exception set is machine-checked in `machine-surface-catalogue.test.ts`.
 * That asymmetry is deliberate and is the only direction that is safe: showing
 * one machine row too many is recoverable, hiding something the human actually
 * wrote is not.
 *
 * Add only heads a human demonstrably never types, and ENUMERATE the population
 * first (a `GROUP BY` on the head) rather than testing a guess — an earlier
 * draft of the sibling module asserted a residue was "near zero" after grepping
 * for the two shapes it already knew about, so it could only ever confirm
 * itself. There is deliberately no `^# ` rule (a human pastes markdown) and no
 * length rule (a human pastes documents).
 *
 * PURE → unit-tested.
 */

/**
 * CLI/subsystem machine surfaces recorded as user turns with NO enrollable
 * envelope (no injector wrote one, so no ledger row could ever vouch for them)
 * that the owner nonetheless never types. Empirically drawn from real psu
 * transcripts (deterministic-context-carry P-018 hardening pass): each is a
 * fixed, self-identifying marker, and biasing a marker-bearing turn toward
 * NOT-owner is the SAFE direction — a false OWNER stamp is the exact failure
 * the turn-provenance protocol exists to kill (D-002 / EI-9904 / the WI-3532
 * manufactured-directive class).
 *
 * Deliberately BROADER than the live classifier's `detectMachineSurface`
 * (turn-provenance.ts), which mirrors the bash UserPromptSubmit hook
 * byte-for-byte and (as of EI-18112745557098348) covers the SYSTEM-NOTIFICATION
 * banner AND the bare `<task-notification>` tag. The post-hoc transcript pass
 * feeds the carry-doc continuation (P-010), where those two plus a
 * `[Request interrupted by user]` marker or a self-issued `/compact` misread as
 * an "open owner message" would hand a successor a machine string as its actual
 * first prompt. Keep the SYSTEM-NOTIFICATION + task-notification +
 * compaction-continuation shapes in lockstep with turn-provenance.ts; the rest
 * are transcript-only by design.
 *
 * Tested against the turn HEAD (bounds an incidental mid-body quote from
 * tripping a marker); each pattern carries its own anchor.
 */
export const MACHINE_SURFACE_PATTERNS: readonly RegExp[] = [
  // Claude's background-task completion banner (self-labels "NOT USER INPUT").
  /\[\s*SYSTEM NOTIFICATION\b[^\]]*\bNOT USER INPUT\b[^\]]*\]/i,
  // Claude's app-level usage-limit reset continuation (no Papercusp injector
  // envelope or ledger row accompanies this standalone client message).
  /^\s*Your claude\.ai usage limit has reset\.\s+Continue the task you were working on when the limit was reached; do not repeat work that is already complete\.\s*$/i,
  // Native auto-compaction continuation summary (unenrollable — no injector).
  //
  // MATCHES THE FULL MACHINE SENTENCE, NOT ITS PREFIX (WI-38157). This pattern
  // used to stop at "…from a previous conversation", which is a prefix an owner
  // legitimately shares: "This session is being continued from a previous
  // conversation -- what does that mean?" matched, and the predicate returned
  // an empty string, so the owner's question was SUPPRESSED OUTRIGHT rather
  // than mislabelled. That is the unrecoverable direction — a machine turn
  // shown as owner speech stays visible and correctable, but an owner's words
  // hidden are simply gone, with nothing left to notice they were lost.
  //
  // Extending to the full sentence is LOSSLESS and strictly NARROWING, measured
  // over the whole corpus (session_turns, workspace_id='default', speaker=user):
  // loose prefix 3,434 rows == full sentence 3,434 rows, 0 rows stop being
  // hidden; the shortest genuine machine turn is 1,066 chars because the banner
  // is always followed by the compaction summary itself.
  //
  // That length fact is also why the obvious fix is the WRONG one: requiring the
  // turn to be "substantially only the banner" fails open on every real machine
  // row, since the banner is a tiny fraction of a large turn. Narrowing the
  // pattern cannot widen what is hidden, so it cannot re-open D-002/D-003.
  /^\s*This session is being continued from a previous conversation that ran out of context\./,
  // Task/subagent completion notification (Task-tool subsystem), e.g.
  //   <task-notification> <task-id>…</task-id> <summary>…</summary>
  /^\s*<task-notification\b/,
  // The TUI's own interrupt marker (also "…for tool use") — a system string,
  // signalling owner action but never itself an owner directive.
  /^\s*\[Request interrupted by user/i,
  // A machine-issued self-compaction command self-declares its provenance
  // (COMPACT_PROVENANCE_MARKER, request-compaction.ts) — it rides just after
  // the `/compact ` slash prefix, so this pattern is not head-anchored.
  /⟦\s*machine-issued self-compaction/i,
  // The compaction UI status line captured verbatim as a turn.
  /✻\s*Conversation compacted|●\s*Compaction is queued/i,
  // The codex CLI's own rendering of CODEX_HOME/AGENTS.md as the session's
  // FIRST user turn (35 rows/14d, still minting — measured 2026-08-11 on
  // turn_idx=0). Papercusp WRITES that AGENTS.md (bootstrap-role mints a
  // per-session CODEX_HOME) but does NOT author this turn: the CLI composes
  // the wrapper, so there is no seam to prefix an envelope onto — see the
  // "why this is a pattern and not an enrolment" note below.
  /^\s*# AGENTS\.md instructions\s*\n+<INSTRUCTIONS>/,
  // The codex CLI's plugin preamble, same population and same authorship
  // (12 rows/14d at turn_idx=0).
  /^\s*<recommended_plugins>/,
  // ── Migrated from `memory/human-turn-tail.ts` (P-005) ─────────────────────
  // These three were caught by the MEMORY altitude's private list and by
  // nothing else, so the owner's CHAT PANE rendered them as things the owner
  // had said: 60 rows over the 20,000 most recent user turns, measured
  // 2026-08-11 (35 skill-loader, 25 auto-heal). Each is machine-authored
  // end-to-end and carries no owner text, which is what makes migrating them
  // safe in BOTH directions rather than merely useful in one.
  //
  // Deliberately added HERE as head-anchored regexes and NOT to
  // SYNTHETIC_MARKERS: that list is substring-matched across the head, so
  // moving an anchored shape into it would WIDEN it into matching an owner who
  // quotes the marker mid-sentence — the unrecoverable direction (D-002/D-003).
  //
  // Our own Stop-hook chain talking back into the turn.
  /^\s*Stop hook feedback:/,
  // The MCP transport auto-heal advisory (mcp-dark-watchdog).
  /^\s*⚠\s*MCP transport auto-heal/,
  // Claude Code's skill-loader preamble, e.g. "Base directory for this skill: …"
  /^\s*Base directory for this skill:/,
];

/*
 * WHY THE TWO ENTRIES ABOVE ARE PATTERNS AND NOT INJECTOR ENROLMENTS
 * (plan owner-visibility-provenance-2026-08-11, V-002 / D-015).
 *
 * D-015 ruled "enrol the su launch prompt". Enrolment turned out to be
 * structurally impossible on this path, for two independent reasons — recorded
 * here so the next agent does not re-attempt it:
 *
 *   1. NO HEAD TO ANCHOR. The recorded turn begins `# AGENTS.md instructions`,
 *      emitted by the CLI. An envelope folded into the AGENTS.md content lands
 *      INSIDE the `<INSTRUCTIONS>` wrapper, and `parseEnvelope` deliberately
 *      refuses a mid-text envelope ("quoted/relayed content must not classify
 *      the turn"). Prefixing would therefore not classify anything.
 *   2. NO HASH TO MATCH. The `cli-schedule-wakeup` precedent (a hash-only
 *      ledger row, matched by classify()'s no-envelope branch) needs the exact
 *      payload sha of the WHOLE turn. Papercusp never sees the wrapped form,
 *      and ingest truncates the row at 8000 chars, so the hash cannot be
 *      computed on either side.
 *
 * That is what makes these the SAME class as the native compaction preamble
 * already listed above: CLI-authored, structurally separable, un-enrollable.
 * It is NOT a licence to close the role-prompt shapes the same way — nothing
 * separates `# Mug — pot placement decider` from an owner's `# my notes`
 * (D-002/D-003), and that residue is P-004's.
 */

/**
 * Slash-command and local-command wrappers the CLI records as `user` turns.
 * Substring-matched rather than anchored: the CLI emits them as tag blocks that
 * can follow a leading newline or a command echo, and the tags are distinctive
 * enough that a substring hit inside a bounded head is not ambiguous.
 */
export const SYNTHETIC_MARKERS: readonly string[] = [
  '<local-command-caveat>',
  '<local-command-stdout>',
  '<command-name>',
  '<command-message>',
];

/**
 * How much of a turn the machine-surface + synthetic scans inspect.
 *
 * This is the arithmetic half of the discipline above. Wide enough to clear a
 * `/compact ` slash prefix before the machine-issued marker, bounded so a long
 * owner message cannot trip a marker on a mid-body quote.
 */
export const CLASSIFY_HEAD_CHARS = 240;

/**
 * Revision of THIS catalogue, stamped alongside every persisted verdict
 * (`session_turns.turn_origin_classifier_version`; plan
 * owner-visibility-provenance-2026-08-11 D-013).
 *
 * BUMP THIS whenever the patterns, markers, or head bound above change in a way
 * that could change a verdict — adding a pattern always can.
 *
 * WHY A PERSISTED VERDICT NEEDS A VERSION AT ALL. `classifyRecordedTurn`
 * returns `owner-typed` as the RESIDUAL — "none of the rules above matched" —
 * not as a positive identification of the owner. So a verdict stored at ingest
 * was computed against this catalogue AS IT WAS THAT MINUTE, and every pattern
 * added later leaves already-ingested rows stamped `owner-typed` forever. That
 * is not a cosmetic staleness: it is precisely the defect this plan exists to
 * kill (machine turns rendered as the owner's own words, EI-20135573616431912),
 * re-created one layer down with database authority behind it.
 *
 * Bumping the number does not fix those rows by itself — it makes them
 * FINDABLE (`WHERE turn_origin_classifier_version < CURRENT`) so a backfill
 * sweep can re-derive them. Leaving it unbumped is what makes them invisible.
 */
// 3 → 4 (WI-38157): the compaction-banner pattern was NARROWED from a prefix to
// the full machine sentence. Unusually, this bump matters in the RECOVERY
// direction rather than the usual one. The note above is written for a pattern
// being ADDED, where stale rows sit wrongly stamped `owner-typed`; here stale
// rows sit wrongly stamped as a machine surface, which means owner turns that
// are currently HIDDEN from the owner's own chat pane and memory tail. Leaving
// this unbumped would fix the classification forward while leaving every
// already-suppressed owner turn suppressed forever — the exact half-fix this
// plan exists to prevent. The bump makes them findable
// (`WHERE turn_origin_classifier_version < CURRENT`) so the scheduled
// turn-provenance-backfill sweep re-derives them and the owner's words come back.
// 4 → 5 (WI-38265): file-backed CLI rows whose text only reaches the
// owner-typed residual are now persisted as explicit `unenrolled-origin`
// uncertainty at ingest. Bump the shared stamp version so existing rows are
// re-derived through the same ingest path rather than retaining the old false
// owner assertion forever.
// 5 → 6 (EI-24061185425252841): Claude's fixed usage-limit reset continuation
// was otherwise captured as an owner directive when it arrived without the
// original machine envelope. Make existing rows findable for reclassification.
export const MACHINE_SURFACE_CATALOGUE_VERSION = 6;

/** Does this turn's head carry a CLI/subsystem synthetic-command wrapper? */
export function hasSyntheticMarker(text: string): boolean {
  if (!text) return false;
  const head = text.slice(0, CLASSIFY_HEAD_CHARS);
  return SYNTHETIC_MARKERS.some((m) => head.includes(m));
}

/**
 * Does this turn's head match a curated un-enrollable machine surface?
 *
 * Head-bounded by construction — callers pass the whole turn and the bound is
 * applied HERE, so no caller can accidentally widen it and start matching an
 * owner's mid-body quote.
 */
export function hasMachineSurfaceMarker(text: string): boolean {
  if (!text) return false;
  const head = text.slice(0, CLASSIFY_HEAD_CHARS);
  return MACHINE_SURFACE_PATTERNS.some((re) => re.test(head));
}

/**
 * Is this turn text a known un-enrollable machine surface — either a synthetic
 * command wrapper or a curated machine marker?
 *
 * The single question every consumer actually asks. Prefer this over reaching
 * for the raw arrays: a caller that re-implements the head-bounding or the
 * or-ing is a caller that can get one of them subtly wrong, which is precisely
 * how the four divergent private copies arose.
 */
export function isUnenrolledMachineSurface(text: string): boolean {
  return hasSyntheticMarker(text) || hasMachineSurfaceMarker(text);
}
