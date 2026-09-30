/**
 * The blueprint-less fallback spine: what a harness with no `.papercusp/blueprint.yaml`
 * actually runs, and whether the code that documents it still tells the truth.
 *
 * ── Why this guard exists ──
 *
 * On 2026-07-20 (commit 33d1bac9f4, owner-directed) the no-blueprint fallback was
 * repointed off the RETIRED `coding-factory` (decider `director`, the full NEXT_* verb
 * vocabulary) onto `coding-solo` — which is, by its own blueprint header, BASELINE A of
 * the impartial-benchmark suite: "the coding harness with the MULTI-AGENT SPINE COLLAPSED
 * TO A SINGLE WORKER … the ONLY difference is orchestration OFF". Decider `worker`; edges
 * inherited from `single-agent` are DONE/ESCALATE/IDLE only.
 *
 * The repoint itself is not in question. What went wrong is that it changed behaviour
 * SILENTLY — no error, no warning — and the prose describing the old behaviour stayed
 * put. Five DBOS durability tests had encoded the old default WITHOUT NAMING IT (they
 * passed no spine, so they inherited whatever the fallback was); they went red together
 * on 2026-07-21 and read as five unrelated durability bugs for three weeks
 * (EI-20631691687347174). Meanwhile three separate comment sites went on describing the
 * fallback as the built-in `coding` spine and as "behavior-preserving" — both false —
 * and one justified NOT hard-blocking on the grounds that the affected population was
 * "unknown, possibly large" (WI-39505 measured it: 44 of 107 registered projects).
 *
 * A test that inherits a runtime default silently asserts that default. So does a doc
 * comment. This module makes the assertion EXPLICIT and therefore falsifiable.
 *
 * ── What this module pins ──
 *
 * Anchored to PROPERTIES, not to the spelling `coding-solo` — a legitimate future
 * repoint should make this guard fail LOUDLY and be fixed by updating the prose in the
 * same change, not by editing an expected string here:
 *
 *   1. AGREEMENT — the two fallback loaders (`codingSpine()` in orchestrator-workflow.ts
 *      and `codingFallback()` in blueprint-run-action.ts) load the SAME builtin blueprint.
 *      They are documented as mirroring each other; a silent divergence would mean the
 *      DBOS pipeline and the scheduled decider-fire disagree about what a blueprint-less
 *      harness runs.
 *   2. NAMED — every documenting site names the blueprint the code ACTUALLY loads. This
 *      is the drift trip-wire: repoint the loader and the stale prose fails here.
 *   3. NOT CLAIMED BEHAVIOR-PRESERVING — no site may describe the blueprint-less fallback
 *      as behavior-preserving. It is an orchestration-OFF ablation arm; that phrase is
 *      what made the change invisible for three weeks. Deliberately scoped to comment
 *      lines that are ABOUT the fallback, so unrelated true uses of the phrase (e.g. the
 *      maxTurns env-override note) are not caught.
 *
 * ⚠ STATED BOUND: comment/code separation here is textual, not a TS parse — sufficient
 * because every property above is about `loadBuiltinBlueprint(...)` argv and comment
 * prose, but a `//`-bearing string literal could in principle be misclassified. It fails
 * OPEN (a misread line can only ADD a finding), and the fixture controls below would
 * catch an over-fire.
 */

/** A documenting site: a source file that describes the blueprint-less fallback. */
export interface FallbackDocSite {
  /** Short label used in violation messages (usually the file's basename). */
  file: string;
  source: string;
}

export interface FallbackLoaderSite {
  file: string;
  source: string;
}

export interface BlueprintlessFallbackVerdict {
  /** Builtin blueprint id loaded at each fallback loader, by file. */
  loadedBy: Record<string, string[]>;
  /** The single agreed-upon fallback blueprint id, or null when the loaders disagree. */
  effectiveId: string | null;
  /** Doc sites that never name `effectiveId`. */
  unnamedBy: string[];
  /** Comment lines claiming the blueprint-less fallback is behavior-preserving. */
  behaviorPreservingClaims: { file: string; line: number; text: string }[];
  violations: string[];
  ok: boolean;
}

/**
 * Strip `//` and block comments, returning the CODE-only text with line count preserved
 * so 1-based line numbers stay meaningful.
 */
