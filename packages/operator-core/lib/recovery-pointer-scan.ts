/**
 * Finds RECOVERY POINTERS that assert a route their own module documents as
 * conditional.
 *
 * ## The class
 *
 * `truncation-honesty-scan.ts` (its sibling) guarantees a truncation door
 * ANNOUNCES its cut in a code-discoverable way. It says nothing about whether
 * the ESCAPE HATCH that announcement names actually recovers anything — and an
 * announced cut whose recovery pointer does not resolve is worse than an
 * unannounced one, because the reader acts on it.
 *
 * The shape this detector exists for is not "someone forgot". It is TWO
 * CO-LOCATED EMITTERS IN ONE MODULE THAT DISAGREE ABOUT THE SAME ROUTE:
 *
 *   payload-tier.ts `buildDefaultRecoveryNext`  — long-form `_projection.next`:
 *     "NOTE: 'payloadTier' is FRAMEWORK-RESERVED — stripped before schema
 *      validation and absent from <tool>'s published schema
 *      (additionalProperties:false), so a schema-validating client REJECTS it
 *      on a direct call; route these args through your host's raw-args
 *      dispatch path instead."                                   ← caveated ✓
 *
 *   payload-tier.ts `RECOVERY_POINTER.RE_CALL`  — the short inline marker,
 *   fired five times per truncated result:
 *     "recover: re-call with payloadTier:'full'"                 ← no caveat ✗
 *
 * Same claimed mechanism. One carries the condition under which it works; the
 * other is the string an agent actually reads, inside a truncated payload,
 * with the long-form field one hop away and routinely unread. Where one
 * emitter carries a caveat and its neighbour drops it, the UNCAVEATED one is
 * the lie an agent acts on.
 *
 * ## What this asserts, and what it deliberately does not
 *
 * It does NOT assert that any named route resolves — that is not decidable
 * from source, and a guard that pretended otherwise would be the same
 * over-claim it is here to catch. It asserts the strictly weaker, statically
 * decidable property: **a module must not name a mechanism bare in a short
 * recovery marker while documenting that same mechanism as conditional
 * elsewhere in the same module.** Either the caveat is wrong and should go, or
 * the marker is over-claiming and should defer.
 *
 * A marker that points at a FIELD IN THE SAME PAYLOAD (`recover: see
 * _projection.cursor`, `recover: see _projection.next`) is deferring rather
 * than asserting: it hands the reader the field that carries the full
 * conditional story instead of collapsing it to a route. Those are honest by
 * construction and are never flagged.
 *
 * Lives in its own module so the DETECTOR is itself unit-testable against
 * fixtures — a guard whose detector has gone blind still prints a confident
 * green, which is worse than no guard at all (the house lesson from
 * child-output-scan.ts, restated by truncation-honesty-scan.ts).
 */

/** How a recovery site was recognised. */
export type RecoverySiteKind =
  /** A short inline recovery marker — the house `recover: …` convention. This
   *  is the string that travels INSIDE the truncated payload. */
  | 'marker'
  /** A long-form string that documents a mechanism WITH a condition on it.
   *  Not itself a defect; it is the evidence that a bare sibling is one. */
  | 'explainer';

/** One recognised recovery site. */
export interface RecoverySite {
  /** Repo-relative path. */
  file: string;
  /** 1-indexed line. */
  line: number;
  kind: RecoverySiteKind;
  /**
   * Mechanism tokens this site names — camelCase identifiers, which is what an
   * API argument or reserved key looks like and what an English word does not.
   * Deduped, in first-seen order.
   */
  mechanisms: string[];
  /** The site carries a condition on the mechanism it names. */
  caveated: boolean;
  /**
   * Marker only: it points at a field in the SAME payload rather than
   * asserting an outbound route. Deferral is the honest form.
   */
  defers: boolean;
  /** The offending source line, trimmed (this feeds a failure message). */
  text: string;
}

/** A bare marker and the caveated sibling that contradicts it. */
export interface RecoveryDivergence {
  file: string;
  /** The mechanism both sites name. */
  mechanism: string;
  /** The uncaveated short marker — the string an agent acts on. */
  marker: RecoverySite;
  /** The co-located site documenting that same mechanism as conditional. */
  explainer: RecoverySite;
}

/**
 * The house short-marker convention: `recover: <route>`. Emitted by
 * `omissionMarker`/`truncationMarker` and their kin, so it is the token a new
 * door almost certainly uses whatever else it names itself.
 */
const MARKER = /recover:\s*\S/;

