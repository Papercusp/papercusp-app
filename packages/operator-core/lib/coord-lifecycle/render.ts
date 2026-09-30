/**
 * render.ts — PURE formatters that turn a structured lifecycle record
 * (./records) into a coord notification `{ summary, body }`
 * (coord-lifecycle-automation-2026-06-04 D-004 / D-006 / D-008).
 *
 * These are the heart of "stop narrating, emit structure": an agent fills in
 * the record's fields once (or a typed op carries them), and the transition
 * renders the notification deterministically — the agent spends zero tokens
 * writing prose. The prose STYLE here matches the real corpus so a reader of
 * `coord:inbox` sees the same shape they're used to, only now generated.
 *
 * INVARIANT (D-006, information preservation): every field a record carries
 * MUST appear in the rendered output. The deferred-set especially — the
 * "surface every deferred item" policy depends on it never being dropped.
 *
 * Pure: no I/O, no clock, no identity resolution. Fully unit-testable. The
 * coord:emit wiring (which fires these) lives in ../agent-tools/coordination;
 * the event-rule that calls them lives in ./lifecycle-rules.
 */

import type {
  ClaimRecord,
  CompletionCoverage,
  CompletionRecord,
  FindingRecord,
  HandoffRecord,
  IntentRecord,
  LifecycleCategory,
  WindowRecord,
} from './records';

/** What every renderer produces — the two coord-notification fields. */
export interface RenderedNotification {
  summary: string;
  body?: string;
}

/** Join non-empty lines, dropping blanks at the seams. */
function block(...lines: Array<string | null | undefined>): string {
  return lines.filter((l): l is string => typeof l === 'string' && l.length > 0).join('\n');
}

/** A "• "-prefixed bullet list, or null when empty. */
function bullets(items: readonly string[] | undefined): string | null {
  if (!items || items.length === 0) return null;
  return items.map((i) => `• ${i}`).join('\n');
}

/** Render the population accounting carried by a universal verification claim. */
function renderCoverage(coverage: CompletionCoverage | undefined): string | null {
  if (!coverage) return null;
  return block(
    `Coverage population:\n${bullets(coverage.population)}`,
    coverage.checked?.length ? `Checked:\n${bullets(coverage.checked)}` : null,
    coverage.notChecked?.length ? `Not checked:\n${bullets(coverage.notChecked)}` : null,
    coverage.notApplicable?.length ? `Not applicable:\n${bullets(coverage.notApplicable)}` : null,
    coverage.residue?.length ? `Residue:\n${bullets(coverage.residue)}` : null,
  );
}

/** The coord:inbox headline budget — headers stay scannable. */
const SUMMARY_MAX = 180;

/** Below this much room for the summary text, clipping the summary instead of
 *  the whole headline stops being an improvement (it would leave a stub), so
 *  renderCompletion falls back to the plain whole-string clip. */
const MIN_SUMMARY_ROOM = 24;

/** Truncate a summary so coord:inbox headers stay scannable. */
function clip(s: string, max = SUMMARY_MAX): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * COMPLETION (D-004). The summary mirrors the corpus headline
 * ("<id> BUILT+TESTED (agent): <one-liner>, <tests>, migs …"); the body
 * carries the full structured detail with the deferred-set called out.
 */
export function renderCompletion(rec: CompletionRecord): RenderedNotification {
  const status = (rec.status || 'done').toUpperCase();
  const coverage = rec.coverage ?? rec.verification?.coverage;
  // P-008 (borrow item 13) — the ANTI-TRUST signal, computed once. A completion
  // that records NEITHER `tests` NOR `verifiedHow` asserts only that its author
  // yielded; nothing about it was checked. The author is already nudged about
  // this at complete.ts (the "neither tests nor deferred" warning) — but that
  // nudge reaches the AUTHOR, and the party who needs it is the PARENT reading
  // the result, who is the one still positioned to act cheaply. Rendered here
  // rather than written into a tool description on purpose: it costs zero
  // prompt weight, and it can be CONDITIONAL — said only when it is true, so it
  // never becomes boilerplate the reader learns to skip.
  const unverified = !rec.tests && !rec.verifiedHow;

  // Compact trailers on the headline, the way agents write them.
  const trailers: string[] = [];
  if (rec.tests) trailers.push(rec.tests);
  if (rec.verifiedHow) trailers.push(`verified:${rec.verifiedHow}`);
  if (unverified) trailers.push('UNVERIFIED');
  if (rec.migrations && rec.migrations.length > 0) {
    trailers.push(`migs ${rec.migrations.map((m) => m.split(/\s/)[0]).join('/')}`);
  }
  const trailer = trailers.length > 0 ? ` — ${trailers.join(', ')}` : '';
  // No `(agent)` re-embed: the injection renderer shows the sender handle once
  // (token-efficient-coord-injection D-005); the bullet/handle names it.
  //
  // Clip the SUMMARY to fit rather than clipping the whole headline: the
  // trailer is where the verification verdict now lives, and a trailing clip
  // would silently drop `UNVERIFIED` off exactly the longest-winded completions
  // — turning the absence of a warning into a length artefact. Falls back to
  // the original whole-string clip when the trailer alone leaves no useful room.
  const head = `${rec.workItem} ${status}: `;
  const room = SUMMARY_MAX - head.length - trailer.length;
  const summary =
    room >= MIN_SUMMARY_ROOM
      ? clip(`${head}${clip(rec.summary, room)}${trailer}`)
      : clip(`${head}${rec.summary}${trailer}`);

  const body = block(
    rec.title ? `**${rec.title}**` : null,
    rec.whatLanded && rec.whatLanded.length > 0 ? `What landed:\n${bullets(rec.whatLanded)}` : null,
    rec.migrations && rec.migrations.length > 0 ? `Migrations:\n${bullets(rec.migrations)}` : null,
    rec.filesChanged && rec.filesChanged.length > 0
      ? `Files changed (${rec.filesChanged.length}):\n${bullets(rec.filesChanged)}`
      : null,
    renderCoverage(coverage),
    rec.tests ? `Tests: ${rec.tests}` : null,
    rec.verifiedHow ? `Verified how: ${rec.verifiedHow}` : null,
    // Stated plainly, and only when true — see `unverified` above.
    // Terse on purpose: the headline already carries the UNVERIFIED marker, so
    // this line only has to supply the CLAUSE a first-time reader needs. Every
    // extra char here is paid on every unverified completion in every inbox.
    unverified
      ? `⚠ UNVERIFIED — no tests, no \`verifiedHow\`: "${status}" means the author yielded, ` +
        'not that the artifacts were checked.'
      : null,
    rec.deploy ? `Deploy: ${rec.deploy}` : null,
    // The deferred-set is intentionally last + visually flagged so it can't be
    // skimmed past — this is the "surface every deferred item" guarantee.
    rec.deferred && rec.deferred.length > 0
      ? `⚠ Still deferred (not done this pass):\n${bullets(rec.deferred)}`
      : null,
    rec.coordNotes ? `\n${rec.coordNotes}` : null,
  );

  return body.length > 0 ? { summary, body } : { summary };
}

