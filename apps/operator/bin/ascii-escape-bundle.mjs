#!/usr/bin/env node
/**
 * Rewrite a built host bundle so every character is ASCII (<= U+007F), by replacing
 * each char >= U+0080 with its `\uXXXX` escape.
 *
 * WHY (WI-38221, measured 2026-08-12): V8 stores a JS string in one byte per
 * char ONLY if EVERY char is <= 0xFF; a single char above that widens the WHOLE
 * string to two-byte UTF-16.
 *
 * ⚠ For MODULE SOURCE the real threshold is ASCII, not Latin-1 (measured 2026-09-27,
 * host-memory-reduction P-005, node 25.9, .papercusp/scratch/latin1-source-probe.mjs):
 * a 40 MB ESM module holds 41 MB of external script source when pure ASCII and 81 MB
 * when ONE comment carries U+00B7 — the same as an em-dash. Node's loader decodes a
 * non-ASCII UTF-8 file straight to UTF-16. The first version of this pass escaped only
 * >= U+0100, left ~180 lines of `·` / `×` / `§` / accented letters in place, and the
 * live :3170 heap snapshot still showed the 63.5 MiB bundle held as a 127 MiB string. The host bundle carries ~9,150 such chars — 0.014%
 * of the file, and 5,017 lines of them sit in COMMENTS (em-dashes, box-drawing,
 * arrows) — which doubles the in-memory cost of all ~61 MB of source in EVERY
 * host process.
 *
 * MEASURED, decisive control: two synthetic 57 MB modules identical except ONE
 * em-dash in one comment, each loaded in a FRESH process, 2 runs each —
 * pure-ASCII 562.3/573.5 MB RSS vs em-dashed 636.1/630.2 MB. heapDelta was
 * identical (197.8 MB both), so the cost is the off-heap source string, which is
 * why a worker's `external` reads ~143 MB. On the real bundle the escape is
 * worth ~63 MB per process; combined with the targeted --external: list in
 * bundle-host.sh, a host process goes 206.2 MB -> 113.4 MB RSS (+92.8 MB each,
 * ~1.54 GB across the 17 host processes on this box).
 *
 * WHY NOT esbuild's own --charset=ascii: it escapes STRING LITERALS only and
 * does not touch comment text or template-literal content — verified on a
 * fixture, where it left the bundle two-byte and saved nothing.
 *
 * WHY THIS IS SEMANTICALLY IDENTICAL: `\uXXXX` means the same char in string
 * literals, template literals and regex literals, and in a comment it is inert
 * text. The ONE construct where it would NOT be equivalent is String.raw`...`,
 * which deliberately leaves escapes uninterpreted — so this script REFUSES the
 * rewrite if any String.raw template contains a char it would escape. (Scanned
 * 2026-08-12 on the live bundle: 57 String.raw sites, 0 of them affected.)
 *
 * SAFETY POSTURE: never fail the build. A host that boots on an UN-escaped
 * bundle is completely correct — just fatter. So every failure path here leaves
 * the input file byte-intact and exits 0 with a loud warning, rather than
 * risking the ExecStartPre fallback-to-stale path over a pure optimization.
 *
 * Usage: node ascii-escape-bundle.mjs <file>
 */
import { readFileSync, writeFileSync, renameSync, unlinkSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const file = process.argv[2];
const mb = (n) => (n / 1048576).toFixed(1);

/** Escape every non-ASCII char. U+0080..U+00FF is NOT safe for module source (see header). */
const ESCAPE_RE = /[\u0080-￿]/g;

function warn(msg) {
  console.warn(`⚠ ascii-escape: ${msg} — leaving the bundle un-escaped (correct, just larger).`);
}

if (!file) {
  warn('no file argument');
  process.exit(0);
}

try {
  const before = statSync(file).size;
  const src = readFileSync(file, 'utf8');

  const hits = src.match(ESCAPE_RE);
  if (!hits) {
    console.log('→ ascii-escape: bundle is already all ASCII, nothing to do');
    process.exit(0);
  }

  // Refuse if any String.raw template would change meaning (see header).
  for (const m of src.matchAll(/String\.raw`([\s\S]*?)`/g)) {
    if (ESCAPE_RE.test(m[1])) {
      ESCAPE_RE.lastIndex = 0;
      warn('a String.raw template contains a char that would need escaping');
      process.exit(0);
    }
    ESCAPE_RE.lastIndex = 0;
  }

  const escaped = src.replace(ESCAPE_RE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

  // Write beside the target, syntax-check the REWRITTEN file, then swap it in.
  // `node --check` on a .mjs path parses it as an ES module — the same grammar
  // the host will use. A corrupt rewrite therefore never reaches $OUTFILE.
  const staged = `${file}.ascii.tmp.mjs`;
  writeFileSync(staged, escaped);
  const check = spawnSync(process.execPath, ['--check', staged], { encoding: 'utf8' });
  if (check.status !== 0) {
    try {
      unlinkSync(staged);
    } catch {
      /* best effort */
    }
    warn(`the escaped bundle failed \`node --check\`: ${(check.stderr || '').split('\n')[0]}`);
    process.exit(0);
  }
  renameSync(staged, file);

  const after = statSync(file).size;
  console.log(
    `→ ascii-escape: ${hits.length.toLocaleString()} non-ASCII chars escaped ` +
      `(${mb(before)} MB → ${mb(after)} MB on disk; the win is in-memory: ` +
      `the source string stays one-byte in every host process)`,
  );
} catch (err) {
  warn(String(err?.message ?? err));
  process.exit(0);
}
