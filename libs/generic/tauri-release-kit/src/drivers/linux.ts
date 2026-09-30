/** Linux target drivers — build locally on the host (no VM frame). */
import type { TargetDriver, TargetKey } from '../types.js';
import { defaultClassifyArtifact } from '../artifacts.js';
import {
  bundleRootFor,
  collectArtifacts,
  resolveTargetDir,
  runTauriBuild,
} from '../tauri-build.js';

export function makeLinuxDriver(
  key: TargetKey,
  target: string | undefined,
  subdirs: string[],
): TargetDriver {
  return {
    key,
    async build(cfg, ports) {
      await runTauriBuild(ports, cfg, target);
      const targetDir = await resolveTargetDir(ports, cfg);
      const bundleRoot = bundleRootFor(targetDir, target);
      const classify = cfg.classifyArtifact ?? defaultClassifyArtifact;
      return collectArtifacts(ports, bundleRoot, subdirs, classify, { version: cfg.version });
    },
  };
}

/** Host x86_64 build (Tauri's default target). */
export const linuxX86Driver = makeLinuxDriver('linux-x86_64', undefined, [
  'deb',
  'appimage',
  'rpm',
]);

/** Cross-compiled arm64 build (needs `cross`); matches WITH_ARM64 in release-local.sh. */
export const linuxArm64Driver = makeLinuxDriver(
  'linux-aarch64',
  'aarch64-unknown-linux-gnu',
  ['deb', 'appimage'],
);
