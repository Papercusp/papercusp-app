/**
 * quote-secret-redaction.ts — EI-22164571843016048.
 *
 * A fact's source-provenance `quote` is captured server-side from the owner's
 * human turn (or a coord message / work-item) and then folded VERBATIM into
 * every relevant agent's orient. That is the feature: deterministic delivery of
 * the words that proved the claim. It is also the hazard — a workspace-scoped
 * fact asserted in the same turn the owner pasted a credential BROADCASTS that
 * credential fleet-wide, and `facts:retract` stops the fold without removing
 * the row. So the quote is scanned and redacted BEFORE it is persisted.
 *
 * WHY THIS IS NOT JUST `scanTextForSecrets`
 * -----------------------------------------
 * The pot-git secrets guard's detector is the right first pass and is used
 * here as one — but measured against the shape that motivated this module it
 * MISSES, because its only generic rule (`secret-assignment`) requires a `:`
 * or `=` separator. The reported leak was PROSE:
 *
 *     "... my super@… password is <CREDENTIAL>"
 *
 * no separator, so no match. Reusing that detector alone would have shipped a
 * redaction that still leaked the exact class of secret it was written for.
 * Hence {@link scanProseCredential}: a keyword-then-value rule that tolerates
 * ordinary English between the two.
 *
 * WHY THE PROSE RULE LIVES HERE AND NOT IN THE SHARED `RULES`
 * ----------------------------------------------------------
 * The two callers have OPPOSITE cost asymmetries, so they cannot share one
 * threshold:
 *   - pot-git publish guard: a false positive BLOCKS a publish, and a refused
 *     range never advances its baseline, so an over-eager rule can wedge the
 *     publish plane indefinitely. False positives are expensive there.
 *   - a provenance quote: a false positive costs one redacted audit snippet
 *     while the fact itself, its body, its label and its verified flag all
 *     survive. False positives are cheap here.
 * Widening the shared RULES to serve this path would silently import this
 * path's tolerance for false positives into the publish plane. So the
 * aggressive rule is layered on top instead, and the shared detector is used
 * unchanged.
 */

import { scanTextForSecrets, shannonEntropy } from '../../sync/pot-git/secrets-guard';

/** What replaces a quote that tripped the scan. Deliberately explicit: a reader
 *  must be able to tell redaction from an absent/unresolved quote. */
export const REDACTED_QUOTE = '[REDACTED: source turn contained a credential-shaped value]';

/** Words that introduce a credential in ordinary prose. */
const CREDENTIAL_KEYWORD =
  /\b(?:password|passwd|passphrase|pass[- ]?code|secret|credential|api[- _]?key|access[- _]?token|auth[- _]?token|bearer[- _]?token|client[- _]?secret|private[- _]?key|token|pin)\b/gi;

/** Filler that may sit between the keyword and the value ("password is X",
 *  "the api key for prod was X"). Matching these is what the shared detector's
 *  `[:=]`-only separator cannot do. */
const CONNECTOR = new Set([
  'is', 'was', 'are', 'were', 'be', 'the', 'a', 'an', 'my', 'our', 'your', 'his', 'her', 'their',
  'its', 'now', 'currently', 'here', 'this', 'that', 'for', 'to', 'of', 'on', 'in', 'at', 'as',
  'and', 'with', 'using', 'use', 'set', 'reads', 'equals', 'prod', 'staging', 'dev', 'admin',
  'super', 'root', 'account', 'login', 'user', 'username', 'email', 'new', 'old', 'temp',
  'temporary', 'rotated', 'regenerated', 'again', 'still', 'just', 'literally', 'currently:',
]);

/** How many whitespace-separated tokens after the keyword may be filler before
 *  we stop looking. Keeps "the password policy requires sixteen characters"
 *  from reaching an unrelated value far down the sentence. */
const MAX_CONNECTOR_TOKENS = 4;

/** Obvious non-secrets — mirrors the shared guard's placeholder suppression so
 *  docs, examples and this module's own marker never trip the rule. */
const PLACEHOLDER_RE =
  /your|here|goes|example|changeme|change-me|placeholder|dummy|sample|redacted|xxxx|<[a-z]|\btest\b|todo|fixme|none|null|undefined|\*{3,}|…/i;