/** A source line carrying a string literal. Keeps regexes and bare code out. */
const QUOTE = /['"`]/;

/**
 * A mechanism is a camelCase identifier — `payloadTier`, `explicitFullRequest`
 * — NOT preceded by a dot or word character. The lookbehind is what separates
 * an ARGUMENT the marker tells you to send from a FIELD PATH it tells you to
 * read: `payloadTier` is a mechanism, the `next` in `_projection.next` is not,
 * and neither is the `toolName` in `${opts.toolName}`.
 */
const MECHANISM = /(?<![.\w$])([a-z][a-z0-9]*[A-Z][a-zA-Z0-9]*)/g;

/**
 * A pointer at a field in the payload the reader already holds. `_projection.`
 * and `_meta.` are the two framework envelopes; `see <field>` is the phrasing.
 */
const DEFERRAL = /_projection\.|_meta\./;

/**
 * Cues that a mechanism is being described WITH a condition attached. These
 * are deliberately the words a careful author reaches for when writing down
 * the thing that makes a route fail — the caveat is what makes the sibling
 * marker's silence a divergence rather than a duplicate.
 */
const CAVEAT_CUES: RegExp[] = [
  /\bNOTE:/,
  /\bstripped\b/i,
  /\breserved\b/i,
  /\breject(s|ed)\b/i,
  /\babsent from\b/i,
  /\bonly (if|when)\b/i,
  /\bcannot\b/i,
  /\bdoes not\b/i,
  /\bconditional\b/i,
  /\bunless\b/i,
  /additionalProperties/,
];

const MAX_TEXT = 200;

/**
 * Line is a `//` comment or an obvious block-comment continuation. Prose ABOUT
 * a mechanism is not an emitter — this very file would otherwise flag itself,
 * and so would payload-tier.ts's own rationale block.
 */
function isCommentary(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

function mechanismsIn(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(MECHANISM)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

function isCaveated(line: string): boolean {
  return CAVEAT_CUES.some((re) => re.test(line));
}

/**
 * Scan one file's source for recovery sites.
 *
 * Deliberately textual and cheap, in the style of its sibling: this runs over
 * the whole tree in a unit test, and every pattern is a house idiom rather
 * than something a parser would see more accurately.
 */
export function scanSource(file: string, src: string): RecoverySite[] {
  const lines = src.split('\n');
  const hits: RecoverySite[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isCommentary(line)) continue;
    if (!QUOTE.test(line)) continue;

    const text = line.trim().slice(0, MAX_TEXT);
    const mechanisms = mechanismsIn(line);
    const caveated = isCaveated(line);

    if (MARKER.test(line)) {
      hits.push({
        file,
        line: i + 1,
        kind: 'marker',
        mechanisms,
        caveated,
        defers: DEFERRAL.test(line),
        text,
      });
      continue;
    }

    // An explainer only matters as evidence against a bare marker, so it must
    // actually name something and actually condition it.
    if (caveated && mechanisms.length > 0) {
      hits.push({ file, line: i + 1, kind: 'explainer', mechanisms, caveated: true, defers: false, text });
    }
  }

  return hits;
}

/**
 * Pair every bare marker with a co-located site that documents the same
 * mechanism as conditional.
 *
 * Grouping is per FILE and per MECHANISM, which is what makes this a
 * structural check rather than a string match: a bare marker in a module with
 * no caveat is not a finding (nobody has documented a condition), and a caveat
 * about a DIFFERENT mechanism is not one either.
 *
 * A caveated marker counts as its own explainer, so a module whose only
 * condition is written on one marker still convicts a bare sibling.
 */
export function findRecoveryDivergences(sites: RecoverySite[]): RecoveryDivergence[] {
  const byFile = new Map<string, RecoverySite[]>();
  for (const s of sites) {
    const bucket = byFile.get(s.file);
    if (bucket) bucket.push(s);
    else byFile.set(s.file, [s]);
  }

  const out: RecoveryDivergence[] = [];
  for (const [file, group] of byFile) {
    const caveated = group.filter((s) => s.caveated && s.mechanisms.length > 0);
    if (caveated.length === 0) continue;

    for (const marker of group) {
      if (marker.kind !== 'marker' || marker.caveated || marker.defers) continue;
      for (const mechanism of marker.mechanisms) {
        const explainer = caveated.find(
          (s) => s.line !== marker.line && s.mechanisms.includes(mechanism),
        );
        if (explainer) out.push({ file, mechanism, marker, explainer });
      }
    }
  }
  return out;
}

/** One-line rendering for a failure message. */
export function describeDivergence(d: RecoveryDivergence): string {
  return (
    `${d.file}:${d.marker.line} names '${d.mechanism}' with no condition — ` +
    `${d.file}:${d.explainer.line} documents it as conditional.\n` +
    `    marker:    ${d.marker.text}\n` +
    `    explainer: ${d.explainer.text}`
  );
}
