#!/usr/bin/env node
// Restricted-hold gate for the host bundle (WI-10005745 — D-012 residue of WI-10005724, plan
// personal-data-reader-set-labels-2026-10-01, BAR R-11).
//
// bg-host's ExecStartPre (bundle-host.sh) esbuild-bundles the LIVE shared tree, and every
// in-process routine then runs that bundle with the network. A session holding an active personal
// disclosure has no network itself (D-012), but a write it left in the tree would run inside the
// next bundle. This gate keeps such a bundle from standing:
//
//   snapshot  BEFORE the build: hardlink every artifact the build may replace into a private
//             snapshot dir inside dist-host (every publish below is tmp-then-rename, so a hardlink
//             keeps the previous bytes even after the build swaps a new file in).
//   gate      AFTER the build: collect the bundle's EXACT inputs (esbuild metafile inputs plus the
//             files/dirs copied verbatim), run the shared restricted-hold census once
//             (scripts/lib/restricted-hold-preflight.mjs → restricted-hold-preflight-cli.ts), and
//             restore the snapshot on anything but an admit. Fail-closed: bad arguments, a missing
//             metafile, a census that cannot be read — all restore the last-known-good bytes.
//
// The census runs after every input was read, so a hold that appears mid-build is still seen.
// Exit codes: 0 admitted (snapshot discarded) · 3 refused (snapshot restored) · 2 misuse before
// any snapshot existed.
import {
  existsSync,
  linkSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import {
  formatBundleRestrictedHoldRefusal,
  runBundleRestrictedHoldPreflight,
} from '../../../scripts/lib/restricted-hold-preflight.mjs';

export const GATE_EXIT = Object.freeze({ admit: 0, misuse: 2, refuse: 3 });
const MANIFEST = 'manifest.json';

/** Hardlink a file or tree (falls back to a copy when a link is impossible, e.g. EXDEV). */
function linkTree(src, dst) {
  const st = lstatSync(src);
  mkdirSync(dirname(dst), { recursive: true });
  if (st.isDirectory()) {
    mkdirSync(dst, { recursive: true });
    for (const entry of readdirSync(src)) linkTree(join(src, entry), join(dst, entry));
  } else if (st.isSymbolicLink()) {
    symlinkSync(readlinkSync(src), dst);
  } else {
    try {
      linkSync(src, dst);
    } catch {
      copyFileSync(src, dst);
    }
  }
}

/**
 * Snapshot the named artifacts of `outdir` into `snapshotDir`. Records which existed, so a restore
 * also REMOVES an artifact this build created where none stood before.
 * @param {{ outdir: string, snapshotDir: string, artifacts: string[] }} opts
 */
export function snapshotArtifacts({ outdir, snapshotDir, artifacts }) {
  rmSync(snapshotDir, { recursive: true, force: true });
  mkdirSync(snapshotDir, { recursive: true });
  const entries = [];
  for (const name of [...new Set(artifacts)]) {
    const src = join(outdir, name);
    const existed = existsSync(src);
    if (existed) linkTree(src, join(snapshotDir, 'files', name));
    entries.push({ name, existed });
  }
  writeFileSync(join(snapshotDir, MANIFEST), JSON.stringify({ outdir: resolve(outdir), entries }, null, 2));
  return entries;
}

/** Put every snapshotted artifact back exactly as it was before the build. */
export function restoreArtifacts({ outdir, snapshotDir }) {
  const manifest = JSON.parse(readFileSync(join(snapshotDir, MANIFEST), 'utf8'));
  for (const { name, existed } of manifest.entries) {
    const target = join(outdir, name);
    rmSync(target, { recursive: true, force: true });
    if (existed) renameSync(join(snapshotDir, 'files', name), target);
  }
  return manifest.entries;
}

/** esbuild metafile `inputs` keys are relative to esbuild's working dir; drop virtual namespaces. */
function metafileInputs(metafile, baseDir) {
  const meta = JSON.parse(readFileSync(metafile, 'utf8'));
  if (!meta || typeof meta.inputs !== 'object' || meta.inputs === null) {
    throw new Error(`${metafile} has no esbuild "inputs" map`);
  }
  return Object.keys(meta.inputs)
    // `<define:…>`/`<stdin>` are virtual, `(disabled):…` is a browser-field stub, `ns:…` a plugin
    // namespace — none is a file the bundle read from the tree.
    .filter((key) => !key.startsWith('<') && !key.startsWith('(') && !/^[a-z-]+:/i.test(key))
    .map((key) => (isAbsolute(key) ? key : resolve(baseDir, key)));
}

/**
 * The exact input set of one build. Every named metafile and list file MUST exist: a missing one
 * means an artifact whose inputs are unknown, which refuses rather than admits.
 * @param {{ baseDir: string, metafiles?: string[], metafileDirs?: string[], listFiles?: string[], paths?: string[] }} opts
 */
export function collectBundleInputs({ baseDir, metafiles = [], metafileDirs = [], listFiles = [], paths = [] }) {
  const files = new Set();
  const dirs = new Set();
  const allMetafiles = [...metafiles];
  for (const dir of metafileDirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) if (entry.endsWith('.meta.json')) allMetafiles.push(join(dir, entry));
  }
  for (const metafile of allMetafiles) for (const input of metafileInputs(metafile, baseDir)) files.add(input);
  const listed = [];
  for (const list of listFiles) {
    for (const line of readFileSync(list, 'utf8').split('\n')) if (line.trim()) listed.push(line.trim());
  }
  for (const path of [...paths, ...listed]) {
    const abs = isAbsolute(path) ? path : resolve(baseDir, path);
    if (existsSync(abs) && statSync(abs).isDirectory()) dirs.add(abs);
    else files.add(abs);
  }
  return { files: [...files].sort(), dirs: [...dirs].sort() };
}

