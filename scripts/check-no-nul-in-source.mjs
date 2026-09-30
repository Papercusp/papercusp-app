#!/usr/bin/env node
/**
 * The REPAIR tool for a literal NUL byte (0x00) in a tracked text source file.
 *
 * ⚠ THE GATE IS NOT HERE. The build gate is the vitest lint
 * `apps/operator/app/_lints/no-nul-bytes.test.ts`, which already owned this
 * class — this script deliberately does NOT get wired into `lint:` as a second
 * gate. What it adds is the one thing the test cannot do: actually FIX the
 * files. That is not a convenience — a NUL line cannot be repaired with the
 * agent Edit tool at all (the Read tool renders the NUL as a SPACE, so there is
 * no exact text to match and the edit fails "not found"), which is exactly why
 * four instances sat unfixed. Report mode is kept only as a fast local scan.
 *
 * ── Why this exists (EI-18744004858454166) ──────────────────────────────────
 * A single raw NUL makes `file(1)` classify a perfectly valid UTF-8 .ts file as
 * "data". The agent-facing `grep` is not /usr/bin/grep — it is a shell function
 * routing to `ugrep ... -I`, and `-I` SKIPS files it considers binary. So the
 * whole file becomes invisible to grep: every pattern returns "no match" for
 * text that is plainly there, with no warning and no diagnostic.
 *
 * That is the worst possible failure shape for a search tool. An empty grep
 * result reads as a confident NO, and agents use grep constantly to decide
 * "is this symbol used", "who calls this", "does this pattern exist". It cost a
 * real misdiagnosis: an agent concluded its own notes were wrong about a line
 * it could see in `sed` output, because grep insisted the string did not exist.
 *
 * ── How to VERIFY absence — NOT with grep (EI-19393869052335703) ────────────
 * The corollary nobody wrote down: the one question grep CANNOT answer is
 * whether a NUL is absent. `-I` excludes exactly the population that would
 * match, so `git grep -lIP '\x00'` returns empty on a tree that provably
 * contains one — and empty reads as a confident "clean". Measured against
 * candidate 060ea000, which carries 2 NUL bytes in contested-fold.ts:
 *
 *     git grep -lIP '\x00' 060ea000 -- '*.ts'   → (empty)      ← FALSE CLEAN
 *     git grep -lP  '\x00' 060ea000 -- '*.ts'   → …/contested-fold.ts
 *
 * Same query, one flag apart, opposite answers. It fired fleet-wide once: an
 * agent verified a candidate with the `-I` form, reported GREEN, and told five
 * agents to stand down and expect a green that could not happen.
 *
 * SOUND ways to answer "is there a NUL here":
 *   node scripts/check-no-nul-in-source.mjs        ← authoritative; use this
 *   git grep -lP '\x00' <ref>                      ← same query WITHOUT -I
 *   git show <ref>:<file> | tr -dc '\000' | wc -c  ← byte count, ref-scoped
 *
 * ── How the NUL gets there ──────────────────────────────────────────────────
 * Always the same idiom: a composite Map key joined with a delimiter that
 * cannot occur in the data —
 *
 *     const key = `${a}<raw 0x00>${b}`;   // ← poisons the file
 *     const key = `${a}\x00${b}`;         // ← escape, identical at runtime
 *
 * The INTENT is right and should be kept; NUL is a good delimiter. Only the
 * ENCODING is wrong. The two produce the same string at runtime — one leaves
 * the file greppable and one does not. Four agents wrote the raw form
 * independently, which is why this is a lint rule and not a code review note.
 *
 * ⚠ It is genuinely easy to emit the raw form by accident, and hard to SEE that
 * you did: the agent Read tool renders a NUL as a SPACE. This very file was
 * written with a raw NUL on its first draft, and the author then nearly
 * "corrected" the correct logic because the rendering made it look like a plain
 * space. Verify with bytes (`file <path>`, or a NUL count) — never by reading.
 *
 * Usage:
 *   node scripts/check-no-nul-in-source.mjs          # report + exit 1 on any hit
 *   node scripts/check-no-nul-in-source.mjs --fix    # rewrite raw NUL → \x00
 *
 * `--fix` is byte-surgical: it replaces only 0x00 with the four ASCII chars
 * \x00 and touches nothing else. That matters because these lines cannot be
 * edited through the normal agent Edit tool at all — with the NUL rendered as a
 * space there is no exact text to match, and the edit fails "not found".
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coverageOf, describeUnscanned, presentOnDisk } from './lib/tracked-files.mjs';

const FIX = process.argv.includes('--fix');

/**
 * WI-6776: pinned to the repo root rather than inherited from `process.cwd()`.
 * Enumerating from a subdirectory returns only that subtree's files, so the scan
 * reports a confident ✓ having opened almost nothing — the same false-clean class
 * this script exists to surface. `scripts/lib/tracked-files.mjs` pins ROOT for
 * exactly this reason; the reads below resolve against it so `--fix` cannot write
 * to a path interpreted relative to a different cwd.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The NUL as a CHARACTER, built numerically so this file never contains one. */
