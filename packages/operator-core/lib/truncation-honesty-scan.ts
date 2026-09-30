/**
 * Finds every agent-facing TRUNCATION DOOR in the tree.
 *
 * A "door" is a framework-level stage that CUTS a payload on its way to an
 * agent because it exceeds a context budget. The property this scanner exists
 * to protect (plan `agent-context-firewall-and-output-spill-2026-08-02`, P-009
 * → P-010) is that a door's cut must be discoverable by CODE, not only by an
 * English sentence a reader has to string-match:
 *
 *   payload-tier   stamps `_meta.payloadProjection`   — structured ✓
 *   result-door    stamps `_meta.resultDoor`          — structured ✓ (P-009)
 *   injection-door prose footer only                  — no envelope exists
 *
 * The third one is the reason a registry exists rather than a flat "everything
 * must stamp a marker" rule: a wake injection IS prompt text typed into a PTY,
 * so there is no envelope to stamp and prose is the only channel. That is a
 * legitimate exemption — but it has to be a DECLARED one, because the same
 * shape with no reason attached is exactly the silent-truncation bug.
 *
 * Shared by the guard test (truncation-honesty-guard.test.ts). It lives in its
 * own module so the DETECTOR itself is unit-testable against fixtures — a guard
 * whose detector has gone blind still prints a confident green, which is worse
 * than no guard at all (the house lesson from child-output-scan.ts).
 */

/** How a door site was recognised. */
export type DoorSiteKind =
  /** A call to `capInjectionText(...)` — the shared text-cutting primitive.
   *  This is the STRUCTURAL arm: a new door that cuts text almost certainly
   *  calls it, whatever it names itself. */
  | 'cap-call'
  /** An EMITTED `[<name>-door: …]` prose footer (unescaped `[` — a string or
   *  template literal). The house convention for announcing a cut in-band. */
  | 'footer-emit'
  /** A CONSUMER of that footer — an escaped `\[<name>-door:` inside a regex.
   *  Code parsing the prose footer makes the footer's exact wording
   *  load-bearing, which is the fragility P-009 is about; the guard requires
   *  each of these to be declared against its door. */
  | 'footer-match';

/** One recognised door site. */
export interface DoorSite {
  /** Repo-relative path. */
  file: string;
  /** 1-indexed line. */
  line: number;
  kind: DoorSiteKind;
  /** Door id parsed from a footer (`result-door`, `injection-door`); null for a
   *  `cap-call`, which is attributed to a door by its FILE in the registry. */
  doorName: string | null;
  /** The offending source line, trimmed (capped — this feeds a failure
   *  message, not an audit). */
  text: string;
}

/** A call to the shared cutting primitive. Its own declaration is excluded
 *  below; a bare `import { capInjectionText }` never matches (no `(` follows). */
const CAP_CALL = /\bcapInjectionText\s*\(/;

/** The primitive's own declaration in context-doors.ts — a definition, not a door. */
const CAP_DECL = /\bfunction\s+capInjectionText\s*\(/;

/**
 * `[<name>-door:` — the emitted footer. The negative lookbehind is what
 * separates an EMITTER from a CONSUMER: `` `\n[injection-door: …` `` is a
 * template literal being built, while `/\[injection-door:…/` is a regex
 * stripping it back off (turn-provenance.ts). Both matter, differently.
 */
const FOOTER_EMIT = /(?<!\\)\[([a-z][a-z0-9-]*-door):/;
const FOOTER_MATCH = /\\\[([a-z][a-z0-9-]*-door):/;

const MAX_TEXT = 200;

/** Line is a `//` comment or inside an obvious block-comment continuation
 *  (` * …`). Prose ABOUT a door is not a door. */
function isCommentary(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/**
 * Scan one file's source for door sites.
 *
 * Deliberately textual and cheap: this runs over the whole tree in a unit test,
 * and every pattern it looks for is a deliberate house idiom (a shared
 * primitive call, a conventional footer) rather than something a parser would
 * see more accurately.
 */
export function scanSource(file: string, src: string): DoorSite[] {
  const lines = src.split('\n');
  const hits: DoorSite[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isCommentary(line)) continue;
    const text = line.trim().slice(0, MAX_TEXT);

    if (CAP_CALL.test(line) && !CAP_DECL.test(line)) {
      hits.push({ file, line: i + 1, kind: 'cap-call', doorName: null, text });
    }

    const emit = FOOTER_EMIT.exec(line);
    if (emit) hits.push({ file, line: i + 1, kind: 'footer-emit', doorName: emit[1], text });

    const match = FOOTER_MATCH.exec(line);
    if (match) hits.push({ file, line: i + 1, kind: 'footer-match', doorName: match[1], text });
  }

  return hits;
}
