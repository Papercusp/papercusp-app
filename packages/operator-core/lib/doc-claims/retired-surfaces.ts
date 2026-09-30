/**
 * Extract the RETIREMENT CLAIMS CLAUDE.md makes — the surfaces it tells a reader
 * are retired — so a test can assert they are actually retired
 * (false-premise-in-prescriptive-artifacts-2026-08-02 P-004, same family as the
 * sibling `executable-claims` module).
 *
 * The live instance: § "Retired / preserved-not-active surfaces" listed
 * `OperatorChatSidebar` as retired for ~1 month while it was live, flag-default-ON,
 * load-bearing and carrying passing tests (EI-19485603307368652).
 *
 * ── Why this class needs a GUARD rather than another manual correction ──
 *
 * That section is not descriptive prose, it is an INSTRUCTION: "Don't write tests
 * for it, wire new code to it, or 'revive' it without an explicit ask." So a wrong
 * entry suppresses real work on shipping code — and does it while the agent looks
 * rigorous, because it cited the project guide.
 *
 * The failure is ASYMMETRIC and biased toward silence, which is why it survived a
 * month:
 *
 *   wrongly says LIVE     self-corrects — the first reader to grep finds nothing.
 *   wrongly says RETIRED  emits NO error, ever. It quietly diverts work away, and
 *                         nobody files a bug about work they decided not to do.
 *
 * ── Why this extracts by RESOLUTION, not by negation cue ──
 *
 * This section is DENSE with deliberate live counter-examples: it names
 * `apps/operator/app/_components/OperatorChatSidebar.tsx`, `apps/operator/app/harness/`
 * and `coord/messages.ts` precisely to say they are LIVE, and it names route paths
 * (`/adv`), plan slugs (`hud-consolidation-2026-07-26`), flag constants
 * (`KNOWN_DARK_FLAGS`) and tool verbs (`coord:send`) in passing. MEASURED on the real
 * file: 43 backticked spans, of which 24 are path-shaped and only 8 name a retirement
 * location. A detector that fired on "every path in the retired section" would fire on
 * 12+ spans the doc is explicitly calling live — i.e. it would fail hardest on the
 * best-documented part of the section, the same inversion the sibling module measured.
 *
 * So nothing here reads intent from prose. A span is judged only when it RESOLVES to
 * something on disk, and the verdict is a filesystem fact: does every resolution of
 * this name sit under a `_retired/` segment, or not? Whether the doc MEANT it as
 * retired is supplied by the caller's classification table (see below), never guessed.
 *
 * ── The closure property that keeps the classification table honest ──
 *
 * A hand-written table of "which of these spans are retirement claims" is exactly the
 * derived artifact this repo has watched go stale three times over. It is safe here
 * only because the caller is expected to assert CLOSURE: the declared key set must
 * equal the judged span set, so a span ADDED to (or removed from) the doc reds the
 * guard until someone classifies it, rather than being silently unjudged.
 *
 * ⚠ KNOWN BOUND: the resolver is the SUPERPROJECT index, so a bare name that lives
 * only inside a submodule resolves to nothing and is skipped, not failed. Fail-open in
 * every uncertain direction (D-001 constraint 2): a missed claim costs nothing, a
 * fabricated one costs a red gate and trains readers to ignore the check.
 */

/** Why a span in the section was not judged. Every skip names its reason. */
export type SurfaceSkipReason =
  /** carries a metavariable (`libs/papercusp/_retired/…`) — not resolvable as written */
  | 'placeholder'
  /** a glob (`libs/papercusp-shared/**\/*View.tsx`) — names a set, not a location */
  | 'glob'
  /** a URL route (`/adv`, `/harness/$slug`), not a filesystem path */
  | 'url-route'
  /** a tool verb, table, flag or plan slug — never a file (`coord:send`, `KNOWN_DARK_FLAGS`) */
  | 'not-file-shaped'
  /** file-shaped but resolves nowhere in the index — see the KNOWN BOUND above */
  | 'unresolved';

export interface SurfaceSpan {
  /** 1-based line in the source markdown. */
  line: number;
  /** the backticked text, verbatim */
  text: string;
  /**
   * Every path in the repo this span resolves to. A path claim resolves to itself
   * (when it exists); a bare name resolves by basename across the index, so it can
   * legitimately resolve to several.
   */
  resolvesTo: string[];
  /** true when EVERY resolution sits under a `_retired/` segment. */
  retiredOnDisk: boolean;
}

