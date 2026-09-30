/**
 * `papercusp plugin lint` — Batch E2.
 *
 * Runs the same manifest validation the loader runs at runtime, but at
 * build time so plugin authors see schema errors before publishing.
 * Covers Rust-port-feedback item 8 (the "papercup plugin build"
 * equivalent for the TS side).
 *
 * Exit codes:
 *   0 — no issues
 *   1 — invalid manifest or missing entry point
 *   2 — usage error
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { validateManifest } from '@papercusp/plugin-loader/manifest-validate';
import { lintManifest } from '@papercusp/plugin-loader/manifest-lint';

const ENTRY_CANDIDATES = [
  'index.cjs', 'dist/index.cjs',
  'index.js', 'index.mjs', 'dist/index.js',
  'index.ts', 'src/index.ts',
];

export async function cmdPluginLint(args: string[]): Promise<void> {
  const dirArg = args.find((a) => !a.startsWith('--')) ?? '.';
  const dir = resolve(dirArg);
  const manifestPath = join(dir, 'papercusp.json');

  if (!existsSync(manifestPath)) {
    console.error(`✗ no papercusp.json found at ${manifestPath}`);
    process.exit(1);
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    console.error(`✗ papercusp.json is not valid JSON: ${(e as Error).message}`);
    process.exit(1);
  }

  // Schema validation (mirrors loader.readManifest). Direct import via
  // the package's `manifest-validate` export — works in both the TS dev
  // setup and any future built distribution.
  const result = validateManifest(manifest);

  let exit = 0;

  if (!result.ok) {
    console.error('✗ manifest invalid:');
    for (const issue of result.issues) {
      console.error(`  ${issue.path} — ${issue.message}`);
    }
    exit = 1;
  } else {
    console.log('✓ manifest schema OK');
  }

  // Entry-point sanity check — the loader rejects plugins whose entry
  // file isn't found, so flag that at lint time too.
  // Non-JS runtimes (wasm, daemon) have their own entry-point semantics
  // (runtime.wasmPath / runtime.daemonCommand) which the schema enforces;
  // they don't need a JS index.* file. Skip the JS-entry check for them.
  const mRuntime = (manifest as { runtime?: { kind?: string; wasmPath?: string; daemonCommand?: string[] } }).runtime;
  const runtimeKind = mRuntime?.kind ?? 'js';
  if (runtimeKind === 'js') {
    const entry = ENTRY_CANDIDATES.find((c) => existsSync(join(dir, c)));
    if (!entry) {
      console.error(
        `✗ no entry point found (looked for ${ENTRY_CANDIDATES.join(', ')})`,
      );
      exit = 1;
    } else {
      console.log(`✓ entry point: ${entry}`);
    }
  } else if (runtimeKind === 'wasm') {
    const wasmAbs = mRuntime?.wasmPath ? join(dir, mRuntime.wasmPath) : null;
    if (!wasmAbs || !existsSync(wasmAbs)) {
      console.error(`✗ runtime.kind="wasm" but wasmPath '${mRuntime?.wasmPath}' not found at ${wasmAbs}`);
      exit = 1;
    } else {
      console.log(`✓ wasm entry: ${mRuntime!.wasmPath}`);
    }
  } else if (runtimeKind === 'daemon') {
    const cmd = mRuntime?.daemonCommand?.[0];
    if (!cmd) {
      console.error('✗ runtime.kind="daemon" but daemonCommand[0] missing');
      exit = 1;
    } else if (cmd.startsWith('/') && !existsSync(cmd)) {
      // Absolute path to a binary that doesn't exist on this host. Note
      // that this is host-dependent (e.g. /usr/bin/python3 may exist in
      // prod but not in CI), so emit a warning rather than an error.
      console.error(`⚠ runtime.daemonCommand[0] = '${cmd}' is absolute but not found on this host (will fail at install time on hosts missing it)`);
    } else {
      console.log(`✓ daemon entry: ${mRuntime!.daemonCommand!.join(' ')}`);
    }
  } else {
    console.error(`✗ unknown runtime.kind: '${runtimeKind}'`);
    exit = 1;
  }

  // capabilities[] sanity — declared caps must be non-empty strings; the
  // loader's hasCapability is forgiving but this catches typos before
  // runtime denials.
  const m = manifest as { capabilities?: unknown };
  if (m.capabilities !== undefined) {
    if (!Array.isArray(m.capabilities)) {
      console.error('✗ capabilities must be an array');
      exit = 1;
    } else {
      const bad = m.capabilities.filter(
        (c) => typeof c !== 'string' || c.length === 0 || !c.includes(':'),
      );
      if (bad.length > 0) {
        console.error(`✗ capabilities contains invalid entries: ${bad.map((b) => JSON.stringify(b)).join(', ')}`);
        exit = 1;
      } else {
        // Bare-* resource (`foo:bar:*`) is a footgun: authors expect it to
        // match anything-in-prefix, but the matcher only treats it as a
        // literal cap-string (decision locked by @plugin 2026-05-12T07:00).
        // Warn but don't fail.
        const bareStar = (m.capabilities as string[]).filter((c) => /:\*$/.test(c));
        if (bareStar.length > 0) {
          console.error(
            `⚠ capability ends with bare \`:*\` — this is NOT a wildcard; it matches only the literal string \`${bareStar[0]}\`. Use prefix-form wildcards instead (\`compute:exec:py-*\`, \`http:fetch:*.googleapis.com\`) or enumerate each value.`,
          );
        }
        console.log(`✓ ${m.capabilities.length} capability declaration(s) look well-formed`);
      }
    }
  }

  // Plan-rev3 lint pass: G6 (wasm-actions cross-check against colocated
  // wit-bindgen .d.ts) + H6 (iframe HTML same-origin asset audit). Pure
  // helpers from `@papercusp/plugin-loader/manifest-lint`; resolvers
  // hand the helpers file I/O appropriate to this dir.
  const lintFindings = await lintManifest(manifest as Parameters<typeof lintManifest>[0], {
    wasmDts: async (wasmPath: string): Promise<string | null> => {
      const wasmAbs = join(dir, wasmPath);
      const dtsCandidates = [
        wasmAbs.replace(/\.wasm$/, '.d.ts'),
        join(dirname(wasmAbs), 'bindings.d.ts'),
        join(dirname(wasmAbs), 'index.d.ts'),
      ];
      const found = dtsCandidates.find((p) => existsSync(p));
      return found ? readFileSync(found, 'utf8') : null;
    },
    iframeHtml: (entry: string): string | null => {
      const abs = join(dir, entry);
      try { return readFileSync(abs, 'utf8'); } catch { return null; }
    },
  });
  // Skip the bare-wildcard finding — the inline check above already
  // surfaced it with a richer message. De-dupe by rule.
  const lintFromHelper = lintFindings.filter((f) => f.rule !== 'bare-wildcard-cap');
  for (const f of lintFromHelper) {
    const sigil = f.level === 'error' ? '✗' : '⚠';
    const tag = f.where ? ` (${f.where})` : '';
    console.error(`${sigil} ${f.rule}: ${f.message}${tag}`);
    if (f.level === 'error') exit = 1;
  }
  if (lintFromHelper.length === 0) {
    console.log('✓ no plan-rev3 lint findings (wasm-actions / iframe-same-origin clean)');
  }

  process.exit(exit);
}
