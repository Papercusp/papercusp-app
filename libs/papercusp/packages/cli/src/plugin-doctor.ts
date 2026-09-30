/**
 * `papercusp plugin doctor` — Tier 3 deferred item from Batch F roadmap.
 *
 * Static analysis: cross-checks the capabilities declared in `papercusp.json`
 * against the actual `ctx.*` usage in the plugin source. Reports:
 *
 *   - **Unused** caps — declared in manifest, no matching call in source.
 *     Likely cap pollution from copy-pasted templates. Non-fatal warning.
 *   - **Missing** caps — used in source, not declared. Will be denied
 *     at runtime by the loader's two-tier check. Fatal.
 *
 * Limitations: regex-based pattern matching, not a real AST walker.
 * Catches the 80% case (literal string arguments). Dynamic / template-
 * built capability identifiers are skipped with an "unverified" tally.
 *
 * Exit codes:
 *   0 — no issues / only warnings
 *   1 — missing caps detected (would fail at runtime)
 *   2 — usage error
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.cjs', '.js', '.mjs']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.next', '.git']);

interface Finding {
  cap: string;
  /** Source file + line where the usage was found. */
  where: string;
}

interface DoctorReport {
  /** Capabilities used by the source but not declared in manifest. */
  missing: Finding[];
  /** Capabilities declared in manifest but not used in source. */
  unused: string[];
  /** Unverified / dynamic capability lookups (manual review needed). */
  unverified: Finding[];
}

/** Walk the plugin dir recursively, yielding source file paths. */
function* walkSources(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
    const p = join(dir, name);
    let stat;
    try {
      stat = statSync(p);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      yield* walkSources(p);
    } else if (SOURCE_EXTS.has(extname(p))) {
      yield p;
    }
  }
}

/**
 * Extract capability strings from a source file by pattern-matching the
 * common `ctx.*` invocation shapes. Returns one finding per literal
 * argument; non-literal arguments are reported as `unverified`.
 */