export interface SkippedSurfaceSpan {
  line: number;
  text: string;
  reason: SurfaceSkipReason;
}

/**
 * A surface the doc attributes to a retirement directory by POSITION rather than by
 * a path — the `` `_retired/<dir>/` — <roster> `` form every entry in this section
 * uses.
 *
 * This leg exists because the ORIGINAL defect is invisible to the span leg above.
 * Recovered verbatim from `6e44d56a0b^`, the doc read:
 *
 *     (`_retired/legacy-web-chats/` — OracleDock/OperatorChatSidebar; the pui chat
 *     pane is the only chat surface)
 *
 * `OperatorChatSidebar` carries no backticks there, so a backtick-only extractor
 * returns a confident all-clear over the very line that motivated this guard. The
 * roster position is the claim: whatever is named after the em-dash is being said to
 * LIVE AT that path, so no classification table is needed to know what the doc meant.
 */
export interface RosterClaim {
  line: number;
  /** the retirement directory the roster is attributed to */
  location: string;
  /** the surface name as written in the roster */
  name: string;
  resolvesTo: string[];
  retiredOnDisk: boolean;
}

export interface RetiredSurfaceExtraction {
  /** false when the section heading is absent — assert nothing rather than pass vacuously. */
  sectionFound: boolean;
  /** spans carrying enough information to judge */
  judged: SurfaceSpan[];
  /** spans deliberately not judged, each with a named reason */
  skipped: SkippedSurfaceSpan[];
  /** surfaces attributed to a retirement directory by roster position */
  roster: RosterClaim[];
}

/** The heading whose claims this module governs. */
const SECTION = /^##\s+Retired\s*\/\s*preserved-not-active surfaces\s*$/;

/** A metavariable makes a span unresolvable as written. */
const PLACEHOLDER = /[<>]|…|\.\.\./;

/** Source extensions this repo's docs name. */
const SOURCE_EXT = /\.(?:tsx?|jsx?|[cm]js|md|json|sql|rs|sh|css)$/;

/** `OperatorChatSidebar` — a component named without its extension. */
const PASCAL_CASE = /^[A-Z][A-Za-z0-9]*$/;

/**
 * A roster token must have at least TWO capitalised humps — `OracleDock`,
 * `TutorialButton`, `OperatorChatSidebar`, `InboxPane`. Single-hump words are
 * rejected deliberately: an em-dash roster is ordinary prose, so it also contains
 * `Real` (from `shell/pages/Real-panels`), `NOT`, `LIVE` and sentence-initial words,
 * and a one-hump rule would resolve some of those to unrelated files and report a
 * confident false positive on the best-documented entry in the section.
 */
const COMPONENT_NAME = /^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+$/;

/** A path segment named `_retired` is this repo's retirement convention. */
export function isRetiredPath(path: string): boolean {
  return path.split('/').includes('_retired');
}

/** Lines of the retired-surfaces section, with their 1-based source line numbers. */
function sectionLines(markdown: string): { line: number; text: string }[] | null {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => SECTION.test(l));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const endOffset = rest.findIndex((l) => /^##\s/.test(l));
  const body = endOffset < 0 ? rest : rest.slice(0, endOffset);
  return body.map((text, i) => ({ line: start + 2 + i, text }));
}

/**
 * Classify a span before any filesystem work. Returns a skip reason, or null when
 * the span is file-shaped enough to be worth resolving.
 */
function preScreen(text: string): SurfaceSkipReason | null {
  if (PLACEHOLDER.test(text)) return 'placeholder';
  if (text.includes('*')) return 'glob';
  // No repo-relative path in this doc starts with `/`; every span that does is a
  // URL route (`/adv`, `/workbench`, `/harness/$slug`).
  if (text.startsWith('/')) return 'url-route';
  // A tool verb (`coord:send`), a namespaced prefix (`cross_harness:`) — never a path.
  if (text.includes(':')) return 'not-file-shaped';
  if (text.includes('/')) return null; // a path claim
  // A bare name is worth resolving only when it LOOKS like a file: it carries a
  // source extension, or it is PascalCase (this repo's component convention).
  // Everything else in this section is a flag constant, a table, a plan slug or a
  // lowercase tool word — `KNOWN_DARK_FLAGS`, `coord_event_log`,
  // `hud-consolidation-2026-07-26`, `inbox` — and judging those would be noise.
  if (SOURCE_EXT.test(text) || PASCAL_CASE.test(text)) return null;
  return 'not-file-shaped';
}