/** CLAIM — "Taking <id>". */
export function renderClaim(rec: ClaimRecord): RenderedNotification {
  const summary = clip(`Taking ${rec.workItem}${rec.summary ? ` — ${rec.summary}` : ''}`);
  return { summary };
}

/**
 * INTENT — "now working on X" heads-up (from coord:declare-intent).
 *
 * GLYPH-FREE + SENDER-FREE (token-efficient-coord-injection P-003/P-010): the
 * line type's glyph (`>`) and the sender handle are applied ONCE by the
 * injection renderer (`coord-schema.renderInjection`) from `COORD_LEGEND` — the
 * stored summary carries only the content, so neither is double-emitted.
 */
export function renderIntent(rec: IntentRecord): RenderedNotification {
  const summary = clip(`now working on: ${rec.intent}`);
  const body = block(
    rec.files && rec.files.length > 0 ? `Files in scope:\n${bullets(rec.files)}` : null,
    rec.planSlug ? `Plan: ${rec.planSlug}` : null,
  );
  return body.length > 0 ? { summary, body } : { summary };
}

/** WINDOW — open / draining / done broadcasts for a held scope. The verb
 *  (holding / draining / released) carries the phase; the `#` glyph + handle are
 *  added by the injection renderer (no inline glyph, no `(agent)`). */
export function renderWindow(rec: WindowRecord): RenderedNotification {
  switch (rec.phase) {
    case 'open':
      return {
        summary: clip(`holding ${rec.scope} — ${rec.intent}`),
        body: `Holding ${rec.scope} for: ${rec.intent}. I'll post DONE for this window when I release it — hold off on edits in this scope until then.`,
      };
    case 'draining':
      return {
        summary: clip(`draining ${rec.scope} — wrapping up: ${rec.intent}`),
        body: `Finishing up on ${rec.scope} (${rec.intent}). Almost done — the window closes shortly.`,
      };
    case 'done':
      return {
        summary: clip(`released ${rec.scope} — ${rec.intent} done`),
        body: `Released ${rec.scope}. ${rec.intent} is done — the scope is free to edit.`,
      };
  }
}

/**
 * HANDOFF (D-008) — the shared formatHandoff. Used by BOTH the coord
 * notification and the agent's-pane render so they never disagree. Glyph-free:
 * the `<` glyph + handle come from the injection renderer.
 */
export function renderHandoff(rec: HandoffRecord): RenderedNotification {
  const dest = rec.to ? ` → ${rec.to}` : '';
  const summary = clip(`handoff${dest}: ${rec.item}`);
  const body = block(
    rec.context,
    rec.nextStep ? `Next step: ${rec.nextStep}` : null,
  );
  return body.length > 0 ? { summary, body } : { summary };
}

/** FINDING / health — a discovered problem. The `!` glyph is added by the
 *  injection renderer (no inline `⚠`). */
export function renderFinding(rec: FindingRecord): RenderedNotification {
  const sev = rec.severity ? `[${rec.severity}] ` : '';
  const ref = rec.workItemId ? ` (${rec.workItemId})` : '';
  const summary = clip(`${sev}${rec.title}${ref}`);
  return rec.detail ? { summary, body: rec.detail } : { summary };
}

/**
 * A category-keyed renderer map for the desugar layer — lets a single emits
 * rule pick the renderer by category without a switch at the callsite. Each
 * entry takes the *already-validated* record shape for its category.
 */
export const CATEGORY_RENDERERS: {
  completion: (r: CompletionRecord) => RenderedNotification;
  claim: (r: ClaimRecord) => RenderedNotification;
  intent: (r: IntentRecord) => RenderedNotification;
  window: (r: WindowRecord) => RenderedNotification;
  handoff: (r: HandoffRecord) => RenderedNotification;
  finding: (r: FindingRecord) => RenderedNotification;
} = {
  completion: renderCompletion,
  claim: renderClaim,
  intent: renderIntent,
  window: renderWindow,
  handoff: renderHandoff,
  finding: renderFinding,
};

/** Type guard helper kept next to the map for callsite ergonomics. */
export function isLifecycleCategory(x: string): x is LifecycleCategory {
  return x in CATEGORY_RENDERERS;
}
