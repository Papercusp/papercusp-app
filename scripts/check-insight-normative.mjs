#!/usr/bin/env node
/**
 * check-insight-normative.mjs — fail-loud guard for the normative-insight
 * frontmatter contract (unified-agent-state-plane-2026-07-27 P-022, per D-028).
 *
 * An agent-insight that declares `normative: true` is asserting "I am a
 * CONVENTION, not an explanation" — something that can be violated, and so
 * something a downstream projector/guard can act on. This guard enforces the
 * one rule that makes that marker meaningful:
 *
 *     normative: true  ⇒  governs: <trigger/surface> is REQUIRED
 *
 * Without `governs:`, a doc claims to be a rule while leaving unstated WHEN it
 * is in force — which is worse than not marking it at all, since it inflates
 * the adoption denominator with an entry nothing can act on.
 *
 *   npm run lint:insight-normative
 *
 * (Run via `tsx`, not bare `node` — it imports a .ts detector that node's bare
 * ESM resolver cannot load; the same is true of its sibling
 * check-insight-citations.mjs.)
 *
 * The rule is NOT "every insight must be marked": an unmarked doc is simply
 * explanatory, which is the corpus default and always passes. Scope + detection
 * are shared modules (`insight-corpus.ts` / `insight-normative.ts`) so this
 * guard, the sibling citations guard, and the unit tests can never disagree.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  findNormativeViolations,
  formatNormativeViolations,
} from '../packages/operator-core/lib/content-lint/insight-normative';
import { isInsightDoc } from '../packages/operator-core/lib/content-lint/insight-corpus';
import { describeUnscanned, listFilesIncludingUntracked } from './lib/tracked-files.mjs';

export { findNormativeViolations, formatNormativeViolations };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function main() {
  // EI-19372547555251881: validate a newly-authored insight before git-sync has
  // tracked it. The shared enumerator preserves ignored-file semantics, descends
  // into checked-out submodules, and reports any subtree it could not inspect.
  const scan = listFilesIncludingUntracked(ROOT);

  const offenders = [];
  let scanned = 0;
  let normative = 0;
  for (const f of scan.files) {
    if (!isInsightDoc(f)) continue;
    let text;
    try {
      text = readFileSync(new URL(f, `file://${ROOT}/`), 'utf8');
    } catch {
      continue;
    }
    scanned++;
    if (/^normative:[ \t]*true[ \t]*$/im.test(text)) normative++;
    const msg = formatNormativeViolations(findNormativeViolations(text));
    if (msg) offenders.push(`${f}  ${msg}`);
  }

  if (offenders.length === 0) {
    console.log(
      `✓ normative-insight frontmatter valid — ${normative} normative of ${scanned} selected tracked/untracked-not-ignored agent-insight doc(s).` +
        describeUnscanned(scan, ROOT),
    );
    process.exit(0);
  }

  console.error('✗ invalid normative-insight frontmatter.');
  console.error('  A doc marked `normative: true` MUST also declare `governs:` — the trigger or');
  console.error('  surface the convention applies to (what an agent is doing when it binds).');
  console.error('  If the doc is explanatory rather than a rule, drop `normative:` instead.\n');
  for (const o of offenders) console.error('    ' + o);
  console.error(`\n  ${offenders.length} offender(s). See plan unified-agent-state-plane-2026-07-27 (P-022 / D-028).`);
  process.exit(1);
}

// Run only as the entry point — importing the detector for reuse has no side effects.
const invokedPath = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '';
if (import.meta.url === invokedPath) main();