/**
 * Resolve a span to repo paths.
 *
 * `exists` answers a direct path claim (so an untracked-but-present directory such
 * as `libs/holepunch-spike` still resolves); `byBasename` answers a bare name.
 */
export interface SurfaceResolver {
  exists: (repoRelativePath: string) => boolean;
  byBasename: (name: string) => string[];
  /**
   * Paths ENDING in this fragment. The doc routinely names a partial path
   * (`coord/messages.ts`) rather than a repo-relative one, and treating those as
   * dangling would manufacture false positives out of a writing convention.
   */
  bySuffix: (fragment: string) => string[];
}

/**
 * Pull the surfaces each `` `_retired/<dir>/` — <roster> `` entry attributes to that
 * directory.
 *
 * The roster ends at the first `;`, `.` or `)` — the doc's own clause boundary. That
 * bound is load-bearing: the current `_retired/legacy-web-chats/` entry is followed,
 * one sentence later, by a deliberate LIVE counter-example naming
 * `OperatorChatSidebar`, and a roster that ran past the period would read that
 * correction as a retirement claim and fail on the very text that fixed the bug.
 */
function extractRoster(
  body: { line: number; text: string }[],
  resolver: SurfaceResolver,
): RosterClaim[] {
  const joined = body.map((b) => b.text).join('\n');
  // offset → source line, so a roster spanning a wrap still reports where it lives.
  const lineAt = (offset: number): number => {
    let seen = 0;
    for (const b of body) {
      seen += b.text.length + 1;
      if (offset < seen) return b.line;
    }
    return body.length ? body[body.length - 1].line : 0;
  };

  const out: RosterClaim[] = [];
  for (const m of joined.matchAll(/`(_retired\/[^`]*)`/g)) {
    const start = (m.index ?? 0) + m[0].length;
    const tail = joined.slice(start);
    const end = tail.search(/[;.)]/);
    const segment = end < 0 ? tail : tail.slice(0, end);
    const location = m[1].replace(/\/+$/, '');

    for (const rawToken of segment.split(/[^A-Za-z0-9._-]+/)) {
      const name = rawToken.replace(SOURCE_EXT, '').replace(/[._-]+$/, '');
      if (!COMPONENT_NAME.test(name)) continue;
      const resolvesTo = resolver.byBasename(name);
      // Fail OPEN: a roster word that resolves to nothing is prose, not a claim.
      if (resolvesTo.length === 0) continue;
      out.push({
        line: lineAt(start),
        location,
        name,
        resolvesTo,
        retiredOnDisk: resolvesTo.every(isRetiredPath),
      });
    }
  }
  return out;
}

export function extractRetiredSurfaceClaims(
  markdown: string,
  resolver: SurfaceResolver,
): RetiredSurfaceExtraction {
  const body = sectionLines(markdown);
  if (!body) return { sectionFound: false, judged: [], skipped: [], roster: [] };

  const judged: SurfaceSpan[] = [];
  const skipped: SkippedSurfaceSpan[] = [];

  for (const { line, text: raw } of body) {
    for (const m of raw.matchAll(/`([^`]+)`/g)) {
      const text = m[1].trim();
      const reason = preScreen(text);
      if (reason) {
        skipped.push({ line, text, reason });
        continue;
      }

      // A trailing slash is how the doc writes a directory; strip it to resolve.
      const asPath = text.replace(/\/+$/, '');
      const resolvesTo = text.includes('/')
        ? resolver.exists(asPath)
          ? [asPath]
          : resolver.bySuffix(asPath)
        : resolver.byBasename(text);

      if (resolvesTo.length === 0) {
        // A path claim that resolves NOWHERE is still a judged claim — a doc
        // pointing at a location that does not exist is the same defect one step
        // further along, and it is exactly what `libs/zero-harness` turned out to
        // be. A BARE NAME that resolves nowhere is genuinely unknown (it may live
        // in a submodule), so that one is skipped.
        if (text.includes('/')) {
          judged.push({ line, text, resolvesTo: [], retiredOnDisk: false });
        } else {
          skipped.push({ line, text, reason: 'unresolved' });
        }
        continue;
      }

      judged.push({
        line,
        text,
        resolvesTo,
        retiredOnDisk: resolvesTo.every(isRetiredPath),
      });
    }
  }

  return { sectionFound: true, judged, skipped, roster: extractRoster(body, resolver) };
}