/** A credential-shaped VALUE: long enough, mixed enough, and disordered enough
 *  that it is not an ordinary English word. All three gates must pass, because
 *  each alone has a well-known false-positive mode (length alone matches long
 *  words; class-mixing alone matches "Monday2026"; entropy alone matches short
 *  acronyms). */
const MIN_VALUE_CHARS = 10;
const MIN_VALUE_ENTROPY = 2.6;
const MIN_CHAR_CLASSES = 2;

function characterClasses(s: string): number {
  let n = 0;
  if (/[a-z]/.test(s)) n += 1;
  if (/[A-Z]/.test(s)) n += 1;
  if (/[0-9]/.test(s)) n += 1;
  if (/[^A-Za-z0-9]/.test(s)) n += 1;
  return n;
}

/** Strip trailing sentence punctuation and surrounding quotes/brackets so
 *  `password is Qv7bTm2xLp9RdKw4.` measures the value, not the full stop. */
function unwrapValue(token: string): string {
  return token.replace(/^[('"`\[{<]+/, '').replace(/[)'"`\]}>.,;!?]+$/, '');
}

/** True if `token` looks like a credential rather than a word. Exported so the
 *  test can pin each gate independently. */
export function looksLikeCredentialValue(token: string): boolean {
  const v = unwrapValue(token);
  if (v.length < MIN_VALUE_CHARS) return false;
  if (PLACEHOLDER_RE.test(v)) return false;
  if (characterClasses(v) < MIN_CHAR_CLASSES) return false;
  if (shannonEntropy(v) < MIN_VALUE_ENTROPY) return false;
  return true;
}

/**
 * PURE: does `text` contain a credential introduced in prose — a credential
 * keyword followed, across up to {@link MAX_CONNECTOR_TOKENS} filler words, by
 * a credential-shaped value? This is the gap the shared detector leaves.
 */
export function scanProseCredential(text: string): boolean {
  CREDENTIAL_KEYWORD.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CREDENTIAL_KEYWORD.exec(text)) !== null) {
    const after = text.slice(m.index + m[0].length);
    const tokens = after.split(/\s+/).filter(Boolean);
    let skipped = 0;
    for (const token of tokens) {
      const bare = unwrapValue(token).toLowerCase();
      // A lone separator ("password : X") is filler, not a candidate value.
      if (bare === '' || bare === ':' || bare === '=' || bare === '->' || bare === '→') continue;
      if (looksLikeCredentialValue(token)) return true;
      if (!CONNECTOR.has(bare)) break; // a real word that is not filler ends the window
      if (++skipped >= MAX_CONNECTOR_TOKENS) break;
    }
  }
  return false;
}

/** Outcome of scanning one provenance quote. */
export interface QuoteRedaction {
  /** The quote to persist — the original, or {@link REDACTED_QUOTE}. */
  quote: string;
  /** True when the original was withheld. Surfaced to the caller so a silent
   *  redaction cannot be mistaken for "the turn had nothing quotable". */
  redacted: boolean;
  /** Which layer fired, for the caller-facing message. */
  detector?: 'secrets-guard' | 'prose-credential';
}

/**
 * PURE: scan a captured provenance quote and redact it if it carries a
 * credential. Both layers run: the shared high-signal detector first (it
 * recognises structural tokens — AKIA…, ghp_…, PEM blocks — that the prose
 * rule has no reason to model), then the prose rule for the human-chosen
 * secrets it cannot see.
 */
export function redactProvenanceQuote(quote: string | undefined): QuoteRedaction {
  if (!quote) return { quote: '', redacted: false };
  // `path` is used by the shared scanner only for reporting and its .env rule;
  // a synthetic name keeps this off any real file's exemption/fixture list.
  if (scanTextForSecrets('<fact-source-provenance-quote>', quote).length > 0) {
    return { quote: REDACTED_QUOTE, redacted: true, detector: 'secrets-guard' };
  }
  if (scanProseCredential(quote)) {
    return { quote: REDACTED_QUOTE, redacted: true, detector: 'prose-credential' };
  }
  return { quote, redacted: false };
}