export function scanSource(filePath: string, body: string): { found: Finding[]; unverified: Finding[] } {
  const found: Finding[] = [];
  const unverified: Finding[] = [];
  const lines = body.split('\n');

  // Track local aliases for ctx.spawn / ctx.fetch / ctx.secrets.
  // `const spawn = ctx.spawn` or `const { spawn } = ctx` lets later
  // `spawn('git', ...)` calls escape pattern detection unless we
  // rewrite the body to use the dotted form. Cheap two-pass: collect
  // alias names first, then synthesise `ctx.spawn(` etc. on the second
  // scan via prepended canonical patterns.
  const spawnAliases: string[] = [];
  const fetchAliases: string[] = [];
  for (const line of lines) {
    const m1 = /\bconst\s+(\w+)\s*=\s*ctx\.spawn\b/.exec(line);
    if (m1) spawnAliases.push(m1[1]);
    const m2 = /\bconst\s+\{\s*([^}]+)\s*\}\s*=\s*ctx\b/.exec(line);
    if (m2) {
      for (const tok of m2[1].split(',').map((s) => s.trim().split(':')[0].trim())) {
        if (tok === 'spawn') spawnAliases.push('spawn');
        if (tok === 'fetch') fetchAliases.push('fetch');
      }
    }
    const m3 = /\bconst\s+(\w+)\s*=\s*ctx\.fetch\b/.exec(line);
    if (m3) fetchAliases.push(m3[1]);
  }

  // Pattern table — each entry maps a regex (with one capture group for
  // the resource arg) to a cap-string builder. Loose matching: we accept
  // any quoted form of the arg, plus optional whitespace.
  const patterns: Array<{ re: RegExp; build: (m: string) => string | null; label: string }> = [
    // ctx.spawn('git', ...) → compute:exec:git
    { re: /\bctx\.spawn\s*\(\s*['"`]([^'"`]+)['"`]/g, build: (m) => `compute:exec:${m}`, label: 'ctx.spawn' },
    // ctx.fetch('https://api.foo.com/...') → http:fetch:api.foo.com
    {
      re: /\bctx\.fetch\s*\(\s*['"`](https?:\/\/[^'"`/]+)/g,
      build: (m) => {
        try {
          return `http:fetch:${new URL(m).hostname}`;
        } catch {
          return null;
        }
      },
      label: 'ctx.fetch',
    },
    // ctx.secrets.read('NAME') / ctx.secrets?.read('NAME') → secrets:read:NAME
    // (real SDK method is `read`, not `get` — see plugin-loader/api-factory.ts)
    { re: /\bctx\.secrets\??\.read\s*\(\s*['"`]([^'"`]+)['"`]/g, build: (m) => `secrets:read:${m}`, label: 'ctx.secrets.read' },
    // ctx.hookBus.emit('foo.bar') / ctx.hookBus?.emit('foo.bar') → events:emit:foo.bar
    {
      re: /\bctx\.hookBus\??\.emit\s*\(\s*['"`]([^'"`]+)['"`]/g,
      build: (m) => `events:emit:${m}`,
      label: 'ctx.hookBus.emit',
    },
    // ctx.hookBus.on('foo.bar', ...) → events:listen:foo.bar
    {
      re: /\bctx\.hookBus\??\.on\s*\(\s*['"`]([^'"`]+)['"`]/g,
      build: (m) => `events:listen:${m}`,
      label: 'ctx.hookBus.on',
    },
    // ctx.oauth.tokenFor('provider') → oauth:<provider> (advisory only;
    // oauth caps are declared via the `oauth` field, not capabilities[])
  ];

  // Aliased spawn/fetch — same shape, different identifier.
  for (const alias of new Set(spawnAliases)) {
    patterns.push({
      re: new RegExp(`\\b${alias}\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]`, 'g'),
      build: (m) => `compute:exec:${m}`,
      label: `${alias}(<bin>) [aliased ctx.spawn]`,
    });
  }
  for (const alias of new Set(fetchAliases)) {
    patterns.push({
      re: new RegExp(`\\b${alias}\\s*\\(\\s*['"\`](https?:\\/\\/[^'"\`/]+)`, 'g'),
      build: (m) => {
        try {
          return `http:fetch:${new URL(m).hostname}`;
        } catch {
          return null;
        }
      },
      label: `${alias}(<url>) [aliased ctx.fetch]`,
    });
  }

  // Unverified: ctx.spawn(varname, ...) or ctx.fetch(templateLiteral)
  const unverifiedPatterns: Array<{ re: RegExp; label: string }> = [
    { re: /\bctx\.spawn\s*\(\s*[a-zA-Z_$][\w$.]*[,)]/g, label: 'ctx.spawn(<dynamic>)' },
    { re: /\bctx\.fetch\s*\(\s*`https?:\/\/\$\{/g, label: 'ctx.fetch(<template-literal>)' },
    { re: /\bctx\.secrets\??\.read\s*\(\s*[a-zA-Z_$][\w$.]*[,)]/g, label: 'ctx.secrets.read(<dynamic>)' },
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const where = `${filePath}:${i + 1}`;

    for (const p of patterns) {
      p.re.lastIndex = 0;
      let m;
      while ((m = p.re.exec(line)) !== null) {
        const cap = p.build(m[1]);
        if (cap) found.push({ cap, where });
      }
    }

    for (const p of unverifiedPatterns) {
      p.re.lastIndex = 0;
      if (p.re.test(line)) {
        unverified.push({ cap: p.label, where });
      }
    }
  }

  return { found, unverified };
}

/**
 * Match a manifest-declared cap pattern against an actual-usage cap.
 * Mirrors the loader's `hasCapability` matcher: exact, subdomain wildcard
 * (`http:fetch:*.foo.com` covers any `http:fetch:sub.foo.com`), and prefix
 * wildcard (`secrets:read:YT_*` covers any `secrets:read:YT_<rest>`).
 */
export function manifestCovers(declared: string, used: string): boolean {
  if (declared === used) return true;
  if (!declared.includes('*')) return false;
  const dColon = declared.lastIndexOf(':');
  const uColon = used.lastIndexOf(':');
  if (dColon < 0 || uColon < 0) return false;
  if (declared.slice(0, dColon) !== used.slice(0, uColon)) return false;
  const dRes = declared.slice(dColon + 1);
  const uRes = used.slice(uColon + 1);
  if (dRes.startsWith('*.')) {
    const suffix = dRes.slice(1);
    return uRes.endsWith(suffix) && uRes.length > suffix.length;
  }
  if (dRes.endsWith('*')) {
    const head = dRes.slice(0, -1);
    if (head.length === 0) return false;
    return uRes.startsWith(head) && uRes.length > head.length;
  }
  return false;
}

export function buildReport(
  declaredCaps: string[],
  usedCaps: Finding[],
  unverified: Finding[],
): DoctorReport {
  const missing: Finding[] = [];
  for (const u of usedCaps) {
    if (!declaredCaps.some((d) => manifestCovers(d, u.cap))) {
      missing.push(u);
    }
  }
  const usedSet = new Set(usedCaps.map((u) => u.cap));
  const unused: string[] = [];
  for (const d of declaredCaps) {
    // Skip caps that are inherently not usage-checkable from source:
    // ui:*, roles:*, tasks:*, features:*, goals:*, hooks:*, runtime
    if (/^(ui|roles|tasks|features|goals|hooks|runtime)\b/.test(d)) continue;
    // If declared has a wildcard, count it as used iff any source-cap matches it.
    if (d.includes('*')) {
      if ([...usedSet].some((u) => manifestCovers(d, u))) continue;
      unused.push(d);
      continue;
    }
    if (!usedSet.has(d)) unused.push(d);
  }
  return { missing, unused, unverified };
}

export async function cmdPluginDoctor(args: string[]): Promise<void> {
  const dirArg = args.find((a) => !a.startsWith('--')) ?? '.';
  const dir = resolve(dirArg);
  const manifestPath = join(dir, 'papercusp.json');

  if (!existsSync(manifestPath)) {
    console.error(`✗ no papercusp.json found at ${manifestPath}`);
    process.exit(1);
  }

  let manifest: { capabilities?: string[] };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    console.error(`✗ papercusp.json is not valid JSON: ${(e as Error).message}`);
    process.exit(1);
  }

  const declared = Array.isArray(manifest.capabilities)
    ? manifest.capabilities.filter((c): c is string => typeof c === 'string')
    : [];

  const allFound: Finding[] = [];
  const allUnverified: Finding[] = [];
  for (const src of walkSources(dir)) {
    const body = readFileSync(src, 'utf8');
    const { found, unverified } = scanSource(src, body);
    allFound.push(...found);
    allUnverified.push(...unverified);
  }

  const report = buildReport(declared, allFound, allUnverified);

  let exit = 0;

  if (report.missing.length === 0) {
    console.log('✓ all source-detected capabilities are declared in manifest');
  } else {
    console.error(`✗ ${report.missing.length} undeclared capabilit${report.missing.length === 1 ? 'y' : 'ies'} used in source:`);
    for (const m of report.missing) {
      console.error(`  ${m.cap}    ${m.where}`);
    }
    console.error('  → add these to capabilities[] in papercusp.json, or the host will deny them at runtime.');
    exit = 1;
  }

  if (report.unused.length > 0) {
    console.error(`⚠ ${report.unused.length} declared capabilit${report.unused.length === 1 ? 'y' : 'ies'} appear unused in source:`);
    for (const u of report.unused) console.error(`  ${u}`);
    console.error('  → review and remove cap pollution, or call sites may be in code paths the scanner missed.');
  } else if (declared.length > 0) {
    console.log(`✓ no obvious cap pollution (${declared.length} declared, all matched)`);
  }

  if (report.unverified.length > 0) {
    console.error(`ℹ ${report.unverified.length} dynamic capability lookup${report.unverified.length === 1 ? '' : 's'} (manual review needed):`);
    for (const u of report.unverified) console.error(`  ${u.cap}    ${u.where}`);
  }

  process.exit(exit);
}