/**
 * How the caller says the doc MEANT each span. Never inferred from prose.
 *
 * ⚠ `retired` and `retired-in-place` are separated because this repo has BOTH
 * conventions, and collapsing them makes the guard assert a rule that does not
 * exist. Measured on the live doc: `libs/papercusp-db` and `libs/holepunch-spike`
 * are genuinely retired yet deliberately sit in the live tree, so a single
 * "retired ⇒ under `_retired/`" rule reported them as violations — a guard
 * demanding a relocation nobody ever agreed to.
 */
export type SurfaceClaim =
  /** retired BY RELOCATION — the doc says it moved under a `_retired/` directory */
  | 'retired'
  /**
   * retired IN PLACE — deliberately kept where it is, not relocated.
   *
   * ⚠ HONEST BOUND: this is the one claim a filesystem cannot fully check. A
   * retired-in-place surface and a live one are both just files in the live tree,
   * so all that is decidable here is that the path still EXISTS — which is not
   * nothing (it is exactly what caught `libs/zero-harness`, deleted in the
   * 2026-06-20 Zero decommission yet still listed as preserved), but it is NOT the
   * "is it secretly live?" check. Deepening this needs an importer analysis, which
   * `lint:no-retired` already computes; it is deliberately not folded in here
   * because the doc explicitly notes live orchestrator files DO reference
   * `libs/holepunch-spike`, so a naive importer rule would red a correct entry.
   */
  | 'retired-in-place'
  /** the doc names this surface explicitly as still LIVE (a counter-example) */
  | 'live'
  /** the doc names this surface as code-live but not mounted by default */
  | GatedSurfaceClaim
  /**
   * The doc names this path precisely to say it is GONE — deleted, not preserved.
   * The assertion inverts: it must resolve to NOTHING. That keeps a tombstone
   * honest, so if `libs/zero-harness` is ever re-added the doc's "it was deleted"
   * sentence reds instead of quietly becoming false.
   */
  | 'deleted';

export interface GatedSurfaceClaim {
  kind: 'gated';
  /** The property name in `FLAGS`, not its wire value. */
  flagKey: string;
  /** The default the document claims for the named flag. */
  defaultValue: boolean;
}

/** The live flag registry used to verify a GATED claim. */
export interface FlagRegistry {
  /** `FLAGS` from `libs/flags/src/types.ts` (property name → wire value). */
  flags: Readonly<Record<string, string>>;
  /** `FLAG_DEFAULTS` from `libs/flags/src/types.ts` (wire value → default). */
  defaults: Readonly<Record<string, boolean>>;
}

export interface SurfaceViolation {
  line: number;
  text: string;
  claim: SurfaceClaim;
  message: string;
}

export interface SurfaceJudgement {
  violations: SurfaceViolation[];
  /** spans present in the doc with no entry in the classification table */
  unclassified: SurfaceSpan[];
  /** classification keys that no longer appear in the doc */
  stale: string[];
}

/**
 * Compare each judged span against how the caller says the doc means it.
 *
 * Every claim must RESOLVE — a doc pointing at a location that does not exist is a
 * defect whichever way it is classified. Beyond that: `retired` must sit entirely
 * under `_retired/`; `live` must resolve to at least one location that does not;
 * `retired-in-place` asserts existence only (see the type's HONEST BOUND); and
 * `gated` must resolve to live code whose named flag exists with the stated default.
 */
