/**
 * HTML → readable text (pure, dependency-free).
 *
 * LIFTED, NOT FORKED. This lived inside the GAIA benchmark's `tools-live.ts`,
 * where it was only ever reachable by importing a module that also pulls in a
 * Brave-search client, a python subprocess runner and a file reader. The second
 * caller (the Mastodon adapter — a status's `content` is documented as
 * "String (HTML)") made that placement untenable: the choice was to import a
 * benchmark harness into the trigger layer, or to copy forty lines. Both are the
 * repo's stated review smells, so the function moved here and `tools-live.ts`
 * re-exports it. No behaviour changed for the GAIA caller except the entity fix
 * below, which was a latent bug in both.
 *
 * WHAT THIS IS NOT. It is a reduction, not a sanitizer. It strips tags rather
 * than parsing them, so it must never be used to make untrusted HTML safe to
 * render — its output is for reading and matching, and every consumer so far
 * treats it as text. Nothing here escapes on the way out.
 */

/**
 * The named entities we decode. Anything else is left verbatim rather than
 * dropped, so unrecognized markup degrades to visible text instead of silently
 * vanishing.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

const MAX_CODE_POINT = 0x10ffff;

/**
 * Decode HTML entities in ONE pass — never by successive replacements.
 *
 * THIS IS THE WHOLE REASON THE FUNCTION EXISTS SEPARATELY. The previous
 * implementation decoded numeric entities, then each named entity in turn, each
 * over the output of the last. That re-scans text that has already been
 * decoded, so a literal `&amp;lt;` becomes `&lt;` on the amp pass and then `<`
 * on the lt pass — markup the author never wrote, invented by the decoder.
 * `&#38;lt;` does the same thing through the numeric pass, which is why simply
 * reordering the named entities does NOT fix it.
 *
 * A single regex pass cannot have the bug by construction: each match is
 * consumed once and its replacement is never re-examined. That distinction is
 * cosmetic on a benchmark page and load-bearing for a Mastodon status, whose
 * `content` is attacker-controlled HTML and where `&amp;lt;script&amp;gt;` is
 * exactly what someone writes when they want to TALK about a script tag.
 */
export function decodeHtmlEntities(input: string): string {
  return input.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g, (match, dec, hex, name) => {
    if (dec !== undefined) return fromCodePoint(Number.parseInt(dec, 10), match);
    if (hex !== undefined) return fromCodePoint(Number.parseInt(hex, 16), match);
    return NAMED_ENTITIES[String(name).toLowerCase()] ?? match;
  });
}

/** Code point → character, falling back to the literal source on anything out of range. */
function fromCodePoint(codePoint: number, fallback: string): string {
  if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > MAX_CODE_POINT) return fallback;
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return fallback;
  }
}

/**
 * Reduce an HTML document to readable text: drop `<script>`/`<style>`/`<noscript>`/`<svg>` bodies and HTML
 * comments, turn block-closing tags into newlines, strip remaining tags, decode common entities, collapse
 * runs of blank lines. Good enough for the static/server-rendered pages most GAIA lookups hit, and for the
 * small HTML fragment a Mastodon status carries.
 */
export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi, ' ');
  // Block-level closers / breaks → newlines so structure survives.
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|table|ul|ol|blockquote)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<[^>]+>/g, ' '); // remaining tags
  s = decodeHtmlEntities(s);
  s = s.replace(/[ \t\f\v]+/g, ' ');
  s = s.replace(/ *\n */g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}
