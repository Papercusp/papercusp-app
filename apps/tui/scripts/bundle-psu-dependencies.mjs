import { realpathSync } from 'node:fs';
import * as path from 'node:path';

// Identifier minification removes esbuild's debugging module-path labels.
// keepNames preserves function/class names used by runtime registration.
export const releaseMinification = Object.freeze({
  minifyWhitespace: true, minifySyntax: true, minifyIdentifiers: true, keepNames: true,
});

/**
 * Identify installed packages by the committed lock's install paths. Node and
 * esbuild resolve symlinks, so their physical directory can be outside ROOT.
 * Only an actual install path in this lock may admit that directory; source
 * containment and installed-version verification remain the caller's checks.
 */
export function lockedPackageKeyResolver(root, packages) {
  const rootPath = realpathSync(root);
  const installKeys = Object.keys(packages).filter((key) =>
    !path.posix.isAbsolute(key) && !key.includes('\\')
    && !key.split('/').includes('..')
    && /(^|\/)node_modules\//.test(key) && !packages[key].link);
  const installKeySet = new Set(installKeys);
  let physicalKeys;

  return (directory) => {
    const realDirectory = realpathSync(directory);
    const relativeKey = path.relative(rootPath, realDirectory).split(path.sep).join('/');
    if (installKeySet.has(relativeKey)) return relativeKey;

    if (!physicalKeys) {
      physicalKeys = new Map();
      for (const key of installKeys) {
        let physical;
        try {
          physical = realpathSync(path.join(rootPath, ...key.split('/')));
        } catch (error) {
          if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
          throw error;
        }
        const keys = physicalKeys.get(physical) ?? [];
        keys.push(key);
        physicalKeys.set(physical, keys);
      }
    }
    const keys = physicalKeys.get(realDirectory) ?? [];
    if (keys.length === 1) return keys[0];
    if (keys.length > 1) {
      throw new Error(`installed package has ambiguous lock paths: ${keys.join(', ')}`);
    }
    throw new Error(`installed package is not reachable through a locked install path: ${directory}`);
  };
}
