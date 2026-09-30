#!/usr/bin/env node
// One-shot scaffolder: drops vitest.config.ts + TESTING.md into workspaces
// that don't have them yet. Idempotent — skips files that already exist.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TARGETS = [
  { dir: 'libs/papercusp-db',                summary: 'Drizzle schema for the papercup app DB.' },
  { dir: 'libs/zero-harness',               summary: 'Zero schemas + permissions for harness sync.' },
  { dir: 'libs/agent-chat',                 summary: 'Reusable agent chat React component.' },
  { dir: 'libs/generic/git-graph',                  summary: 'Git graph rendering helpers.' },
  { dir: 'libs/generic/ui-primitives',              summary: 'Shared UI primitives (buttons, dialogs, etc.).' },
  { dir: 'libs/generic/papergrid/grid',             summary: 'High-level RichGrid + GridTable wrappers.' },
  { dir: 'libs/generic/papergrid/grid-core',        summary: 'Low-level grid primitives.' },
  { dir: 'libs/papercusp/packages/harness', summary: 'Harness runtime primitives.' },
  { dir: 'libs/papercusp/libs/db',          summary: 'Org-DB Drizzle helpers used by the harness.' },
];

const VITEST_CONFIG = `import { defineVitestConfig } from '@papercusp/test-config';

export default defineVitestConfig({ layer: 'unit' });
`;

function testingMd(name, summary) {
  return `# TESTING — ${name}

## What this project's tests cover

- (none yet) — drop \`*.test.ts\` files alongside source and they'll be
  picked up by \`npm test\`.

## What they don't cover

- ${summary}
- Browser flows — verified ad-hoc via the \`verdict\` skill.

## Run after editing

| Edit touches                        | Run                                                   |
| ----------------------------------- | ----------------------------------------------------- |
| Anything in this workspace          | \`npm test --workspace ${name}\`                       |
| Code that other workspaces depend on| \`npm run test:affected\` from repo root               |

See repo-root \`CLAUDE.md\` for the full testing strategy.
`;
}

let touched = 0;

for (const { dir, summary } of TARGETS) {
  const pkgPath = join(ROOT, dir, 'package.json');
  if (!existsSync(pkgPath)) {
    console.log(`skip ${dir} — no package.json`);
    continue;
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  let changed = false;

  pkg.scripts ??= {};
  if (!pkg.scripts.test) {
    pkg.scripts.test = 'vitest run --passWithNoTests';
    changed = true;
  }
  pkg.devDependencies ??= {};
  if (!pkg.devDependencies['@papercusp/test-config']) {
    pkg.devDependencies['@papercusp/test-config'] = '*';
    changed = true;
  }
  if (!pkg.devDependencies.vitest) {
    pkg.devDependencies.vitest = '^4.1.4';
    changed = true;
  }
  if (changed) {
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    console.log(`  pkg ${dir}/package.json — updated`);
    touched++;
  }

  const cfgPath = join(ROOT, dir, 'vitest.config.ts');
  if (!existsSync(cfgPath)) {
    writeFileSync(cfgPath, VITEST_CONFIG);
    console.log(`  cfg ${dir}/vitest.config.ts — created`);
    touched++;
  }

  const tmdPath = join(ROOT, dir, 'TESTING.md');
  if (!existsSync(tmdPath)) {
    writeFileSync(tmdPath, testingMd(pkg.name, summary));
    console.log(`  doc ${dir}/TESTING.md — created`);
    touched++;
  }
}

console.log(`\n${touched} files touched.`);
