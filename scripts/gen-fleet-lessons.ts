#!/usr/bin/env npx tsx
/**
 * gen-fleet-lessons — EXPORT the curated `fleet-lessons` knowledge pack out of
 * the live shared root and INTO the repo's builtin pack dir, where the desktop
 * cut already ships it (memory-corpus-hygiene P-006 / D-017).
 *
 *   npm run gen:fleet-lessons          # write mode (idempotent)
 *   npm run gen:fleet-lessons:check    # CI-style: exit 1 on drift or residue
 *
 * THE PROBLEM THIS SOLVES
 *
 * The curation loop materializes adopted candidates to
 * `<workspaces>/shared/knowledge-packs/fleet-lessons` — a runtime path under
 * the user's home. It is outside the repo and outside the bundle, so the ONE
 * pack the loop actually feeds never reached a fresh install.
 *
 * WHY EXPORT-THEN-COMMIT, AND NOT A COPY AT RELEASE-CUT TIME
 *
 * Copying from `~/.papercusp-workspaces/` during the cut would make the shipped
 * bundle a function of the BUILD BOX's home directory. That fails four ways:
 * builds of the same commit stop being reproducible; nothing in git records
 * what shipped, so there is nothing to review or revert; whatever the loop last
 * adopted goes to customers unvetted; and on any box without that directory (a
 * CI runner, a fresh clone) the cut silently ships the pack MISSING while
 * reporting success — today's bug relocated, not fixed.
 *
 * Exporting into the repo instead makes the commit the source of truth. The cut
 * needs NO changes at all: build-desktop-sidecar.sh already copies every file
 * under `packages/harness` into `sidecar/harness`, so a committed pack ships by
 * the existing path.
 *
 * RESIDUE
 *
 * A pack item is a shipped artifact, so it must carry no internal references and
 * no tier-3 THIS-BOX identity. That is enforced at FOUR points, deliberately:
 * the producer no longer renders internal refs (renderCandidateLearningFile),
 * the curation loop refuses to ADMIT a bad item at all
 * (materializeCandidateIntoPack, P-009), this exporter REFUSES a pack that
 * carries them, and pack-residue.test.ts gates the committed result on every
 * test run. All four share ONE rule module (./pack-residue) — which itself
 * reuses the shared identity-leak detector rather than keeping a second list —
 * so none of them can drift from the others.
 */
import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sharedKnowledgePacksRoot,
  loadKnowledgePackFromDir,
} from '../packages/operator-core/lib/knowledge-packs/load-packs';
import {
  findShippableTextFaults,
  formatPackResidue,
  resolvePackIdentityEntries,
} from '../packages/operator-core/lib/knowledge-packs/pack-residue';
// OKF v0.2 frontmatter, applied ON EXPORT — see okfExportBody below. Both modules
// guard their own entrypoint (`if (import.meta.url === invokedPath) main()`), so
// importing them runs nothing.
import { planDocAddition, planManifestAddition } from './okf-backfill-packs.mjs';
import { insertIntoFrontmatter } from './okf-backfill-insights.mjs';

const PACK_ID = 'fleet-lessons';

/**
 * Normalize one exported file to OKF v0.2 — the shape `lint:okf-conformance`
 * REQUIRES of everything under its PACKS_PREFIX scan root.
 *
 * WHY THIS EXISTS (WI-38239, measured 2026-08-13): this exporter used to copy the
 * curated pack VERBATIM, while the committed copy had been backfilled to OKF v0.2
 * by scripts/okf-backfill-packs.mjs. The curated source has no such backfill, so
 * `--check` reported 4 files "differ" and told the reader to run the writer — and
 * running it would have STRIPPED `okf_version` / `type:` from the committed pack
 * and turned `lint:okf-conformance` red. Two guards over the same files, each
 * prescribing a state the other rejects, with the red one prescribing the break.
 *
 * The asymmetry is real and permanent: the curated pack is machine-local fleet
 * state that nothing lints, while the committed copy is what SHIPS and is linted.
 * So conformance is the EXPORTER's job, not the source's — applied here, what ships
 * is conformant by construction no matter what the curated side holds, and the
 * class cannot recur for a pack adopted tomorrow.
 *
 * Idempotent: both planners no-op (`already-backfilled`) when the field is present,
 * so a file that already conforms round-trips byte-identical and reports no drift.
 */