export function stripComments(source: string): string {
  const noBlock = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return noBlock
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

/** The inverse: COMMENT-only text, line count preserved. */
export function commentsOnly(source: string): string {
  const lines = source.split('\n');
  const out = lines.map(() => '');
  let inBlock = false;
  lines.forEach((line, i) => {
    let acc = '';
    let rest = line;
    if (inBlock) {
      const end = rest.indexOf('*/');
      if (end === -1) {
        out[i] = rest;
        return;
      }
      acc += rest.slice(0, end);
      rest = rest.slice(end + 2);
      inBlock = false;
    }
    for (;;) {
      const blockStart = rest.indexOf('/*');
      const lineStart = rest.indexOf('//');
      if (lineStart !== -1 && (blockStart === -1 || lineStart < blockStart)) {
        acc += ` ${rest.slice(lineStart + 2)}`;
        break;
      }
      if (blockStart !== -1) {
        const end = rest.indexOf('*/', blockStart + 2);
        if (end === -1) {
          acc += ` ${rest.slice(blockStart + 2)}`;
          inBlock = true;
          break;
        }
        acc += ` ${rest.slice(blockStart + 2, end)}`;
        rest = rest.slice(end + 2);
        continue;
      }
      break;
    }
    out[i] = acc;
  });
  return out.join('\n');
}

/** Builtin blueprint ids loaded in CODE (comments cannot contribute a loader). */
function loadedBuiltins(source: string): string[] {
  const code = stripComments(source);
  const ids = new Set<string>();
  for (const m of code.matchAll(/loadBuiltinBlueprint\(\s*['"]([^'"]+)['"]\s*\)/g)) ids.add(m[1]);
  return [...ids];
}

/**
 * A comment BLOCK is ABOUT the blueprint-less fallback when any of its lines mentions the
 * fallback by name or describes the no-blueprint condition. Keeps property 3 from
 * over-firing on unrelated true uses of "behavior-preserving".
 *
 * ⚠ Scoped per BLOCK, not per LINE: the claim and its subject routinely sit on different
 * lines of the same docstring — the exact shape that was live here until 2026-08-16 said
 * "has no blueprint file" three lines above "so this is behavior-preserving". A per-line
 * detector misses it, which is what the fixture controls caught.
 */
const ABOUT_FALLBACK =
  /codingSpine|codingFallback|blueprint-less|blueprintless|no-blueprint|no blueprint|pre-blueprint|has no blueprint|fallback/i;

/** Maximal runs of consecutive lines carrying comment text. 1-based `line` per entry. */
function commentBlocks(source: string): { line: number; text: string }[][] {
  const blocks: { line: number; text: string }[][] = [];
  let current: { line: number; text: string }[] = [];
  commentsOnly(source)
    .split('\n')
    .forEach((text, i) => {
      if (text.trim() === '') {
        if (current.length) blocks.push(current);
        current = [];
        return;
      }
      current.push({ line: i + 1, text });
    });
  if (current.length) blocks.push(current);
  return blocks;
}

export function judgeBlueprintlessFallback(input: {
  loaders: FallbackLoaderSite[];
  docs: FallbackDocSite[];
}): BlueprintlessFallbackVerdict {
  const violations: string[] = [];
  const loadedBy: Record<string, string[]> = {};

  for (const l of input.loaders) {
    const ids = loadedBuiltins(l.source);
    loadedBy[l.file] = ids;
    if (ids.length === 0) {
      violations.push(
        `${l.file}: no loadBuiltinBlueprint('<id>') call found — the blueprint-less fallback loader ` +
          `moved or was renamed. Re-point this guard at it and update the prose that documents it.`,
      );
    }
  }

  // Property 1 — AGREEMENT.
  const allIds = [...new Set(Object.values(loadedBy).flat())];
  const effectiveId = allIds.length === 1 ? allIds[0] : null;
  if (allIds.length > 1) {
    violations.push(
      `the fallback loaders disagree about which builtin a blueprint-less harness runs: ` +
        Object.entries(loadedBy)
          .map(([f, ids]) => `${f} → ${ids.join(', ') || '(none)'}`)
          .join('; ') +
        `. They are documented as mirroring each other; a divergence means the DBOS pipeline and ` +
        `the scheduled decider-fire would run DIFFERENT spines for the same harness.`,
    );
  }

  // Property 2 — NAMED at every documenting site.
  const unnamedBy: string[] = [];
  if (effectiveId) {
    for (const d of input.docs) {
      if (!commentsOnly(d.source).includes(effectiveId)) {
        unnamedBy.push(d.file);
        violations.push(
          `${d.file}: documents the blueprint-less fallback but never names '${effectiveId}', the ` +
            `blueprint the code actually loads. If the fallback was just repointed, update this ` +
            `file's prose in the same change (that drift is exactly what this guard exists to catch).`,
        );
      }
    }
  }

  // Property 3 — NOT CLAIMED BEHAVIOR-PRESERVING.
  const behaviorPreservingClaims: { file: string; line: number; text: string }[] = [];
  const seen = new Set<string>();
  for (const d of [...input.docs, ...input.loaders]) {
    for (const block of commentBlocks(d.source)) {
      if (!block.some((l) => ABOUT_FALLBACK.test(l.text))) continue;
      for (const l of block) {
        if (!/behavio(u)?r-preserving/i.test(l.text)) continue;
        // A line that DENIES the claim ("NOT behavior-preserving") is the correction, not the defect.
        if (/\bnot\b|\bno longer\b|⚠/i.test(l.text)) continue;
        const key = `${d.file}:${l.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        behaviorPreservingClaims.push({ file: d.file, line: l.line, text: l.text.trim() });
      }
    }
  }
  for (const c of behaviorPreservingClaims) {
    violations.push(
      `${c.file}:${c.line}: describes the blueprint-less fallback as behavior-preserving — it is an ` +
        `orchestration-OFF ablation arm (decider 'worker', DONE/ESCALATE/IDLE only). That phrasing is ` +
        `what kept the 2026-07-20 repoint invisible for three weeks. Line: ${c.text}`,
    );
  }

  return {
    loadedBy,
    effectiveId,
    unnamedBy,
    behaviorPreservingClaims,
    violations,
    ok: violations.length === 0,
  };
}
