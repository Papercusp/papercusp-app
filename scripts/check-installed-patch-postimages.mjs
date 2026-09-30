#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function runGit(repoRoot, args) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    const stderr = error.stderr ? String(error.stderr).trim() : '';
    throw new Error(
      'git ' + args.join(' ') + ' failed' + (stderr ? ': ' + stderr : ''),
    );
  }
}

function listWorkingPatchFiles(repoRoot) {
  const patchRoot = resolve(repoRoot, 'patches');
  if (!existsSync(patchRoot)) return [];

  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (
        (entry.isFile() || entry.isSymbolicLink()) &&
        entry.name.endsWith('.patch')
      ) {
        files.push(relative(repoRoot, absolutePath).split(sep).join('/'));
      }
    }
  };

  visit(patchRoot);
  return files.sort();
}

function hasNodeModulesPatchTarget(patchSource) {
  return /^(?:diff --git a\/node_modules\/|\+\+\+ b\/node_modules\/)/m.test(
    patchSource,
  );
}

export function parsePatchPostimages(patchSource, patchPath = '<patch>') {
  const postimages = [];
  let block = null;

  const finishBlock = () => {
    if (!block) return;
    const targetPath = block.newPath === '/dev/null' ? block.oldPath : block.newPath;
    if (!targetPath) {
      throw new Error('diff has no +++ target path');
    }
    if (
      !targetPath.startsWith('node_modules/') ||
      targetPath.startsWith('/') ||
      posix.normalize(targetPath) !== targetPath
    ) {
      throw new Error('unsupported patch target path: ' + targetPath);
    }
    if (!block.postHash) {
      throw new Error(
        'missing Git index postimage hash for ' + targetPath,
      );
    }

    const deleted = /^0+$/.test(block.postHash);
    if ((block.newPath === '/dev/null') !== deleted) {
      throw new Error('Git index hash disagrees with deletion for ' + targetPath);
    }
    postimages.push({
      path: targetPath,
      hash: deleted ? null : block.postHash,
    });
    block = null;
  };

  for (const line of String(patchSource).split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      finishBlock();
      const header = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      if (!header) throw new Error('unsupported diff header: ' + line);
      block = {
        oldPath: header[1],
        newPath: null,
        postHash: null,
        sawIndex: false,
      };
      continue;
    }
    if (!block) continue;

    if (line.startsWith('index ')) {
      if (block.sawIndex) throw new Error('duplicate Git index header');
      const index = line.match(
        /^index ([0-9a-f]{4,64})\.\.([0-9a-f]{4,64})(?: [0-7]{6})?$/i,
      );
      if (!index) throw new Error('invalid Git index header: ' + line);
      block.postHash = index[2].toLowerCase();
      block.sawIndex = true;
      continue;
    }

    if (line === '+++ /dev/null') {
      block.newPath = '/dev/null';
    } else if (line.startsWith('+++ b/')) {
      block.newPath = line.slice(6);
    }
  }
  finishBlock();

  if (postimages.length === 0) {
    throw new Error(patchPath + ' contains no node_modules file diffs');
  }
  return postimages;
}

