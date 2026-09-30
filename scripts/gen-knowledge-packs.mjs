#!/usr/bin/env node
/**
 * gen-knowledge-packs — sync shared knowledge-pack item files from their
 * canonical pack (EI-18121649240446176: coding ↔ papercusp-default were
 * byte-identical hand-maintained copies, and work/ shares six files — a
 * silent-drift trap).
 *
 * The single source of truth for WHAT is shared is
 * `libs/papercusp/packages/harness/knowledge-packs/sync-map.json`, colocated
 * with the packs (the loader only scans directories, so the file is inert at
 * runtime). Semantics:
 *   - mirror: "all"      → the mirror's item set becomes EXACTLY the canonical
 *                          set (missing files copied, extra .md files removed);
 *   - mirror: [ids...]   → only those items are kept byte-identical; the rest
 *                          of the mirror is owned by the mirror (including
 *                          deliberately adapted variants of canonical ids).
 * manifest.yaml is never synced — each pack keeps its own identity.
 *
 *   npm run gen:knowledge-packs           # write mode (idempotent)
 *   npm run gen:knowledge-packs:check     # CI-style: exit 1 on any drift
 *
 * The same invariant is asserted at the test gate by
 * packages/operator-core/lib/knowledge-packs/pack-sync.test.ts.
 */
import { readFileSync, readdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const packsRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', 'libs', 'papercusp', 'packages', 'harness', 'knowledge-packs',
);
const check = process.argv.includes('--check');

const map = JSON.parse(readFileSync(join(packsRoot, 'sync-map.json'), 'utf8'));
const canonicalDir = join(packsRoot, map.canonical);
const canonicalItems = readdirSync(canonicalDir).filter((f) => f.endsWith('.md')).sort();

let drift = 0;
const report = (action, rel) => {
  drift += 1;
  console.log(`${check ? 'DRIFT' : action}: ${rel}`);
};

for (const [mirror, spec] of Object.entries(map.mirrors)) {
  const mirrorDir = join(packsRoot, mirror);
  const wanted = spec === 'all' ? canonicalItems : spec.map((id) => `${id}.md`);

  for (const file of wanted) {
    const src = join(canonicalDir, file);
    if (!existsSync(src)) {
      console.error(`sync-map lists ${map.canonical}/${file} but it does not exist`);
      process.exitCode = 1;
      continue;
    }
    const body = readFileSync(src, 'utf8');
    const dst = join(mirrorDir, file);
    if (!existsSync(dst) || readFileSync(dst, 'utf8') !== body) {
      report('write', `${mirror}/${file}`);
      if (!check) writeFileSync(dst, body);
    }
  }

  if (spec === 'all') {
    for (const extra of readdirSync(mirrorDir).filter((f) => f.endsWith('.md'))) {
      if (!canonicalItems.includes(extra)) {
        report('remove', `${mirror}/${extra}`);
        if (!check) rmSync(join(mirrorDir, extra));
      }
    }
  }
}

if (drift === 0) {
  console.log(`in sync: ${Object.keys(map.mirrors).join(', ')} ← ${map.canonical}`);
} else if (check) {
  console.error(`\n${drift} file(s) out of sync — run: npm run gen:knowledge-packs`);
  process.exitCode = 1;
}
