/**
 * Dead-citation sweep — the ATTEST-tier leg of "hand-maintained operator documentation and
 * metadata lack machine-checked claim synchronization" (EI-21894865709918325).
 *
 * WHY THIS EXISTS
 * ----------------
 * A work-item id cited in a comment or a JSON metadata note (e.g. "see EI-19375134577577530") is
 * accepted with no check that the id was ever real. Measured 2026-08-30 (EI-21893190244110512):
 * `scripts/lint-tsc-operator.mjs` and `apps/operator/.tsc-baseline.json` both cite
 * EI-19375134577577530, which resolves to nothing in `harness_shared.work_items` — the trail for
 * "why isn't this wired into the gate yet, and who owns it" dead-ends silently, with no error
 * anywhere. That is the third leg of the shared root cause EI-21894865709918325 names: curated
 * documentation and metadata are written without deriving or validating the claim they carry
 * against the corpus, work-item store, or repository structure.
 *
 * WHY THIS IS A RUNTIME SWEEP, NOT A doc-claims/*.test.ts PIN
 * ------------------------------------------------------------
 * Every sibling in `packages/operator-core/lib/doc-claims/` is a STATIC, DETERMINISTIC build-time
 * check — it asserts something about the REPOSITORY that never depends on live state, so it can
 * run offline in CI. "Does this id currently exist in harness_shared.work_items" is not that kind
 * of claim: work items are created continuously in a live, shared, multi-agent database, so the
 * answer can change from one minute to the next with no code change at all — a CI-time PG
 * snapshot would be neither reproducible nor meaningful there. Per the derived-truth-ladder
 * (repo CLAUDE.md, "Code-describing metadata"), this is rung 3 — ATTEST: "what static analysis
 * can't see... reconcile against a runtime ledger on a standing sweep that files findings" — the
 * same mechanism `work-items-admission-delta-sweep.ts` already uses for a different
 * reconciliation (this module deliberately does not extend that one: admission-delta-sweep
 * clusters NEWLY ADMITTED work-items by shared root cause via an LLM call; this sweep validates
 * EXISTING prose against the live store via a plain SQL lookup — different inputs, different
 * mechanism, no shared code to reuse beyond the registration pattern).
 *
 * SCOPE
 * -----
 * "Documentation surface" here means prose the reader trusts as a live pointer: markdown/MDX
 * prose, curated JSON metadata sidecars (baseline notes, manifests — this repo's own convention,
 * not bulk data files), and source-code COMMENTS. Runtime string literals in code are DATA, not
 * claims — e.g. a `memberIds: ['WI-1', ...]` array holds real admitted ids (which resolve as
 * live), and a `.test.ts` fixture's `'WI-1'` is deliberately synthetic (which would falsely read
 * as "dead" if scanned) — see `isCitationSurfaceLine` / `isScannableCitationPath`.
 *
 * "Dead" means the id never resolves to a row in `harness_shared.work_items` at all — never
 * "closed": closed/dropped items persist in that table forever (this codebase's audit trail
 * depends on it), so a closed-but-real id is correctly treated as LIVE by this sweep. A citation
 * flagged here is a CANDIDATE for its own fix, exactly like `scripts/check-fixed-but-open.mjs`'s
 * own "report, never auto-close" discipline — this module never edits the cited file.
 *
 * This is the pure, dependency-injected core (no direct fs/PG access, so it is a plain unit test
 * with no database); `dead-citation-sweep-action.ts` wires it into the routines engine as a
 * `system:` action.
 */

/** Work-item id shape. 3+ digits: shorter numbers are overwhelmingly fixture placeholders (the
 *  same floor `scripts/check-fixed-but-open.mjs` uses, for the same reason — `WI-1`/`EI-1` in a
 *  test fixture is not a real citation). */
export const CITATION_ID_RE = /\b(?:WI|EI|F)-[0-9]{3,}\b/g;

/** A line whose first non-space token opens a comment, across every language this sweep scans. */
const COMMENT_LINE_RE = /^\s*(?:\/\/|\/\*|\*|#|--|<!--)/;

/** Path fragments that mean "not a documentation claim" — fixtures, generated mirrors, vendor,
 *  and test/spec files (whose synthetic ids are deliberately not real). */
const EXCLUDED_PATH_RE =
  /(^|\/)(node_modules|dist|storybook-static|\.papercusp|__fixtures__|fixtures|__mocks__)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$/;

/** File extensions this sweep treats as documentation/metadata surfaces at all. */
const SCANNABLE_EXT_RE = /\.(md|mdx|json|ts|tsx|mjs|js|sh)$/;

/** Extensions whose prose lives in every line (not gated to comment-only) — see the module doc's
 *  SCOPE section for why .json is grouped with .md/.mdx here rather than with the code files. */
const PROSE_EXT_RE = /\.(md|mdx|json)$/;

/** Is `filePath` in scope for this sweep at all (before per-line classification)? */
export function isScannableCitationPath(filePath: string): boolean {
  if (EXCLUDED_PATH_RE.test(filePath)) return false;
  return SCANNABLE_EXT_RE.test(filePath);
}

/**
 * Is `line` a genuine documentation CLAIM in `filePath`, as opposed to runtime/test DATA that
 * happens to contain an id-shaped token? Prose files (.md/.mdx/.json) count every line — see the
 * module doc's SCOPE section. Code files count only comment lines, so a real `memberIds` array or
 * a test fixture's synthetic id is never mistaken for a claim someone is trusting as a pointer.
 */
export function isCitationSurfaceLine(filePath: string, line: string): boolean {
  if (PROSE_EXT_RE.test(filePath)) return true;
  return COMMENT_LINE_RE.test(line);
}

export interface CitationCandidate {
  id: string;
  file: string;
  line: number;
  text: string;
}

/**
 * Extract citation candidates from one file's content. `filePath` should already have passed
 * `isScannableCitationPath`; this function does not re-check it (callers own that filter so a
 * single unfiltered call site cannot silently widen scope).
 */
export function extractCitationCandidates(filePath: string, content: string): CitationCandidate[] {
  const out: CitationCandidate[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!isCitationSurfaceLine(filePath, line)) continue;
    const ids = line.match(CITATION_ID_RE);
    if (!ids) continue;
    for (const id of new Set(ids)) {
      out.push({ id, file: filePath, line: i + 1, text: line.trim().slice(0, 160) });
    }
  }
  return out;
}

