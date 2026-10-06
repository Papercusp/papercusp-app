#!/usr/bin/env node
/**
 * check-no-owner-name-tags.mjs — a provenance tag must never carry a real name
 * into shipped source (WI-4419, second rule).
 *
 * WHY THIS EXISTS
 * Two good rules collide. The compaction/provenance discipline says: tag an owner
 * directive `[owner:<name> <date>]` so a later reader can tell an owner mandate from
 * an agent's note-to-self. The release gate says: the build box's git identity must
 * never reach a shipped bundle. Agents follow the first rule INSIDE SOURCE COMMENTS,
 * and bin/audit-release-bundle.py — which resolves this box's `git config user.name`
 * — then kills the cut.
 *
 * It has now killed TWO 0.0.9 cuts, each ~10 minutes in, and it kills them at the
 * WORST possible moment: the audit runs BEFORE the platform legs, so the legs never
 * run and a whole build is spent discovering a one-word comment edit. This lint
 * catches the same class at EDIT time, in seconds.
 *
 * WHY A SEPARATE RULE FROM check-no-box-identity.mjs
 * That lint hunts the HOME-PATH class (`/home/<user>/…`) and deliberately refuses to
 * know your box's name — correctly, since a lint keyed to one machine only works on
 * one machine. This rule needs no such knowledge either: it keys on the TAG, not the
 * name. `[owner:` is a structured marker, so matching inside it is exact.
 *
 * WHY THIS CATCHES WHAT THE AUDIT CANNOT
 * The audit matches a short git name case-SENSITIVELY on a word boundary (`\b<Name>\b`)
 * and says why: matched case-INSENSITIVELY, a three-letter first name also hits things
 * like a `.avi` file extension, a longer proper noun that starts with it, and vendored
 * POS-lexicon entries — noise that gets a gate switched off. Sound for a bare word; but
 * it means the lower-case spelling of a tag slips through while the capitalised one
 * fails the cut, though both leak the same person. Anchoring on `[owner:` removes the
 * ambiguity: this rule is case-INSENSITIVE with no false-positive surface at all.
 *
 * THE RULE: in shipped source, cite the tier and the date — `[owner 2026-07-13]` —
 * never the person: `[owner:Jane 2026-07-13]`. The named form stays CORRECT on carry
 * surfaces (work items, facts, checkpoints, plans); those are internal and never
 * packed into source.tar.zst. Only tracked source is shipped, so only tracked source
 * is linted.
 *
 * TWO FORMS, ONE SHARED DETECTOR (EI-18670349543629060)
 * This rule originally matched only the BRACKET form `[owner:<name>]`. Agents also write
 * the parenthetical section header `OWNER MANDATE (<Name>, <date>, verbatim): "…"`, which
 * leaks the same person — three of the 11 leaks that froze `main` on 2026-07-26 were that
 * form. Both matchers now live in scripts/lib/identity-leak-patterns.mjs, which is ALSO
 * imported by the edit-time hook (apps/operator/scripts/hooks/cc/pretooluse-content-lint.mjs)
 * so the advisory an author sees while typing cannot disagree with the gate that blocks
 * them 40 commits later (EI-18670296139788697). Add a new leak form THERE, not here.
 *
 * NOTE THIS FILE OBEYS ITS OWN RULE. It cannot spell a real contributor's name even to
 * illustrate the bug: this script is tracked source, so it is packed into the bundle and
 * scanned by the very audit described above — quoting the literal name here would fail
 * the cut, from inside the guard written to prevent exactly that. The examples below are
 * placeholders for that reason, not by accident.
 *
 *   node scripts/check-no-owner-name-tags.mjs
 *
 * BASELINE is EMPTY and must stay that way. If this fires, strip the NAME from the
 * tag — do not add an exception to make the build pass. Adding your name to the
 * placeholder list below is the bug this gate exists to catch.
 *
 * SCANS UNTRACKED-BUT-NOT-IGNORED FILES TOO (EI-18676240686848444). A plain
 * `git ls-files` only enumerates already-tracked content, so a brand-NEW file — the
 * exact moment a leak is most likely to be typed — was invisible to this lint until
 * the next `git add`, which meant a confident green that had scanned zero bytes of
 * the file you actually just wrote. `--cached --others --exclude-standard` widens the
 * enumeration to match: tracked content PLUS anything git would happily `add`, while
 * still respecting .gitignore. This makes a local run a strict superset of what the
 * gate later sees (the gate only ever sees committed content) — the safe direction
 * for a pre-commit-shaped check to err in.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  FIX_HINT,
  findOwnerNameLeaks,
  isSkippedPath,
  renderLeak,
} from './lib/identity-leak-patterns.mjs';

/**
 * ⚠ SUPERPROJECT-ONLY, DELIBERATELY — do NOT "fix" this by recursing into
 * submodules (WI-6730 swept the other guards onto scripts/lib/tracked-files.mjs;
 * this one is a documented EXCEPTION, and the exception was measured, not assumed).
 *
 * Recursing here finds 8 pre-existing `[owner:<name>]` tags in submodule source —
 * 3 applied SQL migrations under libs/papercusp/libs/db/sql, and 5 in
 * papercusp-desktop (two of them inside audit-release-bundle.py / stage-source-
 * tree.sh, where the literal is the PATTERN BEING DOCUMENTED, not a leak).
 *
 * They are not a leak, and stripping them is the wrong move, because the desktop
 * release already neutralises this class BY DESIGN — WI-4419 durable /
 * desktop-v0-0-12-release-tri-platform#D-004. bin/stage-source-tree.sh redacts
 * every identity literal in a COPY of each must-ship file at tar time (a
 * --transform overlay, streaming — never the working tree), driven by
 * REDACTION_BY_KEY in bin/audit-release-bundle.py, where the `build-git-name`
 * key maps this box's `git config user.name` to the placeholder `owner`. The
 * produced bytes carry no real name, and the gate still fails on any UN-redacted
 * identity — the scrub removes the leak, it does not hide it.
 *
 * D-004 rejects the alternative in as many words: those files "cannot be pruned
 * (they ship / run), and a per-file source edit is a treadmill that reds the next
 * cut the moment a new tag lands." So extending ENFORCEMENT here would contradict
 * a recorded decision and start exactly that treadmill — while gaining no real
 * coverage, since the bundle is already clean.
 *
 * If you are here because you want submodule coverage: the seam exists
 * (`listFilesIncludingUntracked()` in scripts/lib/tracked-files.mjs recurses while
 * keeping `--others`, which plain `--recurse-submodules` cannot). The blocker is
 * the POLICY above, not the enumerator. Change D-004 first, or leave this alone.
 */
const files = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  { maxBuffer: 1 << 28 },
)
  .toString()
  .split('\0')
  .filter(Boolean)
  .filter((f) => !isSkippedPath(f));

const findings = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue; // unreadable / binary / vanished mid-run — not our class
  }
  // findOwnerNameLeaks() applies its own cheap FAST_REJECT before matching.
  for (const hit of findOwnerNameLeaks(text)) findings.push({ file, ...hit });
}

if (findings.length === 0) {
  console.log('✓ no named owner-provenance tags in shipped source (superproject — see the scope note above)');
  process.exit(0);
}

console.error(
  `\n✗ ${findings.length} named provenance tag(s) in shipped source — these leak a real ` +
    `person's name into the release bundle (source.tar.zst) and WILL fail the cut's ` +
    `box-identity audit (bin/audit-release-bundle.py), ~10 minutes in, before any ` +
    `platform leg runs.\n`
);
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}  ${renderLeak(f)}`);
  console.error(`      ${f.text}`);
}
console.error(`\n${FIX_HINT}\n`);
process.exit(1);
