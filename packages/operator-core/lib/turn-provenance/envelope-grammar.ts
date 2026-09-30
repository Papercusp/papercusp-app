/**
 * THE turn-origin envelope grammar — one definition, four languages.
 *
 * The canonical envelope is `⟦turn-origin:<origin> nonce:<hex>⟧` at the very
 * start of a turn. It decides whether a recorded turn is attributed to the
 * OWNER or to a machine seam, so a divergence between two copies of this
 * grammar does not fail loudly — it silently mis-attributes turns, in whichever
 * direction the drift happens to go. That is the same failure class as the
 * machine-surface catalogue one layer up (D-004): a matcher that quietly stops
 * agreeing with its twin.
 *
 * ── ZERO-IMPORT LEAF, deliberately ──────────────────────────────────────────
 * This module imports NOTHING. That is load-bearing, not stylistic:
 * `agent-tools/coordination/owner-chat-turn.ts` must stay import-light to cross
 * the client seam, and it can only depend on leaves. (Its sibling
 * `machine-surface-catalogue.ts` is a leaf for the same reason and is already
 * imported there.) Adding an import here would break that seam from a distance,
 * with no local symptom. Do not add one.
 *
 * ── WHY THIS IS NOT SIMPLY "IMPORT IT EVERYWHERE" ───────────────────────────
 * Two of the six real sites are not TypeScript and can never import anything
 * from this package:
 *
 *   • `apps/operator/scripts/psu-launcher.mjs` — a launcher outside the TS
 *     package graph, so no typecheck or lint can ever tie it to this file;
 *   • `apps/operator/scripts/hooks/cc/userpromptsubmit-provenance.sh` — a
 *     PYTHON `re.compile(...)` embedded in a shell hook, a third language.
 *
 * and one more is a fourth language living inside TypeScript:
 *
 *   • the Postgres POSIX-regex copies in `adv-agent-detail.ts`, whose dialect
 *     differs from JS (`[[:space:]]`, not `\s`) — so even "same file, same
 *     language" does not make it the same pattern text.
 *
 * So this module does what it CAN reach (the TS sites import it) and exports
 * the grammar as PATTERN TEXT so the sites it cannot reach are checkable by a
 * guard test that reads them off disk and runs them against a shared corpus.
 * That guard — `envelope-grammar-cross-language.test.ts` — is the mechanism
 * that actually spans the language boundary. Its predecessor mechanism was a
 * comment in each copy saying "change them together", i.e. human memory, which
 * is precisely what failed for the catalogue.
 *
 * ⚠ The copy at `papercusp-desktop/src-tauri/sidecar/**` is a GITIGNORED BUILD
 * ARTIFACT, not a source site — it is produced from the file above and cannot
 * drift on its own. Do not add it to the guard: a guard that fails on a stale
 * build output teaches people to ignore the guard.
 */

/** The character class an ORIGIN may draw from (`wake-pump`, `coord-inject:owner`, …). */
export const ENVELOPE_ORIGIN_CLASS = '[A-Za-z0-9:._@-]+';

/** The nonce is 16 hex chars in practice; the grammar accepts 8–64 for headroom. */
export const ENVELOPE_NONCE_CLASS = '[a-f0-9]{8,64}';

/** U+27E6 / U+27E7 — MATHEMATICAL WHITE SQUARE BRACKETs. Spelled as escapes so a
 *  transcoding accident anywhere in the toolchain is visible in review. */
export const ENVELOPE_OPEN = '⟦';
export const ENVELOPE_CLOSE = '⟧';

/**
 * The canonical pattern, as JS regex SOURCE, capturing origin then nonce.
 *
 * Head-anchored with tolerated leading whitespace: TUIs pad. An envelope found
 * mid-text is NOT an envelope — it is quoted or relayed content, and must not
 * classify the turn.
 */
export const ENVELOPE_PATTERN_SOURCE =
  `^\\s*${ENVELOPE_OPEN}turn-origin:(${ENVELOPE_ORIGIN_CLASS}) ` +
  `nonce:(${ENVELOPE_NONCE_CLASS})${ENVELOPE_CLOSE}`;

/**
 * The trailing run a STRIP site additionally consumes, so removing the envelope
 * does not leave a blank first line. Display-only: no classifier uses it.
 */
export const ENVELOPE_TRAILING_SOURCE = '[ \\t]*\\r?\\n?';

/** Canonical matcher: `m[1]` = origin, `m[2]` = nonce. */
export const ENVELOPE_RE = new RegExp(ENVELOPE_PATTERN_SOURCE);

/** Canonical matcher for DISPLAY stripping — also eats the trailing newline. */
export const ENVELOPE_STRIP_RE = new RegExp(ENVELOPE_PATTERN_SOURCE + ENVELOPE_TRAILING_SOURCE);

