/**
 * Generic VM (SSH-frame) build target driver. Captures the SHAPE of both
 * remote builds — the app injects the OS-specific specifics as a recipe:
 *
 *   pack-ship-build-collect (Windows / build-windows-on-vm.sh):
 *     tar the local tree → scp up → extract remotely → build in VM →
 *     assert → list + scp the bundle files back.
 *   build-in-place (Mac / mac-vm-build.sh):
 *     the tree is already on the VM → run the remote build → assert →
 *     list + scp the dmg back. (`recipe.pack` omitted.)
 *
 * Everything runs through the SshFrame (→ Exec port), so the choreography is
 * unit-testable with a fake. The OS-specific quirks (WSL rootfs, term-shim,
 * Authenticode, the keyless-sign assertion) live in the app's recipe, NOT here.
 *
 * NOTE: these drivers are structurally faithful to the existing scripts and
 * unit-tested for call sequence, but a LIVE Mac/Windows VM run is owner-gated
 * (needs the VMs + signing certs) — see the plan.
 */
import type {
  Artifact,
  PlatformKey,
  ReleasePorts,
  TargetDriver,
  TargetKey,
  TauriReleaseConfig,
} from '../types.js';
import { SshFrame } from '../ssh-frame.js';
import { joinPath } from '../path.js';
import { defaultClassifyArtifact, toArtifact } from '../artifacts.js';

export interface VmBuildRecipe {
  /** Pack + ship + extract the local tree first. Omit for build-in-place. */
  pack?: {
    /** `tar -C <localTreeParent>` parent dir. */
    localTreeParent: string;
    /** Directory under the parent to pack (e.g. 'papercusp-desktop'). */
    treeName: string;
    /** Paths to --exclude from the tarball. */
    excludes: string[];
    /** Local tarball path to write. */
    localTarball: string;
    /** Remote path to scp the tarball to. */
    remoteTarball: string;
    /** Remote command that removes+recreates the build dir, extracts, cleans up. */
    extractCommand: string;
  };
  /** The fully-formed remote build command (env prefix included by the app). */
  remoteBuildCommand: string;
  /** Reachability probe command (default `echo VM-OK`). */
  reachableProbe?: string;
  /** Decide success from the combined build log (default: exit 0). */
  assertSuccess?: (log: string) => boolean;
  /** Remote command listing the produced bundle filenames. */
  listCommand: string;
  /** Parse the list command's stdout into filenames (default: split lines). */
  parseList?: (stdout: string) => string[];
  /** Remote path for a produced bundle filename. */
  remoteBundlePath: (name: string) => string;
  /** Local dir to download artifacts into. */
  collectDir: string;
  /** Override the artifact → PlatformKey classifier. */
  classify?: (p: string) => PlatformKey | null;
}

const defaultParseList = (stdout: string): string[] =>
  stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

export function makeVmBuildDriver(
  key: TargetKey,
  recipeOf: (cfg: TauriReleaseConfig, ports: ReleasePorts) => VmBuildRecipe,
  vmKey: TargetKey = key,
): TargetDriver {
  return {
    key,
    async build(cfg, ports) {
      const vm = cfg.vm?.[vmKey];
      if (!vm) throw new Error(`no VM config for target "${vmKey}" (cfg.vm)`);
      const frame = new SshFrame(vm, ports.exec);
      const recipe = recipeOf(cfg, ports);

      if (!(await frame.reachable(recipe.reachableProbe ?? 'echo VM-OK'))) {
        throw new Error(`VM for ${key} unreachable on :${vm.port}`);
      }

      if (recipe.pack) {
        ports.log.info(`packing tree for ${key}`);
        const tarArgs = [
          '-czhf',
          recipe.pack.localTarball,
          ...recipe.pack.excludes.map((e) => `--exclude=${e}`),
          '-C',
          recipe.pack.localTreeParent,
          recipe.pack.treeName,
        ];
        const tar = await ports.exec.run('tar', tarArgs);
        if (tar.code !== 0) throw new Error(`tar failed: ${tar.stderr || tar.stdout}`);
        await frame.upload(recipe.pack.localTarball, recipe.pack.remoteTarball);
        const extract = await frame.run(recipe.pack.extractCommand);
        if (extract.code !== 0) {
          throw new Error(`remote extract failed: ${extract.stderr || extract.stdout}`);
        }
      }

      ports.log.info(`building ${key} in VM (this can take 15-25 min)`);
      const built = await frame.run(recipe.remoteBuildCommand);
      const log = `${built.stdout}\n${built.stderr}`;
      const ok = recipe.assertSuccess ? recipe.assertSuccess(log) : built.code === 0;
      if (!ok) throw new Error(`VM build for ${key} failed — tail: ${log.slice(-600)}`);

      const listed = await frame.run(recipe.listCommand);
      const names = (recipe.parseList ?? defaultParseList)(listed.stdout);
      const classify = recipe.classify ?? cfg.classifyArtifact ?? defaultClassifyArtifact;
      // EI-7474: scp-download into a not-yet-created collectDir fails "No such
      // file or directory" — a SUCCESSFUL remote build then silently drops its
      // artifact (0 collected). Create it (recursive, idempotent) once before
      // the download loop, same as every other consumer worked around by hand.
      await ports.fs.mkdir(recipe.collectDir);
      const artifacts: Artifact[] = [];
      for (const name of names) {
        const local = joinPath(recipe.collectDir, name);
        await frame.download(recipe.remoteBundlePath(name), local);
        artifacts.push(toArtifact(local, classify));
      }
      ports.log.info(`collected ${artifacts.length} artifact(s) for ${key}`);
      return artifacts;
    },
  };
}
