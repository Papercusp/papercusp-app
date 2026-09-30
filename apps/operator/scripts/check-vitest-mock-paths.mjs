#!/usr/bin/env node
/**
 * check-vitest-mock-paths.mjs — fail-loud guard for orphaned `vi.mock()` calls.
 *
 * Vitest accepts a mock for a specifier that no test imports. During a rename,
 * that means a stale mock path silently becomes a no-op and the real module
 * runs instead. Check relative imports, local aliases, and @papercusp/*
 * workspace imports against the source tree; third-party bare specifiers are
 * intentionally left to their package's own tests (some tests mock optional
 * packages that are absent by design).
 *
 *   npm run lint:vitest-mock-paths
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { describeUnscanned, listFilesIncludingUntracked } from '../../../scripts/lib/tracked-files.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function sourceCandidates(base) {
  const candidates = [base];
  const ext = extname(base);
  if (SOURCE_EXTENSIONS.includes(ext)) {
    for (const candidateExt of SOURCE_EXTENSIONS) {
      candidates.push(base.slice(0, -ext.length) + candidateExt);
    }
  } else {
    for (const candidateExt of SOURCE_EXTENSIONS) candidates.push(base + candidateExt);
  }
  for (const candidateExt of SOURCE_EXTENSIONS) {
    candidates.push(join(base, `index${candidateExt}`));
  }
  return candidates;
}

function resolveSourceFile(base) {
  for (const candidate of sourceCandidates(base)) {
    if (isFile(candidate)) return candidate;
  }
  return null;
}

function nearestPackageRoot(testFile, root) {
  let dir = dirname(testFile);
  while (dir === root || dir.startsWith(`${root}/`)) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return root;
}

function loadPathMappings(testFile, root) {
  let dir = dirname(testFile);
  while (dir === root || dir.startsWith(`${root}/`)) {
    const configPath = join(dir, 'tsconfig.json');
    if (isFile(configPath)) {
      const parsed = ts.parseConfigFileTextToJson(configPath, readFileSync(configPath, 'utf8'));
      if (!parsed.error) {
        const config = ts.parseJsonConfigFileContent(parsed.config, ts.sys, dir);
        return {
          baseUrl: config.options.baseUrl ?? dir,
          paths: config.options.paths ?? {},
        };
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { baseUrl: root, paths: {} };
}

function aliasCandidates(specifier, testFile, root) {
  const { baseUrl, paths } = loadPathMappings(testFile, root);
  const candidates = [];
  for (const [pattern, targets] of Object.entries(paths)) {
    const star = pattern.indexOf('*');
    if (star < 0) {
      if (specifier !== pattern) continue;
      for (const target of targets) candidates.push(resolve(baseUrl, target));
      continue;
    }
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
    const replacement = specifier.slice(prefix.length, specifier.length - suffix.length);
    for (const target of targets) {
      candidates.push(resolve(baseUrl, target.replace('*', replacement)));
    }
  }
  // `apps/*` packages conventionally expose `@/*` from their own root even
  // when a consumer's config is inherited or not present in a test fixture.
  if (specifier.startsWith('@/')) {
    candidates.push(join(nearestPackageRoot(testFile, root), specifier.slice(2)));
  }
  return candidates;
}

function shouldCheck(specifier) {
  return specifier.startsWith('.') ||
    isAbsolute(specifier) ||
    specifier.startsWith('@/') ||
    specifier.startsWith('@papercusp/');
}

export function extractMockSpecifiers(source, fileName = 'fixture.ts') {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const mocks = [];
  function visit(node) {
    if (ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText(sourceFile) === 'vi' &&
        node.expression.name.text === 'mock') {
      const firstArg = node.arguments[0];
      if (firstArg && (ts.isStringLiteralLike(firstArg) || ts.isNoSubstitutionTemplateLiteral(firstArg))) {
        const location = sourceFile.getLineAndCharacterOfPosition(firstArg.getStart(sourceFile));
        mocks.push({ specifier: firstArg.text, line: location.line + 1 });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return mocks;
}

export function resolveMockSpecifier(specifier, testFile, root = ROOT) {
  const absoluteTestFile = resolve(testFile);
  if (!shouldCheck(specifier)) return { checked: false, resolved: null };

  if (specifier.startsWith('.') || isAbsolute(specifier)) {
    const base = isAbsolute(specifier) ? specifier : resolve(dirname(absoluteTestFile), specifier);
    return { checked: true, resolved: resolveSourceFile(base) };
  }

  for (const candidate of aliasCandidates(specifier, absoluteTestFile, root)) {
    const resolved = resolveSourceFile(candidate);
    if (resolved) return { checked: true, resolved };
  }

  try {
    const resolved = createRequire(absoluteTestFile).resolve(specifier);
    return { checked: true, resolved };
  } catch {
    return { checked: true, resolved: null };
  }
}

export function findUnresolvedMocks({ files, root = ROOT }) {
  const unresolved = [];
  let checked = 0;
  for (const file of files) {
    const absoluteFile = resolve(root, file);
    if (!TEST_FILE_RE.test(absoluteFile) || !isFile(absoluteFile)) continue;
    const source = readFileSync(absoluteFile, 'utf8');
    for (const mock of extractMockSpecifiers(source, absoluteFile)) {
      const resolution = resolveMockSpecifier(mock.specifier, absoluteFile, root);
      if (!resolution.checked) continue;
      checked++;
      if (!resolution.resolved) {
        unresolved.push({
          file: relative(root, absoluteFile),
          line: mock.line,
          specifier: mock.specifier,
        });
      }
    }
  }
  return { checked, unresolved };
}

/**
 * WI-6666: `git ls-files -co --exclude-standard` (tracked + untracked-but-not-
 * ignored) STOPS AT THE SUPERPROJECT BOUNDARY — a submodule (libs/generic/**,
 * libs/papercusp/**, papercusp-desktop/**) is a single gitlink entry, so every
 * test file inside one — including libs/papercusp's own vitest suites — was
 * never scanned for an orphaned `vi.mock()`. `listFilesIncludingUntracked`
 * recurses into each submodule's own working tree with the same flags (git
 * refuses to combine `--others` with `--recurse-submodules` directly), so this
 * keeps BOTH the untracked-file coverage this guard always had AND submodule
 * coverage it never did.
 */
function trackedTestFiles(root) {
  const { files, unscanned } = listFilesIncludingUntracked(root);
  const filtered = files.filter((file) =>
    file &&
    TEST_FILE_RE.test(file) &&
    !file.startsWith('_retired/') &&
    !file.includes('/_retired/') &&
    !file.includes('/node_modules/') &&
    !file.includes('/dist/') &&
    !file.startsWith('.papercusp/'),
  );
  return { files: filtered, unscanned };
}

function isMain() {
  return process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isMain()) {
  const { files: testFiles, unscanned } = trackedTestFiles(ROOT);
  const result = findUnresolvedMocks({ files: testFiles, root: ROOT });
  if (result.unresolved.length === 0) {
    console.log(`✓ all ${result.checked} local vi.mock() specifiers resolve to real modules.` + describeUnscanned(unscanned));
  } else {
    console.error('✗ orphaned vi.mock() specifiers found:');
    for (const offender of result.unresolved) {
      console.error(`  ${offender.file}:${offender.line}  vi.mock('${offender.specifier}', ...)`);
    }
    console.error(
      '\nFix the mock path (or remove the mock). Third-party bare package mocks are not checked because optional packages may be absent by design.',
    );
    process.exitCode = 1;
  }
}