export function judgeRetiredSurfaceClaims(
  extraction: RetiredSurfaceExtraction,
  classification: Record<string, SurfaceClaim>,
  flagRegistry?: FlagRegistry,
): SurfaceJudgement {
  const violations: SurfaceViolation[] = [];
  const unclassified: SurfaceSpan[] = [];
  const seen = new Set<string>();

  for (const span of extraction.judged) {
    const claim = classification[span.text];
    if (!claim) {
      unclassified.push(span);
      continue;
    }
    seen.add(span.text);

    if (claim === 'deleted') {
      if (span.resolvesTo.length > 0) {
        violations.push({
          line: span.line,
          text: span.text,
          claim,
          message:
            `\`${span.text}\` is described as DELETED, but it resolves to ` +
            `${span.resolvesTo.join(', ')}. The tombstone is stale — it came back.`,
        });
      }
      continue;
    }

    if (span.resolvesTo.length === 0) {
      violations.push({
        line: span.line,
        text: span.text,
        claim,
        message:
          `\`${span.text}\` resolves to NOTHING in the repo — the doc points at a ` +
          `location that does not exist. Delete the entry, or fix the path.`,
      });
      continue;
    }

    if (typeof claim === 'object' && claim.kind === 'gated') {
      if (!flagRegistry) {
        violations.push({
          line: span.line,
          text: span.text,
          claim,
          message:
            `\`${span.text}\` is marked GATED by flag key \`${claim.flagKey}\`, but no ` +
            `flag registry was supplied. Pass FLAGS + FLAG_DEFAULTS so the claim is checked.`,
        });
      } else {
        const wireValue = flagRegistry.flags[claim.flagKey];
        const hasDefault =
          typeof wireValue === 'string' &&
          Object.prototype.hasOwnProperty.call(flagRegistry.defaults, wireValue);
        if (!hasDefault) {
          violations.push({
            line: span.line,
            text: span.text,
            claim,
            message:
              `\`${span.text}\` is marked GATED by flag key \`${claim.flagKey}\`, but ` +
              `that key is absent from FLAGS or has no FLAG_DEFAULTS entry.`,
          });
        } else {
          const actualDefault = flagRegistry.defaults[wireValue];
          if (actualDefault !== claim.defaultValue) {
            violations.push({
              line: span.line,
              text: span.text,
              claim,
              message:
                `\`${span.text}\` says GATED flag \`${claim.flagKey}\` defaults ` +
                `${claim.defaultValue ? 'ON' : 'OFF'}, but FLAG_DEFAULTS resolves it to ` +
                `${actualDefault ? 'ON' : 'OFF'}.`,
            });
          }
        }
      }

      if (span.retiredOnDisk) {
        violations.push({
          line: span.line,
          text: span.text,
          claim,
          message:
            `\`${span.text}\` is marked GATED but every resolution is under ` +
            `\`_retired/\`: ${span.resolvesTo.join(', ')}. A gated claim must point ` +
            `to code that remains live, even when its mount is disabled.`,
        });
      }
      continue;
    }

    // `retired-in-place` asserts existence only — and it just did, above.
    if (claim === 'retired-in-place') continue;

    if (claim === 'retired' && !span.retiredOnDisk) {
      const live = span.resolvesTo.filter((p) => !isRetiredPath(p));
      violations.push({
        line: span.line,
        text: span.text,
        claim,
        message:
          `\`${span.text}\` is listed as RETIRED but resolves to a LIVE tree ` +
          `location: ${live.join(', ')}. A live surface listed as retired tells ` +
          `every agent not to test it, not to wire to it, and not to revive it ` +
          `without an ask — i.e. the doc suppresses work on shipping code. Either ` +
          `move it under a \`_retired/\` directory, or correct the doc.`,
      });
      continue;
    }

    if (claim === 'live' && span.retiredOnDisk) {
      violations.push({
        line: span.line,
        text: span.text,
        claim,
        message:
          `\`${span.text}\` is named as a LIVE counter-example but every ` +
          `resolution is under \`_retired/\`: ${span.resolvesTo.join(', ')}. ` +
          `It was retired without updating the doc.`,
      });
    }
  }

  // ── the roster leg needs no classification: position IS the claim ──
  for (const r of extraction.roster) {
    if (r.retiredOnDisk) continue;
    const live = r.resolvesTo.filter((p) => !isRetiredPath(p));
    violations.push({
      line: r.line,
      text: r.name,
      claim: 'retired',
      message:
        `\`${r.name}\` is listed as living in \`${r.location}\` but resolves to a ` +
        `LIVE tree location: ${live.join(', ')}. A live surface listed as retired ` +
        `tells every agent not to test it, not to wire to it, and not to revive it ` +
        `without an ask — i.e. the doc suppresses work on shipping code. Either ` +
        `move it under \`${r.location}\`, or correct the doc.`,
    });
  }

  return {
    violations,
    unclassified,
    stale: Object.keys(classification).filter((k) => !seen.has(k)),
  };
}
