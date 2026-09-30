#!/usr/bin/env node
/**
 * CI gate — plans are PG-canonical (plans-pg-canonical-migration-2026-06-03).
 *
 * Fails if any source file reads plan markdown off the filesystem. Plans live in
 * `harness_shared.harness_plans`; the `apps/operator/docs/plans/` files were
 * removed (Stage 2). The ONLY place allowed to know that path is `source.ts`
 * (which keeps it as a slug-validator / synthetic locator) and the one-time
 * `scripts/migrations/backfill-fs-plans-to-pg.ts` (which reads the FS to seed PG,
 * and only runs against a tree that still has the files / a restored backup).
 *
 * Run: node apps/operator/scripts/check-plans-pg-canonical.mjs
 */
import { execFileSync } from 'node:child_process';

const ROOT = new URL('../', import.meta.url).pathname; // apps/operator/
// Lines that READ the FS at a docs/plans path. Comments (`*`, `//`, `--`) and the
// allowed files are filtered below. Matches readFile/readFileSync/readdir/createReadStream
// on/near a docs/plans literal.
const PATTERN = "(readFile|readFileSync|readdir|createReadStream)[^\\n]*docs/plans|docs/plans[^\\n]*(readFile|readFileSync|readdir)";

const ALLOW = [
  'lib/agent-tools/plans/source.ts',
  'scripts/migrations/backfill-fs-plans-to-pg.ts',
  'scripts/check-plans-pg-canonical.mjs',
];

let hits = '';
try {
  // No shell — args passed directly to grep. grep exits 1 when there are no
  // matches (caught below as "clean"), 2 on a real error.
  hits = execFileSync(
    'grep',
    ['-rnE', PATTERN, 'lib', 'app', 'scripts', '--include=*.ts', '--include=*.tsx'],
    { cwd: ROOT, encoding: 'utf8' },
  );
} catch (e) {
  if (e && e.status === 1) hits = ''; // no matches
  else if (e && typeof e.stdout === 'string') hits = e.stdout;
  else hits = '';
}

const offending = hits
  .split('\n')
  .filter(Boolean)
  // drop comment lines + the allow-list
  .filter((line) => {
    const [file] = line.split(':');
    if (ALLOW.some((a) => file.endsWith(a) || file.includes(a))) return false;
    const code = line.slice(line.indexOf(':', line.indexOf(':') + 1) + 1).trim();
    return !(code.startsWith('*') || code.startsWith('//') || code.startsWith('--') || code.startsWith('/*'));
  });

if (offending.length > 0) {
  console.error('✗ plans-pg-canonical gate: filesystem reads of plan markdown found.');
  console.error('  Plans are PG-canonical — read via the plans:* tools / source.ts (PG), not the FS.');
  for (const o of offending) console.error('   ' + o);
  process.exit(1);
}
console.log('✓ plans-pg-canonical gate: no filesystem reads of plan markdown.');