function okfExportBody(file: string, text: string): string {
  if (file === 'manifest.yaml') {
    const { next } = planManifestAddition(text);
    return next ?? text;
  }
  const { lines } = planDocAddition(text);
  // insertIntoFrontmatter returns null when there is no frontmatter block to
  // insert into; that is not ours to repair here — ship the text unchanged and
  // let lint:okf-conformance name it, rather than silently rewriting a doc shape
  // this exporter does not understand.
  return insertIntoFrontmatter(text, lines) ?? text;
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const destDir = join(
  repoRoot, 'libs', 'papercusp', 'packages', 'harness', 'knowledge-packs', PACK_ID,
);

const check = process.argv.includes('--check');
const srcDir = process.env.FLEET_LESSONS_SRC ?? join(sharedKnowledgePacksRoot(), PACK_ID);

const exists = async (p: string) => !!(await fs.stat(p).catch(() => null));

async function main(): Promise<number> {
  if (!(await exists(srcDir))) {
    // The normal case off-fleet: a CI runner or a fresh clone has no shared
    // root. Nothing to export is NOT a failure — the committed copy is the
    // source of truth for what ships, and it is already in the tree.
    console.log(`[gen:fleet-lessons] no curated pack at ${srcDir} — nothing to export (ok)`);
    return 0;
  }

  // Validate the SOURCE through the real pack parser before copying anything:
  // a malformed pack must fail here, not silently ship a broken artifact.
  const { loaded, errors } = await loadKnowledgePackFromDir(srcDir);
  if (!loaded) {
    console.error(`[gen:fleet-lessons] ${srcDir} is not a valid pack:`);
    for (const e of errors) console.error(`  ${e}`);
    return 1;
  }

  const srcFiles = (await fs.readdir(srcDir))
    .filter((f) => f.endsWith('.md') || f === 'manifest.yaml')
    .sort();

  // Admission gate — refuse the whole export rather than ship a bad item.
  // P-009: the same gate the curation loop enforces at adoption, now including
  // the tier-3 THIS-BOX identity legs (hostname / git identity / absolute paths /
  // named owner tags), not just the internal-reference residue. Items adopted
  // BEFORE the gate existed are exactly the population this catches.
  const identityEntries = resolvePackIdentityEntries();
  const residue: string[] = [];
  const bodies = new Map<string, string>();
  await Promise.all(
    srcFiles.map(async (f) => {
      const body = await fs.readFile(join(srcDir, f), 'utf8');
      bodies.set(f, body);
      const hits = findShippableTextFaults(body, { identityEntries });
      if (hits.length > 0) residue.push(`${f}\n${formatPackResidue(hits)}`);
    }),
  );
  if (residue.length > 0) {
    console.error(
      `[gen:fleet-lessons] REFUSING to export — ${residue.length} item(s) carry internal\n` +
        `references or tier-3 THIS-BOX identity that must not ship:\n\n${residue.join('\n\n')}\n\n` +
        `Fix the item text in ${srcDir} (the producing renderer no longer emits these;\n` +
        `items adopted before that fix still carry them). Do not relax the rule.`,
    );
    return 1;
  }

  await fs.mkdir(destDir, { recursive: true });
  const destFiles = (await fs.readdir(destDir).catch(() => [] as string[]))
    .filter((f) => f.endsWith('.md') || f === 'manifest.yaml');

  let drift = 0;
  const report = (action: string, rel: string) => {
    drift += 1;
    console.log(`${check ? 'DRIFT' : action}: ${PACK_ID}/${rel}`);
  };

  for (const f of srcFiles) {
    // Residue was judged on the RAW source above; conformance is applied to what
    // actually ships, so the comparison below is committed-vs-what-we-would-write.
    const body = okfExportBody(f, bodies.get(f)!);
    const dst = join(destDir, f);
    const current = await fs.readFile(dst, 'utf8').catch(() => null);
    if (current !== body) {
      report('write', f);
      if (!check) await fs.writeFile(dst, body);
    }
  }

  // The export is a MIRROR: an item retracted from the curated pack must stop
  // shipping, so extras are removed rather than left to accumulate.
  for (const f of destFiles) {
    if (!srcFiles.includes(f)) {
      report('remove', f);
      if (!check) await fs.rm(join(destDir, f));
    }
  }

  if (drift === 0) {
    console.log(`[gen:fleet-lessons] up to date (${srcFiles.length} file(s), v${loaded.pack.manifest.version})`);
    return 0;
  }
  if (check) {
    console.error(
      `\n[gen:fleet-lessons] ${drift} file(s) differ from the curated pack.\n` +
        `The fleet has adopted knowledge that is not committed, so it would not ship.\n` +
        `Run: npm run gen:fleet-lessons`,
    );
    return 1;
  }
  console.log(`[gen:fleet-lessons] exported ${drift} change(s) → ${destDir}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('[gen:fleet-lessons] failed:', err);
    process.exit(1);
  },
);