export function verifyPostimages({
  patches,
  hashInstalled,
  modifiedPatchPaths = [],
  untrackedPatchPaths = [],
}) {
  const errors = [];
  let checked = 0;
  const seenTargets = new Set();

  if (patches.length === 0) {
    errors.push('HEAD contains no tracked patch-package patch files');
  }
  if (modifiedPatchPaths.length > 0) {
    errors.push(
      'patch sources differ from HEAD; patch-package may have applied local edits: ' +
        modifiedPatchPaths.join(', '),
    );
  }
  if (untrackedPatchPaths.length > 0) {
    errors.push(
      'untracked patch-package inputs are present: ' + untrackedPatchPaths.join(', '),
    );
  }

  for (const patch of patches) {
    let postimages;
    try {
      postimages = parsePatchPostimages(patch.contents, patch.path);
    } catch (error) {
      errors.push(patch.path + ': ' + (error instanceof Error ? error.message : String(error)));
      continue;
    }

    for (const postimage of postimages) {
      if (seenTargets.has(postimage.path)) {
        errors.push(
          'multiple committed patches target ' +
            postimage.path +
            '; their postimage order cannot be verified independently',
        );
        continue;
      }
      seenTargets.add(postimage.path);
      checked += 1;

      let actualHash;
      try {
        actualHash = hashInstalled(postimage.path);
      } catch (error) {
        errors.push(
          postimage.path +
            ': could not hash installed file: ' +
            (error instanceof Error ? error.message : String(error)),
        );
        continue;
      }

      if (postimage.hash === null) {
        if (actualHash !== null) {
          errors.push(postimage.path + ': expected the patched file to be absent');
        }
      } else if (typeof actualHash !== 'string') {
        errors.push(
          postimage.path +
            ': installed file is missing; expected Git blob ' +
            postimage.hash,
        );
      } else if (!actualHash.startsWith(postimage.hash)) {
        errors.push(
          postimage.path +
            ': installed blob ' +
            actualHash +
            ' does not match committed postimage ' +
            postimage.hash,
        );
      }
    }
  }

  return { ok: errors.length === 0, checked, errors };
}

export function checkInstalledPatchPostimages({ repoRoot = REPO_ROOT } = {}) {
  const allTrackedPatchPaths = runGit(repoRoot, [
    'ls-tree',
    '-r',
    '-z',
    '--name-only',
    'HEAD',
    '--',
    'patches',
  ])
    .split('\0')
    .filter((path) => path.endsWith('.patch'))
    .sort();
  const committedPatches = [];
  const modifiedPatchPaths = [];

  for (const patchPath of allTrackedPatchPaths) {
    const committedText = runGit(repoRoot, ['show', 'HEAD:' + patchPath]);
    if (!hasNodeModulesPatchTarget(committedText)) continue;
    const committed = Buffer.from(committedText, 'utf8');
    const workingPath = resolve(repoRoot, patchPath);
    if (!existsSync(workingPath)) {
      modifiedPatchPaths.push(patchPath + ' (missing from working tree)');
    } else if (!readFileSync(workingPath).equals(committed)) {
      modifiedPatchPaths.push(patchPath);
    }
    committedPatches.push({
      path: patchPath,
      contents: committed.toString('utf8'),
    });
  }

  const trackedPatchPackagePaths = new Set(
    committedPatches.map((patch) => patch.path),
  );
  const untrackedPatchPaths = listWorkingPatchFiles(repoRoot).filter((path) => {
    const absolutePath = resolve(repoRoot, path);
    const workingText = readFileSync(absolutePath, 'utf8');
    return (
      hasNodeModulesPatchTarget(workingText) &&
      !trackedPatchPackagePaths.has(path)
    );
  });

  return verifyPostimages({
    patches: committedPatches,
    modifiedPatchPaths,
    untrackedPatchPaths,
    hashInstalled: (targetPath) => {
      const absolutePath = resolve(repoRoot, targetPath);
      if (!absolutePath.startsWith(resolve(repoRoot) + sep)) {
        throw new Error('refusing path outside repository: ' + targetPath);
      }
      if (!existsSync(absolutePath)) return null;
      return runGit(repoRoot, ['hash-object', '--', targetPath]).trim();
    },
  });
}

function main() {
  let result;
  try {
    result = checkInstalledPatchPostimages();
  } catch (error) {
    console.error(
      'Installed patch postimage check could not run: ' +
        (error instanceof Error ? error.message : String(error)),
    );
    process.exitCode = 1;
    return;
  }

  if (result.ok) {
    console.log(
      'Verified ' + result.checked + ' installed patch postimage(s) against HEAD.',
    );
    return;
  }

  console.error('Installed patch postimage check failed:');
  for (const error of result.errors) console.error('  - ' + error);
  process.exitCode = 1;
}

if (isCliEntry(import.meta.url)) {
  main();
}