export interface DeadCitation {
  id: string;
  citationCount: number;
  samples: Array<{ file: string; line: number; text: string }>;
}

export interface DeadCitationSweepDeps {
  /** List tracked, in-scope file paths (repo-relative), e.g. via `git ls-files`. May include
   *  out-of-scope paths — `runDeadCitationSweep` re-filters with `isScannableCitationPath`. */
  listFiles: () => Promise<string[]> | string[];
  /** Read one file's content by a path `listFiles` returned. */
  readFile: (filePath: string) => Promise<string> | string;
  /** Resolve which of `ids` currently exist in `harness_shared.work_items` (any status). */
  liveIds: (ids: string[]) => Promise<Set<string>>;
}

export interface DeadCitationSweepResult {
  scannedFiles: number;
  citedIds: number;
  deadCitations: DeadCitation[];
}

/** Cap on sample locations recorded per dead id — enough to act on, never the full citation list
 *  (a heavily-mirrored doc can cite the same dead id from dozens of built/mirrored copies). */
const MAX_SAMPLES_PER_ID = 3;

export async function runDeadCitationSweep(deps: DeadCitationSweepDeps): Promise<DeadCitationSweepResult> {
  const files = (await deps.listFiles()).filter(isScannableCitationPath);
  const byId = new Map<string, CitationCandidate[]>();
  for (const file of files) {
    const content = await deps.readFile(file);
    for (const c of extractCitationCandidates(file, content)) {
      const list = byId.get(c.id);
      if (list) list.push(c);
      else byId.set(c.id, [c]);
    }
  }
  const ids = [...byId.keys()];
  const live = ids.length > 0 ? await deps.liveIds(ids) : new Set<string>();
  const deadCitations: DeadCitation[] = [];
  for (const id of ids) {
    if (live.has(id)) continue;
    const all = byId.get(id)!;
    deadCitations.push({
      id,
      citationCount: all.length,
      samples: all.slice(0, MAX_SAMPLES_PER_ID).map(({ file, line, text }) => ({ file, line, text })),
    });
  }
  deadCitations.sort((a, b) => a.id.localeCompare(b.id));
  return { scannedFiles: files.length, citedIds: ids.length, deadCitations };
}

/** Cap on how many dead citations are itemized in a filed improvement's body — a rollup, not an
 *  exhaustive dump; the routine's own log line (see the action) always carries the true count. */
const MAX_ITEMIZED_DEAD_CITATIONS = 30;

/** Render a dead-citation-sweep result as an improvement body. This is evidence, never a verdict —
 *  see the module doc: it never asserts WHY an id is dead, only that no row resolves it. */
export function renderDeadCitationSweepBody(result: DeadCitationSweepResult): string {
  const lines: string[] = [];
  lines.push(
    `Scanned ${result.scannedFiles} tracked documentation/metadata files (md/mdx/json prose + ` +
      `source comments) and found ${result.citedIds} distinct work-item id citations, of which ` +
      `${result.deadCitations.length} resolve to no row in harness_shared.work_items.`,
  );
  lines.push('');
  const shown = result.deadCitations.slice(0, MAX_ITEMIZED_DEAD_CITATIONS);
  for (const d of shown) {
    lines.push(`- ${d.id} (cited ${d.citationCount}x):`);
    for (const s of d.samples) lines.push(`    ${s.file}:${s.line}  ${s.text}`);
  }
  if (result.deadCitations.length > shown.length) {
    lines.push(`… ${result.deadCitations.length - shown.length} more dead citation(s), not itemized here.`);
  }
  lines.push('');
  lines.push(
    'A dead citation here means the id resolves to NOTHING in harness_shared.work_items right ' +
      'now — not that it was closed or dropped (closed items persist forever). Fix each by ' +
      'correcting or removing the stale reference at its cited location(s); this item is filed ' +
      'by the dead-citation-sweep system action and is re-evaluated on its next scheduled run.',
  );
  return lines.join('\n');
}

/** Stable identity for the periodic filing, so re-runs coalesce onto one standing item instead of
 *  filing a fresh one every fire (matches `work-item-admission-delta-sweep-action.ts`'s pattern of
 *  a per-harness, stable `watchdogKey`). */
export function deadCitationSweepWatchdogKey(harnessSlug: string): string {
  return `dead-citation-sweep:${harnessSlug}`;
}
