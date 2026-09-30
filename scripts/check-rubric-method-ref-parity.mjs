#!/usr/bin/env node
/**
 * check-rubric-method-ref-parity.mjs — fail-loud guard for the rubrics/<id>/METHOD.md
 * ⇄ operator-docs agent-insights mdx drift trap (EI-8795).
 *
 * A rubric's `method_ref` (the free-form "how to run this grading exercise" doc that
 * the structured criteria in the `rubrics` store can't hold) is authored as TWO
 * hand-synced copies with no generation link:
 *   - rubrics/<id>/METHOD.md          — the repo-native copy, edited directly.
 *   - apps/operator-docs/src/content/docs/agent-insights/<id>.mdx
 *                                      — frontmatter + the SAME body, served via
 *                                        docs:search/docs:get, which is what a grader
 *                                        actually reads at runtime.
 *
 * On 2026-07-09 (WI-3456) an author updated only METHOD.md (21 criteria), leaving the
 * served mdx a version behind (12 criteria) — caught and fixed a turn later (WI-3479)
 * by hand-diffing the two. Any future edit to just one side reproduces the same silent
 * drift with no signal until a grader notices the served page looks stale.
 *
 * This is the durable guard, not a full generation pipeline (the mdx also carries
 * Starlight frontmatter METHOD.md has no home for, so "generate one from the other at
 * build time" needs a real seam in apps/operator-docs' build — left as a future
 * refinement; EI-8795's own interim-guard suggestion is exactly this: name the paired
 * edit as a hard requirement, backed by a check that actually enforces it). For every
 * rubrics/<id>/METHOD.md, the corresponding mdx body (frontmatter stripped) MUST be
 * byte-identical to METHOD.md's content. A rubric with a METHOD.md but no paired mdx
 * (or vice versa) is also flagged — the pairing itself must be complete.
 *
 *   node scripts/check-rubric-method-ref-parity.mjs
 *
 * Exits 1 (prints every drifted/missing pair) on any mismatch; 0 when every pair
 * matches (or there are currently no METHOD.md files at all — nothing to enforce yet).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUBRICS_DIR = join(ROOT, 'rubrics');
const INSIGHTS_DIR = join(ROOT, 'apps/operator-docs/src/content/docs/agent-insights');

/** Strip a leading `---\n...\n---\n` YAML frontmatter block, if present. */
function stripFrontmatter(raw) {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(raw);
  return m ? raw.slice(m[0].length) : raw;
}

/**
 * Returns { ok, offenders } — offenders is an array of human-readable strings, one
 * per drifted or incomplete pair. Pure (fs reads only); safe to import + call directly.
 */
export function checkRubricMethodRefParity() {
  const offenders = [];
  if (!existsSync(RUBRICS_DIR)) return { ok: true, offenders };

  const rubricIds = readdirSync(RUBRICS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((id) => existsSync(join(RUBRICS_DIR, id, 'METHOD.md')));

  for (const id of rubricIds) {
    const methodPath = join(RUBRICS_DIR, id, 'METHOD.md');
    const mdxPath = join(INSIGHTS_DIR, `${id}.mdx`);
    const methodBody = readFileSync(methodPath, 'utf8');

    if (!existsSync(mdxPath)) {
      offenders.push(
        `${id}: rubrics/${id}/METHOD.md exists but apps/operator-docs/.../agent-insights/${id}.mdx is missing — ` +
          `docs:search/docs:get (what a grader actually reads) has nothing to serve.`,
      );
      continue;
    }

    const mdxRaw = readFileSync(mdxPath, 'utf8');
    const mdxBody = stripFrontmatter(mdxRaw);
    if (mdxBody !== methodBody) {
      offenders.push(
        `${id}: rubrics/${id}/METHOD.md and agent-insights/${id}.mdx have DRIFTED — ` +
          `the served copy no longer matches the repo-native one. Re-sync (copy METHOD.md's ` +
          `content as the mdx body, keeping its frontmatter) before this rubric is next graded.`,
      );
    }
  }

  return { ok: offenders.length === 0, offenders };
}

function main() {
  const { ok, offenders } = checkRubricMethodRefParity();
  if (ok) {
    console.log('✓ every rubric METHOD.md ⇄ agent-insights mdx pair matches (or none exist yet).');
    process.exit(0);
  }
  console.error('✗ rubric method_ref drift (EI-8795) — a METHOD.md and its served mdx twin disagree:\n');
  for (const o of offenders) console.error('    ' + o);
  console.error(`\n  ${offenders.length} offender(s).`);
  process.exit(1);
}

// Run only as the entry point — importing the detector for reuse has no side effects.
const invokedPath = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '';
if (import.meta.url === invokedPath) main();