/**
 * Run the gate. Anything but an admit restores the snapshot.
 * @param {{ root: string, baseDir: string, outdir: string, snapshotDir: string, metafiles?: string[], metafileDirs?: string[], listFiles?: string[], paths?: string[], preflight?: typeof runBundleRestrictedHoldPreflight, log?: (line: string) => void }} opts
 */
export function runGate({ root, baseDir, outdir, snapshotDir, metafiles, metafileDirs, listFiles, paths, preflight = runBundleRestrictedHoldPreflight, log = console.log }) {
  let verdict;
  let inputCount = 0;
  try {
    const inputs = collectBundleInputs({ baseDir, metafiles, metafileDirs, listFiles, paths });
    inputCount = inputs.files.length + inputs.dirs.length;
    const inputsFile = join(snapshotDir, 'inputs.json');
    writeFileSync(inputsFile, JSON.stringify(inputs));
    verdict = preflight({ repoRoot: root, inputsFile });
  } catch (error) {
    verdict = {
      verdict: 'refuse',
      error: 'restricted_hold_state_unknown',
      hint: `the bundle's inputs could not be established (${error instanceof Error ? error.message : String(error)}); the host bundle was not published`,
    };
  }
  if (verdict.verdict === 'admit') {
    rmSync(snapshotDir, { recursive: true, force: true });
    log(`✓ restricted-hold gate: ${inputCount} bundle inputs checked, none is a held restricted write (D-012)`);
    return GATE_EXIT.admit;
  }
  const restored = restoreArtifacts({ outdir, snapshotDir });
  rmSync(snapshotDir, { recursive: true, force: true });
  log(formatBundleRestrictedHoldRefusal(verdict));
  log(`🚨 restored ${restored.filter((entry) => entry.existed).length} last-known-good artifact(s) in ${outdir}; removed ${restored.filter((entry) => !entry.existed).length} that had no predecessor`);
  return GATE_EXIT.refuse;
}

function parseArgs(argv) {
  const opts = { metafiles: [], metafileDirs: [], listFiles: [], paths: [], artifacts: [] };
  const multi = { '--metafile': 'metafiles', '--metafile-dir': 'metafileDirs', '--list-file': 'listFiles', '--path': 'paths', '--artifact': 'artifacts' };
  const single = { '--root': 'root', '--base-dir': 'baseDir', '--outdir': 'outdir', '--snapshot-dir': 'snapshotDir' };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (multi[flag]) opts[multi[flag]].push(value);
    else if (single[flag]) opts[single[flag]] = value;
    else throw new Error(`unknown flag ${flag}`);
  }
  return opts;
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  let opts;
  try {
    opts = parseArgs(rest);
  } catch (error) {
    console.error(`bundle-restricted-hold-gate: ${error.message}`);
    // A gate whose snapshot exists must still restore; misuse before a snapshot simply refuses.
    if (command === 'gate' && rest.includes('--snapshot-dir')) {
      const outdir = rest[rest.indexOf('--outdir') + 1];
      const snapshotDir = rest[rest.indexOf('--snapshot-dir') + 1];
      if (outdir && snapshotDir && existsSync(join(snapshotDir, MANIFEST))) {
        restoreArtifacts({ outdir, snapshotDir });
        rmSync(snapshotDir, { recursive: true, force: true });
        return GATE_EXIT.refuse;
      }
    }
    return GATE_EXIT.misuse;
  }
  if (command === 'snapshot') {
    if (!opts.outdir || !opts.snapshotDir) {
      console.error('bundle-restricted-hold-gate snapshot needs --outdir and --snapshot-dir');
      return GATE_EXIT.misuse;
    }
    const entries = snapshotArtifacts({ outdir: opts.outdir, snapshotDir: opts.snapshotDir, artifacts: opts.artifacts });
    console.log(`→ restricted-hold gate: snapshotted ${entries.filter((entry) => entry.existed).length}/${entries.length} last-known-good artifact(s)`);
    return GATE_EXIT.admit;
  }
  if (command === 'gate') {
    const snapshotted = Boolean(opts.outdir && opts.snapshotDir && existsSync(join(opts.snapshotDir, MANIFEST)));
    if (!opts.root || !opts.baseDir || !snapshotted) {
      console.error('bundle-restricted-hold-gate gate needs --root, --base-dir, --outdir and an existing --snapshot-dir');
      if (!snapshotted) return GATE_EXIT.misuse;
      restoreArtifacts({ outdir: opts.outdir, snapshotDir: opts.snapshotDir });
      rmSync(opts.snapshotDir, { recursive: true, force: true });
      return GATE_EXIT.refuse;
    }
    return runGate(opts);
  }
  console.error('usage: bundle-restricted-hold-gate.mjs snapshot|gate [flags]');
  return GATE_EXIT.misuse;
}

if (isCliEntry(import.meta.url)) {
  process.exitCode = main();
}
