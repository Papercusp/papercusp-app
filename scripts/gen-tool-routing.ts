/**
 * gen-tool-routing.ts — project the audited bash→tool substitution pairs into the
 * CLAUDE.md routing table and both zero-import hook prefilters
 * (plan `bash-to-tool-substitution-2026-07-26`, P-019).
 *
 *   npm run gen:tool-routing          # update docs plus both hook head sets
 *   npm run gen:tool-routing:check    # fail (exit 1) if any projection is stale
 *
 * This file is only the I/O shell. All the rendering — and every decision about
 * what may appear in the table — lives in
 * `packages/operator-core/lib/bash-substitution/routing-table.ts`, so it is unit
 * testable without touching the filesystem and so the dependency runs
 * `scripts/ → packages/` and never the reverse.
 *
 * SOURCE OF TRUTH, and why this does not contradict D-002. D-002 makes
 * `harness_shared.bash_tool_substitutions` the runtime source both PreToolUse
 * hooks read. But nothing hand-authors those rows: `seed.ts` DERIVES every one
 * from `ALL_PAIRS` plus the committed corpus fixtures, and refuses a row whose
 * recorded verdict it cannot re-derive. The pairs are therefore UPSTREAM of the
 * table, and generating from them means the prose, the seeded rows, and the
 * enforcement all descend from the same artifact.
 *
 * The pairs remain the deterministic build input, but the generated block is a
 * part of the composed `claude-md` document. The write path therefore goes
 * through `set-doc-part.ts` (which validates and records the part row) and then
 * `project-doc-parts.mjs` (which is the only writer of `CLAUDE.md`/`AGENTS.md`).
 *
 * `--check` compares the rendered block with the canonical part row and derives
 * both hook head sets from `BASH_GATE_PAIRS` plus their frozen fixtures, so a
 * projected file cannot mask a database-side change and a new command head
 * cannot silently miss one hook. A row inserted DIRECTLY into the runtime
 * substitution table with a novel `intent_label` remains the separate
 * registry-drift concern documented by `registry-drift.ts`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPairFixtures } from '../packages/operator-core/lib/bash-substitution/corpus';
import { ALL_PAIRS, BASH_GATE_PAIRS } from '../packages/operator-core/lib/bash-substitution/pairs';
import {
  deriveSubstitutionPrefilterHeads,
  renderRoutingBlock,
  renderShellPrefilterHeads,
  renderTsPrefilterHeads,
  SHELL_PREFILTER_BEGIN_MARKER,
  SHELL_PREFILTER_END_MARKER,
  spliceGeneratedRegion,
  TS_PREFILTER_BEGIN_MARKER,
  TS_PREFILTER_END_MARKER,
} from '../packages/operator-core/lib/bash-substitution/routing-table';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOC_ID = 'claude-md';
const ROUTING_PART_KEY = 'reaching-for-bash-these-read-begin-generated-gen';
const SET_DOC_PART = join(REPO_ROOT, 'scripts/set-doc-part.ts');
const PROJECT_DOC_PARTS = join(REPO_ROOT, 'scripts/project-doc-parts.mjs');
const TS_PREFILTER_FILE = join(REPO_ROOT, 'apps/operator/scripts/hooks/omp/coord-hook.ts');
const SHELL_PREFILTER_FILE = join(
  REPO_ROOT,
  'apps/operator/scripts/hooks/cc/pretooluse-bash-resource-gate.sh',
);
const CHECK = process.argv.includes('--check');

function nodeScript(script: string, args: string[], input?: string): string {
  return execFileSync(process.execPath, ['--import', 'tsx', script, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    input,
    stdio: input === undefined ? ['ignore', 'pipe', 'inherit'] : ['pipe', 'inherit', 'inherit'],
  });
}

function readCanonicalRoutingPart(): string {
  return nodeScript(SET_DOC_PART, [
    "--doc-id",
    DOC_ID,
    "--part-key",
    ROUTING_PART_KEY,
    "--show",
  ]);
}

function writeCanonicalRoutingPart(body: string): void {
  nodeScript(
    SET_DOC_PART,
    ['--doc-id', DOC_ID, '--part-key', ROUTING_PART_KEY, '--body-stdin', '--write'],
    body,
  );
}

function projectCanonicalDocs(): void {
  nodeScript(PROJECT_DOC_PARTS, ['--write']);
}

interface FileProjection {
  label: string;
  path: string;
  current: string;
  expected: string;
}

/** Render both zero-import hook projections from the same audited fixture set. */
function prefilterProjections(): FileProjection[] {
  const heads = deriveSubstitutionPrefilterHeads(loadPairFixtures(BASH_GATE_PAIRS));
  const tsCurrent = readFileSync(TS_PREFILTER_FILE, 'utf8');
  const shellCurrent = readFileSync(SHELL_PREFILTER_FILE, 'utf8');

  return [
    {
      label: 'OMP TypeScript substitution prefilter',
      path: TS_PREFILTER_FILE,
      current: tsCurrent,
      expected: spliceGeneratedRegion(
        tsCurrent,
        TS_PREFILTER_BEGIN_MARKER,
        TS_PREFILTER_END_MARKER,
        renderTsPrefilterHeads(heads),
        'OMP TypeScript substitution prefilter',
      ),
    },
    {
      label: 'Claude shell substitution prefilter',
      path: SHELL_PREFILTER_FILE,
      current: shellCurrent,
      expected: spliceGeneratedRegion(
        shellCurrent,
        SHELL_PREFILTER_BEGIN_MARKER,
        SHELL_PREFILTER_END_MARKER,
        renderShellPrefilterHeads(heads),
        'Claude shell substitution prefilter',
      ),
    },
  ];
}

function main(): void {
  // Derive every output before writing any of them. A missing fixture or marker
  // therefore fails loudly without leaving a half-projected source tree.
  const expectedRouting = renderRoutingBlock(ALL_PAIRS);
  const currentRouting = readCanonicalRoutingPart();
  const projections = prefilterProjections();
  const routingStale = currentRouting !== expectedRouting;
  const stalePrefilters = projections.filter(({ current, expected }) => current !== expected);

  if (!routingStale && stalePrefilters.length === 0) {
    process.stdout.write('✓ canonical CLAUDE.md routing part and substitution prefilters are up to date\n');
    if (!CHECK) projectCanonicalDocs();
    return;
  }
  if (CHECK) {
    const stale = [
      ...(routingStale ? ['canonical CLAUDE.md routing part'] : []),
      ...stalePrefilters.map(({ label }) => label),
    ];
    process.stderr.write(
      '✗ generated tool-routing projections are stale — run `npm run gen:tool-routing`\n' +
        stale.map((label) => `  - ${label}\n`).join('') +
        '  (the audited pairs changed; the docs and both zero-import hook prefilters must follow them)\n',
    );
    process.exit(1);
  }

  if (routingStale) writeCanonicalRoutingPart(expectedRouting);
  for (const { path, current, expected } of stalePrefilters) {
    if (current !== expected) writeFileSync(path, expected, 'utf8');
  }
  projectCanonicalDocs();
  process.stdout.write('✓ updated and projected tool routing docs and substitution prefilters\n');
}

main();