/**
 * A prompt that is ENTIRELY one Claude Code paste block, as JS regex source:
 * `m[1]` = paste id, `m[2]` = the pasted text.
 *
 * WI-10002461. Claude Code delivers a large bracketed paste to the model as
 * `<pasted_content id="4e03">\n…\n</pasted_content id="4e03">`. Every machine
 * injector that types through the PTY (wake-pump, self-compaction, fleet-kickoff)
 * now arrives in that wrapper, which pushes the envelope off the head of the turn.
 * The head anchor above then misses it, and the turn falls through to the
 * affirmative OWNER default — so a wake became a pending owner directive, reached
 * the owner-only mode-grant branch of the provenance hook, and rendered in the
 * owner's chat pane as something they had said. Measured from `orders`: #170 and
 * #173 are exactly `\n\n<pasted_content id="4e03">\n⟦turn-origin:wake-pump …⟧…\n</pasted_content id="4e03">\n`.
 *
 * WHOLE-PROMPT ONLY, deliberately. The opening tag must sit at the head and the
 * MATCHING closing tag at the tail with nothing but whitespace outside them. A
 * paste the owner surrounds with their own words (directive #153 is exactly that
 * shape) is not unwrapped, so it keeps its OWNER verdict: that owner is quoting
 * content, which is the same reason a mid-text envelope never classifies a turn.
 * Unwrapping never grants authority by itself — the unwrapped text still has to
 * carry a head envelope backed by a live ledger row to verify as agent-origin.
 */
export const PASTE_WRAPPER_SOURCE =
  '^\\s*<pasted_content id="([A-Za-z0-9_-]{1,64})">\\r?\\n?([\\s\\S]*?)\\r?\\n?' +
  '</pasted_content id="\\1">\\s*$';

/** Canonical whole-prompt paste matcher: `m[1]` = paste id, `m[2]` = pasted text. */
export const PASTE_WRAPPER_RE = new RegExp(PASTE_WRAPPER_SOURCE);

/** The pasted text when `text` is entirely one paste block; otherwise `text` unchanged. */
export function unwrapWholePaste(text: string): string {
  const m = PASTE_WRAPPER_RE.exec(text ?? '');
  return m ? m[2] : text;
}

/** The opening half of {@link PASTE_WRAPPER_SOURCE}: `m[1]` = paste id. */
const PASTE_OPEN_RE = /^\s*<pasted_content id="([A-Za-z0-9_-]{1,64})">/;

/**
 * A HEAD-BOUNDED view of a turn, made whole-paste-classifiable (WI-10004057).
 *
 * Every classifier that reads only `left(text, N)` hands {@link unwrapWholePaste} a
 * head whose closing tag was cut off, so a paste longer than the head never unwraps:
 * the envelope inside stays invisible and the turn falls through to the affirmative
 * OWNER default. Measured: a loop-fire turn surfaced by `sessions:search` as
 * `owner-typed`, and the same head fed the activation audit's owner-evidence check.
 *
 * `tail` is the END of the same turn (`right(text, M)`). When the head opens a paste
 * block and the tail closes the SAME id with only whitespace after it, the whole turn
 * is exactly one paste — the shape {@link PASTE_WRAPPER_RE} accepts on full text — so
 * the closing tag is re-appended to the head and every head-bounded check sees what it
 * would have seen on the full text. The whole-prompt rule is unchanged: owner words
 * before the paste fail the head test, owner words after it fail the tail test, and
 * either way the head is returned as-is. A head that already contains its closing tag
 * (the turn fit in the head) is returned unchanged.
 */
export function closeTruncatedWholePaste(head: string, tail: string | null | undefined): string {
  if (typeof tail !== 'string' || PASTE_WRAPPER_RE.test(head)) return head;
  const open = PASTE_OPEN_RE.exec(head);
  if (!open) return head;
  // The id charset is regex-safe by construction ([A-Za-z0-9_-]).
  const closing = `</pasted_content id="${open[1]}">`;
  return new RegExp(`${closing}\\s*$`).test(tail) ? `${head}\n${closing}` : head;
}

/**
 * The same grammar in POSTGRES POSIX-regex dialect, for SQL `~` comparisons.
 *
 * Not interchangeable with the JS source: POSIX has no `\s`, and a JS pattern
 * pasted into SQL matches nothing while looking perfectly correct — a silent
 * always-false branch. Pass an `originPattern` to pin one specific origin
 * (e.g. `coord-inject:owner`); omit it to match any.
 */
export function envelopePatternSql(originPattern: string = ENVELOPE_ORIGIN_CLASS): string {
  return (
    `^[[:space:]]*${ENVELOPE_OPEN}turn-origin:${originPattern} ` +
    `nonce:${ENVELOPE_NONCE_CLASS}${ENVELOPE_CLOSE}`
  );
}

/** Build an envelope. The one producer every other producer must agree with. */
export function formatEnvelope(origin: string, nonce: string): string {
  return `${ENVELOPE_OPEN}turn-origin:${origin} nonce:${nonce}${ENVELOPE_CLOSE}`;
}