const NUL_CHAR = String.fromCharCode(0);

/**
 * Text sources only. A NUL is legitimate in a real binary fixture, and some
 * tests deliberately assert on NUL handling using a fixture file — so the scan
 * is limited to source extensions and skips anything under a fixtures dir.
 */
const SOURCE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|mdx|css|sql|sh|yml|yaml|toml)$/;
const SKIP_RE = /(^|\/)(fixtures?|__fixtures__|snapshots?|__snapshots__)\//;

/**
 * `--recurse-submodules` must match the lint in
 * apps/operator/app/_lints/no-nul-bytes.test.ts — see its comment for the full
 * story. Short version: a plain `git ls-files` treats each submodule as one
 * gitlink and never descends, hiding ~5,400 files (21% of the tree) including
 * ALL of `libs/generic/*`. If the checker and the --fix script disagree on
 * scope, `--fix` cannot repair what the checker reports.
 */
function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z', '--recurse-submodules'], {
    cwd: ROOT,
    maxBuffer: 64 * 1024 * 1024,
  });
  const files = out
    .toString('utf8')
    .split(NUL_CHAR)
    .filter((p) => p && SOURCE_RE.test(p) && !SKIP_RE.test(p));
  // WI-10004176: drop index entries a plain `rm` left behind until git-sync commits it.
  return presentOnDisk(files, ROOT);
}

const scannedFiles = trackedFiles();
const hits = [];
for (const path of scannedFiles) {
  let buf;
  try {
    buf = readFileSync(join(ROOT, path));
  } catch {
    continue; // deleted-but-still-tracked, submodule gitlink, etc.
  }
  if (!buf.includes(0)) continue;

  // Report the 1-indexed line of each NUL so the fix is one jump away.
  const lines = [];
  let line = 1;
  let count = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) line++;
    else if (buf[i] === 0) {
      count++;
      if (!lines.includes(line)) lines.push(line);
    }
  }
  hits.push({ path, count, lines });

  if (FIX) {
    // 0x00 → the 4 ASCII chars \ x 0 0. latin1 is a lossless byte↔char
    // round-trip, so splitting on the NUL char and rejoining cannot disturb any
    // other byte (including multi-byte UTF-8 sequences).
    const fixed = Buffer.from(buf.toString('latin1').split(NUL_CHAR).join('\\x00'), 'latin1');
    writeFileSync(join(ROOT, path), fixed);
  }
}

if (hits.length === 0) {
  // WI-6776: a bare ✓ over an enumeration that reached no submodule is
  // indistinguishable from a real clean. State the coverage so it cannot be.
  const { declared, scanned, unscanned } = coverageOf(scannedFiles, ROOT);
  console.log(
    `✓ no literal NUL bytes in ${scannedFiles.length} tracked source file(s) ` +
      `(superproject + ${scanned.length}/${declared.length} submodule(s))` +
      describeUnscanned({ declared, scanned, unscanned }, ROOT),
  );
  // EI-19393869052335703: hand the next agent a SOUND re-check instead of
  // letting one be invented. Same reasoning as the WI-6776 coverage line above,
  // on a different axis: there, a bare ✓ could not be told from an enumeration
  // that reached nothing; here, the obvious re-check (`git grep -lIP '\x00'`)
  // CANNOT ever answer the question, because -I skips exactly the files a NUL
  // makes binary — so it reports clean on a dirty tree.
  console.log(
    `  Re-checking elsewhere? grep CANNOT answer this: \`-I\` skips the very files a NUL makes binary.\n` +
      `  Sound: this script, or \`git grep -lP '\\x00' <ref>\` (no -I), or \`git show <ref>:<file> | tr -dc '\\000' | wc -c\`.`,
  );
  process.exit(0);
}

for (const h of hits) {
  const plural = h.lines.length > 1 ? 's' : '';
  console.log(`${FIX ? 'fixed' : 'NUL '}  ${h.path}  (${h.count} at line${plural} ${h.lines.join(', ')})`);
}

if (FIX) {
  console.log(`\n✓ rewrote ${hits.length} file(s): raw NUL → \\x00 escape (runtime-identical, and greppable again).`);
  console.log('  Re-run the affected tests — the runtime string is unchanged, so they should be untouched.');
  process.exit(0);
}

console.error(
  `\n✗ ${hits.length} tracked source file(s) contain a literal NUL byte.\n` +
    `  Such a file is classified BINARY by file(1), so the agent-facing grep shim (ugrep -I) SKIPS IT\n` +
    `  ENTIRELY — every pattern silently returns "no match" for text that is plainly there.\n` +
    `  Almost always a composite map key: write \`\${a}\\x00\${b}\` (escape) instead of a raw NUL byte.\n` +
    `  They are byte-identical at runtime; only the escape keeps the file greppable.\n` +
    `  Auto-fix:  node scripts/check-no-nul-in-source.mjs --fix\n` +
    `  Background: EI-18744004858454166`,
);
process.exit(1);
