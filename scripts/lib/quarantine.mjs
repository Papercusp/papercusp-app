// scripts/lib/quarantine.mjs
//
// WI-3371 (2026-07-09): pure quarantine.txt parsing, split out of
// scripts/affected-tests.mjs so it can be unit-tested without importing (and
// thereby executing) that script's side-effecting top-level CLI flow.
//
// quarantine.txt lines come in two shapes:
//   - a BARE workspace name (no `::`)        -> quarantines the WHOLE workspace
//   - a per-file `workspace::glob` pair       -> informational ONLY here; the
//     precise per-file match lives in green-checkpoint.ts's applyTestQuarantine,
//     which only runs on a genuinely red exit code.
//
// Before this fix, `const [ws] = line.split('::'); quarantined.add(ws)` added
// the workspace half of a per-file entry too, so ANY per-file quarantine entry
// silently quarantined its ENTIRE workspace for affected-tests.mjs's coarse
// gate (npm run test:affected) — contradicting the file's own "informational
// only" comment. A workspace with only per-file entries (operator-core, at the
// time of this fix) never gated a real failure.

/**
 * Parse quarantine.txt content into the set of BARE (fully-quarantined)
 * workspace names. Per-file `workspace::glob` lines are deliberately excluded.
 * @param {string} text
 * @returns {Set<string>}
 */
export function parseQuarantineWorkspaces(text) {
  const quarantined = new Set();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    if (line.includes('::')) continue; // per-file entry — informational only, see above
    quarantined.add(line);
  }
  return quarantined;
}
