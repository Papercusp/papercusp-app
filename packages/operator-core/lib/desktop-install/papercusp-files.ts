/**
 * Phase 1 (always-on) of desktop-app-install-integration-2026-05-23:
 *
 * Mint / reuse the superuser-token + agent_id, copy the engineer-
 * collaborator playbook + coordination extension into ~/.papercusp/.
 *
 * Idempotent: token + agent_id are minted only on first call; subsequent
 * calls reuse the existing values (per a03fb875 — don't disrupt live
 * shells by rotating their bearer). Playbook + extension are refreshed
 * every call so app updates flow to the user.
 *
 * Node port of steps 1–2b + 4 + 4c of install-standalone-mcp.sh. The
 * shell script remains the dev/repo path; this is the
 * Papercusp.app/sidecar path (D-001a).
 */

import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import * as TOML from '@iarna/toml';
import { fileURLToPath } from 'node:url';
import { createTextCollector } from '../child-output';
import { filterInstallSources, describeRefusals } from './install-source-guard';
// Single definition, shared with the pot-git ext:: transport (EI-20078551747038927).
// Re-exported below so existing importers of this module keep resolving it here.
import { resolveBundledNode } from '../bundled-node';
import { standardToolDirs } from '../tool-path';
// WI-37920 / P-006: the ONE list of where a backend CLI can live, shared with
// psu's own detection and the operator's spawn-PATH injection.
import { BACKEND_AGENTS, backendSearchDirs, resolveOnPath } from '../backend-bin-resolve.mjs';
export { resolveBundledNode };
import {
  readInstallStamp,
  writeInstallStamp,
  classifyDowngrade,
  resolveSourceGitProvenance,
  resolveUncommittedSources,
  gcStrandedInstallTmp,
} from './install-provenance';
import {
  spliceAtMarker,
  spliceToolingOverlay,
  spliceGeneratedSection,
  WIRE_SCHEMAS_MARKER,
  COORD_LEGEND_MARKER,
  WORKSPACE_MAP_MARKER,
  PROMOTION_MODEL_MARKER,
  PROJECT_GUIDE_MARKER,
  AUTO_MODE_MARKER,
  COMPACTION_MARKER,
  COMPACTION_CLIENT_OVERLAY_MARKER,
  RESULT_DOOR_MARKER,
  SHARED_BASE_NOTES_MARKER,
} from './splice-tooling-overlay';
import { renderResultDoorSection } from '../result-door-prompt';
import { renderModesPolicy } from '../operating-modes-policy';
import { renderDeployPipelineNote } from '../deploy-pipeline-policy';
import { renderWaitLoopNote } from '../wait-loop-policy';
import { renderPeerWakeNote } from '../peer-wake-policy';
import { renderCouplingNote } from '../coupling-policy';
import { renderStatePlaneNote } from '../state-plane-policy';
import { renderWorkspaceMapSection } from './workspace-map';
import { renderPromotionModelSection } from './promotion-model';
import { renderWireSchemasSection } from '../prompt-assembly';
import { renderCoordLegend } from '../coord-schema';

export interface InstallPaths {
  /** ~/.papercusp/ — created if missing. */
  papercuspDir: string;
  /** ~/.papercusp/superuser-token — created mode 0600 if missing. */
  tokenPath: string;
  /** ~/.papercusp/su-agent-id — created mode 0600 if missing. */
  agentIdPath: string;
  /** ~/.papercusp/engineer-collaborator.md — refreshed every call. */
  playbookPath: string;
  /** ~/.papercusp/papercusp-coord.ts — refreshed every call. */
  extensionPath: string;
  /** ~/.papercusp/compaction-strategy.md — Claude compaction floor (base+claude
   *  overlay), @import-ed by ~/.claude/CLAUDE.md's `# Compact Instructions`. */
  compactionStrategyPath: string;
  /** ~/.papercusp/bin — user-writable dir for the on-PATH CLI shims. */
  binDir: string;
  /** ~/.papercusp/bin/psu — superuser launcher shim → the bundled psu.mjs. */
  psuPath: string;
  /** ~/.papercusp/bin/ptool — defineTool CLI shim → the bundled ptool.mjs. */
  ptoolPath: string;
  /** ~/.papercusp/bin/papercusp — installed CLI dispatcher for onboarding and
   *  the standalone Project History generator. */
  papercuspCliPath: string;
  /** ~/.papercusp/bin/psu-sentinel — the 🛡 Sentinel dock pane launcher (EI-9935-adjacent
   *  WI-4244 fix): registers the pane for voice-transcript routing, applies a per-session
   *  model override, then execs the just-written `psu` shim with `--role=papercup`. Mirrors
   *  apps/operator/scripts/psu-sentinel.sh (the dev-repo source of truth for this logic),
   *  which was NEVER added to the on-boot shim set — the packaged app's dock layout invokes
   *  `psu-sentinel` by name (apps/tui/src/layout.rs) but nothing ever put it on PATH. */
  psuSentinelPath: string;
  /** ~/.papercusp/bin/psu-sentinel-deep — the deep-brain dock pane launcher
   *  (voice-public-release-readiness-2026-07-12 P-014): registers the pane to
   *  sentinel-deep-pane, applies ~/.papercusp/sentinel-deep-model (absent ⇒ the
   *  heavy `opus:xhigh` default), then execs the psu shim with
   *  `--role=papercup-deep`. Mirrors apps/operator/scripts/psu-sentinel-deep.sh. */
  psuSentinelDeepPath: string;
  /** ~/.papercusp/bin/rg — ripgrep entry point (WI-41085 / P-017). The dir is appended
   *  LAST to augmentedSpawnPath's `extra`, so this can only SUPPLY `rg` when the host has
   *  none; a real ripgrep already on PATH always wins. Generated here rather than
   *  hand-placed at ~/.local/bin/rg, which was a host file outside git that did not
   *  reproduce on a fresh machine. */
  ripgrepPath: string;
  /** ~/Applications/Papercusp Tutorial & Setup.app — macOS-only clickable launcher that opens a
   *  Terminal window running `papercusp tutorial` (windows-macos-tutorial-shortcut-parity
   *  2026-07-04, WI-2197 — macOS/Dock-Applications parity with the Linux .desktop icon). */
  macTutorialAppPath: string;
  /** ~/.local/share/applications/papercusp-tutorial.desktop — Linux-only per-user XDG
   *  launcher for the guided tutorial (the .deb writes a system twin under /usr/share). */
  linuxTutorialDesktopPath: string;
}

export interface InstallResult extends InstallPaths {
  /**
   * Indicates which artifacts were newly minted on this call.
   * Playbook/extension are not tracked here (always written).
   */
  minted: { token: boolean; agentId: boolean };
  /** True when the playbook source file was found and copied. */
  playbookWritten: boolean;
  /** True when the extension source file was found and copied. */
  extensionWritten: boolean;
  /** True when the compaction-strategy.md floor was rendered + written. */
  compactionStrategyWritten: boolean;
  /** Where the playbook source was read from. Empty when not found. */
  playbookSource: string;
  /** Where the extension source was read from. Empty when not found. */
  extensionSource: string;
  /** True when the `psu` shim was written (bundled/dev launcher resolved). */
  psuShimWritten: boolean;
  /** True when the `ptool` shim was written. */
  ptoolShimWritten: boolean;
  /** True when the `papercusp` dispatcher shim was written (P-014). */
  papercuspCliWritten: boolean;
  /** True when the `psu-sentinel` dock-pane launcher shim was written (WI-4244). Only
   *  attempted when the `psu` shim itself was written this call — sentinel execs psu. */
  psuSentinelShimWritten: boolean;
  /** True when the `psu-sentinel-deep` deep-brain pane launcher shim was written
   *  (voice-public-release-readiness P-014). Same gating as psu-sentinel. */
  psuSentinelDeepShimWritten: boolean;
  /** True when the `rg` entry point was written (P-017). FALSE means a real ripgrep
   *  already resolves on PATH and the shim deliberately stood aside — not a failure. */
  ripgrepShimWritten: boolean;
  /** True when the macOS "Papercusp Tutorial & Setup.app" wrapper was written (darwin only, WI-2197). */
  macTutorialAppWritten: boolean;
  /** True when the Linux per-user tutorial `.desktop` launcher was written (linux only). */
  linuxTutorialDesktopWritten: boolean;
  /** True when the tutorial launcher was newly pinned to the GNOME dock this call (linux
   *  only; one-time via a marker so a later user un-pin is respected). */
  linuxTutorialPinned: boolean;
  /** Resolved psu launcher the shim points at. Empty when not found. */
  psuLauncherSource: string;
  /** Resolved ptool launcher the shim points at. Empty when not found. */
  ptoolLauncherSource: string;
  /** Resolved onboarding-concierge launcher the dispatcher points at. Empty when not found. */
  onboardLauncherSource: string;
  /** Resolved standalone project-history launcher. Empty when not packaged. */
  projectHistoryLauncherSource: string;
  /** Shell-profile files updated to put ~/.papercusp/bin on PATH (empty if none). */
  pathProfilesUpdated: string[];
  /** The CC hook scripts copied to ~/.papercusp/hooks/cc/ this call (empty when the
   *  sources weren't shipped — the pre-EI-8191 Mac/Windows gap). */
  claudeHooksInstalled: string[];
  /** Context-injection files installed under ~/.papercusp/hooks/ (dispatcher +
   *  omp artifact), relative to that dir. EMPTY means none — never partial, so a
   *  caller can treat [] as "omp injection inactive on this box". */
  injectionHooksInstalled: string[];
  /** True when the CC hooks + fleet statusline were merged into ~/.claude/settings.json. */
  claudeSettingsMerged: boolean;
  /** True when [tui].status_line was merged into an existing ~/.codex/config.toml this call
   *  (false when codex isn't set up here or the user already configured their own status line). */
  codexStatusLineMerged: boolean;
}

export interface InstallOpts {
  /** Override ~/. Useful for tests. Defaults to os.homedir(). */
  home?: string;
  /**
   * Override the playbook source path. Defaults to first-found among
   * the candidate layout list (see `playbookCandidates`).
   */
  playbookSource?: string;
  /**
   * Override the extension source path. Defaults to first-found among
   * the candidate layout list (see `extensionCandidates`).
   */
  extensionSource?: string;
  /**
   * Operator app root. Defaults to walking up from this module's
   * location. Used as the *primary* candidate for default source
   * resolution. Tests set this to a fake tree.
   */
  operatorAppRoot?: string;
}

/**
 * Mint a 32-character base64url-safe token. The shell script does
 * `head -c 24 /dev/urandom | base64 | tr -d '+/=' | head -c 32` —
 * which actually yields variable length (~26 chars) because base64
 * of 24 bytes has zero padding chars but does contain `+`/`/`. The
 * Node port uses base64url for clean fixed-length 32 chars with the
 * same 24-byte (192-bit) entropy — strictly more secure than the
 * shell version, and read by the same consumers (bearer string, no
 * length check).
 */
function mintToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

function mintAgentId(): string {
  return crypto.randomUUID();
}

async function readNonEmptyFile(p: string): Promise<string | null> {
  try {
    const s = await fs.readFile(p, 'utf8');
    const trimmed = s.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

async function ensureSecret(filePath: string, mint: () => string): Promise<{ value: string; minted: boolean }> {
  const existing = await readNonEmptyFile(filePath);
  if (existing) return { value: existing, minted: false };
  const value = mint();
  await fs.writeFile(filePath, value + '\n', { mode: 0o600 });
  // writeFile honors mode only on creation; chmod to guarantee on overwrite.
  await fs.chmod(filePath, 0o600);
  return { value, minted: true };
}

async function copyOmpFile(src: string, dst: string): Promise<boolean> {
  try {
    const data = await fs.readFile(src);
    // OMP can load these files while another psu launch refreshes them. Keep
    // the established temp-file + rename atomicity so a companion bundle is
    // never observed as a torn source file.
    const tmp = `${dst}.psu-install.${process.pid}.tmp`;
    await fs.writeFile(tmp, data, { mode: 0o644 });
    await fs.chmod(tmp, 0o644);
    await fs.rename(tmp, dst);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}

const LOCAL_OMP_IMPORT_RE =
  /\bfrom\s+['"](\.[^'"]+)['"]|\bimport\s+['"](\.[^'"]+)['"]|\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function localOmpImportCandidates(importer: string, specifier: string): string[] {
  // OMP's TypeScript loader accepts extensionless imports. Keep the check a little
  // broader so a future hook extraction using an explicit .js/.mjs specifier is
  // still diagnosed against the source .ts sibling instead of silently passing.
  const cleanSpecifier = specifier.split(/[?#]/, 1)[0];
  const raw = path.resolve(path.dirname(importer), cleanSpecifier);
  const ext = path.extname(raw);
  const stem = ext ? raw.slice(0, -ext.length) : raw;
  return [
    ...new Set([
      raw,
      `${raw}.ts`,
      `${raw}.mjs`,
      `${stem}.ts`,
      `${stem}.mts`,
      `${stem}.tsx`,
      `${stem}.mjs`,
      path.join(raw, 'index.ts'),
      path.join(stem, 'index.ts'),
      path.join(raw, 'index.mjs'),
      path.join(stem, 'index.mjs'),
    ]),
  ];
}

/**
 * Check the files that will be loaded by OMP before the install is reported
 * healthy. OMP appends a cache-busting query to the error it logs, but the
 * source import is a normal relative specifier; resolving that specifier here
 * catches the exact "copied importer, omitted sibling" failure at install time.
 */
async function findUnresolvedOmpImports(filePath: string): Promise<string[]> {
  let source: string;
  try {
    source = await fs.readFile(filePath, 'utf8');
  } catch {
    return [`${path.basename(filePath)} (file unreadable)`];
  }

  const unresolved: string[] = [];
  for (const match of source.matchAll(LOCAL_OMP_IMPORT_RE)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (!specifier) continue;
    const candidates = localOmpImportCandidates(filePath, specifier);
    if (!(await Promise.all(candidates.map(isRegularFile))).some(Boolean)) {
      unresolved.push(`${path.basename(filePath)} -> ${specifier}`);
    }
  }
  return unresolved;
}

export interface OmpHookBundleInstallResult {
  /** Destination-relative files written in this pass. */
  installed: string[];
  /** Destination-relative importer → missing relative module diagnostics. */
  unresolved: string[];
}

/**
 * Agent-facing hooks are shared mutable executables, not ordinary release
 * assets: a process from the green release checkout and one from staging can
 * install into the same home minutes apart. Refuse *any* known older source
 * here. The generic CC-hook guard keeps a 24h rollback margin, but that margin
 * is too wide for this surface — one recent missing provider hook is enough to
 * change the behavior of the next agent launch.
 */
async function refuseKnownOlderHookSource(
  label: string,
  sourceDir: string,
  stampDir: string,
  incoming?: Awaited<ReturnType<typeof resolveSourceGitProvenance>>,
): Promise<boolean> {
  const existing = await readInstallStamp(stampDir);
  const verdict = classifyDowngrade(existing, incoming ?? (await resolveSourceGitProvenance(sourceDir)), 0);
  if (!verdict.downgrade) return false;
  console.error(
    `[desktop-install] ${label}: REFUSING downgrade — source ${sourceDir} ` +
      `(${verdict.incomingAt}) is older than the installed hook source ` +
      `(${verdict.installedAt}, from ${existing?.sourceDir}). Leaving the newer hooks in place.`,
  );
  return true;
}

/**
 * Install an OMP TypeScript hook together with every sibling `.ts` artifact,
 * or install one self-contained `.mjs` release bundle under the caller's
 * established destination name.
 *
 * The OMP runner loads TypeScript files independently from the sidecar's main
 * esbuild bundle, so a
 * new relative import must travel with the importer. Direct siblings are used
 * deliberately (rather than naming today's `non-preempting-delivery.ts`) so a
 * future extraction cannot recreate the same partial-install class. `entryFile`
 * may be renamed at the destination (`coord-hook.ts` → `papercusp-coord.ts`).
 * A `.mjs` entry is already bundled and therefore copies only that entry, never
 * unrelated sibling bundles; vm-release uses this path while preserving the
 * `.ts` destination names consumed by existing OMP launchers.
 * `__tests__` is a directory and is therefore never copied.
 *
 * The post-copy import check is an out-of-band detector: a broken OMP extension
 * cannot report its own death through coord, so the installer emits a stable,
 * grep-able error before the next session starts.
 */
export async function installOmpHookBundle(opts: {
  sourceDir: string;
  entryFile: string;
  destinationDir: string;
  destinationEntry?: string;
  /** Existing provenance for the shared hook family this copy must not downgrade. */
  provenanceGuardDir?: string;
  provenanceLabel?: string;
}): Promise<OmpHookBundleInstallResult> {
  const destinationEntry = opts.destinationEntry ?? opts.entryFile;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(opts.sourceDir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { installed: [], unresolved: [] };
    }
    throw e;
  }

  const sourceFiles = opts.entryFile.endsWith('.mjs')
    ? entries
        .filter((entry) => entry.isFile() && entry.name === opts.entryFile)
        .map((entry) => entry.name)
    : entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
        .map((entry) => entry.name)
        .sort();
  if (!sourceFiles.includes(opts.entryFile)) {
    return { installed: [], unresolved: [] };
  }

  if (
    opts.provenanceGuardDir &&
    (await refuseKnownOlderHookSource(
      opts.provenanceLabel ?? 'OMP hook bundle',
      opts.sourceDir,
      opts.provenanceGuardDir,
    ))
  ) {
    return { installed: [], unresolved: [] };
  }

  await fs.mkdir(opts.destinationDir, { recursive: true, mode: 0o755 });
  const installed: string[] = [];
  for (const file of sourceFiles) {
    const destinationName = file === opts.entryFile ? destinationEntry : file;
    if (await copyOmpFile(path.join(opts.sourceDir, file), path.join(opts.destinationDir, destinationName))) {
      installed.push(destinationName);
    }
  }

  const unresolved: string[] = [];
  for (const file of installed) {
    unresolved.push(...(await findUnresolvedOmpImports(path.join(opts.destinationDir, file))));
  }
  if (unresolved.length > 0) {
    console.error(
      `[desktop-install] OMP hook bundle load check FAILED in ${opts.destinationDir}: ` + unresolved.join('; '),
    );
  }
  return { installed, unresolved };
}

/** Read the per-agent tooling overlay (`papercusp-su.<agent>.md`) beside
 *  the base playbook; missing → '' (the marker is still removed, never
 *  shipped literally). One reader for every client (omp/claude/codex) so
 *  the install path and `buildLaunchSpec`'s `su` branch can't drift. */
async function readAgentOverlay(baseSrc: string, agent: string, overlayDir?: string): Promise<string> {
  const overlayPath = path.join(overlayDir ?? path.dirname(baseSrc), `papercusp-su.${agent}.md`);
  try {
    return (await fs.readFile(overlayPath, 'utf8')).replace(/\n+$/, '');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw e;
  }
}

/** Read the agent self-management compaction protocol
 *  (`papercusp-compaction.protocol.md`) beside the base playbook; missing → ''
 *  (the marker is still removed, never shipped literally). Client-neutral — the
 *  same protocol for every agent. agent-managed-compaction-2026-07-01. */
async function readCompactionProtocol(baseSrc: string, overlayDir?: string): Promise<string> {
  const p = path.join(overlayDir ?? path.dirname(baseSrc), 'papercusp-compaction.protocol.md');
  try {
    return (await fs.readFile(p, 'utf8')).replace(/\n+$/, '');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw e;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Render the Claude compaction floor: papercusp-compaction.base.md with the
 * papercusp-compaction.claude.md overlay spliced at COMPACTION_CLIENT_OVERLAY_MARKER,
 * leading HTML comments stripped. Written to ~/.papercusp/compaction-strategy.md and
 * @import-ed by CLAUDE.md's `# Compact Instructions`. Empty base -> '' (nothing to
 * write). agent-managed-compaction-2026-07-01.
 */
export async function renderCompactionStrategy(promptsDir: string): Promise<string> {
  const base = await readNonEmptyFile(path.join(promptsDir, 'papercusp-compaction.base.md'));
  if (!base) return '';
  const overlay = await readNonEmptyFile(path.join(promptsDir, 'papercusp-compaction.claude.md'));
  const overlayBody = overlay ? overlay.replace(/^<!--[\s\S]*?-->\s*/, '').trim() : '';
  const spliced = spliceAtMarker(base, COMPACTION_CLIENT_OVERLAY_MARKER, overlayBody);
  const body = spliced.replace(/^<!--[\s\S]*?-->\s*/, '').trim();
  // GENERATED artifact — stamp a do-not-hand-edit banner (drift guard, P-010).
  const banner =
    '<!-- GENERATED — do not hand-edit. Edit apps/operator/prompts/papercusp-compaction.base.md' +
    ' (+ .claude.md overlay), then reinstall. agent-managed-compaction-2026-07-01. -->';
  return `${banner}\n\n${body}`;
}

/**
 * Ensure `<home>/.claude/CLAUDE.md` carries a managed `# Compact Instructions`
 * stanza that @import-s the rendered compaction-strategy.md (the Claude compaction
 * floor). Idempotent + marker-delimited so it never clobbers the owner's own
 * CLAUDE.md; re-running replaces only the managed block. Best-effort — a failure
 * never breaks the install. agent-managed-compaction-2026-07-01.
 */
async function ensureClaudeCompactImport(home: string, strategyPath: string): Promise<boolean> {
  const claudeDir = path.join(home, '.claude');
  const claudeMd = path.join(claudeDir, 'CLAUDE.md');
  const BEGIN = '<!-- PAPERCUSP-COMPACTION:BEGIN (managed — do not edit) -->';
  const END = '<!-- PAPERCUSP-COMPACTION:END -->';
  const block = `${BEGIN}\n# Compact Instructions\n\n@${strategyPath}\n${END}`;
  try {
    await fs.mkdir(claudeDir, { recursive: true });
    let existing = '';
    try {
      existing = await fs.readFile(claudeMd, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const re = new RegExp(`${escapeRe(BEGIN)}[\\s\\S]*?${escapeRe(END)}`);
    const next = re.test(existing)
      ? existing.replace(re, block)
      : existing.replace(/\n+$/, '') + (existing.trim() ? '\n\n' : '') + block + '\n';
    if (next !== existing) {
      await fs.writeFile(claudeMd, next, { mode: 0o644 });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Wrap the project guide (the repo's `CLAUDE.md`) for splicing into a psu
 * playbook (psu-isolation P-001 / D-002). Empty guide → '' so the marker is
 * removed, never shipped literally. The provenance header tells the agent this
 * is the repo's editable guide delivered by splice (NOT client auto-load), so
 * a session knows where to edit it and that personal config was deliberately
 * left out.
 */
export function renderProjectGuideSection(guideText: string): string {
  const body = guideText.replace(/\n+$/, '').trim();
  if (!body) return '';
  return (
    '## Project guide — repo conventions\n\n' +
    "> The following is the working repo's project guide (`CLAUDE.md` at the\n" +
    '> repo root — the single editable source; `AGENTS.md` is a symlink to it).\n' +
    '> It is spliced in here so a psu session gets these conventions WITHOUT the\n' +
    '> client auto-loading the file (which would also drag in the launching\n' +
    "> user's personal/global config). To change it, edit the repo's `CLAUDE.md`.\n\n" +
    body +
    '\n'
  );
}

/**
 * Candidate project-guide (`CLAUDE.md`) paths for the ENGINEER profile — the
 * working repo's own guide, resolved relative to the resolved base playbook
 * (which lives at `<repo>/apps/operator/prompts/`) and `process.cwd()`. The
 * power profile passes an explicit `projectGuideSource` (the managed repo's
 * guide) instead of relying on this. First existing wins; none → no guide.
 */
function projectGuideCandidates(baseSource: string): string[] {
  const promptsDir = path.dirname(baseSource);
  return [
    path.resolve(promptsDir, '..', '..', '..', 'CLAUDE.md'), // <repo>/apps/operator/prompts → <repo>
    path.resolve(promptsDir, '..', 'CLAUDE.md'), // <sidecar>/prompts → <sidecar>
    path.join(process.cwd(), 'CLAUDE.md'),
  ];
}

/**
 * Resolve + read the project guide for splicing. `explicitSource` (when not
 * undefined) wins — including '' which means "no guide" (e.g. a power launch
 * whose managed repo has none). Otherwise auto-resolve the engineer candidates.
 * Reads only when the base actually carries the marker (the caller gates this),
 * so a markerless base never pays the file read.
 */
async function resolveProjectGuideText(
  baseSource: string,
  explicitSource: string | undefined,
): Promise<{ text: string; source: string }> {
  const source =
    explicitSource !== undefined ? explicitSource : ((await firstExisting(projectGuideCandidates(baseSource))) ?? '');
  if (!source) return { text: '', source: '' };
  try {
    return { text: await fs.readFile(source, 'utf8'), source };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { text: '', source: '' };
    throw e;
  }
}

/**
 * Project the shared, cross-cutting BEHAVIORAL notes — canonical constants owned by
 * `@papercusp/orchestrator` (re-exported through operator-core's policy wrappers) — into the
 * su playbook from the SINGLE source. Currently `DEPLOY_PIPELINE_NOTE` (the "deploy pipeline is
 * async; a RED gate is EVERYONE's job to FIX, no owner-ask, even out of lane" directive),
 * `WAIT_LOOP_NOTE` (the "waiting on something? arm a self-wake LOOP — never sleep on an event that
 * may never fire; re-check + FIX what's preventing it" directive), and `PEER_WAKE_NOTE` (the "you can
 * WAKE a peer; a parked agent sleeps until something re-invokes it, so handing work off is not enough"
 * directive) — all of which the su base playbook otherwise misses entirely while the spawned-bee +
 * operator-launched bases already inject them programmatically (prompt-build.ts / prompt-assembly.ts).
 * This keeps such universal directives
 * in ONE place that projects to EVERY base, model/provider-agnostic (plain strings spliced
 * regardless of model), ADDITIVELY — su's existing condensed notes and the `.md` prompt files are
 * left untouched. Inserted just before the project-guide section so they sit in the playbook body,
 * not buried under the 600-line guide.
 */
function injectSharedBaseNotes(text: string, opts: { repoSpecific?: boolean; eligible?: boolean } = {}): string {
  // POSITION and ELIGIBILITY are now decided SEPARATELY. Conflating them is what caused the
  // 12-day silent drop (see SHARED_BASE_NOTES_MARKER's doc-comment):
  //
  //   · POSITION — an optional hint. SHARED_BASE_NOTES_MARKER places the bundle exactly;
  //     PROJECT_GUIDE_MARKER is the legacy anchor that keeps the `.tools.md` bases' existing
  //     placement (notes just BEFORE the guide). With NEITHER, the notes are APPENDED.
  //   · ELIGIBILITY — `opts.eligible`, decided by the CALLER from the ORIGINAL base, because
  //     only the caller can still see markers that the splices have by now consumed. A
  //     minimal/test base is ineligible and still gets nothing.
  //
  // The bundle is MANDATORY for a real su playbook, so a missing marker must never mean
  // "ship nothing" — it means "no preferred position stated". That inversion is the fix: the
  // old code treated an absent anchor as an absent REQUIREMENT, so the live base losing an
  // unrelated feature's marker silently dropped five behavioural clauses.
  const { repoSpecific = true, eligible = false } = opts;
  const anchor = text.includes(SHARED_BASE_NOTES_MARKER)
    ? SHARED_BASE_NOTES_MARKER
    : text.includes(PROJECT_GUIDE_MARKER)
      ? PROJECT_GUIDE_MARKER
      : '';
  if (!anchor && !eligible) return text;
  const notes = [
    // REPO-SPECIFIC: the deploy-pipeline note names :3070, the green gate and this repo's
    // promotion stages, so it is meaningful only for a profile that works the Papercusp repo.
    // Everything below it is PLATFORM-wide and applies to any su session on any repo — that
    // split is the whole reason this takes a flag rather than gating the entire bundle. Before
    // the split, `profile === 'engineer'` gated ALL of these, which silently withheld the
    // coupling note from su-power even though D-062's owner directive was explicitly "ALL
    // agents" — a platform behaviour lost to a repo-specific gate it had been bundled with.
    ...(repoSpecific ? [renderDeployPipelineNote()] : []),
    renderWaitLoopNote(),
    renderPeerWakeNote(),
    // Coupling (owner directive 2026-07-27; P-031, D-061/D-062) — the owner's ask was
    // explicitly ALL agents, and su sessions couple/decouple like any other role.
    renderCouplingNote(),
    // The state plane's two agent-CHOICE behaviours (unified-agent-state-plane-2026-07-27):
    // read a cell rather than transcribing a value, and say what you want back / section a
    // message that mixes dispositions. su sessions are the HEAVIEST users of both surfaces —
    // they send the directed messages and they act on live pipeline/gate values — and the
    // measured non-adoption (state:read 5 agents of 157; the sectioned body never once
    // agent-authored) includes them. Platform-wide: `coord:send` and `state:read` are operator
    // tools, not repo tools, so a power-profile session needs this exactly as much.
    renderStatePlaneNote(),
  ].filter((n) => n && n.trim());
  const body = notes.join('\n\n');
  if (!anchor) {
    // Eligible base with no position stated: append. Placement is less important than
    // DELIVERY — these are standing behavioural clauses, not a section the reader navigates
    // to, and shipping them at the end beats shipping them nowhere.
    return notes.length === 0 ? text : `${text.replace(/\n+$/, '')}\n\n${body}\n`;
  }
  if (anchor === SHARED_BASE_NOTES_MARKER) {
    // The bundle's own marker is CONSUMED — replaced by the notes, or removed outright when
    // there are none, so an internal marker can never leak into a rendered prompt
    // (psu-prompt-isolation). Same contract as spliceGeneratedSection.
    return text.split(SHARED_BASE_NOTES_MARKER).join(body);
  }
  // Legacy anchor: insert BEFORE the project guide and LEAVE the marker in place — the guide
  // splice that runs after us still needs it.
  if (notes.length === 0) return text;
  return text.split(PROJECT_GUIDE_MARKER).join(`${body}\n\n${PROJECT_GUIDE_MARKER}`);
}

/**
 * Write the base playbook with the OMP tooling overlay spliced in at
 * the marker (or appended, if a pre-marker base is ever encountered).
 * Node port of `render_playbook` from install-standalone-mcp.sh.
 * Returns false when the base source is missing.
 */
async function writeSplicedPlaybook(baseSrc: string, dst: string): Promise<boolean> {
  let base: string;
  try {
    base = await fs.readFile(baseSrc, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
  const overlay = await readAgentOverlay(baseSrc, 'omp');
  let out = spliceGeneratedSection(
    spliceToolingOverlay(base, overlay),
    WIRE_SCHEMAS_MARKER,
    renderWireSchemasSection(),
  );
  out = spliceGeneratedSection(out, COORD_LEGEND_MARKER, renderCoordLegend());
  out = spliceGeneratedSection(out, WORKSPACE_MAP_MARKER, renderWorkspaceMapSection());
  // per-hive-git-and-release-gate P-012: the staging→main promotion contract, generated
  // from the same release-gate config (non-coding hives render nothing → marker removed).
  out = spliceGeneratedSection(out, PROMOTION_MODEL_MARKER, renderPromotionModelSection());
  // Operating modes (AUTO act-don't-ask switch + its AUTO↔loop relationship, plus the IDEATE
  // invent-vs-patch switch and the AUTO×IDEATE composition table) — profile-agnostic, so both
  // engineer + power get the one canonical clause spliced here at the (still-named) AUTO marker.
  out = spliceGeneratedSection(out, AUTO_MODE_MARKER, renderModesPolicy());
  // agent-context-firewall P-015: the per-result door cap + the `projection` knob,
  // sourced from computeTurnDoors so the taught number cannot drift from the enforced one.
  out = spliceGeneratedSection(out, RESULT_DOOR_MARKER, renderResultDoorSection());
  // agent-managed-compaction: the agent self-management compaction protocol (client-neutral).
  out = spliceGeneratedSection(out, COMPACTION_MARKER, await readCompactionProtocol(baseSrc));
  // Same eligibility rule as renderSuPlaybook, read off the ORIGINAL base (see there).
  out = injectSharedBaseNotes(out, {
    eligible: base.includes(PROJECT_GUIDE_MARKER) || base.includes(AUTO_MODE_MARKER),
  });
  // Project guide (P-001): engineer-profile install splices the repo's CLAUDE.md.
  if (out.includes(PROJECT_GUIDE_MARKER)) {
    const { text } = await resolveProjectGuideText(baseSrc, undefined);
    out = spliceGeneratedSection(out, PROJECT_GUIDE_MARKER, renderProjectGuideSection(text));
  }
  await fs.writeFile(dst, out, { mode: 0o644 });
  await fs.chmod(dst, 0o644);
  return true;
}

/**
 * Resolve the operator app root from the directory containing this module.
 *
 * The source module lives below `packages/operator-core`, while an esbuild
 * bundle collapses the module directory to `sidecar/` and the dist-host build
 * puts it below `apps/operator/`. A fixed number of `..` hops therefore cannot
 * describe all three layouts. Walk upward and accept either an existing
 * `<ancestor>/apps/operator` (source/package sidecar) or an ancestor already
 * named `apps/operator` (dist-host/source app). The artifact check makes the
 * source and packaged choices self-validating instead of cwd-dependent.
 */
export function resolveOperatorAppRootFromModuleDir(moduleDir: string): string {
  const originalDir = path.resolve(moduleDir);
  let dir = originalDir;
  while (true) {
    if (path.basename(dir) === 'operator' && path.basename(path.dirname(dir)) === 'apps') {
      return dir;
    }

    const packagedAppRoot = path.join(dir, 'apps', 'operator');
    if (existsSync(packagedAppRoot)) return packagedAppRoot;

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Preserve the old best-effort fallback for an incomplete/unpacked runtime;
  // the candidate lists still provide their cwd and legacy-layout fallbacks.
  return path.resolve(originalDir, '..', '..');
}

function resolveOperatorAppRoot(): string {
  // ESM-safe: use fileURLToPath(import.meta.url) for the module path, with
  // process.cwd() as a safe fallback if that fails for any reason.
  let moduleDir: string;
  try {
    moduleDir = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    moduleDir = process.cwd();
  }
  return resolveOperatorAppRootFromModuleDir(moduleDir);
}

/**
 * Candidate playbook source paths, ordered most-specific first. The
 * first one that exists wins.
 *
 * When `operatorAppRoot` is explicitly provided (tests, or the caller
 * knows where the app lives), ONLY that root is considered — no
 * process.cwd() fallback. Auto-discovered mode (no explicit root)
 * also tries process.cwd()-rooted paths to cover the esbuild-bundled
 * Tauri sidecar layout where `__dirname` collapses to `sidecar/`.
 */
/**
 * The prompts DIRECTORIES to search, ordered most-specific first — the shared
 * root-resolution every `apps/operator/prompts/*` lookup needs.
 *
 * Extracted from `playbookCandidates` (EI-996) so a sibling prompt-source
 * resolver (e.g. the su-tier ROLE ADDENDUM, `su-role-<role>.addendum.md`) reuses
 * the SAME roots instead of forking a second, silently-diverging copy — notably
 * the `process.cwd()` fallbacks that cover older esbuild-bundled Tauri sidecar
 * layouts and partially unpacked runtimes. The resolver now returns the
 * packaged `sidecar/apps/operator` root directly when that tree is present.
 */
export function promptsDirCandidates(operatorAppRoot: string, explicitRoot: boolean): string[] {
  if (explicitRoot) return [path.join(operatorAppRoot, 'prompts')];
  const out = [
    path.join(operatorAppRoot, 'prompts'),
    path.join(process.cwd(), 'apps', 'operator', 'prompts'),
    path.join(process.cwd(), 'prompts'),
  ];
  // MODULE-relative ancestors, so resolution does not depend on where the
  // process was STARTED (EI-996). The cwd candidates above silently resolve
  // nothing whenever cwd is not the repo root — measured: from
  // packages/operator-core they miss entirely. In production the operator
  // happens to run from the repo root, which is exactly what makes this class
  // of bug invisible until something launches from elsewhere. Walking up from
  // this module's own location has no such dependency.
  for (const base of [operatorAppRoot, process.cwd()]) {
    let dir = base;
    for (let up = 0; up < 6; up += 1) {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
      out.push(path.join(dir, 'apps', 'operator', 'prompts'));
    }
  }
  return [...new Set(out)];
}

/** The auto-discovered operator app root — exported for sibling prompt resolvers (EI-996). */
export function operatorAppRootForPrompts(): string {
  return resolveOperatorAppRoot();
}

function playbookCandidates(operatorAppRoot: string, explicitRoot: boolean, profile = 'engineer'): string[] {
  // Profile-specific base, then the ENGINEER base as a graceful fallback for any
  // non-engineer profile (domain-generic-hive-architecture P-025): a `generic`
  // (non-coding work-hive) launch has no `papercusp-su-generic.tools.md` of its own
  // yet, so it degrades to the engineer base playbook — its domain context comes from
  // the per-hive su override + a NO repo-guide splice (role-launch-spec, profile=generic),
  // not a bespoke base. `power` has its own file so the fallback never triggers for it.
  // Only GENERIC gets the engineer fallback (it has no bespoke file by design). Every
  // OTHER profile keeps the strict single-candidate behavior so a typo'd/missing profile
  // file still THROWS (defense-in-depth alongside the bootstrap-su allow-list) rather than
  // silently masking to engineer.
  const files =
    profile === 'generic'
      ? [`papercusp-su-${profile}.tools.md`, 'papercusp-su-engineer.tools.md']
      : [`papercusp-su-${profile}.tools.md`];
  const roots = promptsDirCandidates(operatorAppRoot, explicitRoot);
  // Specificity-first: try the profile-specific file in every root before the
  // engineer fallback in every root, so a real generic file (if later authored) wins.
  return files.flatMap((file) => roots.map((r) => path.join(r, file)));
}

function extensionCandidates(operatorAppRoot: string, explicitRoot: boolean): string[] {
  const fromRoot = [
    path.join(operatorAppRoot, 'scripts', 'hooks', 'omp', 'coord-hook.ts'),
    path.join(operatorAppRoot, 'scripts', 'hooks', 'omp', 'coord-hook.mjs'),
  ];
  if (explicitRoot) return fromRoot;
  const sidecarRoot = process.cwd();
  // Plain-cwd candidate for the dist-host layout — same miss as ccHookDirCandidates.
  return [
    ...fromRoot,
    path.join(sidecarRoot, 'scripts', 'hooks', 'omp', 'coord-hook.ts'),
    path.join(sidecarRoot, 'scripts', 'hooks', 'omp', 'coord-hook.mjs'),
    path.join(sidecarRoot, 'apps', 'operator', 'scripts', 'hooks', 'omp', 'coord-hook.ts'),
    path.join(sidecarRoot, 'apps', 'operator', 'scripts', 'hooks', 'omp', 'coord-hook.mjs'),
  ];
}

/**
 * The Claude/Codex CC hook scripts installed to `~/.papercusp/hooks/cc/`. Kept in
 * sync with install-standalone-mcp.sh's `CC_HOOK_*` set (the dev/Linux installer)
 * AND build-desktop-sidecar.sh (which ships these sources into the packaged bundle).
 * `pretooluse-locks-acquire.sh` MUST stay first — it is the presence gate for the
 * whole set (mirrors the bash `[ -f … ]` guard). `posttooluse-objective-title.sh` is
 * copied for parity but, like the bash installer, is not registered in settings.json.
 */
// Exported so `orphaned-cc-hooks.test.ts` can assert the INVARIANT that every hook script
// on disk appears here — the check that would have caught WI-5543, WI-5542 and
// EI-20782070131658758, each of which shipped a working guard that never installed.
export const CC_HOOK_FILES = [
  'pretooluse-locks-acquire.sh',
  // Managed Codex automatic compaction must enter Papercusp's deterministic
  // carry path instead of cutting around its checkpoint/authority gate.
  'precompact-managed-carry.mjs',
  'posttooluse-locks-release.sh',
  // WI-7182: shared Claude/Codex/OMP edit-path filter + targeted declaration
  // generator, invoked while the edited source's lock is still held.
  'regenerate-declaration-before-lock-release.mjs',
  // EI-21220966892195714: PostToolUse byte-exact diagnostic for full Write calls.
  // The incoming-content guard cannot see corruption introduced after dispatch;
  // this hook compares the requested UTF-8 bytes with the resulting file.
  'posttooluse-write-byte-integrity-guard.mjs',
  // PostToolUse nudge: an Edit/Write after the last `lint:tsc` run invalidates that
  // run's "clean" verdict, so the hook says so at the edit instead of hours later at
  // the gate (the hook file shipped without this allowlist entry — install parity 3/3).
  'posttooluse-tsc-verdict-stale-nudge.mjs',
  // review-system-rework-reduction-2026-09-23 P-040: tells the editor, at the edit, which
  // live repo-files proof the edit staled, and tells each peer holder once per edit burst.
  'posttooluse-proof-stale-nudge.mjs',
  // Claude native edit batches defer the union-lock release until this
  // matcher-less PostToolBatch hook sees the complete batch.
  'posttoolbatch-locks-release.sh',
  // EI-11405 / coordination-hook-rpc-fanout-collapse-2026-07-16: this hook now
  // ALSO carries the delta-aware coord:inbox PUSH that used to be a separate
  // posttooluse-coord-inbox.sh entry (deleted) — one round trip instead of two.
  'posttooluse-activity-report.sh',
  'pretooluse-activity-report.sh',
  'lifecycle-report.sh',
  'statusline-fleet.sh',
  'posttooluse-objective-title.sh',
  'pretooluse-bash-resource-gate.sh',
  // kickoff-prompt-absorption-2026-07-17 P-003(b): teach `plans:get` at the
  // point of failure when a Read/Grep targets a docs/plans/*.md projection.
  'pretooluse-plans-read-guard.sh',
  'workitem-verify-nudge.sh',
  // turn-provenance-owner-vs-agent-2026-07-11 P-003: classify every submitted
  // prompt against the injectors' envelope+nonce ledger → additionalContext
  // stamp (VERIFIED agent-origin / UNVERIFIED claim / affirmative OWNER).
  'userpromptsubmit-provenance.sh',
  // memory-delivery-unification-2026-07-12 P-003a: turn-start memory delta —
  // small high-precision recall for THIS prompt via the local operator,
  // epoch-deduped (never re-pays what initialize/orient already injected).
  'userpromptsubmit-memory.sh',
  // context-injection-audit-2026-07-28 P-015 (D-026): the MID-TURN half of the
  // same delta — turn-start fires once per prompt, so a fifty-tool-call turn got
  // one injection and then silence. This asks per tool dispatch, epoch-deduped
  // through the same ledger (port 'mid-turn'), at ~1/10th the budget.
  'posttoolbatch-midturn-context.sh',
  // portable-identity-packages-2026-09-26 P-011 (D-023 §2): a worn identity's
  // synchronous rules at the three sinks the two ports above do not reach — the
  // pre-tool GUARD (deny-only), stop, and a fresh context after compaction.
  'pretooluse-identity-guard.sh',
  'stop-identity-context.sh',
  'sessionstart-identity-context.sh',
  // deterministic-context-carry-2026-07-14 P-012: per-turn journal collection —
  // pings journal:record-turn at each Stop; the server extracts the agent's
  // ⟦journal⟧ line (mechanical first-line fallback, flagged).
  'stop-turn-journal.sh',
  // EI-21844056581395228 (a repeat of EI-19944806095285549): an artifact URL was
  // twice reported to the owner as delivered when no artifact existed. The prompt
  // rail was present both times, so this is the mechanical layer under it —
  // PostToolUse(Artifact) ledgers the ids real calls RETURNED, and Stop blocks a
  // final message citing one that was never returned. See the script's header.
  'artifact-url-delivery-guard.mjs',
  // owner-directive-delivery-redesign-2026-09-22 P-007: the turn-end owner-directive
  // check — Stop blocks once to ask done-or-still-open about a directive the session
  // replied to, and until an over-cap directive addressed to it has a summary.
  'stop-owner-directive-check.mjs',
  // owner-inbox-single-pane-2026-07-17 P-001: the owner-gate CAPTURE + MIRROR layer —
  // PreToolUse/PostToolUse around AskUserQuestion/ExitPlanMode, a Notification
  // permission-wait capture, and a Stop `<ask>`-tag mirror + question-shaped-ending
  // bounce. See the script's own header for the full four-branch contract.
  'ask-gate-mirror.sh',
  // EI-16981: keep agents on the Tauri desktop shell, not the retired browser
  // webapp — blocks browser-navigation MCP tools + the verdict skill when
  // pointed at the operator's desktop-internal ports (:3055/:3070/:3170).
  // Previously lived at repo-root scripts/cc-hooks/ and was never wired into
  // any installer (dead code with a misleading "Registered" comment); moved
  // here and wired below.
  'guard-operator-desktop.mjs',
  // WI-5543: same orphaned-directory shape as guard-operator-desktop.mjs above — this
  // PreToolUse (Edit|Write|MultiEdit) advisory curly-quote content-lint (P-013) lived at
  // repo-root scripts/cc-hooks/ and was never wired into any installer (dead code). Moved
  // here and wired below.
  'pretooluse-content-lint.mjs',
  // WI-5542: same orphaned-directory shape as guard-operator-desktop.mjs /
  // pretooluse-content-lint.mjs above — this PreToolUse (Edit|Write|MultiEdit) hard
  // DENY backstop against writing key-shaped secrets into a shared git-sync tree
  // file lived at repo-root scripts/cc-hooks/ and was never wired into any
  // installer (dead code whose own header claimed it was "the hard backstop").
  // Moved here and wired below.
  'pretooluse-secrets-guard.mjs',
  // EI-18896033546676518: PreToolUse (matcher "Edit|MultiEdit") hard DENY on any file
  // that already contains a raw NUL byte — the Edit tool has a confirmed round-trip
  // corruption bug on such files (silently writes a different byte than requested
  // while reporting success). See the script's own header for the full writeup.
  'pretooluse-nul-byte-edit-guard.mjs',
  // EI-20782070131658758: PreToolUse (matcher "Edit|Write|MultiEdit") hard DENY on a raw
  // forbidden CONTROL BYTE in the content being written. Disjoint from the nul-byte sibling
  // directly above, which is easy to mistake for coverage: that one asks "is the file I am
  // about to PATCH already dirty?" (NUL-only, and it deliberately excludes Write), while this
  // one asks "is the content I am about to WRITE legal?". A `Write` of a NUL-bearing .ts
  // therefore passed BOTH — the reported failure: the file became binary, `file` reported
  // `data`, and grep silently skipped it, so the natural verification ("grep for the symbol I
  // just wrote") returned nothing and read as "my edit did not land".
  //   ⚠ THIRD instance of this exact dead-code shape (cf. WI-5543 content-lint, WI-5542
  //   secrets-guard above): the guard existed in-repo since 2026-08-03, WITH a passing
  //   dedicated test file, and was never added here — so it never installed and never ran.
  //   `orphaned-cc-hooks.test.ts` now fails on any hook script that is not listed here.
  'pretooluse-control-bytes-content-guard.mjs',
  // EI-18680056073436345: PreToolUse (matcher "ScheduleWakeup") best-effort
  // turn-provenance ENROLLMENT for the Claude-CLI-native ScheduleWakeup tool —
  // observes the SCHEDULING call (which does pass through this hook chain) and
  // writes a hash-only ledger row with a per-row ttl sized to the requested
  // delay, so the eventual delivery classifies VERIFIED agent-origin instead of
  // falling through to the affirmative (and WRONG) OWNER default. See the
  // script's own header for the full root-cause + fix writeup.
  'pretooluse-schedule-wakeup-provenance.mjs',
  // EI-19966323166806405: PreToolUse (matcher "Write") ADVISORY guard — the native Write
  // tool's own contract says an overwrite of an existing, un-Read file "will fail", but
  // on 2026-08-09 it silently overwrote a 350-line shared module instead, crash-looping
  // staging for ~13min. Independently reconstructs "was this path Read this session" from
  // the transcript and warns (never denies — see the script header for why a hard deny
  // would be the wrong trade on a shared tree) when a Write targets an existing file with
  // no matching prior Read/Edit/MultiEdit/Write in the transcript.
  'pretooluse-write-overwrite-guard.mjs',
  // Plan claude-md-projection-from-pg-2026-08-10 P-006: PreToolUse (matcher
  // "Edit|Write|MultiEdit") BLOCKING guard on a hand-edit to a file that DECLARES ITSELF
  // GENERATED in its own header — extending the repo rule that already governs prompts
  // ("edit the source, never the rendered output"). Keyed on the ARTIFACT's banner rather
  // than a path list, so it arms itself the instant CLAUDE.md/AGENTS.md become projections
  // (D-003/D-014) with no flag day, and disarms if a file goes back to hand-authored.
  // Measured: 54 of 21,267 tracked files carry such a banner, every one a real generated
  // artifact. Generators are untouched — they write via node:fs, not tool calls.
  'pretooluse-generated-file-edit-guard.mjs',
  // P-010 (fleet-friction-remediation-2026-08-21): PreToolUse BLOCKING guard on an
  // apply_patch envelope carrying more than one operation for the same target path.
  // apply_patch rejects that whole envelope deterministically, before writing
  // anything; the class was filed independently five times (EI-21353344120350526,
  // EI-21354846297369687, EI-21565696681975825, EI-21573638140720842,
  // EI-22346861820470210 — "deterministic validation behavior but was not surfaced
  // before submission"), so the guard moves detection to authoring time and carries
  // the mechanical fix (merge into ONE Update File block with multiple @@ hunks).
  //   ⚠ COPIED BUT NOT REGISTERED IN mergeClaudeHookSettings, on purpose — the
  //   second such case after posttooluse-objective-title.sh, and for a different
  //   reason: this trap is CODEX-ONLY BY CONSTRUCTION. `apply_patch` is Codex's
  //   file-edit tool; Claude's Edit/Write carry a single file_path and cannot
  //   express a duplicate target at all, so a Claude registration would be a
  //   matcher that can never fire. It is registered where it can: the managed
  //   Codex home's PreToolUse chain in role-codex-home.ts (matcher ^apply_patch$).
  'pretooluse-apply-patch-duplicate-target-guard.mjs',
  // WI-38352: PreToolUse (matcher "Edit|Write|MultiEdit") BLOCKING guard on a write to
  // libs/papercusp/libs/db/sql/<NNN>-*.sql whose NNN was hand-picked rather than allocated
  // via `node scripts/next-migration.mjs` (no row in harness_shared.migration_reservations).
  // Such a file red-pins lint:migrations, which is a RELEASE-CUT PREFLIGHT, so it blocks
  // EVERY agent's cut — 3 occurrences in ~24h, the last costing ~2h of fleet-wide block.
  // Write time is the only seam where the repair is still a `mv`: boot auto-apply reaches
  // the file within minutes and the number is immutable from then on. Imports ENFORCED_FROM
  // from the repo's own scripts/lint-migrations.mjs so guard and lint cannot drift, and
  // FAILS OPEN (loudly, on stderr) when PG is unreachable — the lint stays the backstop.
  'pretooluse-unreserved-migration-guard.mjs',
  // EI-19374535041074908: PostToolUse (matcher "Edit|Write|MultiEdit") ADVISORY nudge
  // when an edit adds a REQUIRED field to an exported interface (or tightens one from
  // optional), which silently strands every construction site in files the change never
  // touched. The detector already exists (scripts/check-required-field-strands.mjs,
  // WI-6814) and its own header names the real gap: "the hard part is KNOWING TO RUN IT."
  // Documentation did not close it — the class recurred 7× in ~48h, each fixed one file
  // at a time. Running the CLI later does not close it either: its `--base HEAD` diff goes
  // EMPTY once git-sync sweeps the tree (minutes), so it false-greens — measured in its own
  // formatNoFindings docstring. Only an edit-time hook sees the true pre-edit HEAD.
  'posttooluse-required-field-strand-nudge.mjs',
  // EI-20022235111425919: PostToolUse (matcher "Edit|Write|MultiEdit") ADVISORY nudge for
  // the BEHAVIOURAL sibling of the strand class above. Adding a CALL to an injected
  // collaborator inside a shared lib changes how many times that seam is called, stranding
  // every `toHaveBeenCalledTimes` / call-order assertion in OTHER workspaces — files the
  // change never touched. It is invisible to BOTH instruments the author reads as green:
  // `lint:tsc` sees no type change (only a runtime count moved), and `test:affected`
  // selects by the workspaces the changed PATHS map into, which is the wrong workspace by
  // construction. Measured cost of one instance (WI-37582): ~3 gate reds, ~2h of frozen
  // `main`, three agents diagnosing it in parallel. The detector exists
  // (scripts/check-behavioural-strands.mjs) and, exactly as for the required-field sibling,
  // the hard part is KNOWING TO RUN IT — and running it later cannot work here either,
  // because git-sync sweeps the edit into HEAD within minutes and `--base HEAD` then diffs
  // content that already contains it. Only an edit-time hook sees the true pre-edit HEAD.
  // Submodule-aware by necessity: libs/generic/* and libs/papercusp ARE submodules and are
  // this guard's whole trigger class, and a superproject `git show HEAD:<path>` answers
  // "absent" for a committed file inside one.
  'posttooluse-behavioural-strand-nudge.mjs',
  // EI-19457231269012320 / EI-19457320059999661: PostToolUse (matcher
  // "Edit|Write|MultiEdit") ADVISORY nudge when the file just written does not PARSE.
  // A parse-class guard already exists and is correct (tsParseDetector in
  // content-lint/registry.ts) but it runs on the COMMIT path, and the damage does not
  // need a commit: apps/operator/bin/bundle-host.sh esbuild-bundles operator-core as
  // ExecStartPre for papercup-staging-api, papercup-bg-host and the release host, and it
  // bundles the WORKING TREE. Measured 2026-08-03: backticks written as prose inside a
  // sql tagged template closed the literal at watchdog.ts:1836; :3170 crash-looped 6x into
  // systemd's start-limit and was down fleet-wide for 17 minutes — and `git log` on that
  // file shows exactly ONE commit that day, the FIX. The break was never committed, so no
  // commit-path guard could have seen it. The sibling PreToolUse content-lint hook cannot
  // cover it either: PreToolUse sees `new_string`, a FRAGMENT, and a fragment does not
  // parse standalone. PostToolUse reads the actual resulting file from disk.
  'posttooluse-ts-parse-nudge.mjs',
  // EI-19450114644493388: the MDX sibling. The real MDX detector already protects
  // git-sync, but only after the author's turn; this reports the resulting full-file
  // compile error immediately after an .mdx edit. PreToolUse sees only fragments and
  // cannot compile them meaningfully.
  'posttooluse-mdx-nudge.mjs',
  'posttooluse-no-proc-path-fixture-nudge.mjs',
  // EI-19359711978838614: PostToolUse (matcher "Edit|Write|MultiEdit") ADVISORY nudge
  // when a new/edited migration (libs/papercusp/libs/db/sql/*.sql) introduces a column
  // that some OTHER *.integration.test.ts already relies on via an inline CREATE TABLE
  // fixture for the same table — the sibling trap to the required-field-strand one
  // above, but for hand-rolled SQL schema fixtures instead of TS interfaces. The
  // detector (scripts/check-migration-fixture-drift.mjs) is deliberately DIFF-triggered
  // rather than a blanket schema-diff lint, because most such fixtures are
  // intentionally partial stubs by design; only a fixture that ALREADY names the table
  // and is missing exactly the new column is a precise, low-noise signal. As with its
  // sibling, running the CLI later does not reliably work on this tree — git-sync
  // sweeps the shared checkout on a schedule, so a diff-vs-HEAD run a few minutes later
  // can already see the migration as committed history. A PostToolUse hook runs
  // milliseconds after the write, while it is still the author's turn to add one line
  // to a sibling fixture.
  'posttooluse-migration-fixture-drift-nudge.mjs',
  // EI-19462877357083817: PostToolUse (matcher "Edit|Write|MultiEdit") ADVISORY nudge when an
  // edited migration carries destructive DDL (DROP INDEX/COLUMN/TABLE/CONSTRAINT, RENAME,
  // SET NOT NULL, partial UNIQUE INDEX) with no `-- FORWARD-COMPAT:` acknowledgment. The
  // detector (scripts/check-migration-forward-compat.mjs) is correct but speaks LAST: it runs
  // only inside green-checkpoint, which is hours after the write AND after db:migrate already
  // applied the DDL to the live DB — so the window it exists to protect (dropping something
  // out from under the older release still serving :3070) is never actually guarded, and what
  // it delivers is a fleet-wide gate red. Worse, the gate short-circuits at the first failing
  // leg, so this leg only RUNS once every earlier one passes: on WI-9591 it fired zero times
  // in three preceding verdicts and surfaced only on the first candidate whose tests went
  // green — a fresh red exactly when the fleet believed it was recovering. In that incident
  // the required justification was ALREADY present in all five migrations and was rigorous;
  // only the machine-readable token was missing. At least the fourth occurrence (WI-6842,
  // EI-19407054630567497, WI-9573/WI-9591). Finding the violation was never the hard part —
  // KNOWING TO RUN the lint is, at the one moment the fix is a single comment line typed by
  // the author who still has the reasoning in their head. Deliberately covers `.DRAFT` /
  // `.PENDING-CODE-DEPLOY` files, since next-migration.mjs tells authors to iterate there and
  // that IS the authoring window.
  'posttooluse-migration-forward-compat-nudge.mjs',
  // EI-19401978567233485: PostToolUse (matcher "Edit|Write|MultiEdit") ADVISORY nudge when an
  // edited file adds an entry to a registry array whose sibling *.test.ts still asserts an
  // exact-ordered-list census of that same array. The census test IS already the detector and
  // it DOES fire — but at the fleet green-checkpoint ~an hour later, where the red holds `main`
  // for EVERY agent and costs a release-fixer dispatch plus a ~55min re-run. Both genuine reds
  // on candidate 2edd4735 (2026-08-03) were this identical class: GATE_OWNERSHIP_CELL added to
  // BUILTIN_CELLS, and nulBytesDetector added to DEFAULT_CONTENT_DETECTORS (whose census title
  // still read "all five seeded detectors"). Finding the drift was never the hard part — the
  // census is cheap and deterministic; KNOWING TO LOOK is, at the one moment the fix is a
  // one-line census bump by the author who still has the registry open. The detector
  // (scripts/check-registry-census-drift.mjs) is imported rather than re-implemented, so the
  // nudge cannot drift quiet on a shape the CLI still reports.
  'posttooluse-registry-census-drift-nudge.mjs',
  // EI-19459260956682226: PostToolUse (matcher "Edit|Write|MultiEdit") ADVISORY nudge when
  // an edited tool-definition file breaches the P-011 prompt-weight budget. Three detectors
  // already measure this and ALL THREE are post-hoc or opt-in — the gate test (after the
  // breach is committed and the fleet is blocked), the tools-md-sync quick-check (only if
  // the editor REMEMBERS to run it), and the live operator's registration self-check (whose
  // log nobody reads at edit time). CLAUDE.md already names this as the DOMINANT failure
  // mode: nearly every prompt-weight gate red comes from GROWING an existing tool's
  // description, and an editor never reads the "Adding a tool" section. Measured instances:
  // loop:status 1568, loop:checkpoint 1552, plans:set-status 1693, autonomy:decide 1545 —
  // each locally green, each surfacing only at the gate hours later. This is a TIMING gap,
  // not an enforcement gap, so it is deliberately NOT an `npm run lint:*` script: gate-time
  // enforcement already exists, and a lint entry no blocking path runs would (correctly)
  // red the lint-guard reachability census.
  'posttooluse-tool-prompt-weight-nudge.mjs',
  // EI-20204186116417704: PreToolUse (matcher "Edit|Write|MultiEdit") hard DENY on an edit that
  // pushes a tool OVER the P-011 budget — the BLOCKING half of the nudge directly above. That
  // nudge closed the TIMING gap (it measures exactly, milliseconds after the write) but not the
  // ENFORCEMENT gap, because PostToolUse cannot block: the edit lands, git-sync sweeps the tree
  // minutes later, and the breach is committed anyway. Measured 2026-08-11: `rubrics:propose`
  // grew to 1528 in commit 21337b7874 and an unrelated agent hit the red NINE MINUTES later, on
  // a tool they had never touched. Refuses only a WORSENING edit — a tool that is over budget
  // and getting SMALLER always passes, so the guard can never block its own remedy — and reuses
  // the nudge's exported weigher rather than carrying a second copy of the formula.
  'pretooluse-tool-prompt-weight-guard.mjs',
  // WI-37497: PostToolUse (matcher "Edit|Write|MultiEdit") ADVISORY nudge when an edit ADDS
  // an `as never`/`as any` cast closing a vitest `.mock*(...)` call — i.e. raises the
  // `lint:mock-cast-escape` ratchet. Same TIMING gap as the strand nudge, with a sharper
  // incentive problem: a ratchet lint bites ONLY at the fleet gate, so the author never pays
  // and a stranger waiting on a deploy does. Neither routine check can catch it —
  // test:affected does not typecheck, and lint:tsc passes BECAUSE of the cast. Measured: the
  // guard was burned 1121 -> 1061 (EI-19452618085391226, 2026-08-03) and was back to 1113 six
  // days later, where it became the SOLE holder of a red gate and froze `main` (verdict
  // 2026-08-09T13:59Z, candidate 00376d971c, GATE_HELD_BY count=1, every test passing).
  // Reuses the guard's own exported matcher rather than re-implementing it: a hand-grep on
  // `as never|as unknown as` counts 7656 tree-wide against the guard's 1113, a different
  // population entirely.
  'posttooluse-mock-cast-escape-nudge.mjs',
  // EI-20023819609804890: PostToolUse (matcher "Edit|Write|MultiEdit") ADVISORY nudge when an
  // edit ADDS a banned nonzero `letter-spacing` — i.e. arms the `lint:design-primitives`
  // green-checkpoint leg. Same author-never-pays incentive gap as the mock-cast nudge above,
  // with a measured recurrence: hud.css ALONE red-pinned the fleet 3x on this one rule (once
  // 2026-08-02, twice 2026-08-09). The remedy already tried was PROSE — that file carries four
  // warning comments about this exact rule (L564, L782, L885, L1372) and broke anyway, because
  // a comment only reaches someone reading that region of a 1,445-line stylesheet while the
  // author adding a new uppercase micro-label is writing elsewhere in it. Neither routine check
  // catches it either: a CSS declaration is not a type error, and an author editing .css is
  // typically not running tests at all. Reuses the lint's own matcher via the extracted
  // app/_lints/letter-spacing-pattern.mjs rather than re-implementing the regex — the negative
  // lookahead is exactly what separates a banned `0.04em` from the REQUIRED `letter-spacing: 0`,
  // so a drifted copy would fire on every compliant declaration in the tree.
  'posttooluse-css-design-primitives-nudge.mjs',
  // EI-20043039577586381: PostToolUse (matcher "Edit|Write|MultiEdit") ADVISORY nudge when an
  // edit introduces a relative `.mjs` import from TS with no sibling `.d.mts` and no enrolment
  // in tsconfig.declarations.json — i.e. arms TS7016 and the `check-unenrolled-mjs-imports`
  // RATCHET, a green-checkpoint leg. Two shapes, and the second is why prose has not fixed it:
  // (1) a brand-new `scripts/*.mjs` imported from a `.test.ts`, where BOTH `gen:declarations`
  // and `gen:declarations:check` report SUCCESS about the unenrolled module
  // (EI-20035436440627349), so the author's natural confirmation step actively reassures them;
  // (2) a MULTI-LINE import whose `@ts-expect-error`/`@ts-ignore` sits above the `import`
  // keyword instead of above the `} from '...'` line — tsc reports TS7016 at the module
  // SPECIFIER, so a directive that LOOKS right suppresses nothing. Shape 2 has bitten 3x
  // (EI-19389216343173748, EI-18817201237512691, WI-37657 — the last held `main` and burned a
  // full gate suite), and that author HAD written a correct explanatory comment about the
  // constraint, which is exactly why a mechanical edit-time check is warranted over more prose.
  // Same TIMING gap as the siblings above: the detector is already correct but only runs inside
  // vitest at the gate, hours later, and a diff-vs-HEAD run minutes after the edit is unreliable
  // here because git-sync may already have committed the import as history with no informative
  // "before". Reuses the detector's OWN `offendersIn`/`isSuppressed` rather than re-implementing
  // them, so the nudge cannot drift from the ratchet's verdict — including on the
  // specifier-line suppression anchor, which is the whole of shape 2.
  'posttooluse-mjs-import-declaration-nudge.mjs',
  // EI-22085994981415983: PostToolUse (matcher "Edit|Write|MultiEdit") ADVISORY nudge when an
  // edit introduces a hand-rolled ESM CLI-entry guard — comparing `import.meta.url` against
  // `pathToFileURL(process.argv[1]).href` or against `file://${process.argv[1]}`, or comparing
  // `fileURLToPath(import.meta.url)` against `process.argv[1]` (the three naive spellings; this
  // comment deliberately does not spell any of them out verbatim, because cli-entry.test.ts's
  // detector regex would otherwise match the prose). Correct unbundled and a
  // BOOT-TIME LANDMINE once esbuild inlines the module into the desktop sidecar: every inlined
  // module inherits the bundle entry's import.meta.url, so the comparison is true for every
  // imported CLI and runs its main()/process.exit() during host boot (EI-650 — the sidecar
  // exited before serving and took embedded PG with it). It is the most natural thing to type
  // when adding a `.mjs`, so it keeps returning: it reddened the repo-wide gate 3x in 3 days
  // (WI-1398269 08-30, EI-21985446777087608 08-31, EI-22085994981415983 09-01 with four sites
  // in one day), each time blocking EVERY agent's affected run rather than only the author's.
  // Same TIMING gap as the siblings above — check-no-hand-rolled-cli-entry.mjs already detects
  // all three spellings correctly, but only as a repo-wide guard at the ~55min gate, so the
  // one-line fix surfaces at the most expensive possible moment and to the wrong person.
  // Reuses the detector's OWN `findGuards` + `ALLOW_COUNTS` + `STANDALONE_ENTRY_EXEMPTIONS`
  // rather than re-implementing the patterns, so the nudge cannot drift from the gate's
  // verdict, and fires only when an edit BOTH introduces an occurrence and leaves the file over
  // its allowance — i.e. exactly when the gate would fail. Nearly free on unrelated edits: the
  // detector's own `import.meta.url` substring short-circuit runs before any git work.
  'posttooluse-cli-entry-nudge.mjs',
  // frozen-candidate-compliance-enforcement-2026-08-30 P-004/P-005: PostToolUse (matcher
  // "Edit|Write|MultiEdit") ADVISORY nudge when the edited path is one the FROZEN gate
  // candidate is failing on. Under freeze-and-converge (D-007) every run RESUMES one frozen
  // candidate, so a fix committed to `staging` lands ABOVE the sha under judgment: nothing
  // fails, the gate keeps reporting the same red, and the author reports it fixed. Both are
  // locally true. Measured 2026-08-30: 3 of 10 reds on candidate 4184805d were already fixed
  // at tip. D-001 (ratified) rules out documentation/prose/tool-text/opt-in diagnostics for
  // this class — all were tried and measurably did not hold — so the remedy has to fire
  // without the agent knowing to ask. The gate-side detector
  // (detectFrozenRepairSharedTreeCollision) has existed since P-009 but is REPORT-ONLY and
  // speaks hours later, inside the gate, to whoever reads a diagnostic; this speaks
  // milliseconds after the write while it is still the author's turn. Costs one failed read
  // when nothing is frozen (no marker file ⇒ no DB round-trip), which is what makes it safe
  // to fire on every edit fleet-wide.
  'posttooluse-frozen-candidate-edit-nudge.mjs',
  // Shared python libs, NOT hooks: statusline-fleet.sh + posttooluse-objective-title.sh
  // import pc_tty, while the MCP response hooks import mcp_response. Omit either and
  // the importing hooks raise ImportError, fail OPEN, and silently lose their guard,
  // reporting, or title behavior. They are imported, never executed, so
  // installClaudeHooks installs them 0644.
  'pc_tty.py',
  'mcp_response.py',
  // WI-10003957: lifecycle-report.sh runs this through `python3 <path>` to skip the
  // SessionStart/SessionEnd report of a CLI NESTED inside another agent (it inherited
  // the su's PAPERCUSP_SID). Omit it and the guard fails open: a nested `claude -p`
  // ends the su again. Run via the interpreter, never exec'd directly, so it is 0644.
  'pc_nested_cli.py',
] as const;

/** Hook files that are LIBRARIES, not executables — installed 0644, never chmod +x. */
const CC_HOOK_LIB_FILES: ReadonlySet<string> = new Set([
  'pc_tty.py',
  'mcp_response.py',
  'pc_nested_cli.py',
]);

/** Match the runtime-vintage unit label used by host-bootstrap in install evidence. */
function desktopInstallUnit(): string {
  const configured = process.env.PAPERCUSP_VINTAGE_UNIT?.trim();
  if (configured) return configured;
  if (process.env.PAPERCUSP_DESKTOP === '1') return 'desktop-sidecar';
  const port = process.env.PAPERCUSP_HONO_PORT?.trim() || process.env.PORT?.trim() || '3070';
  return `hono-host:${port}`;
}

/**
 * Candidate DIRS for the CC hook sources — the bundled sidecar layout first
 * (`<operatorAppRoot>/scripts/hooks/cc`), then the dev-repo fallback. Mirrors
 * `extensionCandidates` (the omp coord-hook resolver); esbuild can't trace these
 * fs-read scripts, so build-desktop-sidecar.sh copies the dir verbatim.
 */
export function ccHookDirCandidates(operatorAppRoot: string, explicitRoot: boolean): string[] {
  return hookDirCandidates(operatorAppRoot, explicitRoot, 'cc');
}

/**
 * Generalised form of the above for any `scripts/hooks/<subdir>` source dir.
 * Extracted (rather than copied) when the context-injection dispatcher needed
 * the SAME resolution — the dist-host cwd quirk documented below is exactly the
 * kind of thing that gets fixed in one copy and not the other.
 */
function hookDirCandidates(operatorAppRoot: string, explicitRoot: boolean, subdir: string): string[] {
  const fromRoot = [path.join(operatorAppRoot, 'scripts', 'hooks', subdir)];
  if (explicitRoot) return fromRoot;
  // Plain-cwd candidate mirrors cliLauncherCandidates/playbookCandidates: in the
  // dist-host layout (module at <operatorApp>/dist-host/, cwd = <operatorApp>) it
  // remains a defense-in-depth fallback for an older or partially unpacked bundle
  // whose module root cannot be inspected (found live 2026-07-12: the :3070 install
  // endpoint returned ok with zero hooks).
  return [
    ...fromRoot,
    path.join(process.cwd(), 'scripts', 'hooks', subdir),
    path.join(process.cwd(), 'apps', 'operator', 'scripts', 'hooks', subdir),
  ];
}

/**
 * Install the CONTEXT-INJECTION pair into `~/.papercusp/hooks/`
 * (omp-context-injection-parity-2026-08-09 P-003 / D-001):
 *   hooks/inject/**          the shared dispatcher (client-agnostic)
 *   hooks/omp/inject-hook.ts the omp artifact psu passes as `--hook`
 *
 * ⚠ ALL-OR-NOTHING, and that is the whole point of installing them in one
 * function. The artifact resolves the dispatcher RELATIVE TO ITSELF, so a
 * half-install (hook present, dispatcher absent) produces an omp session that
 * loads the hook, finds nothing, and fail-silently injects NOTHING on every
 * turn. That reads exactly like "no memories were relevant" — the same
 * invisible-failure shape as EI-8191, where fail-open looked like success for
 * weeks. Sources missing ⇒ install NOTHING and report [], never a partial set.
 *
 * Best-effort like its CC sibling: never throws, never blocks install.
 */
export async function installInjectionHooks(home: string, injectSrcDir: string): Promise<string[]> {
  const ompSourceDir = path.join(path.dirname(injectSrcDir), 'omp');
  const ompTypeScriptSource = path.join(ompSourceDir, 'inject-hook.ts');
  const ompBundledSource = path.join(ompSourceDir, 'inject-hook.mjs');
  // Dogfood/dev keeps the readable TypeScript family. vm-release ships the
  // self-contained esbuild fallback instead, but installs it under the same
  // inject-hook.ts destination so the existing psu/OMP launch contract does not
  // fork by distribution profile.
  const ompHookSrc = (await isRegularFile(ompTypeScriptSource)) ? ompTypeScriptSource : ompBundledSource;
  const installed: string[] = [];
  // EI-20006285243973245 — until now this installer recorded NOTHING, anywhere.
  // The CC hooks beside it have carried a provenance stamp since WI-37405, but
  // the injection pair had none, so "when were these installed, and from which
  // build?" had no answer at all. That gap is what left a real omp injection
  // outage (2026-08-09 18:15Z) permanently cause-UNDETERMINED: file mtimes are
  // useless here because this function rewrites them on EVERY psu launch.
  // Resolved once and reused for both stamps — the dispatcher and the omp
  // artifact are copied from the same checkout.
  const incomingProvenance = await resolveSourceGitProvenance(injectSrcDir);
  const stampBase = {
    ...incomingProvenance,
    installedAt: new Date().toISOString(),
    pid: process.pid,
    installedBy: process.argv[1] ? path.basename(process.argv[1]) : undefined,
  };
  const dispatcherFiles: string[] = [];
  const hooksRoot = path.join(home, '.papercusp', 'hooks');
  const injectDest = path.join(hooksRoot, 'inject');
  const ompDest = path.join(hooksRoot, 'omp');
  // EI-20333884491932817: the release service and staging launchers share this
  // home. A release process only a few commits behind repeatedly replaced the
  // proactive Vertex pacing hook, recreating 429s in otherwise-fresh sessions.
  // Either destination proving a newer install protects the pair as a unit.
  if (
    (await refuseKnownOlderHookSource('injection hooks', injectSrcDir, injectDest, incomingProvenance)) ||
    (await refuseKnownOlderHookSource('OMP injection hook', ompSourceDir, ompDest, incomingProvenance))
  ) {
    return [];
  }
  // Hoisted so the EARLY-RETURN path can reach it. It previously sat after the
  // try/catch, which made it unreachable in the one case it exists to report —
  // a missing dispatcher source returns [] from the catch. The warning about the
  // invisible failure was itself invisible; a test caught it.
  const warnInactive = () =>
    console.warn(
      `[desktop-install] injection hooks: installed NOTHING (${hooksRoot}/inject dispatcher unavailable ` +
        `from ${injectSrcDir}) — omp inject-hook injection is INACTIVE for sessions on this box`,
    );
  try {
    // Refuse the partial install before writing anything.
    await fs.access(path.join(injectSrcDir, 'index.mjs'));

    // ⚠ The omp hook is NO LONGER a precondition for installing the dispatcher
    // (codex-context-injection-parity-2026-08-09 P-002). It used to be checked
    // here, which was right while omp was the dispatcher's only consumer. It is
    // no longer: the claude cc hooks are now thin shims onto this dispatcher and
    // codex reaches it from its per-session hooks.json. A missing omp artifact
    // would therefore have skipped the DISPATCHER as well, silently disabling
    // injection for CLAUDE — ~100% of real traffic — over an unrelated omp file.
    // Each artifact now gates only itself; the omp copy is best-effort below.
    await fs.mkdir(path.join(injectDest, 'adapters'), { recursive: true, mode: 0o755 });

    for (const rel of ['', 'adapters']) {
      const srcDir = rel ? path.join(injectSrcDir, rel) : injectSrcDir;
      for (const name of await fs.readdir(srcDir)) {
        if (!name.endsWith('.mjs')) continue;
        const dst = path.join(injectDest, rel, name);
        // Same atomic-rename discipline as installClaudeHooks (EI-18755593630003816):
        // this dir is shared by every session on the box and re-installed on every psu
        // launch, so a concurrent hook fire must never observe a torn prefix.
        const tmp = `${dst}.psu-install.${process.pid}.tmp`;
        await fs.writeFile(tmp, await fs.readFile(path.join(srcDir, name)), {
          mode: name === 'index.mjs' ? 0o755 : 0o644,
        });
        await fs.rename(tmp, dst);
        installed.push(path.join('inject', rel, name));
        dispatcherFiles.push(path.join(rel, name));
      }
    }

    // Written after the copies so it always describes what is actually on disk.
    // `.installed-from` is inert here: the dispatcher is resolved by the exact
    // path `index.mjs`, and the copy loops read the SOURCE dir, never this one.
    if (dispatcherFiles.length > 0) {
      await writeInstallStamp(injectDest, { sourceDir: injectSrcDir, ...stampBase, files: dispatcherFiles });
    }
  } catch {
    // The invisible-failure case: [] is documented as "omp injection inactive on
    // this box", which every downstream turn then presents as the
    // indistinguishable "no memories were relevant". Say it once, loudly,
    // instead of leaving it to be inferred from an absence.
    warnInactive();
    return [];
  }

  // omp's client-native artifact — installed SEPARATELY and best-effort, in its
  // own try, for two reasons that both bite silently:
  //   1. It must not gate the dispatcher (see the note above).
  //   2. The outer catch returns [], so a throw here would ALSO discard the
  //      dispatcher's install record — reporting "nothing installed" while its
  //      files are in fact on disk. `injectionHooksInstalled: []` is documented
  //      as "omp injection inactive on this box", so that mis-report is exactly
  //      the kind of false negative the P-005 coverage detector must not be fed.
  try {
    const ompBundle = await installOmpHookBundle({
      sourceDir: path.dirname(ompHookSrc),
      entryFile: path.basename(ompHookSrc),
      destinationDir: ompDest,
      destinationEntry: 'inject-hook.ts',
      provenanceGuardDir: ompDest,
      provenanceLabel: 'OMP injection hook',
    });
    installed.push(...ompBundle.installed.map((file) => path.join('omp', file)));
    if (ompBundle.installed.length > 0) {
      await writeInstallStamp(ompDest, {
        sourceDir: ompSourceDir,
        ...stampBase,
        files: ompBundle.installed,
      });
    }
  } catch {
    // omp hook absent/unreadable — claude + codex injection are unaffected.
  }

  // One greppable line per install pass. The stamps above are the durable record;
  // this is the one that would have DATED the outage from the operator journal,
  // which is where the investigation actually looked:
  //   journalctl --user -u papercup-dev-api.service | grep -icE 'injectionHooks|hooks/inject|inject-hook'
  // returned 0 for the entire window, because nothing on this path had ever
  // logged anything. Keep the substrings 'hooks/inject' and 'inject-hook'
  // present here — that exact probe is what a future diagnosis will re-run.
  const sha = incomingProvenance.sourceSha ? ` @ ${incomingProvenance.sourceSha.slice(0, 12)}` : '';
  if (installed.length > 0) {
    console.log(
      `[desktop-install] injection hooks: installed ${installed.length} file(s) into ` +
        `${hooksRoot}/inject + ${hooksRoot}/omp from ${injectSrcDir}${sha} — ${installed.join(', ')}`,
    );
  } else {
    // Reachable when the copy loop found no .mjs to write without throwing; the
    // throwing path warns from the catch above.
    warnInactive();
  }
  return installed;
}

/**
 * Candidate launcher paths for the on-PATH CLI shims (psu / ptool). The
 * shipped sidecar bundles esbuild outputs at `<root>/scripts/psu.mjs` +
 * `ptool.mjs` (build-desktop-sidecar.sh); the dev repo has the un-bundled
 * sources at `apps/operator/scripts/psu-launcher.mjs` + `ptool.mjs`. `names`
 * is ordered bundled-first, dev-second, so a real packaged build always
 * prefers its self-contained bundle. Mirrors playbookCandidates' root list
 * (operatorAppRoot first, then process.cwd()-rooted fallbacks for the esbuild
 * sidecar layout where __dirname collapses to sidecar/).
 */
function cliLauncherCandidates(operatorAppRoot: string, explicitRoot: boolean, names: string[]): string[] {
  const roots = explicitRoot
    ? [path.join(operatorAppRoot, 'scripts')]
    : [
        path.join(operatorAppRoot, 'scripts'),
        path.join(process.cwd(), 'scripts'),
        path.join(process.cwd(), 'apps', 'operator', 'scripts'),
      ];
  // Names-outer so the bundled name wins in EVERY root before the dev name is tried.
  return names.flatMap((n) => roots.map((r) => path.join(r, n)));
}

/**
 * Max directory levels to walk upward when locating a repo-root-anchored path.
 * 8 clears every layout on this box with room to spare (the deepest real anchor,
 * a release checkout's `apps/operator`, needs 2).
 */
const REPO_ANCHORED_WALK_DEPTH = 8;

/**
 * Candidates for a REPO-ROOT-ANCHORED `relPath`, walking UP from `start`.
 *
 * Why a walk instead of a fixed number of `..` hops: the caller never reliably
 * knows its own depth below the repo root. `resolveOperatorAppRoot()` returns
 * `<repo>/apps/operator` in the tsx SOURCE layout and `<sidecar>/apps/operator`
 * in the packaged layout. `process.cwd()` is no better as the sole anchor: the
 * deployed operator may run with cwd `<release>/apps/operator`, not the repo
 * root.
 *
 * A fixed hop count therefore encodes ONE layout and silently misses the others —
 * the candidate resolver returns no source, and the caller degrades to an install
 * with the feature quietly absent (WI-39140/P-006: the shipped `papercusp project-history`
 * route vanished from the installed dispatcher in exactly this way, on a green
 * deploy, with nothing failing).
 *
 * Walking up and testing for the artifact ITSELF is self-validating: it cannot be
 * fooled by a layout it was not written for, because the thing it looks for is
 * the thing it needs. Emitting candidates (rather than resolving here) keeps the
 * existing "candidates -> firstExisting" contract, so an absent file still falls
 * through to the next legitimate source exactly as before.
 */
function repoAnchoredCandidates(start: string, relPath: string, depth = REPO_ANCHORED_WALK_DEPTH): string[] {
  const out: string[] = [];
  let dir = path.resolve(start);
  for (let i = 0; i <= depth; i++) {
    out.push(path.join(dir, relPath));
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root — stop, do not emit duplicates
    dir = parent;
  }
  return out;
}

/**
 * Resolve Project History's packaged bundle first, then the canonical source
 * CLI on a dev checkout. The source fallback keeps the installed
 * `papercusp project-history` contract usable before a desktop sidecar has
 * been built; packaged installs still select their self-contained bundle.
 *
 * The source fallback is anchored by an upward WALK (see repoAnchoredCandidates)
 * rather than a fixed hop count, so it resolves under the source, bundled and
 * release-checkout layouts alike. This is a strict SUPERSET of the previous
 * two-candidate list — the old `../..`-from-operatorAppRoot and cwd-relative
 * paths are still emitted, at walk depth 2 and 0 respectively.
 */
export function projectHistoryLauncherCandidates(operatorAppRoot: string, explicitRoot: boolean): string[] {
  const bundled = cliLauncherCandidates(operatorAppRoot, explicitRoot, ['project-history.mjs']);
  if (explicitRoot) return bundled;

  const sourceCli = path.join('libs', 'papercusp', 'packages', 'cli', 'bin', 'papercusp');
  const seen = new Set<string>();
  const source = [
    ...repoAnchoredCandidates(operatorAppRoot, sourceCli),
    ...repoAnchoredCandidates(process.cwd(), sourceCli),
  ].filter((candidate) => {
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    return true;
  });
  return [...bundled, ...source];
}

/** Render the command after `exec` for the Project History dispatcher case. */
export function projectHistoryDispatcherExec(nodeCmd: string, launcherPath: string): string {
  const isSourceCli =
    path.basename(launcherPath) === 'papercusp' && path.basename(path.dirname(launcherPath)) === 'bin';
  return isSourceCli
    ? `${JSON.stringify(launcherPath)} project-history`
    : `${JSON.stringify(nodeCmd)} ${JSON.stringify(launcherPath)}`;
}

/**
 * Resolve the node binary a CLI shim should exec. Prefer the BUNDLED node over
 * a bare PATH `node` (end users — a macOS Terminal, a WSL distro, a fresh Linux
 * dogfood install — rarely have node on PATH; bare `node` → "node not found",
 * WI-3334). Anchors, checked in order — the first that exists wins:
 *   1. `$PAPERCUSP_SIDECAR_BIN/node` — the explicit sidecar-bin path the app
 *      exports to serve.mjs (and inherits to children). Canonical + cwd-independent.
 *   2. `process.execPath` — the node binary running THIS process. On a packaged
 *      install that IS the bundled sidecar node (Tauri spawns serve.mjs with
 *      `sidecar/bin/node`); on a dev box it's a valid node too. Existence- and
 *      cwd-independent.
 *   3. next to the launcher: `<dirname(dirname(launcher))>/bin/node` — the
 *      bundled `sidecar/scripts/<launcher>` → `sidecar/bin/node` layout.
 *   4. the sidecar root: `<cwd>/bin/node` — a last-ditch anchor for the case
 *      where serve.mjs's cwd happens to be the sidecar dir.
 * Falls back to PATH `node` only when none resolve (a dev/unbundled layout).
 *
 * WI-3334 history: the original fix used only anchors 3+4. But when the launcher
 * resolved to the extracted dev-source tree (`<dev-source>/apps/operator/scripts`),
 * anchor 3's grandparent (`<dev-source>/apps/operator`) has no `bin/node`, AND
 * installPapercuspFiles does NOT always run with cwd = the sidecar dir, so anchor
 * 4 missed too → the shim fell back to bare `node` on a real packaged install
 * (verified on the Linux dogfood VM). Anchors 1+2 are cwd-independent, so they hold.
 */
export async function resolveShimNode(launcherPath: string): Promise<string> {
  const sidecarBin = process.env.PAPERCUSP_SIDECAR_BIN;
  const execBase = path.basename(process.execPath).toLowerCase();
  const execIsNode = execBase === 'node' || execBase === 'node.exe';
  const candidates = [
    sidecarBin ? path.join(sidecarBin, 'node') : '',
    execIsNode ? process.execPath : '',
    path.join(path.dirname(path.dirname(launcherPath)), 'bin', 'node'),
    path.join(process.cwd(), 'bin', 'node'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (await pathExists(c)) return c;
  }
  return 'node';
}

interface ShimRuntimeOptions {
  /** Explicit per-process override, useful for tests and unusual installs. */
  explicitLauncherEnv: string;
  /** Stable fallback paths captured from the install environment. */
  fallbackLaunchers: string[];
  /**
   * WI-38292: emit a re-exec LOOP instead of a bare `exec`, and advertise it to
   * the launcher as `PAPERCUSP_PSU_REEXEC=<code>`. The launcher exits with this
   * code to mean "re-run me from disk"; every other code exits the shim.
   *
   * Why the PARENT has to do this: psu-launcher.mjs is the long-lived host
   * process and it imports psu-pty-host.mjs exactly once, so a deployed host fix
   * stays inert for the session's whole life. Node has no execve, and the host
   * cannot self-replace either: with `exec`, node IS the interactive shell's
   * child and holds the terminal's FOREGROUND process group, so a
   * spawn-a-successor-then-exit hand-off leaves the shell reclaiming the
   * terminal and the successor stranded in a background pgid (SIGTTIN on every
   * stdin read). Keeping bash in the loop keeps the foreground pgid alive across
   * the swap — the successor is bash's child, in bash's process group, exactly
   * as the first iteration was.
   *
   * The advertisement is a CAPABILITY HANDSHAKE, not decoration: a launcher that
   * does not see it must never take the exiting path, because nothing would
   * re-run it. Old shims, operator-spawned headless members and packaged CLI
   * wrappers therefore keep today's in-process child respawn.
   */
  reexecExitCode?: number;
}

/** WI-38292: the psu shim's "re-run me from disk" exit code. Outside the range
 *  any agent backend or node itself produces (node uses 0-13 and 128+N for
 *  signals; claude passes its own child's code through), so it cannot collide
 *  with a real session exit and re-run a session the owner meant to end. */
export const PSU_REEXEC_EXIT_CODE = 87;

/** WI-38292: hard cap on re-execs per shim invocation. A re-exec only happens at
 *  a carry-respawn that observed stale host code, and the successor loads the
 *  fresh code, so the fixed point is reached in one hop. The cap exists for the
 *  case that does NOT converge — a file rewritten under a running loop (git-sync
 *  sweeps this tree continuously) — where an uncapped loop would respawn the
 *  owner's session forever. */
export const PSU_REEXEC_MAX = 16;

function launcherNameVariants(launcherPath: string): string[] {
  const names = [path.basename(launcherPath)];
  if (names[0] === 'psu-launcher.mjs') names.push('psu.mjs');
  if (names[0] === 'psu.mjs') names.push('psu-launcher.mjs');
  if (names[0] === 'ptool.mjs') names.push('ptool-launcher.mjs');
  if (names[0] === 'ptool-launcher.mjs') names.push('ptool.mjs');
  return [...new Set(names)];
}

function launcherRelativePaths(launcherPath: string): string[] {
  return [
    ...new Set(
      launcherNameVariants(launcherPath).flatMap((name) => [`apps/operator/scripts/${name}`, `scripts/${name}`]),
    ),
  ];
}

/**
 * Keep the release tree as the install-time fallback. The active integration
 * tree is selected at shim invocation time from PAPERCUSP_INTEGRATION_ROOT;
 * embedding it here would recreate the boot-order race this shim fixes.
 */
export function shimRuntimeOptions(launcherPath: string, explicitLauncherEnv: string): ShimRuntimeOptions {
  const releaseRoot = process.env.PAPERCUSP_RELEASE_ROOT?.trim();
  const releaseFallbacks = releaseRoot
    ? launcherRelativePaths(launcherPath).map((relative) => path.join(releaseRoot, relative))
    : [];
  return {
    explicitLauncherEnv,
    fallbackLaunchers: [...new Set([...releaseFallbacks, launcherPath])],
  };
}

/**
 * Write an executable bash shim that resolves its launcher at RUN time.
 *
 * The old shim baked whichever operator tree happened to run
 * installPapercuspFiles last. On a dev box both the green release operator and
 * the staging operator boot, so the shared ~/.papercusp/bin/psu silently
 * changed behavior based on boot order. Runtime resolution makes the active
 * integration/release root win, while the install-time fallback keeps a
 * packaged app usable when no root env is exported.
 */
export async function writeShim(
  shimPath: string,
  launcherPath: string,
  label: string,
  runtime: ShimRuntimeOptions,
): Promise<boolean> {
  const nodeCmd = await resolveShimNode(launcherPath);
  const bundledBinDir = nodeCmd === 'node' ? null : path.dirname(nodeCmd);
  const relativeLauncherPaths = launcherRelativePaths(launcherPath);
  const shellLiteral = (value: string): string => JSON.stringify(value);
  const fallbackLiterals = runtime.fallbackLaunchers.map(shellLiteral);
  const relativeLiterals = relativeLauncherPaths.map(shellLiteral);
  const body =
    '#!/usr/bin/env bash\n' +
    `# papercusp ${label} shim — managed by Papercusp.app (installPapercuspFiles).\n` +
    '# Refreshed on every boot; do not edit. Resolves the launcher at runtime.\n' +
    // The agent backend must be resolvable by the launcher's pty.spawn('claude').
    // The official claude.ai installer uses ~/.local/bin, while `npm install -g`
    // in the packaged Windows WSL runtime writes its shim beside the bundled node
    // under sidecar/bin. The distro deliberately omits both from its login PATH.
    // Prepend the resolved node's directory when it is not a bare PATH command;
    // JSON quoting keeps packaged paths containing spaces shell-safe.
    (bundledBinDir
      ? `export PATH=${shellLiteral(bundledBinDir)}:"$HOME/.local/bin:$PATH"\n`
      : 'export PATH="$HOME/.local/bin:$PATH"\n') +
    'resolve_launcher() {\n' +
    `  if [ -n "\${${runtime.explicitLauncherEnv}:-}" ] && [ -f "\${${runtime.explicitLauncherEnv}}" ]; then\n` +
    `    printf '%s\\n' "\${${runtime.explicitLauncherEnv}}"\n` +
    '    return 0\n' +
    '  fi\n' +
    '  local root rel candidate\n' +
    '  for root in "${PAPERCUSP_INTEGRATION_ROOT:-}" "${PAPERCUSP_RELEASE_ROOT:-}"; do\n' +
    '    [ -n "$root" ] || continue\n' +
    '    for rel in \\\n' +
    `      ${relativeLiterals.join(' \\\n      ')}\n` +
    '    do\n' +
    '      candidate="$root/$rel"\n' +
    '      if [ -f "$candidate" ]; then\n' +
    '        printf \'%s\\n\' "$candidate"\n' +
    '        return 0\n' +
    '      fi\n' +
    '    done\n' +
    '  done\n' +
    '  for candidate in \\\n' +
    `    ${fallbackLiterals.join(' \\\n    ')}\n` +
    '  do\n' +
    '    if [ -f "$candidate" ]; then\n' +
    '      printf \'%s\\n\' "$candidate"\n' +
    '      return 0\n' +
    '    fi\n' +
    '  done\n' +
    `  printf '%s\\n' 'papercusp ${label}: no launcher found; set ${runtime.explicitLauncherEnv} or PAPERCUSP_INTEGRATION_ROOT' >&2\n` +
    '  return 127\n' +
    '}\n' +
    'launcher="$(resolve_launcher)" || exit $?\n' +
    `printf '%s\\n' ${shellLiteral(`papercusp ${label}: launcher`)} "$launcher" >&2\n` +
    (runtime.reexecExitCode == null
      ? `exec ${shellLiteral(nodeCmd)} "$launcher" "$@"\n`
      : // WI-38292 re-exec loop. NOT `exec`: bash must survive the swap so the
        // terminal's foreground process group outlives it (see reexecExitCode).
        // The launcher is RE-RESOLVED each pass — picking up new code is the
        // whole point, and the active release/integration root may have moved.
        `export PAPERCUSP_PSU_REEXEC=${runtime.reexecExitCode}\n` +
        // Our OWN pid, so the launcher can tell an advertisement made to IT from
        // one it merely inherited. Env vars flow to every descendant; a nested
        // `psu` (or anything the CLI child spawns) would otherwise read this as a
        // promise that someone will re-run it, and exit into nobody.
        'export PAPERCUSP_PSU_REEXEC_PPID=$$\n' +
        'psu_reexecs=0\n' +
        'while :; do\n' +
        `  ${shellLiteral(nodeCmd)} "$launcher" "$@"\n` +
        '  psu_code=$?\n' +
        `  [ "$psu_code" -eq ${runtime.reexecExitCode} ] || exit "$psu_code"\n` +
        // EI-20994934425970874: kickoff is a ONE-SHOT launch input. The shim's
        // host-code adoption loop deliberately re-runs the original launcher,
        // but `$@` and exported env survive that loop unless we consume them
        // here. The inner host handoff also nulls kickoff, but only after the
        // successor has parsed/tagged the original input — and a rejected or
        // missed handoff used to deliver the same first turn again. Strip both
        // supported channels at the parent boundary before iteration two. The
        // carry itself rides the handoff's child argv, not either kickoff input.
        '  unset PAPERCUSP_KICKOFF_PROMPT\n' +
        '  psu_next_args=()\n' +
        '  psu_drop_kickoff_value=0\n' +
        '  for psu_arg in "$@"; do\n' +
        '    if [ "$psu_drop_kickoff_value" -eq 1 ]; then\n' +
        '      psu_drop_kickoff_value=0\n' +
        '      continue\n' +
        '    fi\n' +
        '    case "$psu_arg" in\n' +
        '      --kickoff) psu_drop_kickoff_value=1 ;;\n' +
        '      --kickoff=*) ;;\n' +
        '      *) psu_next_args+=("$psu_arg") ;;\n' +
        '    esac\n' +
        '  done\n' +
        '  set -- "${psu_next_args[@]}"\n' +
        '  psu_reexecs=$((psu_reexecs + 1))\n' +
        // -gt, not -ge: `psu_reexecs` counts re-execs ALREADY PERFORMED, so the
        // Nth one must be allowed to happen before the N+1th is refused.
        `  if [ "$psu_reexecs" -gt ${PSU_REEXEC_MAX} ]; then\n` +
        `    printf '%s\\n' ${shellLiteral(
          `papercusp ${label}: ${PSU_REEXEC_MAX} host re-execs in one session — refusing to loop again`,
        )} >&2\n` +
        '    exit "$psu_code"\n' +
        '  fi\n' +
        `  printf '%s\\n' ${shellLiteral(
          `papercusp ${label}: adopting updated host code (re-exec`,
        )}"$psu_reexecs)" >&2\n` +
        '  launcher="$(resolve_launcher)" || exit $?\n' +
        'done\n');
  await fs.writeFile(shimPath, body, { mode: 0o755 });
  // writeFile honors mode only on creation; chmod to guarantee on overwrite.
  await fs.chmod(shimPath, 0o755);
  return true;
}

/**
 * Write the `papercusp` end-user dispatcher shim (agent-first-onboarding
 * P-014): `papercusp setup` (alias `onboard`) runs the terminal onboarding
 * concierge, `papercusp tutorial` re-opens the guided tutorial (concierge
 * --tutorial), and `papercusp project-history` runs the standalone generator.
 * The onboarding commands reach the same unified shell (owner batch #4/#5).
 * Same node-resolution rules as writeShim. The Linux .deb writes a system
 * twin at /usr/bin/papercusp (deb/postinstall.sh); this per-user copy covers
 * macOS + dev boxes, where installPapercuspFiles is the install path.
 */
async function writeDispatcherShim(
  shimPath: string,
  launcherPath: string,
  projectHistoryLauncherPath?: string,
): Promise<boolean> {
  const nodeCmd = await resolveShimNode(launcherPath);
  const projectHistoryExec = projectHistoryLauncherPath
    ? projectHistoryDispatcherExec(nodeCmd, projectHistoryLauncherPath)
    : '';
  const projectHistoryCase = projectHistoryLauncherPath
    ? `  project-history) shift; exec ${projectHistoryExec} "$@" ;;\n`
    : '';
  const usage = projectHistoryLauncherPath
    ? 'usage: papercusp <setup|tutorial|project-history>'
    : 'usage: papercusp <setup|tutorial>';
  const projectHistoryHelp = projectHistoryLauncherPath
    ? '    echo "  project-history  generate a versioned project History artifact"\n'
    : '';
  const body =
    '#!/usr/bin/env bash\n' +
    '# papercusp CLI dispatcher — managed by Papercusp.app (installPapercuspFiles).\n' +
    '# Refreshed on every boot; do not edit.\n' +
    'cmd="${1:-}"\n' +
    'case "$cmd" in\n' +
    // `setup` and `tutorial` both open the SAME unified Tutorial|Setup shell — they
    // just default to a different tab (owner batch #4/#5: "Papercusp Setup" & "Papercusp
    // Tutorial" reach the same place, with tabs for both). `onboard` is the desktop's
    // AUTO first-boot linear concierge (kept as a back-compat alias for direct use).
    `  setup)    shift; exec ${JSON.stringify(nodeCmd)} ${JSON.stringify(launcherPath)} --tab=setup "$@" ;;\n` +
    `  tutorial) shift; exec ${JSON.stringify(nodeCmd)} ${JSON.stringify(launcherPath)} --tutorial "$@" ;;\n` +
    `  onboard)  shift; exec ${JSON.stringify(nodeCmd)} ${JSON.stringify(launcherPath)} "$@" ;;\n` +
    projectHistoryCase +
    '  *)\n' +
    `    echo "${usage}"\n` +
    '    echo "  setup     open the Tutorial & Setup shell on the Setup tab"\n' +
    '    echo "  tutorial  open the Tutorial & Setup shell on the Tutorial tab"\n' +
    projectHistoryHelp +
    '    exit 2 ;;\n' +
    'esac\n';
  await fs.writeFile(shimPath, body, { mode: 0o755 });
  await fs.chmod(shimPath, 0o755);
  return true;
}

/**
 * Write the `psu-sentinel` dock-pane launcher shim (WI-4244). The zellij dock
 * layout (apps/tui/src/layout.rs) invokes `psu-sentinel` by bare command name
 * for the 🛡 Sentinel pane — but nothing ever put it on PATH, so packaged
 * builds hit "Command not found: psu-sentinel". Mirrors the dev-repo source
 * of truth (apps/operator/scripts/psu-sentinel.sh) exactly: register the
 * current zellij pane for voice-transcript routing, apply a per-session model
 * override if one is staged, then exec the just-written `psu` shim with
 * `--role=papercup`. Takes the ALREADY-RESOLVED `psu` shim path (not a
 * launcher source) — hardcoding the concrete shim path is more robust than
 * relying on PATH resolution for `psu` again at pane-launch time. Only ever
 * called when the `psu` shim itself was written this pass (sentinel execs
 * psu; a sentinel shim with no psu to exec would be worse than no shim).
 */
async function writeSentinelShim(shimPath: string, psuShimPath: string): Promise<boolean> {
  const body =
    '#!/usr/bin/env bash\n' +
    '# papercusp psu-sentinel shim — managed by Papercusp.app (installPapercuspFiles).\n' +
    '# Refreshed on every boot; do not edit. Registers the dock pane for voice-transcript\n' +
    '# routing, applies a model override, then execs the psu shim with role=papercup.\n' +
    'mkdir -p "$HOME/.papercusp" 2>/dev/null || true\n' +
    'if [ -n "$ZELLIJ_PANE_ID" ] && [ -n "$ZELLIJ_SESSION_NAME" ]; then\n' +
    '  printf \'%s %s\' "$ZELLIJ_SESSION_NAME" "$ZELLIJ_PANE_ID" > "$HOME/.papercusp/sentinel-pane" 2>/dev/null || true\n' +
    'fi\n' +
    // Absent override ⇒ default to a FAST spec: the pane is the papercup-fast
    // voice front-end and must answer inside the voice response window; the old
    // absent⇒workspace-default fallback is how it became a too-slow heavy
    // session (voice-public-release-readiness D-007). Keep in lockstep with the
    // dev shim (apps/operator/scripts/psu-sentinel.sh).
    "spec='sonnet:medium'\n" +
    'if [ -s "$HOME/.papercusp/sentinel-model" ]; then\n' +
    '  file_spec="$(tr -d \' \\t\\r\\n\' < "$HOME/.papercusp/sentinel-model" 2>/dev/null)"\n' +
    '  [ -n "$file_spec" ] && spec="$file_spec"\n' +
    'fi\n' +
    'model_args=("--model=$spec")\n' +
    `exec ${JSON.stringify(psuShimPath)} --no-picker --agent=claude --role=papercup "\${model_args[@]}"\n`;
  await fs.writeFile(shimPath, body, { mode: 0o755 });
  await fs.chmod(shimPath, 0o755);
  return true;
}

/**
 * Write the `rg` entry point (P-017 / D-001 of
 * orchestration-surface-residue-drain-2026-08-23).
 *
 * WHY AN ENTRY POINT RATHER THAN A PATH ENTRY. Four agents filed `rg: command not
 * found` inside `capability:bash` on one day, and all four named the cause as "the
 * confined shell's PATH lacks rg". That is wrong, and a PATH-only fix changes
 * nothing: a scan of every plausible bin dir found NO standalone ripgrep binary and
 * no ripgrep package on the host, while the same scan found /usr/bin/git — so the
 * instrument was sound and the absence genuine. `rg` reaches an interactive shell
 * ONLY as a shell FUNCTION that Claude Code defines in the profile, which re-execs
 * the claude binary with argv[0]=rg (that binary embeds ripgrep 14.1.1 +pcre2).
 * Shell functions are not exported into a scrubbed `bash -c` child, which is
 * exactly why a human typing the command succeeded and every operator-spawned child
 * failed. This file supplies the missing entry point; `augmentedSpawnPath` supplies
 * the directory.
 *
 * Deliberately writes ONLY when nothing else on the system provides `rg`
 * (`resolvesElsewhere`): a real ripgrep install must always win over a shim that
 * costs a 342MB process launch, and a host that later installs ripgrep properly
 * should not keep executing this.
 *
 * `claudeExecutable` is the resolved claude binary, or undefined when none was
 * found. Undefined still writes the shim, which then exits 127 with a pointer to
 * grep/gitnexus — a stated "ripgrep is unavailable here" beats `command not found`,
 * which reads as a PATH bug and sent four agents down the wrong path already.
 */
export async function writeRipgrepShim(
  shimPath: string,
  opts: { claudeExecutable?: string; resolvesElsewhere?: boolean } = {},
): Promise<boolean> {
  if (opts.resolvesElsewhere) return false;
  // The stable ~/.local/bin/claude symlink is the fallback because the Claude Code
  // installer REPOINTS it on upgrade — pinning a versioned path here would make the
  // shim rot at the next version bump, which is the failure mode a generated file is
  // supposed to remove.
  const fallback = path.join(os.homedir(), '.local', 'bin', 'claude');
  const resolved = opts.claudeExecutable && opts.claudeExecutable.length > 0 ? opts.claudeExecutable : fallback;
  const body =
    '#!/usr/bin/env bash\n' +
    '# papercusp `rg` entry point — managed by Papercusp.app (installPapercuspFiles).\n' +
    '# Refreshed on every boot; do not edit.\n' +
    '#\n' +
    '# There is no standalone ripgrep binary on this host. Interactive shells get `rg`\n' +
    '# from a shell FUNCTION Claude Code defines in the profile, which re-execs the\n' +
    '# claude binary with argv[0]=rg. Shell functions are NOT exported into a scrubbed\n' +
    '# `bash -c` child, so non-interactive callers (capability:bash, code:run, saved\n' +
    '# recipes, exec-sandbox) saw "command not found" while a human typing the same\n' +
    '# command succeeded. This supplies the entry point they were missing.\n' +
    'set -euo pipefail\n' +
    '\n' +
    '# CLAUDE_CODE_EXECPATH wins when the caller set it; otherwise the stable\n' +
    '# ~/.local/bin/claude symlink, which the installer repoints on upgrade.\n' +
    '_cc="${CLAUDE_CODE_EXECPATH:-}"\n' +
    `if [[ -z \${_cc} || ! -x \${_cc} ]]; then\n  _cc=${JSON.stringify(resolved)}\n` +
    'fi\n' +
    '\n' +
    'if [[ ! -x ${_cc} ]]; then\n' +
    '  echo "rg: ripgrep is unavailable — no standalone ripgrep binary is installed on this host," >&2\n' +
    '  echo "rg: and the claude executable that embeds it was not found at \'${_cc}\'." >&2\n' +
    '  echo "rg: use grep -rn (exhaustive text search) or gitnexus.context { name } (symbol lookup)." >&2\n' +
    '  exit 127\n' +
    'fi\n' +
    '\n' +
    '# exec -a rg: the claude binary dispatches to its embedded ripgrep purely on argv[0].\n' +
    'exec -a rg "${_cc}" "$@"\n';
  await fs.writeFile(shimPath, body, { mode: 0o755 });
  // writeFile honors mode only on creation; chmod to guarantee on overwrite.
  await fs.chmod(shimPath, 0o755);
  return true;
}

/**
 * Write the `psu-sentinel-deep` dock-pane launcher shim
 * (voice-public-release-readiness-2026-07-12 P-014/D-006 — the deep-brain
 * pane). Twin of writeSentinelShim above: registers the pane to
 * ~/.papercusp/sentinel-deep-pane, applies ~/.papercusp/sentinel-deep-model
 * when staged (absent ⇒ the HEAVY `opus:xhigh` default — depth is this
 * session's contract; the front-end pane owns responsiveness), then execs the
 * psu shim as the workspace-level `papercup-deep` role. Keep in lockstep with
 * the dev shim (apps/operator/scripts/psu-sentinel-deep.sh). Only called when
 * the `psu` shim was written this pass (same reasoning as the sentinel shim).
 */
async function writeSentinelDeepShim(shimPath: string, psuShimPath: string): Promise<boolean> {
  const body =
    '#!/usr/bin/env bash\n' +
    '# papercusp psu-sentinel-deep shim — managed by Papercusp.app (installPapercuspFiles).\n' +
    '# Refreshed on every boot; do not edit. Registers the deep-brain dock pane, applies a\n' +
    '# model override, then execs the psu shim with role=papercup-deep.\n' +
    'mkdir -p "$HOME/.papercusp" 2>/dev/null || true\n' +
    'if [ -n "$ZELLIJ_PANE_ID" ] && [ -n "$ZELLIJ_SESSION_NAME" ]; then\n' +
    '  printf \'%s %s\' "$ZELLIJ_SESSION_NAME" "$ZELLIJ_PANE_ID" > "$HOME/.papercusp/sentinel-deep-pane" 2>/dev/null || true\n' +
    'fi\n' +
    "spec='opus:xhigh'\n" +
    'if [ -s "$HOME/.papercusp/sentinel-deep-model" ]; then\n' +
    '  file_spec="$(tr -d \' \\t\\r\\n\' < "$HOME/.papercusp/sentinel-deep-model" 2>/dev/null)"\n' +
    '  [ -n "$file_spec" ] && spec="$file_spec"\n' +
    'fi\n' +
    'model_args=("--model=$spec")\n' +
    `exec ${JSON.stringify(psuShimPath)} --no-picker --agent=claude --role=papercup-deep "\${model_args[@]}"\n`;
  await fs.writeFile(shimPath, body, { mode: 0o755 });
  await fs.chmod(shimPath, 0o755);
  return true;
}

/**
 * Write a minimal, self-contained macOS `.app` bundle at
 * `~/Applications/Papercusp Tutorial & Setup.app` that double-clicks (Finder/Launchpad/
 * Spotlight) into a fresh Terminal (or iTerm, if installed) window running
 * `papercusp tutorial` (windows-macos-tutorial-shortcut-parity-2026-07-04,
 * WI-2197). Parity with the Linux .deb's third `.desktop` icon
 * (deb/postinstall.sh, agent-first-onboarding P-014) and the forthcoming
 * Windows Start-Menu entry (src-tauri/windows/fragments + hooks.nsh) — this is
 * the macOS leg, since a DMG has no postinstall-script hook to lean on the way
 * the .deb does, so it has to be provisioned here at first-run instead.
 *
 * `~/Applications` (NOT `/Applications`) so this needs no admin privilege —
 * it's a standard, LaunchServices/Spotlight-indexed per-user location, same
 * unprivileged-per-user posture as the rest of installPapercuspFiles.
 *
 * The bundle's own executable is a bash script (macOS doesn't require a
 * compiled binary — LaunchServices only needs CFBundleExecutable to be
 * executable) that mirrors native_console.rs's spawn_macos_new_window: write a
 * one-shot `.command` file and `open -na <Terminal.app|iTerm.app>` it, so a
 * REAL terminal window opens (a bare script would otherwise run invisibly in
 * the background).
 */
async function writeMacTutorialApp(appPath: string): Promise<boolean> {
  // WI-2945: the mac DMGs now BAKE a "Papercusp Tutorial.app" at build time
  // (papercusp-desktop/bin/mac-vm-build.sh — same bundle id com.papercusp.tutorial,
  // same launcher script; keep the two generators in sync). When the user dragged
  // that copy into /Applications, don't write a second one into ~/Applications —
  // LaunchServices would surface two identical apps. This first-boot write remains
  // the fallback for installs that skipped dragging the tutorial app.
  for (const installed of ['/Applications/Papercusp Tutorial.app', '/Applications/Papercusp Tutorial & Setup.app']) {
    if (await pathExists(installed)) return false;
  }
  const contentsDir = path.join(appPath, 'Contents');
  const macosDir = path.join(contentsDir, 'MacOS');
  await fs.mkdir(macosDir, { recursive: true });

  const infoPlist =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n' +
    '<dict>\n' +
    '  <key>CFBundleName</key><string>Papercusp Tutorial &amp; Setup</string>\n' +
    '  <key>CFBundleDisplayName</key><string>Papercusp Tutorial &amp; Setup</string>\n' +
    '  <key>CFBundleIdentifier</key><string>com.papercusp.tutorial</string>\n' +
    '  <key>CFBundleVersion</key><string>1</string>\n' +
    '  <key>CFBundleShortVersionString</key><string>1.0</string>\n' +
    '  <key>CFBundlePackageType</key><string>APPL</string>\n' +
    '  <key>CFBundleExecutable</key><string>papercusp-tutorial</string>\n' +
    '  <key>LSMinimumSystemVersion</key><string>10.15</string>\n' +
    '  <key>LSUIElement</key><true/>\n' +
    '  <key>NSHighResolutionCapable</key><true/>\n' +
    '</dict>\n' +
    '</plist>\n';
  await fs.writeFile(path.join(contentsDir, 'Info.plist'), infoPlist, { mode: 0o644 });

  const executable =
    '#!/bin/bash\n' +
    '# Papercusp Tutorial launcher — managed by Papercusp.app (installPapercuspFiles).\n' +
    '# Refreshed on every boot; do not edit. Opens a Terminal window running\n' +
    '# `papercusp tutorial` (mirrors native_console.rs spawn_macos_new_window).\n' +
    'set -e\n' +
    'TMP="$(mktemp -t papercusp-tutorial).command"\n' +
    'cat > "$TMP" <<\'SCRIPT\'\n' +
    '#!/bin/bash\n' +
    'set -e\n' +
    'export PATH="$HOME/.papercusp/bin:$HOME/.local/bin:$PATH"\n' +
    '"$HOME/.papercusp/bin/papercusp" tutorial\n' +
    'SCRIPT\n' +
    'chmod +x "$TMP"\n' +
    'TERM_APP="Terminal.app"\n' +
    '[ -d "/Applications/iTerm.app" ] && TERM_APP="iTerm.app"\n' +
    'open -na "$TERM_APP" "$TMP"\n';
  const execPath = path.join(macosDir, 'papercusp-tutorial');
  await fs.writeFile(execPath, executable, { mode: 0o755 });
  await fs.chmod(execPath, 0o755);
  return true;
}

/**
 * Write a per-user XDG `.desktop` launcher at
 * `~/.local/share/applications/papercusp-tutorial.desktop` — the LINUX leg of the
 * tutorial-icon parity (owner 2026-07-06: "how come I still don't see the icon on my
 * taskbar in this dev box", 4th report). Until now the tutorial icon was provisioned
 * ONLY by the .deb postinstall (deb/postinstall.sh, into the ROOT /usr/share) and by
 * macOS `writeMacTutorialApp` — so a Linux DEV box or ANY non-.deb Linux install
 * (a tarball, `npm run dev`, a hand-run operator) got NO tutorial icon at all. This is
 * the first-boot equivalent, mirroring `writeMacTutorialApp`: an UNPRIVILEGED per-user
 * dir (no root, unlike the .deb), `Exec` pointed at the per-user dispatcher shim, and
 * `Terminal=true` so the DE opens a real terminal running `papercusp tutorial`.
 *
 * Icon: install a real PNG into the user hicolor theme and reference it by ABSOLUTE
 * path (robust — no icon-cache refresh needed); if no source PNG resolves, fall back to
 * the themed name `papercusp-desktop` (what the .deb + Tauri bundle install). The entry
 * appears in the app grid; pinning it to a dock/taskbar is the user's/DE's choice (the
 * .deb doesn't auto-pin either). Best-effort throughout — never breaks the install.
 */
export async function writeLinuxTutorialDesktopEntry(
  desktopPath: string,
  papercuspCliPath: string,
  home: string,
  operatorAppRoot: string,
): Promise<boolean> {
  try {
    const appsDir = path.dirname(desktopPath);
    await fs.mkdir(appsDir, { recursive: true });

    // Best-effort: install a real icon PNG into the user hicolor theme; reference it by
    // absolute path so it renders even without a gtk-update-icon-cache pass.
    let iconRef = 'papercusp-desktop'; // themed-name fallback (.deb / Tauri bundle install it)
    const iconSrc = await firstExisting([
      path.resolve(operatorAppRoot, '..', '..', 'papercusp-desktop', 'src-tauri', 'icons', '128x128.png'),
      path.resolve(operatorAppRoot, 'papercusp-desktop', 'src-tauri', 'icons', '128x128.png'),
      path.join(operatorAppRoot, 'icons', '128x128.png'),
      path.join(operatorAppRoot, 'resources', 'icons', '128x128.png'),
    ]);
    if (iconSrc) {
      const iconDst = path.join(
        home,
        '.local',
        'share',
        'icons',
        'hicolor',
        '128x128',
        'apps',
        'papercusp-desktop.png',
      );
      try {
        await fs.mkdir(path.dirname(iconDst), { recursive: true });
        await fs.writeFile(iconDst, await fs.readFile(iconSrc), { mode: 0o644 });
        iconRef = iconDst;
      } catch {
        /* keep the themed-name fallback */
      }
    }

    // A path with spaces must be double-quoted per the freedesktop Exec spec.
    const execBin = papercuspCliPath.includes(' ') ? `"${papercuspCliPath}"` : papercuspCliPath;
    const desktop =
      '[Desktop Entry]\n' +
      'Type=Application\n' +
      'Name=Papercusp Tutorial & Setup\n' +
      'Comment=Open the guided Papercusp tutorial and setup (tabs for both)\n' +
      `Exec=${execBin} tutorial\n` +
      `Icon=${iconRef}\n` +
      'Terminal=true\n' +
      'Categories=Development;\n' +
      'StartupNotify=true\n';
    await fs.writeFile(desktopPath, desktop, { mode: 0o644 });
    await fs.chmod(desktopPath, 0o644);

    // Refresh the desktop DB so the entry shows without a re-login (best-effort, detached).
    try {
      const { spawn } = await import('node:child_process');
      spawn('update-desktop-database', [appsDir], { stdio: 'ignore' }).on('error', () => {});
    } catch {
      /* not installed — the DE picks the entry up on its next scan */
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Append a desktop-id to a GNOME `favorite-apps` gsettings array LITERAL, idempotently.
 * Pure/string-only so it is unit-testable without a session bus. Handles the shapes
 * gsettings emits: `['a.desktop', 'b.desktop']`, an empty `[]`, and the typed-empty
 * `@as []`. Returns the input unchanged (sans type annotation) when `id` is already
 * present, so callers never double-pin.
 */
export function appendGnomeFavorite(current: string, id: string): string {
  let s = (current || '').trim();
  if (s.startsWith('@as ')) s = s.slice(4).trim(); // drop the type annotation on empty arrays
  const item = `'${id}'`;
  if (s.includes(item)) return s; // already pinned — no-op (don't duplicate)
  if (s === '' || s === '[]') return `[${item}]`;
  const close = s.lastIndexOf(']');
  if (close < 0) return `[${item}]`;
  const inner = s.slice(s.indexOf('[') + 1, close).trim();
  return inner.length ? `[${inner}, ${item}]` : `[${item}]`;
}

/**
 * Auto-pin the tutorial launcher to the GNOME dock/taskbar (owner 2026-07-06, repeated
 * to a 5th report: "I still don't see the papercusp icon in my taskbar"). Writing the
 * `.desktop` only lands it in the app GRID — the owner wants it PINNED to the dock — so
 * this appends `papercusp-tutorial.desktop` to `org.gnome.shell.favorite-apps` (GNOME's
 * dock-favorites list) via gsettings.
 *
 * Pins exactly ONCE, guarded by `markerPath`: installPapercuspFiles re-runs on every
 * boot, and re-pinning every time would fight a user who deliberately un-pinned it — so
 * after the first attempt we drop a marker and never touch favorites again. Best-effort
 * and GNOME-only: silently no-ops when gsettings / the schema is absent (non-GNOME DE,
 * no session bus) and never throws (an install must not fail over a dock cosmetic).
 *
 * NOTE: on an already-running GNOME session the newly-pinned favorite only renders once
 * the shell has re-scanned `~/.local/share/applications` (a fresh app is registered via
 * its file monitor after `update-desktop-database`); a first-boot / fresh login always
 * shows it. This is why the dev box that had a shell running for days needed a manual
 * shell reload once — a normal install does not.
 */
export async function pinLinuxTutorialToDock(desktopId: string, markerPath: string): Promise<boolean> {
  try {
    // Pin-once gate: if we've already attempted a pin, respect any later user un-pin.
    try {
      await fs.access(markerPath);
      return false;
    } catch {
      /* not attempted yet — fall through */
    }

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const pexec = promisify(execFile);

    let current = '';
    try {
      const { stdout } = await pexec('gsettings', ['get', 'org.gnome.shell', 'favorite-apps']);
      current = stdout.trim();
    } catch {
      return false; // no gsettings / GNOME schema (non-GNOME DE, headless) — nothing to pin
    }

    const next = appendGnomeFavorite(current, desktopId);
    let pinned = false;
    if (next !== current.replace(/^@as\s+/, '').trim()) {
      try {
        await pexec('gsettings', ['set', 'org.gnome.shell', 'favorite-apps', next]);
        pinned = true;
      } catch {
        return false; // couldn't write — don't drop the marker, allow a retry next boot
      }
    }
    // Mark the one-time attempt as done (whether we added it or it was already present).
    try {
      await fs.mkdir(path.dirname(markerPath), { recursive: true });
      await fs.writeFile(markerPath, `${new Date().toISOString()}\n`, { mode: 0o644 });
    } catch {
      /* marker is best-effort; worst case we re-check (idempotent) next boot */
    }
    return pinned;
  } catch {
    return false;
  }
}

/**
 * Ensure ~/.papercusp/bin is on the user's shell PATH so `psu` / `ptool` work in
 * ANY terminal the user opens — not only the in-app "+" console (which sets PATH
 * itself). Appends an idempotent, marker-guarded block to the common login +
 * interactive shell profiles; the `case` guard makes the export a no-op when the
 * dir is already on PATH (safe across multiple sourcings). Only profiles that
 * already exist are touched, except when the user has NO profile at all (fresh
 * account) — then ~/.zprofile is seeded (zsh is the macOS default).
 * (psu-in-desktop-builds: "access psu from whatever the native console is".)
 */
async function ensureBinOnPath(home: string, binDir: string): Promise<string[]> {
  const marker = '# papercusp psu PATH (managed by Papercusp.app)';
  const block =
    `\n${marker} >>>\n` +
    `case ":$PATH:" in *":${binDir}:"*) ;; *) export PATH="${binDir}:$PATH" ;; esac\n` +
    `# papercusp psu PATH <<<\n`;
  const touched: string[] = [];
  let anyExisting = false;
  for (const name of ['.zprofile', '.zshrc', '.bash_profile', '.bashrc', '.profile']) {
    const fp = path.join(home, name);
    let content: string | null = null;
    try {
      content = await fs.readFile(fp, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (content === null) continue; // don't create a profile that isn't there
    anyExisting = true;
    if (content.includes(marker)) continue; // already added — idempotent
    await fs.writeFile(fp, content + block, { mode: 0o644 });
    touched.push(fp);
  }
  if (!anyExisting) {
    const fp = path.join(home, '.zprofile');
    await fs.writeFile(fp, block, { mode: 0o644 });
    touched.push(fp);
  }
  return touched;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function firstExisting(candidates: string[]): Promise<string | null> {
  for (const c of candidates) {
    if (await pathExists(c)) return c;
  }
  return null;
}

/**
 * psu execs the chosen agent CLI BY NAME, expecting it on PATH — but a GUI
 * app's operator child rarely inherits the user's login PATH, so a `claude` /
 * `codex` / `omp` installed under `~/.local/bin` (etc.) is invisible and
 * `psu → claude` exits immediately ("can't launch the agent"). `~/.papercusp/bin`
 * IS on psu's PATH (ensureBinOnPath), so symlink any agent CLI we find there.
 * Best-effort + idempotent. (`gh` ships bundled in the sidecar; a CLI absent
 * everywhere is the WI-681 install gap, surfaced separately — not linkable.)
 *
 * WI-37920 / P-006 — two changes, both from the same measured failure:
 *
 *  • `omp` was NOT in this loop, so a bun-installed omp never got a shim. That
 *    is the installer-layer half of the defect whose spawn-layer half was
 *    "psu: the omp backend (`omp`) is not installed" inside a desktop terminal.
 *  • The search list was hand-rolled here and missed `~/.bun/bin` (and nvm, and
 *    volta, and Linux brew). It now comes from `backendSearchDirs`, the ONE
 *    definition shared with psu's detection and with the operator's spawn-PATH
 *    injection — three consumers, one list, so a new install location is added
 *    in exactly one place.
 *
 * ⚠ What this deliberately does NOT link: the shebang INTERPRETER (`omp` is
 * `#!/usr/bin/env bun`). `~/.papercusp/bin` is PREPENDED to a spawned PATH, so a
 * `bun` shim here would outrank the user's own `bun` for every command they run
 * — a far worse bug than the one being fixed. The interpreter is handled by the
 * spawn-time PATH APPEND instead (console-spawn's buildPathExport), which cannot
 * shadow anything the user already has.
 */
export async function ensureAgentClisLinked(home: string, binDir: string): Promise<string[]> {
  const linked: string[] = [];
  const searchDirs = backendSearchDirs({ home });
  for (const agent of BACKEND_AGENTS) {
    const dest = path.join(binDir, agent);
    try {
      await fs.access(dest);
      continue; // already linked/present
    } catch {
      /* not there yet — try to link it */
    }
    for (const dir of searchDirs) {
      // Never link a dir to itself: binDir (~/.papercusp/bin) is IN the shared
      // search list, so without this a missing dest could resolve to the dest.
      if (dir === binDir) continue;
      const src = path.join(dir, agent);
      try {
        await fs.access(src);
        await fs.symlink(src, dest);
        linked.push(agent);
        break;
      } catch {
        /* not in this dir / link failed — try next */
      }
    }
  }
  return linked;
}

/**
 * Make the common `python` spelling available to agent shells without changing
 * the host's shared bin directories (EI-22568296159914561). Agent snippets and
 * forensic runbooks sometimes invoke `python`, while the managed Linux host
 * only provides `python3`. The installer already owns ~/.papercusp/bin and puts
 * it on PATH, so a compatibility link there fixes the shell boundary without
 * shadowing a user's existing `python` elsewhere on the host.
 *
 * This is deliberately non-clobbering: even a dangling existing entry is left
 * untouched so an installer upgrade cannot silently take over the user's
 * chosen `python` command. The search list supplements the GUI process PATH,
 * which may omit user package-manager and Linuxbrew directories.
 */
export async function ensurePythonCompatibilityLinked(
  home: string,
  binDir: string,
  searchDirs: string[] = backendSearchDirs({ home }),
): Promise<boolean> {
  const dest = path.join(binDir, 'python');

  // Preserve any existing file, symlink (including dangling), or other entry.
  try {
    await fs.lstat(dest);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
  }

  const candidates = [
    resolveOnPath('python3', { env: process.env }),
    ...searchDirs.map((dir) => path.join(dir, 'python3')),
  ].filter((candidate, index, all): candidate is string => Boolean(candidate) && all.indexOf(candidate) === index);
  const python3 = await firstExisting(candidates);
  if (!python3) return false;

  try {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.symlink(python3, dest);
    return true;
  } catch {
    // A concurrent installer or a permission issue must not make desktop boot fail.
    return false;
  }
}

/** Suffix for the one-time backup of a displaced stale shim (WI-10001537). */
export const SHADOWED_SHIM_BACKUP_SUFFIX = '.papercusp-shadow-backup';

export type ShadowHealAction = 'repointed' | 'already-managed' | 'kept-foreign' | 'failed';

export interface ShadowHealEntry {
  /** Shim basename, e.g. `psu`. */
  name: string;
  /** The shadowing entry that was found earlier on PATH. */
  shadowPath: string;
  /** The managed shim in `~/.papercusp/bin` it should resolve to. */
  managedPath: string;
  action: ShadowHealAction;
}

/**
 * Repoint an UNMANAGED wrapper that shadows a managed `~/.papercusp/bin` shim
 * (WI-10001537).
 *
 * The measured failure: `~/.local/bin/psu` was a 347-byte one-liner written by
 * the retired `install-standalone-mcp.sh` in Aug 2026 —
 * `exec node ".../psu-launcher.mjs" "$@"`. `~/.local/bin` precedes
 * `~/.papercusp/bin` on a login shell's PATH, so `psu` resolved to THAT, and the
 * managed shim — refreshed every boot right next to it — never ran. The stale
 * wrapper does not export `PAPERCUSP_PSU_REEXEC`, so `reexecExitCodeFrom(env)`
 * returns null and psu-launcher wires `onReexec: null` BY DESIGN ("a launcher
 * nobody will re-run must never take this path"). The host then has no clean
 * hand-off to a fresh process, and what should be a re-exec becomes a hard
 * death — which killed a live interactive session mid-`AskUserQuestion`,
 * destroying the dialog under the owner. It also ran a bare `node` off PATH
 * instead of the shim's pinned `node25`.
 *
 * Nothing detected it, because every layer was behaving correctly in isolation:
 * the installer wrote a perfect shim, and a perfectly ordinary PATH meant no
 * one ever ran it. Deleting the stale file is NOT the fix — muscle memory and
 * existing scripts still resolve the old path — so it becomes a symlink to the
 * managed shim and both spellings converge on one implementation.
 *
 * Like `ensureGhLinked` this REFRESHES every boot rather than healing once: a
 * future installer regression (or a user re-running a retired install script)
 * re-creates the shadow, and a once-only repair would leave it armed again.
 *
 * Three rails keep a self-healing PATH rewrite safe:
 *
 *  • **Only shims we WRITE are candidates.** Every managed entry the installer
 *    authors (psu, ptool, papercusp, psu-sentinel*) is a regular FILE; every
 *    entry it merely LINKS to something the user already installed (claude,
 *    codex, bun, gh, python) is a SYMLINK. Skipping symlink-valued managed
 *    entries is therefore exactly the right discriminator — and it is what
 *    structurally prevents a cycle: `~/.papercusp/bin/claude` already points AT
 *    `~/.local/bin/claude`, so repointing that one would produce a symlink loop
 *    and make `claude` unlaunchable.
 *  • **Only a Papercusp-authored shadow is touched.** The displaced file must
 *    mention `papercusp`, so a user's own unrelated binary that happens to share
 *    a name is reported (`kept-foreign`) and left strictly alone.
 *  • **Nothing is destroyed.** The displaced file is backed up once, and the
 *    replacement is a same-directory rename, so a reader never observes a
 *    missing `psu`.
 *
 * Best-effort throughout: a permission error or a read-only dir must never make
 * desktop boot fail.
 */
export async function healShadowedManagedShims(
  home: string,
  binDir: string,
  searchDirs: string[] = backendSearchDirs({ home }),
): Promise<ShadowHealEntry[]> {
  const healed: ShadowHealEntry[] = [];
  const resolvedBinDir = path.resolve(binDir);

  let managedNames: string[];
  try {
    const entries = await fs.readdir(binDir, { withFileTypes: true });
    // isFile() on a Dirent from withFileTypes is lstat-shaped: a symlink reports
    // isSymbolicLink(), never isFile(). That is the rail described above.
    managedNames = entries.filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return healed; // no managed bin dir yet — nothing can be shadowing it
  }
  if (managedNames.length === 0) return healed;

  const candidateDirs = searchDirs.filter((dir) => path.resolve(dir) !== resolvedBinDir);

  for (const name of managedNames) {
    const managedPath = path.join(binDir, name);
    for (const dir of candidateDirs) {
      const shadowPath = path.join(dir, name);
      let action: ShadowHealAction;
      try {
        action = await repointShadowedShim(shadowPath, managedPath);
      } catch {
        action = 'failed';
      }
      if (action === 'already-managed') continue; // steady state — not worth reporting
      healed.push({ name, shadowPath, managedPath, action });
    }
  }
  return healed;
}

async function repointShadowedShim(shadowPath: string, managedPath: string): Promise<ShadowHealAction> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(shadowPath);
  } catch {
    return 'already-managed'; // nothing there: no shadow, nothing to do
  }

  if (stat.isSymbolicLink()) {
    // Already ours? Compare resolved targets, not the raw link text — a relative
    // link and an absolute one can name the same file.
    try {
      const target = await fs.realpath(shadowPath);
      if (path.resolve(target) === path.resolve(await fs.realpath(managedPath))) return 'already-managed';
    } catch {
      /* dangling or unreadable link — fall through and evaluate it as a shadow */
    }
  } else if (!stat.isFile()) {
    return 'kept-foreign'; // a directory or socket named `psu` is not ours to move
  }

  // Never hijack a name that belongs to something else. Only a Papercusp-authored
  // wrapper is repointed; anything else is reported and left untouched.
  let body = '';
  try {
    const handle = await fs.open(shadowPath, 'r');
    try {
      const buf = Buffer.alloc(8192);
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      body = buf.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return 'kept-foreign'; // unreadable (a binary we cannot vet) — leave it alone
  }
  if (!/papercusp/i.test(body)) return 'kept-foreign';

  // Preserve the displaced file exactly once. A second boot must not overwrite
  // the original backup with a copy of our own symlink.
  if (stat.isFile()) {
    const backupPath = `${shadowPath}${SHADOWED_SHIM_BACKUP_SUFFIX}`;
    try {
      await fs.access(backupPath);
    } catch {
      await fs.copyFile(shadowPath, backupPath);
    }
  }

  // Same-directory rename, so `psu` is never momentarily absent for a concurrent
  // launcher. A plain unlink+symlink leaves exactly that window open.
  const tmpPath = `${shadowPath}.papercusp-shadow-${process.pid}-${Date.now()}`;
  try {
    await fs.symlink(managedPath, tmpPath);
    await fs.rename(tmpPath, shadowPath);
  } catch (error) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
  return 'repointed';
}

/**
 * Ensure `~/.papercusp/bin/gh` is a symlink to the currently-bundled `gh` CLI
 * (WI-3626). `buildGithubLoginSpec` (endpoint-route/routes/desktop/setup-pty-
 * commands.ts) resolves `gh` to sign in + run `gh auth setup-git`, which bakes
 * WHICHEVER path it resolved verbatim into `credential.https://github.com.helper`
 * in the user's `~/.gitconfig`. Without this shim, that resolution falls through
 * to an app-bundle-relative path (`<cwd>/bin/gh`, i.e. inside
 * `/Applications/Papercusp.app/Contents/Resources/sidecar/`) — which dangles the
 * instant the app is renamed or replaced (confirmed live on the Mac VM: the
 * bundle is now `Papercusp Server.app` / `Papercusp GUI.app`, no `Papercusp.app`
 * — EI-8793 rounds 1-2). `~/.papercusp/bin/gh` never moves, so gitconfig
 * referencing THAT path instead survives every future rename.
 *
 * Unlike `ensureAgentClisLinked` (link-once-if-missing — a user's own claude/
 * codex install rarely moves), this REFRESHES every boot: an app rename
 * between boots must re-point the symlink at the new bundle's gh, or the shim
 * itself would just reproduce the same dangling-path bug one level removed.
 * Idempotent (a no-op once already pointed correctly) + best-effort (a dev box
 * with no bundled gh in this run leaves any prior link untouched — never
 * removes a working link just because THIS run can't resolve a source).
 */
export async function ensureGhLinked(
  home: string,
  binDir: string,
  fallbackDirs: string[] = standardToolDirs(),
): Promise<boolean> {
  const dest = path.join(binDir, 'gh');
  const sidecarBin = process.env.PAPERCUSP_SIDECAR_BIN;
  const bundledCandidates = [
    sidecarBin ? path.join(sidecarBin, 'gh') : '',
    path.join(process.cwd(), 'bin', 'gh'),
    path.join(process.cwd(), '..', 'bin', 'gh'),
  ].filter(Boolean);
  let resolved: string | null = null;
  for (const c of bundledCandidates) {
    if (await pathExists(c)) {
      resolved = c;
      break;
    }
  }
  if (!resolved) {
    // A working stable shim is deliberately sticky on dev boxes: a system gh
    // appearing later must not silently replace the known-good bundled binary.
    // A BROKEN shim is different. It makes every GitHub credential lookup fail,
    // even when the canonical tool-path surface can resolve a healthy gh (live
    // Linux repro: the old extracted desktop bundle disappeared while
    // /usr/bin/gh remained installed). Heal only that broken/missing case.
    if (await pathExists(dest)) return false;
    const destResolved = path.resolve(dest);
    for (const dir of fallbackDirs) {
      const candidate = path.join(dir, 'gh');
      // ~/.papercusp/bin may itself be present in a caller-supplied search list;
      // never make the stable shim point to itself.
      if (path.resolve(candidate) === destResolved) continue;
      if (await pathExists(candidate)) {
        resolved = candidate;
        break;
      }
    }
  }
  if (!resolved) return false; // no healthy bundled or canonical-system gh visible this run
  try {
    const current = await fs.readlink(dest);
    if (current === resolved) return false; // already correct — no-op
  } catch {
    /* not a symlink yet (missing, or a plain file/broken link) — fall through to (re)create */
  }
  try {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rm(dest, { force: true });
    await fs.symlink(resolved, dest);
    return true;
  } catch {
    return false;
  }
}

interface GitConfigCommandResult {
  code: number;
  stdout: string;
}

export type GitConfigRunner = (args: string[]) => Promise<GitConfigCommandResult>;

const PAPERCUSP_BUNDLE_GH_HELPER =
  /^!\/Applications\/Papercusp[^/]*\.app\/Contents\/Resources\/sidecar\/bin\/gh auth git-credential$/;
const GITHUB_CREDENTIAL_HELPER_KEYS = [
  'credential.https://github.com.helper',
  'credential.https://gist.github.com.helper',
] as const;

function gitConfigValues(stdout: string): string[] {
  const normalized = stdout.replace(/\r\n/g, '\n');
  if (!normalized) return [];
  // `git config --get-all` terminates every value with a newline. Remove only
  // that terminator: an intentional blank helper is represented by `"\n"` and
  // must remain as `['']`, not disappear.
  return (normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized).split('\n');
}

function exactGitConfigValueRegex(value: string): string {
  return `^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
}

async function defaultGitConfigRunner(home: string, args: string[]): Promise<GitConfigCommandResult> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const pexec = promisify(execFile);
  try {
    const { stdout } = await pexec('git', args, {
      encoding: 'utf8',
      // installPapercuspFiles accepts an explicit home in tests and repair
      // tooling. Make `--global` target that same user instead of the operator
      // process's ambient HOME.
      env: { ...process.env, HOME: home },
    });
    return { code: 0, stdout: String(stdout ?? '') };
  } catch (error: unknown) {
    const result = error as { code?: number; stdout?: string | Buffer };
    return {
      code: typeof result.code === 'number' ? result.code : 1,
      stdout: String(result.stdout ?? ''),
    };
  }
}

/**
 * Heal credential helpers written by older Papercusp app bundles (WI-38006).
 *
 * `gh auth setup-git` historically wrote the bundle-relative gh path into the
 * user's global gitconfig. Once `Papercusp.app` was renamed/replaced, Git tried
 * to execute a path that no longer existed even though ensureGhLinked had
 * already installed the stable `~/.papercusp/bin/gh` shim.
 *
 * This deliberately replaces ONLY exact Papercusp-owned `/Applications/
 * Papercusp*.app/.../sidecar/bin/gh auth git-credential` values. Blank reset
 * entries, osxkeychain, and arbitrary user helpers are preserved in place.
 * Best-effort: a missing stable shim or unavailable git executable is a no-op,
 * so desktop boot can never fail because credential repair was unavailable.
 * Returns the number of stale values replaced.
 */
export async function repairPapercuspGitCredentialHelpers(
  home: string,
  binDir: string,
  runner?: GitConfigRunner,
): Promise<number> {
  const stableGh = path.join(binDir, 'gh');
  if (!(await pathExists(stableGh))) return 0;

  const run = runner ?? ((args: string[]) => defaultGitConfigRunner(home, args));
  const stableHelper = `!${stableGh} auth git-credential`;
  let replaced = 0;

  for (const key of GITHUB_CREDENTIAL_HELPER_KEYS) {
    const read = await run(['config', '--global', '--get-all', key]);
    if (read.code !== 0) continue;
    const staleValues = gitConfigValues(read.stdout).filter((value) => PAPERCUSP_BUNDLE_GH_HELPER.test(value));
    for (const stale of new Set(staleValues)) {
      const update = await run([
        'config',
        '--global',
        '--replace-all',
        key,
        stableHelper,
        exactGitConfigValueRegex(stale),
      ]);
      if (update.code === 0) replaced += staleValues.filter((value) => value === stale).length;
    }
  }
  return replaced;
}

/**
 * WI-3334 (dev-source shim gap): the psu/ptool shims `exec node` after
 * `export PATH="$HOME/.local/bin:$PATH"`, expecting node in ~/.local/bin. But a
 * shim written where resolveShimNode fell back to bare `node` — the extracted
 * dev-source operator (no PAPERCUSP_SIDECAR_BIN, tsx execPath), verified on the
 * Linux all-5-buttons dogfood VM 2026-07-08 — then dies with `exec: node: not
 * found`. Nothing was creating the ~/.local/bin/node the shims lean on. Link the
 * bundled node there whenever THIS run can resolve it: the primary operator's
 * boot-time install run always can (PAPERCUSP_SIDECAR_BIN set), so the link
 * lands regardless of which operator later rewrites the shim. Non-clobbering
 * (leaves a user's own ~/.local/bin/node) + idempotent + best-effort.
 */
export async function ensureBundledNodeLinked(home: string): Promise<boolean> {
  const dest = path.join(home, '.local', 'bin', 'node');
  // A working node already there (user-installed binary or a live link)? Leave it.
  if (await pathExists(dest)) return false;
  const node = await resolveBundledNode();
  if (!node) return false;
  try {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rm(dest, { force: true }); // clear a DANGLING link (pathExists=false but the link file exists)
    await fs.symlink(node, dest);
    return true;
  } catch {
    return false;
  }
}

export function resolveInstallPaths(home: string): InstallPaths {
  const papercuspDir = path.join(home, '.papercusp');
  const binDir = path.join(papercuspDir, 'bin');
  return {
    papercuspDir,
    tokenPath: path.join(papercuspDir, 'superuser-token'),
    agentIdPath: path.join(papercuspDir, 'su-agent-id'),
    playbookPath: path.join(papercuspDir, 'engineer-collaborator.md'),
    extensionPath: path.join(papercuspDir, 'papercusp-coord.ts'),
    compactionStrategyPath: path.join(papercuspDir, 'compaction-strategy.md'),
    binDir,
    psuPath: path.join(binDir, 'psu'),
    ptoolPath: path.join(binDir, 'ptool'),
    papercuspCliPath: path.join(binDir, 'papercusp'),
    psuSentinelPath: path.join(binDir, 'psu-sentinel'),
    psuSentinelDeepPath: path.join(binDir, 'psu-sentinel-deep'),
    ripgrepPath: path.join(binDir, 'rg'),
    macTutorialAppPath: path.join(home, 'Applications', 'Papercusp Tutorial & Setup.app'),
    linuxTutorialDesktopPath: path.join(home, '.local', 'share', 'applications', 'papercusp-tutorial.desktop'),
  };
}

type HookCommand = { type: 'command'; command: string };
type HookEntry = { matcher?: string; hooks: HookCommand[] };

/** Drop every COMMAND in `arr` that references one of `ours` (full path OR basename)
 *  — at the command level, not the whole entry — then append `fresh`. An entry that
 *  mixes one of ours with a FOREIGN command (e.g. a live settings.json's single Bash
 *  entry carrying both `pretooluse-bash-resource-gate.sh` AND a third-party `rtk hook
 *  claude`) keeps its foreign command; only entries left with ZERO commands after the
 *  filter are dropped. A whole-ENTRY drop silently destroyed a co-located foreign
 *  command on a real live settings.json (EI-8997 follow-up) — this is the fix. Mirrors
 *  the python is_ours filter used by every merge_* helper in install-standalone-mcp.sh
 *  (KEEP THE TWO IN SYNC — see that script's own merge_* comments). */
function replaceOurHookEntries(arr: HookEntry[], ours: readonly string[], fresh: HookEntry): HookEntry[] {
  const isOursCmd = (h: HookCommand) => ours.some((o) => String(h?.command ?? '').includes(o));
  const filtered = arr
    .map((e) => (Array.isArray(e?.hooks) ? { ...e, hooks: e.hooks.filter((h) => !isOursCmd(h)) } : e))
    .filter((e) => Array.isArray(e?.hooks) && e.hooks.length > 0);
  return [...filtered, fresh];
}

/**
 * Non-destructive, idempotent merge of the papercusp CC hooks + fleet statusline into a Claude
 * `settings.json` object (mutated + returned). FAITHFUL TS port of the merge_lock_hooks /
 * merge_coord_hook / merge_activity_hook / merge_lifecycle_hooks / merge_workitem_nudge_hook /
 * merge_statusline / merge_bash_gate_hook / merge_plans_read_guard_hook python helpers in
 * apps/operator/scripts/install-standalone-mcp.sh — KEEP THE TWO IN SYNC. For each event, any prior
 * entry pointing at OUR script (by full path OR basename) is dropped then a fresh one appended,
 * preserving every other user hook. `statusLine` is set only when absent or already ours (never
 * clobbers a personal one).
 *
 * `destDir` = the installed hook dir (~/.papercusp/hooks/cc). `present` = the hook basenames actually
 * installed (mirrors the bash `[ -x … ]` gates), so a missing source degrades gracefully. The
 * `PAPERCUSP_WORKSPACE_ROOT` env prefix the bash installer threads onto the lock/coord/bash-gate
 * commands is intentionally OMITTED: those hooks fall back to `~/papercupai-workspace` (== what the
 * bash installer computes on the standard layout) and self-gate on PAPERCUSP_SID, so behavior is
 * identical and the port stays cross-platform-simple. `isClaudeSettings` gates the Claude-only
 * `enableAllProjectMcpServers` flag. Exported for unit tests.
 */
export function mergeClaudeHookSettings(
  cfg: Record<string, any>,
  destDir: string,
  opts: { present?: ReadonlySet<string>; isClaudeSettings?: boolean } = {},
): Record<string, any> {
  const present = opts.present ?? new Set<string>(CC_HOOK_FILES);
  const has = (name: string) => present.has(name);
  const p = (name: string) => path.join(destDir, name);
  const ours = (name: string): readonly string[] => [p(name), name];
  const cmd = (name: string): HookCommand[] => [{ type: 'command', command: p(name) }];

  const hooks: Record<string, HookEntry[]> =
    cfg.hooks && typeof cfg.hooks === 'object' && !Array.isArray(cfg.hooks) ? cfg.hooks : (cfg.hooks = {});
  const ev = (name: string): HookEntry[] => (Array.isArray(hooks[name]) ? hooks[name] : []);

  // WI-38363: Claude matches Pre/PostToolUse registrations against the external
  // tool name before invoking the hook. capability:* file writers arrive as
  // mcp__<server>__capability_edit/write/multi_edit, so a native-only matcher
  // leaves every guard below unreachable even when its script accepts that shape.
  // Keep the server segment deliberately unpinned: capability tools may be
  // projected by any trusted MCP server.
  const fileWriteMatcher = 'Edit|Write|MultiEdit|mcp__.*__capability_(edit|write|multi_?edit)';
  const fileEditMatcher = 'Edit|MultiEdit|mcp__.*__capability_(edit|multi_?edit)';
  const fileOverwriteMatcher = 'Write|mcp__.*__capability_write';
  // EI-21971958067151594: WI-38363 (above) widened the FILE writers and left the
  // SHELL gate on a native-only matcher, so `capability:bash` — the same shell,
  // and the one CLAUDE.md tells agents to prefer for long jobs — was exempt from
  // every deny in pretooluse-bash-resource-gate.sh. Measured 2026-08-31:
  // `tauri-agent-tools dom` DENIED as Bash, RAN as capability:bash against a
  // foreign webview. `capability_bash_output`/`_kill` are readers, not shells;
  // the gate's own anchored name test rejects them, so a broad matcher here
  // costs only a no-op invocation.
  const bashShellMatcher = 'Bash|mcp__.*__capability_bash';

  // merge_lock_hooks — PreToolUse + PostToolUse, matcher Edit|Write|MultiEdit,
  // plus the Claude-only matcher-less PostToolBatch union release.
  if (has('pretooluse-locks-acquire.sh') && has('posttooluse-locks-release.sh')) {
    hooks.PreToolUse = replaceOurHookEntries(ev('PreToolUse'), ours('pretooluse-locks-acquire.sh'), {
      matcher: fileWriteMatcher,
      hooks: cmd('pretooluse-locks-acquire.sh'),
    });
    hooks.PostToolUse = replaceOurHookEntries(ev('PostToolUse'), ours('posttooluse-locks-release.sh'), {
      matcher: fileWriteMatcher,
      hooks: cmd('posttooluse-locks-release.sh'),
    });
    if (has('posttoolbatch-locks-release.sh'))
      hooks.PostToolBatch = replaceOurHookEntries(ev('PostToolBatch'), ours('posttoolbatch-locks-release.sh'), {
        hooks: cmd('posttoolbatch-locks-release.sh'),
      });
    // Claude-only: auto-approve project-scoped .mcp.json servers (operator-signed papercusp MCP).
    if (opts.isClaudeSettings) cfg.enableAllProjectMcpServers = true;
  }
  // merge_activity_hook — PostToolUse, matcher '*'. Since EI-11405 this ALSO
  // carries the coord:inbox PUSH fold (the separate merge_coord_hook entry is
  // retired).
  if (has('posttooluse-activity-report.sh'))
    hooks.PostToolUse = replaceOurHookEntries(ev('PostToolUse'), ours('posttooluse-activity-report.sh'), {
      matcher: '*',
      hooks: cmd('posttooluse-activity-report.sh'),
    });
  // merge_write_byte_integrity_guard — PostToolUse full writes only
  // (EI-21220966892195714). A full Write carries the complete requested content,
  // so the hook can compare its UTF-8 bytes with the resulting file. Edit/MultiEdit
  // are intentionally excluded because their inputs are fragments.
  if (has('posttooluse-write-byte-integrity-guard.mjs'))
    hooks.PostToolUse = replaceOurHookEntries(
      ev('PostToolUse'),
      ours('posttooluse-write-byte-integrity-guard.mjs'),
      {
        matcher: fileOverwriteMatcher,
        hooks: cmd('posttooluse-write-byte-integrity-guard.mjs'),
      },
    );
  // merge_activity_pre_hook — PreToolUse, matcher '*' (EI-8997: a renewal signal
  // at dispatch time too, not just completion — see the script's own header).
  if (has('pretooluse-activity-report.sh'))
    hooks.PreToolUse = replaceOurHookEntries(ev('PreToolUse'), ours('pretooluse-activity-report.sh'), {
      matcher: '*',
      hooks: cmd('pretooluse-activity-report.sh'),
    });
  // merge_lifecycle_hooks — SessionStart + SessionEnd, no matcher.
  if (has('lifecycle-report.sh'))
    for (const e of ['SessionStart', 'SessionEnd'])
      hooks[e] = replaceOurHookEntries(ev(e), ours('lifecycle-report.sh'), { hooks: cmd('lifecycle-report.sh') });
  // merge_workitem_nudge_hook — PostToolUse Edit|Write|MultiEdit + Stop + SessionEnd.
  if (has('workitem-verify-nudge.sh')) {
    hooks.PostToolUse = replaceOurHookEntries(ev('PostToolUse'), ours('workitem-verify-nudge.sh'), {
      matcher: 'Edit|Write|MultiEdit',
      hooks: cmd('workitem-verify-nudge.sh'),
    });
    for (const e of ['Stop', 'SessionEnd'])
      hooks[e] = replaceOurHookEntries(ev(e), ours('workitem-verify-nudge.sh'), {
        hooks: cmd('workitem-verify-nudge.sh'),
      });
  }
  // merge_required_field_strand_nudge_hook — PostToolUse, matcher 'Edit|Write|MultiEdit'
  // (EI-19374535041074908). Advisory only: it can never deny, because adding a required
  // field is usually correct. Reports to the AUTHOR while it is still their turn — the one
  // moment the signal is both correct (HEAD is still pre-edit) and actionable.
  if (has('posttooluse-required-field-strand-nudge.mjs'))
    hooks.PostToolUse = replaceOurHookEntries(ev('PostToolUse'), ours('posttooluse-required-field-strand-nudge.mjs'), {
      matcher: 'Edit|Write|MultiEdit',
      hooks: cmd('posttooluse-required-field-strand-nudge.mjs'),
    });
  // merge_behavioural_strand_nudge_hook — PostToolUse, matcher 'Edit|Write|MultiEdit'
  // (EI-20022235111425919). The BEHAVIOURAL sibling of the block above: that one catches a
  // required field stranding construction sites, this one catches an added CALL stranding
  // call-COUNT/ORDER assertions in another workspace. Advisory only, and it must stay that
  // way — adding a call is usually correct, and the guard's own narrowing is a RANKING, not
  // a filter. Registered here rather than merely copied: the file shipped in hooks/cc
  // unregistered, which orphaned-cc-hooks.test.ts flags precisely because a copied-but-
  // unregistered hook is inert while looking installed.
  if (has('posttooluse-behavioural-strand-nudge.mjs'))
    hooks.PostToolUse = replaceOurHookEntries(ev('PostToolUse'), ours('posttooluse-behavioural-strand-nudge.mjs'), {
      matcher: 'Edit|Write|MultiEdit',
      hooks: cmd('posttooluse-behavioural-strand-nudge.mjs'),
    });
  // merge_ts_parse_nudge_hook — PostToolUse, matcher 'Edit|Write|MultiEdit'
  // (EI-19457231269012320 / EI-19457320059999661). Advisory only, and this one MUST stay
  // advisory: a multi-step refactor legitimately passes through unparseable intermediate
  // states, so a blocking verdict here would be wrong as often as it was right. It reports
  // the parser's own first diagnostic to the author milliseconds after the write — before
  // git-sync can sweep the file into a commit, and before any host bundles the working tree
  // and crash-loops on it.
  if (has('posttooluse-ts-parse-nudge.mjs'))
    hooks.PostToolUse = replaceOurHookEntries(ev('PostToolUse'), ours('posttooluse-ts-parse-nudge.mjs'), {
      matcher: 'Edit|Write|MultiEdit',
      hooks: cmd('posttooluse-ts-parse-nudge.mjs'),
    });
  // merge_mdx_nudge_hook — PostToolUse, matcher native edits + docs:author MCP variants
  // (EI-19450114644493388 / EI-22997442030423826). Advisory only: native edits can be
  // checked by the real MDX compiler, while a successful docs:author call can be checked
  // against the affected source-to-served mirror mapping before git-sync sweeps the tree.
  if (has('posttooluse-mdx-nudge.mjs'))
    hooks.PostToolUse = replaceOurHookEntries(ev('PostToolUse'), ours('posttooluse-mdx-nudge.mjs'), {
      matcher: 'Edit|Write|MultiEdit|docs:author|mcp__.*__docs[_:-]author',
      hooks: cmd('posttooluse-mdx-nudge.mjs'),
    });
  // merge_no_proc_path_fixture_nudge_hook — PostToolUse, matcher 'Edit|Write|MultiEdit'
  // (EI-19968483416347685). Advisory only, like its siblings. Closes the last gap in the
  // guard family: until this landed, the ONLY ways to learn you had written a made-up
  // `/proc/…` fixture were `npm run lint:no-proc-path-fixture` (which nobody runs by name)
  // and the green-checkpoint leg — i.e. a ~55min-later red that freezes `main` fleet-wide.
  // That put the WEAKEST feedback loop on the trap with the WORST symptom: the hang occurs
  // during vitest COLLECTION, so the run emits zero output and reads as a queued heavy job,
  // and it poisons sibling files in the same vitest process. Three recorded incidents
  // (2026-07-11, 2026-08-02, 2026-08-09) before it got an edit-time nudge.
  // Unlike the ts-parse sibling this hook IMPORTS the real detector
  // (scripts/check-no-proc-path-fixture.mjs is already .mjs with a symlink-robust isMain
  // guard), so there is no second copy of the allowlist or the procfs-entry set to drift.
  if (has('posttooluse-no-proc-path-fixture-nudge.mjs'))
    hooks.PostToolUse = replaceOurHookEntries(ev('PostToolUse'), ours('posttooluse-no-proc-path-fixture-nudge.mjs'), {
      matcher: 'Edit|Write|MultiEdit',
      hooks: cmd('posttooluse-no-proc-path-fixture-nudge.mjs'),
    });
  // merge_migration_fixture_drift_nudge_hook — PostToolUse, matcher 'Edit|Write|MultiEdit'
  // (EI-19359711978838614). Advisory only: it can never deny — adding a migration column
  // is normal and usually has nothing to do with any test fixture. Fires only when some
  // OTHER *.integration.test.ts already builds the exact table via an inline CREATE TABLE
  // and is missing exactly the new column.
  if (has('posttooluse-migration-fixture-drift-nudge.mjs'))
    hooks.PostToolUse = replaceOurHookEntries(
      ev('PostToolUse'),
      ours('posttooluse-migration-fixture-drift-nudge.mjs'),
      {
        matcher: 'Edit|Write|MultiEdit',
        hooks: cmd('posttooluse-migration-fixture-drift-nudge.mjs'),
      },
    );
  // merge_migration_forward_compat_nudge_hook — PostToolUse, matcher 'Edit|Write|MultiEdit'
  // (EI-19462877357083817). Advisory only: it can never deny — destructive DDL is often
  // correct, and the acknowledgment is the point, not abstention. Fires only when the file
  // AS IT NOW STANDS carries destructive DDL with no `-- FORWARD-COMPAT:` line, i.e. exactly
  // the state the green-checkpoint leg would red on hours later. The rule itself
  // (violationsFor / ACK_MARKER / ENFORCE_FROM) is imported from the lint rather than copied,
  // so the nudge and the gate leg cannot drift apart and leave the nudge quiet on a file the
  // gate still fails.
  if (has('posttooluse-migration-forward-compat-nudge.mjs'))
    hooks.PostToolUse = replaceOurHookEntries(
      ev('PostToolUse'),
      ours('posttooluse-migration-forward-compat-nudge.mjs'),
      {
        matcher: 'Edit|Write|MultiEdit',
        hooks: cmd('posttooluse-migration-forward-compat-nudge.mjs'),
      },
    );
  // merge_tool_prompt_weight_nudge_hook — PostToolUse, matcher 'Edit|Write|MultiEdit'
  // (EI-19459260956682226). Advisory only: it can never deny — growing a tool description
  // is normal, and this fires only when the edited file contains a tool that is OVER the
  // P-011 budget right now. Limits are read from the production tool-guidance-budget.ts, so
  // there is no fourth copy of the numbers to drift.
  if (has('posttooluse-tool-prompt-weight-nudge.mjs'))
    hooks.PostToolUse = replaceOurHookEntries(ev('PostToolUse'), ours('posttooluse-tool-prompt-weight-nudge.mjs'), {
      matcher: 'Edit|Write|MultiEdit',
      hooks: cmd('posttooluse-tool-prompt-weight-nudge.mjs'),
    });
  // merge_mock_cast_escape_nudge_hook — PostToolUse, matcher 'Edit|Write|MultiEdit'
  // (WI-37497). Advisory only, and it MUST stay advisory: the baseline tolerates 1076 of
  // these and a deliberate `as never` is sometimes the right call — this reports a DELTA the
  // author just created, not a verdict on the idiom. Fires only on an INCREASE, so a
  // burn-down never nags the person doing it, and only for `.test.ts`/`.test.tsx`, which is
  // exactly the population the ratchet counts.
  if (has('posttooluse-mock-cast-escape-nudge.mjs'))
    hooks.PostToolUse = replaceOurHookEntries(ev('PostToolUse'), ours('posttooluse-mock-cast-escape-nudge.mjs'), {
      matcher: 'Edit|Write|MultiEdit',
      hooks: cmd('posttooluse-mock-cast-escape-nudge.mjs'),
    });
  // merge_css_design_primitives_nudge_hook — PostToolUse, matcher 'Edit|Write|MultiEdit'
  // (EI-20023819609804890). Advisory only, and it MUST stay advisory: PostToolUse cannot block,
  // and the gate remains the authority. Fires only on an INCREASE, so removing offenders never
  // nags the person doing it, and only for the file population the lint actually scans
  // (.css/.ts/.tsx under apps/operator/app + apps/operator-vite/src, tests excluded) — nudging
  // outside that set would be a false positive by construction.
  if (has('posttooluse-css-design-primitives-nudge.mjs'))
    hooks.PostToolUse = replaceOurHookEntries(ev('PostToolUse'), ours('posttooluse-css-design-primitives-nudge.mjs'), {
      matcher: 'Edit|Write|MultiEdit',
      hooks: cmd('posttooluse-css-design-primitives-nudge.mjs'),
    });
  // merge_frozen_candidate_edit_hook — PostToolUse (frozen-candidate-compliance-enforcement
  // -2026-08-30 P-004/P-005), the desktop counterpart of install-standalone-mcp.sh:1090. Advisory
  // only, and it MUST stay advisory: editing a failing path is often exactly right — what is wrong
  // is doing it believing the gate will see it. Uses `fileWriteMatcher`, NOT the bare
  // 'Edit|Write|MultiEdit' its neighbours above carry, and the difference is load-bearing here:
  // psu agents are instructed to write through capability:edit/capability:write (those arrive as
  // mcp__<server>__capability_edit/write — WI-38363), so the bare literal would go silent on the
  // dominant write path on this box and leave the hook firing mostly for native-tool edits. A
  // nudge that misses the writes agents actually make is the failure mode the file exists to stop.
  if (has('posttooluse-frozen-candidate-edit-nudge.mjs'))
    hooks.PostToolUse = replaceOurHookEntries(ev('PostToolUse'), ours('posttooluse-frozen-candidate-edit-nudge.mjs'), {
      matcher: fileWriteMatcher,
      hooks: cmd('posttooluse-frozen-candidate-edit-nudge.mjs'),
    });
  // merge_registry_census_drift_nudge_hook — PostToolUse, matcher 'Edit|Write|MultiEdit'
  // (EI-19401978567233485). Advisory only, and it MUST stay advisory: PostToolUse cannot block,
  // and the census test itself remains the authority — this only moves the SIGNAL from the
  // ~55min-later fleet gate to the edit that caused it. Fires only when the edited file holds
  // a registry array AND a sibling census asserting an exact count/list of that same array AND
  // the two now disagree, so a registry with no census, or a census already updated in the same
  // change, is silent by construction.
  if (has('posttooluse-registry-census-drift-nudge.mjs'))
    hooks.PostToolUse = replaceOurHookEntries(
      ev('PostToolUse'),
      ours('posttooluse-registry-census-drift-nudge.mjs'),
      {
        matcher: 'Edit|Write|MultiEdit',
        hooks: cmd('posttooluse-registry-census-drift-nudge.mjs'),
      },
    );
  // merge_cli_entry_nudge_hook — PostToolUse, matcher 'Edit|Write|MultiEdit'
  // (EI-22085994981415983). Advisory only, and it MUST stay advisory: PostToolUse cannot block,
  // and check-no-hand-rolled-cli-entry.mjs remains the authority — this only moves the SIGNAL
  // from the ~55min-later fleet gate to the edit that caused it. Fires only when an edit
  // introduces a hand-rolled ESM entry guard AND leaves that file over its allowance, so a
  // baselined occurrence, a reasoned standalone exemption, or an unrelated edit is silent by
  // construction.
  if (has('posttooluse-cli-entry-nudge.mjs'))
    hooks.PostToolUse = replaceOurHookEntries(ev('PostToolUse'), ours('posttooluse-cli-entry-nudge.mjs'), {
      matcher: 'Edit|Write|MultiEdit',
      hooks: cmd('posttooluse-cli-entry-nudge.mjs'),
    });
  // merge_tsc_verdict_stale_nudge_hook — PostToolUse, matcher 'Edit|Write|MultiEdit'.
  // Advisory only: an Edit/Write landing AFTER the session's last `lint:tsc` run invalidates
  // that run's "clean" verdict (vitest never typechecks, so a green suite cannot stand in for
  // it), and the hook says so at the edit instead of hours later at the fleet gate. The hook
  // file shipped in hooks/cc without this registration, so packaged installs copied it and
  // never ran it (install parity 3/3 in tty-title-target.test.ts caught the allowlist half).
  if (has('posttooluse-tsc-verdict-stale-nudge.mjs'))
    hooks.PostToolUse = replaceOurHookEntries(ev('PostToolUse'), ours('posttooluse-tsc-verdict-stale-nudge.mjs'), {
      matcher: 'Edit|Write|MultiEdit',
      hooks: cmd('posttooluse-tsc-verdict-stale-nudge.mjs'),
    });
  // merge_proof_stale_nudge_hook — PostToolUse, matcher 'Edit|Write|MultiEdit' (P-040 of
  // review-system-rework-reduction-2026-09-23). Advisory only: after an edit it asks
  // plans:evidence-measuring-paths which live repo-files proof measured the file, names the
  // clauses/BARs, holders and the re-measure call, and sends each peer holder one coord
  // notice per edit burst. Fails open with a bounded timeout and a 60s circuit breaker.
  if (has('posttooluse-proof-stale-nudge.mjs'))
    hooks.PostToolUse = replaceOurHookEntries(ev('PostToolUse'), ours('posttooluse-proof-stale-nudge.mjs'), {
      matcher: 'Edit|Write|MultiEdit',
      hooks: cmd('posttooluse-proof-stale-nudge.mjs'),
    });
  // merge_statusline — non-destructive: set only when absent or already ours.
  if (has('statusline-fleet.sh')) {
    const sl = p('statusline-fleet.sh');
    const existing = cfg.statusLine;
    const mine = existing && typeof existing === 'object' && String(existing.command ?? '').includes(sl);
    if (!existing || mine) cfg.statusLine = { type: 'command', command: sl };
  }
  // merge_bash_gate_hook — PreToolUse, matcher bashShellMatcher.
  if (has('pretooluse-bash-resource-gate.sh'))
    hooks.PreToolUse = replaceOurHookEntries(ev('PreToolUse'), ours('pretooluse-bash-resource-gate.sh'), {
      matcher: bashShellMatcher,
      hooks: cmd('pretooluse-bash-resource-gate.sh'),
    });
  // merge_plans_read_guard_hook — PreToolUse, matcher 'Read|Grep' (P-003(b)).
  if (has('pretooluse-plans-read-guard.sh'))
    hooks.PreToolUse = replaceOurHookEntries(ev('PreToolUse'), ours('pretooluse-plans-read-guard.sh'), {
      matcher: 'Read|Grep',
      hooks: cmd('pretooluse-plans-read-guard.sh'),
    });
  // merge_provenance_hook — UserPromptSubmit, no matcher (fires on every prompt).
  // turn-provenance-owner-vs-agent-2026-07-11 P-003: verified owner-vs-agent stamps.
  if (has('userpromptsubmit-provenance.sh'))
    hooks.UserPromptSubmit = replaceOurHookEntries(ev('UserPromptSubmit'), ours('userpromptsubmit-provenance.sh'), {
      hooks: cmd('userpromptsubmit-provenance.sh'),
    });
  // merge_turn_start_memory_hook — UserPromptSubmit, no matcher (fires on every prompt).
  // memory-delivery-unification-2026-07-12 P-003a: turn-start memory delta, epoch-deduped
  // via the session-surfaced ledger (never re-pays initialize/orient injections).
  if (has('userpromptsubmit-memory.sh'))
    hooks.UserPromptSubmit = replaceOurHookEntries(ev('UserPromptSubmit'), ours('userpromptsubmit-memory.sh'), {
      hooks: cmd('userpromptsubmit-memory.sh'),
    });
  // merge_mid_turn_context_hook — PostToolBatch, NO matcher (the event does not
  // support one). context-injection-audit-2026-07-28 P-015, D-026 + D-027:
  // mid-turn recall, the boundary turn-start structurally cannot reach.
  // ⚠ This deliberately does NOT ride PreToolUse (D-027): PreToolUse only injects
  // additionalContext alongside a `permissionDecision`, and a context hook that
  // emits `allow` becomes a blanket auto-approver for everything it matches.
  // PostToolBatch is the documented additionalContext channel, carries no
  // permission semantics, and fires once per batch before the next model request.
  if (has('posttoolbatch-midturn-context.sh'))
    hooks.PostToolBatch = replaceOurHookEntries(ev('PostToolBatch'), ours('posttoolbatch-midturn-context.sh'), {
      hooks: cmd('posttoolbatch-midturn-context.sh'),
    });
  // merge_identity_hooks — portable-identity-packages-2026-09-26 P-011 (D-023 §2).
  // PreToolUse has NO matcher: a worn guard can name any tool, and which ones is
  // the operator's business, not the install's. It renders ONLY a deny for the one
  // pending call (never allow), so it cannot become a blanket auto-approver (D-027).
  // SessionStart matches the sources that can mean a fresh context; a resume
  // replays a transcript that already holds what the compaction rules said.
  if (has('pretooluse-identity-guard.sh'))
    hooks.PreToolUse = replaceOurHookEntries(ev('PreToolUse'), ours('pretooluse-identity-guard.sh'), {
      hooks: cmd('pretooluse-identity-guard.sh'),
    });
  if (has('stop-identity-context.sh'))
    hooks.Stop = replaceOurHookEntries(ev('Stop'), ours('stop-identity-context.sh'), {
      hooks: cmd('stop-identity-context.sh'),
    });
  if (has('sessionstart-identity-context.sh'))
    hooks.SessionStart = replaceOurHookEntries(ev('SessionStart'), ours('sessionstart-identity-context.sh'), {
      matcher: 'startup|clear|compact',
      hooks: cmd('sessionstart-identity-context.sh'),
    });
  // merge_turn_journal_hook — Stop, no matcher (fires at each turn end).
  // deterministic-context-carry-2026-07-14 P-012: per-turn journal collection.
  if (has('stop-turn-journal.sh'))
    hooks.Stop = replaceOurHookEntries(ev('Stop'), ours('stop-turn-journal.sh'), {
      hooks: cmd('stop-turn-journal.sh'),
    });
  // merge_artifact_url_delivery_guard_hook — EI-21844056581395228 (prose) and
  // EI-21890940999877469 (durable surfaces). THREE branches of ONE script:
  // PostToolUse (matcher scoped to the Artifact tool) harvests the ids that
  // non-error calls actually returned into a session ledger; Stop (no matcher)
  // blocks a final message citing an id that ledger never saw; PreToolUse denies a
  // DURABLE write (checkpoint/plan/fact/coord:send) carrying an unverified id.
  // Stop must be wired matcher-less because that failure lands in assistant PROSE,
  // which no tool matcher can see. `stop_hook_active` bounds it to one bounce/turn.
  //
  // The PreToolUse matcher mirrors the script's DURABLE_WRITE_TOOLS allow-list
  // (the script re-validates, so the matcher is only a spawn filter). It must
  // never grow to cover the Artifact tool or WebFetch: those are how an agent
  // VERIFIES a URL, and denying them would leave a blocked agent no way out.
  if (has('artifact-url-delivery-guard.mjs')) {
    hooks.PostToolUse = replaceOurHookEntries(ev('PostToolUse'), ours('artifact-url-delivery-guard.mjs'), {
      matcher: 'Artifact|mcp__.*__[Aa]rtifact',
      hooks: cmd('artifact-url-delivery-guard.mjs'),
    });
    hooks.PreToolUse = replaceOurHookEntries(ev('PreToolUse'), ours('artifact-url-delivery-guard.mjs'), {
      matcher:
        'mcp__.*__(work_items_(checkpoint|comment|complete|create|update)|loop_checkpoint|facts_assert|memory_remember|coord_send|improvements_capture|plans_(new|edit|add-item|add-decision|set-now))',
      hooks: cmd('artifact-url-delivery-guard.mjs'),
    });
    hooks.Stop = replaceOurHookEntries(ev('Stop'), ours('artifact-url-delivery-guard.mjs'), {
      hooks: cmd('artifact-url-delivery-guard.mjs'),
    });
  }
  // merge_stop_owner_directive_check_hook — Stop, no matcher.
  // owner-directive-delivery-redesign-2026-09-22 P-007: `stop_hook_active` bounds it
  // to one bounce per turn; the verdict is computed by the local operator.
  if (has('stop-owner-directive-check.mjs'))
    hooks.Stop = replaceOurHookEntries(ev('Stop'), ours('stop-owner-directive-check.mjs'), {
      hooks: cmd('stop-owner-directive-check.mjs'),
    });
  // merge_ask_gate_hook — PreToolUse + PostToolUse (matcher 'AskUserQuestion|ExitPlanMode')
  // + matcher-less Notification + Stop. owner-inbox-single-pane-2026-07-17 P-001: the
  // owner-gate CAPTURE + MIRROR layer (see the script's own header for the four branches).
  if (has('ask-gate-mirror.sh')) {
    for (const e of ['PreToolUse', 'PostToolUse'])
      hooks[e] = replaceOurHookEntries(ev(e), ours('ask-gate-mirror.sh'), {
        matcher: 'AskUserQuestion|ExitPlanMode',
        hooks: cmd('ask-gate-mirror.sh'),
      });
    for (const e of ['Notification', 'Stop'])
      hooks[e] = replaceOurHookEntries(ev(e), ours('ask-gate-mirror.sh'), { hooks: cmd('ask-gate-mirror.sh') });
  }
  // merge_guard_operator_desktop_hook — PreToolUse, matcher scoped to the
  // browser-navigation MCP tools + the Skill tool (NOT Bash — see the script's
  // own header). EI-16981: this hook existed in-repo but was never wired.
  if (has('guard-operator-desktop.mjs'))
    hooks.PreToolUse = replaceOurHookEntries(ev('PreToolUse'), ours('guard-operator-desktop.mjs'), {
      matcher:
        'mcp__playwright__browser_navigate|mcp__claude-in-chrome__navigate|mcp__claude-in-chrome__tabs_create_mcp|Skill',
      hooks: cmd('guard-operator-desktop.mjs'),
    });
  // merge_content_lint_hook — PreToolUse, matcher 'Edit|Write|MultiEdit' (P-013). WI-5543:
  // this hook existed in-repo but was never wired (same shape as guard-operator-desktop above).
  if (has('pretooluse-content-lint.mjs'))
    hooks.PreToolUse = replaceOurHookEntries(ev('PreToolUse'), ours('pretooluse-content-lint.mjs'), {
      matcher: fileWriteMatcher,
      hooks: cmd('pretooluse-content-lint.mjs'),
    });
  // merge_secrets_guard_hook — PreToolUse, matcher 'Edit|Write|MultiEdit' (su-papercusp-way-gate
  // P-006). WI-5542: this hard-DENY secrets backstop existed in-repo but was never wired (same
  // dead-code shape as guard-operator-desktop / content-lint above).
  if (has('pretooluse-secrets-guard.mjs'))
    hooks.PreToolUse = replaceOurHookEntries(ev('PreToolUse'), ours('pretooluse-secrets-guard.mjs'), {
      matcher: fileWriteMatcher,
      hooks: cmd('pretooluse-secrets-guard.mjs'),
    });
  // merge_nul_byte_edit_guard_hook — PreToolUse, matcher 'Edit|MultiEdit' (EI-18896033546676518).
  // Write is deliberately NOT in the matcher — see the script header for why.
  if (has('pretooluse-nul-byte-edit-guard.mjs'))
    hooks.PreToolUse = replaceOurHookEntries(ev('PreToolUse'), ours('pretooluse-nul-byte-edit-guard.mjs'), {
      matcher: fileEditMatcher,
      hooks: cmd('pretooluse-nul-byte-edit-guard.mjs'),
    });
  // merge_control_bytes_content_guard_hook — PreToolUse, matcher 'Edit|Write|MultiEdit'
  // (EI-20782070131658758). Write IS in the matcher, and that is the load-bearing difference
  // from the nul-byte sibling above: the reported failure was a `Write` of a NUL-bearing .ts,
  // which the Edit-only sibling can never see. The guard reads its byte policy + scanned-set
  // from scripts/check-no-control-bytes.mjs (the green-checkpoint leg's own module), so it can
  // only refuse content that `lint:no-control-bytes` would red the fleet gate on anyway.
  if (has('pretooluse-control-bytes-content-guard.mjs'))
    hooks.PreToolUse = replaceOurHookEntries(ev('PreToolUse'), ours('pretooluse-control-bytes-content-guard.mjs'), {
      matcher: fileWriteMatcher,
      hooks: cmd('pretooluse-control-bytes-content-guard.mjs'),
    });
  // merge_tool_prompt_weight_guard_hook — PreToolUse, matcher 'Edit|Write|MultiEdit'
  // (EI-20204186116417704). Write IS in the matcher: a full-file rewrite of a tool definition is
  // just as capable of introducing the breach as a find/replace. Denies only a WORSENING edit.
  if (has('pretooluse-tool-prompt-weight-guard.mjs'))
    hooks.PreToolUse = replaceOurHookEntries(ev('PreToolUse'), ours('pretooluse-tool-prompt-weight-guard.mjs'), {
      matcher: fileWriteMatcher,
      hooks: cmd('pretooluse-tool-prompt-weight-guard.mjs'),
    });
  // merge_schedule_wakeup_provenance_hook — PreToolUse, matcher 'ScheduleWakeup'
  // (EI-18680056073436345). Observational only (never denies) — see the script.
  if (has('pretooluse-schedule-wakeup-provenance.mjs'))
    hooks.PreToolUse = replaceOurHookEntries(ev('PreToolUse'), ours('pretooluse-schedule-wakeup-provenance.mjs'), {
      matcher: 'ScheduleWakeup',
      hooks: cmd('pretooluse-schedule-wakeup-provenance.mjs'),
    });
  // merge_write_overwrite_guard_hook — PreToolUse, matcher 'Write' (EI-19966323166806405).
  // Advisory only (additionalContext, never a deny) — see the script header for why.
  if (has('pretooluse-write-overwrite-guard.mjs'))
    hooks.PreToolUse = replaceOurHookEntries(ev('PreToolUse'), ours('pretooluse-write-overwrite-guard.mjs'), {
      matcher: fileOverwriteMatcher,
      hooks: cmd('pretooluse-write-overwrite-guard.mjs'),
    });
  // merge_generated_file_edit_guard_hook — PreToolUse, matcher 'Edit|Write|MultiEdit'
  // (claude-md-projection-from-pg-2026-08-10 P-006). Hard DENY, self-arming off the
  // target file's own GENERATED banner — see the script header.
  if (has('pretooluse-generated-file-edit-guard.mjs'))
    hooks.PreToolUse = replaceOurHookEntries(ev('PreToolUse'), ours('pretooluse-generated-file-edit-guard.mjs'), {
      matcher: fileWriteMatcher,
      hooks: cmd('pretooluse-generated-file-edit-guard.mjs'),
    });
  // merge_unreserved_migration_guard_hook — PreToolUse, matcher 'Edit|Write|MultiEdit'
  // (WI-38352). Hard DENY on a hand-numbered migration; keyed on the PATH + the live
  // reservations table, not on the file's prior existence, because the primary case is a
  // Write CREATING one. Fails open when PG is unreachable — see the script header.
  if (has('pretooluse-unreserved-migration-guard.mjs'))
    hooks.PreToolUse = replaceOurHookEntries(ev('PreToolUse'), ours('pretooluse-unreserved-migration-guard.mjs'), {
      matcher: fileWriteMatcher,
      hooks: cmd('pretooluse-unreserved-migration-guard.mjs'),
    });

  return cfg;
}

/**
 * Syntax-check a hook we are about to publish, by interpreter, before it is renamed into
 * the machine-wide hooks dir (EI-21974793277035753).
 *
 * This is the COMPLEMENT to the atomic-rename discipline below, not a duplicate of it.
 * EI-18755593630003816 made a concurrent reader see a *whole* file instead of a torn
 * prefix; nothing yet made it see a *valid* one. A hook that does not parse fails at the
 * worst possible moment — inside another agent's turn — and `pretooluse-bash-resource-gate.sh`
 * in particular is fail-open by construction (`python3 ... || { echo 'hook error'; exit 0; }`),
 * so a broken copy does not crash and does not deny: it silently stops gating, fleet-wide,
 * with nothing in any log.
 *
 * Only interpreters that can answer in milliseconds, and only parse-level checks — this
 * runs on the hot path of every psu launch. `.d.mts` declarations and anything else are
 * deliberately unvalidated rather than validated badly: `node --check` cannot parse TS.
 *
 * Fail-safe: an interpreter that is missing or errors in an unexpected way returns `ok`.
 * Refusing to install because `bash` could not be spawned would turn a diagnostic into an
 * outage — the verdict must be "this file definitely does not parse", never "I could not tell".
 */
export async function checkHookSyntax(
  content: Buffer,
  name: string,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  // Fed over STDIN, not as a path, for two reasons that both bit during development:
  //  1. the staged file is named `<hook>.psu-install.<pid>.tmp`, and `node --check` infers
  //     module format from the EXTENSION — it rejects a `.tmp` file with
  //     ERR_UNKNOWN_FILE_EXTENSION no matter how valid the JavaScript is. Path-checking the
  //     staged copy would therefore have refused all 24 `.mjs` hooks forever, silently
  //     freezing them at their installed versions. Renaming the staged file is not
  //     available either: `gcStrandedInstallTmp` matches /\.psu-install\.\d+\.tmp$/.
  //  2. stdin checks the EXACT bytes about to be written, closing the read→validate window
  //     that path-checking the source would leave open.
  const argv: string[] | null = name.endsWith('.sh')
    ? ['bash', '-n']
    : name.endsWith('.mjs')
      ? ['node', '--input-type=module', '--check']
      : name.endsWith('.py')
        ? ['python3', '-c', 'import ast,sys; ast.parse(sys.stdin.buffer.read())']
        : null;
  if (!argv) return { ok: true };
  try {
    const { spawn } = await import('node:child_process');
    return await new Promise((resolve) => {
      const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'ignore', 'pipe'] });
      const stderrCollector = createTextCollector(child.stderr);
      let settled = false;
      const done = (v: { ok: true } | { ok: false; detail: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        done({ ok: true });
      }, 10_000);
      // The interpreter could not be spawned at all (missing, not executable). That is
      // "could not tell", never "does not parse" — condemning here would refuse working
      // hooks on any box without python3 and turn a diagnostic into an outage.
      child.on('error', () => done({ ok: true }));
      // A child killed by a signal reports code === null: also could-not-tell.
      child.on('close', (code) => {
        if (code === 0 || code === null) return done({ ok: true });
        const detail = stderrCollector.text().slice(0, 4096).trim().split('\n').slice(0, 3).join('; ');
        done({ ok: false, detail: detail || `exit ${code}` });
      });
      // An interpreter that bails before draining stdin gives us EPIPE; that is its
      // verdict arriving early, not an error to propagate.
      child.stdin?.on('error', () => {});
      child.stdin?.end(content);
    });
  } catch {
    return { ok: true };
  }
}

/**
 * Install the Claude/Codex CC hooks to ~/.papercusp/hooks/cc/ and merge them (+ the fleet
 * statusline) into ~/.claude/settings.json — the desktop-installer equivalent of the CC-hook block in
 * install-standalone-mcp.sh (EI-8191: the packaged Mac/Windows apps shipped NEITHER the sources NOR the
 * merge, so Claude rendered a blank statusline + lock/coord enforcement was silently off). Cross-platform:
 * runs under Node natively on macOS and inside the WSL distro on Windows, so both get the hooks from this
 * ONE path. Best-effort + idempotent; a missing source (hooks not shipped) degrades to "nothing
 * installed" and leaves settings.json untouched. `srcDir` = the resolved sidecar/dev hooks/cc dir.
 */
async function installClaudeHooks(
  home: string,
  srcDir: string,
): Promise<{ installed: string[]; settingsMerged: boolean }> {
  const destDir = path.join(home, '.papercusp', 'hooks', 'cc');
  await fs.mkdir(destDir, { recursive: true, mode: 0o755 });

  // WI-37405 #2 — never silently downgrade. The scratch guard stops sandbox trees; this
  // stops one CANONICAL tree quietly reverting another's newer hooks (a release checkout
  // booting after staging installed a fix). Date the actual CC hook files, not repository
  // HEAD: an unrelated commit must not make an unchanged hook appear newer. Unlike the
  // generic provenance paths, CC has no grace period — even a minutes-old source can
  // change the next agent's turn-gating behavior. Best-effort and fail-open: no git, no
  // stamp, or unknown dates all fall through to a normal install.
  const incomingProvenance = await resolveSourceGitProvenance(srcDir, CC_HOOK_FILES);
  const existingStamp = await readInstallStamp(destDir);
  const verdict = classifyDowngrade(existingStamp, incomingProvenance, 0);
  if (verdict.downgrade) {
    console.error(
      `[desktop-install] cc hooks: REFUSING downgrade — source ${srcDir} ` +
        `(${verdict.incomingAt}) is ${verdict.olderByMs}ms older than what is installed ` +
        `(${verdict.installedAt}, from ` +
        `${existingStamp?.sourceDir}). Leaving the newer hooks in place.`,
    );
    return { installed: [], settingsMerged: false };
  }

  // WI-37405 #3 — clear temp files a killed install stranded here. Age-gated, not
  // pid-gated: PIDs wrap ~daily under fleet load, so a liveness probe can match an
  // unrelated recycled process.
  const gcd = await gcStrandedInstallTmp(destDir);
  if (gcd.length > 0) {
    console.warn(`[desktop-install] cc hooks: removed ${gcd.length} stranded temp file(s) from an interrupted install`);
  }

  // EI-21974793277035753: does `sourceSha` actually DESCRIBE what we are about to install?
  // resolveSourceGitProvenance answers "last commit TOUCHING these paths", which is not the
  // same question — so without this the stamp names a sha whose blob differs from the bytes
  // on disk, with the authority of a machine-generated record. Tri-state: `undefined` means
  // "could not tell" (no git, packaged app), NOT "clean".
  const uncommitted = await resolveUncommittedSources(srcDir, CC_HOOK_FILES);

  // T3: uncommitted hooks reach every agent on this box on the next launch, with no commit,
  // no green-checkpoint verdict and no deploy. Refusing by default makes that window an
  // explicit, deliberate choice instead of an invisible default. Opt in while developing a
  // hook — the escape hatch is the point, not a loophole: it keeps the fast iteration loop
  // available to whoever knowingly wants it.
  const allowDirty = process.env.PAPERCUSP_ALLOW_DIRTY_HOOKS === '1';

  const installed: string[] = [];
  const refused: string[] = [];
  const refusedDirty: string[] = [];
  for (const name of CC_HOOK_FILES) {
    try {
      const data = await fs.readFile(path.join(srcDir, name));
      const dst = path.join(destDir, name);
      // Libraries are imported, not exec'd — 0644. Hooks stay 0755.
      const mode = CC_HOOK_LIB_FILES.has(name) ? 0o644 : 0o755;

      // EI-21974793277035753: identical bytes mean there is nothing to publish. Skipping
      // holds the steady-state launch at zero validation cost (the overwhelmingly common
      // case is "no hook changed"), and avoids a pointless rename under live readers.
      // Still reported as installed, because it IS installed — the settings merge below
      // is gated on that, and a no-op pass must not silently un-gate it.
      const current = await fs.readFile(dst).catch(() => null);
      if (current && current.equals(data)) {
        // Bytes match, so there is nothing to publish — but this path previously chmod'd
        // on EVERY launch, and skipping the write must not silently also skip mode repair.
        // A hook that has lost its +x does not error: it simply stops running, which for
        // the fail-open bash gate is silent ungating — the exact class this work closes.
        // Not hypothetical: a 775 hook was observed drifted in the live dir on 2026-08-31.
        const st = await fs.stat(dst).catch(() => null);
        if (st && (st.mode & 0o777) !== mode) {
          await fs.chmod(dst, mode).catch(() => {});
        }
        installed.push(name);
        continue;
      }

      // T3 (EI-21974793277035753): refuse to publish an UNCOMMITTED hook fleet-wide.
      //
      // Gated on `current` existing, and that condition is load-bearing rather than
      // defensive: "keep the last known-good copy" needs a last known-good copy to keep.
      // With no previously installed file, refusing leaves the hook ABSENT — and for a
      // guard hook, absent and ungated are the same outcome, so refusing would cause the
      // very thing it is meant to prevent. Present-but-uncommitted beats missing, so a
      // first install proceeds and is reported loudly below.
      //
      // Unreachable when git cannot answer (`uncommitted` undefined), which keeps the
      // packaged-app path and any non-repo checkout installing exactly as before.
      if (!allowDirty && current && uncommitted?.includes(name)) {
        refusedDirty.push(name);
        continue;
      }
      // EI-18755593630003816: write to a same-directory temp file then rename() into
      // place, NOT a direct in-place fs.writeFile. This path is shared across every
      // agent session on the box (one `home`/HOME dir), and installClaudeHooks re-runs
      // on every psu launch/bootstrap — so a concurrent PreToolUse hook invocation can
      // open this EXACT file mid a plain writeFile's truncate-then-write, observe a
      // truncated/partial script, and hard-refuse with a spurious shell-syntax error
      // (observed live: a bash heredoc's un-terminated body fell through to the shell
      // parser because the terminator line hadn't been written yet). rename(2) is
      // atomic on the same filesystem, so a concurrent reader always sees either the
      // whole old file or the whole new one, never a torn prefix.
      // EI-21974793277035753: parse-check the bytes BEFORE staging them. rename() below
      // guarantees a reader sees a whole file; this is what makes it a valid one.
      // Refusing keeps the previously installed copy, which is the safe direction: a
      // stale working hook beats a live broken one, and for the fail-open bash gate a
      // broken copy would silently stop gating rather than error. Checked before the
      // write so a refused hook never creates a temp file for the GC to collect.
      const syntax = await checkHookSyntax(data, name);
      if (!syntax.ok) {
        refused.push(name);
        console.error(
          `[desktop-install] cc hooks: REFUSING ${name} — it does not parse ` +
            `(${syntax.detail}). Keeping the previously installed copy.`,
        );
        continue;
      }
      const tmp = `${dst}.psu-install.${process.pid}.tmp`;
      await fs.writeFile(tmp, data, { mode });
      await fs.chmod(tmp, mode);
      await fs.rename(tmp, dst);
      installed.push(name);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  // WI-37405 #3 — record WHERE these came from, so "which build are my hooks?" is one
  // read instead of hashing every file against four checkouts (what EI-19956921121874213
  // actually cost). Written after the copies so it always describes what is on disk.
  if (refused.length > 0) {
    console.error(
      `[desktop-install] cc hooks: ${refused.length} file(s) refused as unparseable: ${refused.join(', ')}`,
    );
  }
  if (refusedDirty.length > 0) {
    console.error(
      `[desktop-install] cc hooks: ${refusedDirty.length} file(s) refused as UNCOMMITTED — they ` +
        `would go live for every agent on this box ungated. Commit them, or set ` +
        `PAPERCUSP_ALLOW_DIRTY_HOOKS=1 to install them deliberately: ${refusedDirty.join(', ')}`,
    );
  } else if (uncommitted && uncommitted.length > 0) {
    // Reached when the dirty hooks were installed anyway: either the opt-in is set, or
    // there was no previously installed copy to fall back to. Either way they are LIVE and
    // the stamp's sha does not contain them, so say so rather than leaving it to the stamp.
    console.warn(
      `[desktop-install] cc hooks: ${uncommitted.length} file(s) UNCOMMITTED in ${srcDir} — ` +
        `now live for every agent on this box, and NOT contained in ` +
        `sha=${incomingProvenance.sourceSha ?? 'unknown'}: ${uncommitted.join(', ')}`,
    );
  }

  if (installed.length > 0) {
    await writeInstallStamp(destDir, {
      sourceDir: srcDir,
      ...incomingProvenance,
      installedAt: new Date().toISOString(),
      pid: process.pid,
      unit: desktopInstallUnit(),
      installedBy: process.argv[1] ? path.basename(process.argv[1]) : undefined,
      files: installed,
      uncommittedFiles: uncommitted,
    });
    console.log(
      `[desktop-install] hooks/cc <- ${srcDir} ` +
        `(unit=${desktopInstallUnit()}, sha=${incomingProvenance.sourceSha ?? 'unknown'}` +
        `${uncommitted && uncommitted.length > 0 ? `, ${uncommitted.length} uncommitted` : ''})`,
    );
  }

  // Gate the settings merge on the primary lock hook landing (parity with the bash `[ -x $CC_PRE_HOOK ]`).
  if (!installed.includes('pretooluse-locks-acquire.sh')) return { installed, settingsMerged: false };

  const settingsPath = path.join(home, '.claude', 'settings.json');
  let cfg: Record<string, any> = {};
  try {
    const raw = await fs.readFile(settingsPath, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      cfg = parsed as Record<string, any>;
    } else {
      // Corrupt / non-object → back up then start fresh (mirrors the python except branch).
      await fs.rename(settingsPath, `${settingsPath}.bak.${Date.now()}`).catch(() => {});
      cfg = {};
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    cfg = {};
  }
  mergeClaudeHookSettings(cfg, destDir, { present: new Set(installed), isClaudeSettings: true });
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  await fs.chmod(settingsPath, 0o600);
  return { installed, settingsMerged: true };
}

/**
 * The codex built-in `[tui].status_line` items papercusp configures for the user's SHARED
 * ~/.codex/config.toml — the codex parallel of the Claude fleet statusLine (EI-8191). codex has
 * NO command-backed status item (openai/codex#17827), so this is codex's OWN native bottom pane
 * (run-state · model+reasoning · context-remaining · git-branch), NOT the fleet coord chips.
 * Kept identical to CODEX_TUI_TOML in role-codex-home.ts (per-session homes) so plain `codex` and
 * a psu-launched codex render the SAME status line.
 */
export const CODEX_STATUS_LINE_ITEMS = [
  'run-state',
  'model-with-reasoning',
  'context-remaining',
  'git-branch',
] as const;

/**
 * Non-destructive, idempotent merge of `[tui].status_line` into a codex `config.toml` STRING
 * (returns the new text + whether it changed). The codex analogue of merge_statusline: codex's
 * default is `status_line = None` ⇒ NO status line renders, which is exactly the "I see no status
 * lines in codex at all" report. NON-CLOBBER: we set `status_line` ONLY when it is entirely absent,
 * so any user choice (including an explicit `[]` = "off on purpose", or a personal item list set via
 * `/statusline`) is preserved. Corrupt/unparseable TOML ⇒ returns unchanged (caller leaves the file
 * alone) rather than risk clobbering. Pure + exported for unit tests.
 */
export function mergeCodexStatusLineToml(raw: string): { toml: string; changed: boolean } {
  let obj: Record<string, any>;
  try {
    const parsed = TOML.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { toml: raw, changed: false };
    obj = parsed as Record<string, any>;
  } catch {
    // Unparseable — never clobber a config we can't understand.
    return { toml: raw, changed: false };
  }
  const tui =
    obj.tui && typeof obj.tui === 'object' && !Array.isArray(obj.tui)
      ? (obj.tui as Record<string, any>)
      : (obj.tui = {});
  if (tui.status_line !== undefined) return { toml: raw, changed: false };
  tui.status_line = [...CODEX_STATUS_LINE_ITEMS];
  return { toml: TOML.stringify(obj as any), changed: true };
}

/**
 * Merge the papercusp codex status line into the user's shared ~/.codex/config.toml (best-effort,
 * idempotent) — so a PLAIN `codex` gets a native bottom status pane, the codex sibling of the Claude
 * settings.json statusLine merge (EI-8191). Only touches an EXISTING codex config (we don't create a
 * ~/.codex the user never set up); leaves any user-configured status_line untouched. Never throws.
 */
async function installCodexStatusLine(home: string): Promise<{ merged: boolean }> {
  const configPath = path.join(home, '.codex', 'config.toml');
  let raw: string;
  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch {
    // No ~/.codex/config.toml (codex not set up here) — nothing to do. The per-session CODEX_HOME
    // path (role-codex-home.ts) already covers psu-launched codex.
    return { merged: false };
  }
  try {
    const { toml, changed } = mergeCodexStatusLineToml(raw);
    if (!changed) return { merged: false };
    await fs.writeFile(configPath, toml.endsWith('\n') ? toml : toml + '\n', { mode: 0o600 });
    return { merged: true };
  } catch {
    return { merged: false };
  }
}

export async function installPapercuspFiles(opts: InstallOpts = {}): Promise<InstallResult> {
  const home = opts.home ?? os.homedir();
  const explicitRoot = !!opts.operatorAppRoot;
  const operatorAppRoot = opts.operatorAppRoot ?? resolveOperatorAppRoot();

  /**
   * Resolve an install SOURCE, refusing scratch/sandbox trees (WI-37405).
   *
   * Every source resolved in this function is copied into the single SHARED
   * `~/.papercusp/**` dest that every agent on the box reads, so a source from a
   * throwaway checkout poisons the whole fleet — measured live, 19 agent hooks
   * (file-locking, secrets, NUL-byte guards) served for days from an 8-day-old
   * sandbox (EI-19956921121874213).
   *
   * Fail-safe by construction: this only ever REMOVES poisoned candidates, letting
   * resolution fall through to the next legitimate one. If nothing legitimate
   * remains it returns null and the caller installs NOTHING, leaving whatever is
   * already on disk untouched — always safer than overwriting it with sandbox code.
   */
  const resolveSource = async (what: string, candidates: string[]): Promise<string | null> => {
    const filtered = filterInstallSources(candidates, {
      dest: home,
      allowScratch: process.env.PAPERCUSP_ALLOW_SCRATCH_INSTALL_SOURCE === '1',
    });
    const line = describeRefusals(what, filtered);
    if (line) {
      // SEVERITY SPLIT (fixes 27 failing tests in __tests__/papercusp-files.test.ts,
      // which would have red-pinned the fleet gate). describeRefusals emits TWO
      // different messages and only one of them is actionable:
      //   destIsScratch  -> "ALLOWING scratch source(s)" — the guard INSPECTED the
      //                     candidates and permitted them, because the destination is
      //                     itself a scratch tree (every test installs into /tmp, and
      //                     so does any sandbox install). Nothing was withheld, so
      //                     there is nothing for a reader to do about it.
      //   otherwise      -> "REFUSED scratch source(s)" — sources were actually
      //                     dropped and the install may be incomplete. That is a
      //                     warning.
      // Routing both through console.warn made the EXPECTED path fail every test
      // that calls installPapercuspFiles, via vitest-fail-on-console — a warning
      // about a decision the guard itself just made is noise, and noise on the
      // normal path is what trains readers to ignore the real refusal message.
      if (filtered.destIsScratch) console.log(line);
      else console.warn(line);
    }
    const chosen = await firstExisting(filtered.accepted);
    // GATE ON `accepted`, NOT ON `refused` — `refused` is a RECORD, not a verdict.
    // filterInstallSources pushes a scratch candidate onto BOTH lists when it
    // passes it through (dest is itself a scratch tree, or the env opt-in is set;
    // see its `if (passthrough) accepted.push(candidate)`). So a non-empty
    // `refused` does NOT mean anything was withheld, and testing it here claimed
    // "every candidate source was a scratch tree — installing NOTHING" for the
    // ordinary case of an OPTIONAL artifact that simply does not exist in this
    // layout — as console.error, which failed all 27 tests in
    // __tests__/papercusp-files.test.ts (every test installs into /tmp) and would
    // have red-pinned the fleet gate.
    //
    // `accepted.length === 0` is the condition that actually means "refusal left
    // us with nothing to try": under passthrough it is never empty, and without
    // passthrough it is empty exactly when every candidate was withheld. A missing
    // file then falls through silently, which is correct — resolveSource returning
    // null for an absent optional source is normal and its callers already handle it.
    if (!chosen && filtered.accepted.length === 0 && filtered.refused.length > 0) {
      console.error(
        `[desktop-install] ${what}: every candidate source was a scratch tree — installing NOTHING. ` +
          `Existing files left untouched. Boot the operator from the canonical checkout, or set ` +
          `PAPERCUSP_ALLOW_SCRATCH_INSTALL_SOURCE=1 if this is a deliberate sandbox install.`,
      );
    }
    return chosen;
  };

  const playbookSource =
    opts.playbookSource ?? (await resolveSource('su playbook', playbookCandidates(operatorAppRoot, explicitRoot)));
  const extensionSource =
    opts.extensionSource ??
    (await resolveSource('coord extension', extensionCandidates(operatorAppRoot, explicitRoot)));
  // psu/ptool launchers — bundled (psu.mjs/ptool.mjs) first, dev source second.
  const psuLauncherSource = await resolveSource(
    'psu launcher',
    cliLauncherCandidates(operatorAppRoot, explicitRoot, ['psu.mjs', 'psu-launcher.mjs']),
  );
  const ptoolLauncherSource = await resolveSource(
    'ptool launcher',
    cliLauncherCandidates(operatorAppRoot, explicitRoot, ['ptool.mjs']),
  );
  // Onboarding concierge — bundled (onboard.mjs) first, dev source second (P-014).
  const onboardLauncherSource = await resolveSource(
    'onboard launcher',
    cliLauncherCandidates(operatorAppRoot, explicitRoot, ['onboard.mjs', 'onboard-launcher.mjs']),
  );
  const projectHistoryLauncherSource = await resolveSource(
    'project-history launcher',
    projectHistoryLauncherCandidates(operatorAppRoot, explicitRoot),
  );

  const paths = resolveInstallPaths(home);

  await fs.mkdir(paths.papercuspDir, { recursive: true, mode: 0o700 });

  const token = await ensureSecret(paths.tokenPath, mintToken);
  const agentId = await ensureSecret(paths.agentIdPath, mintAgentId);

  // Playbook: splice the OMP overlay at the marker (NOT a raw copy —
  // the marker-model base is incomplete on its own). Install the coord
  // extension as a complete OMP sibling bundle: its destination is renamed,
  // but its relative modules must land beside that renamed entrypoint.
  const playbookWritten = playbookSource ? await writeSplicedPlaybook(playbookSource, paths.playbookPath) : false;
  // The injection installer stamps this exact OMP source family in hooks/omp.
  // Reuse that provenance to keep a green-release process from replacing the
  // newer staging extension loaded by the next visible OMP session.
  const ompHookProvenanceDir = path.join(paths.papercuspDir, 'hooks', 'omp');
  const extensionBundle = extensionSource
    ? await installOmpHookBundle({
        sourceDir: path.dirname(extensionSource),
        entryFile: path.basename(extensionSource),
        destinationDir: paths.papercuspDir,
        destinationEntry: path.basename(paths.extensionPath),
        provenanceGuardDir: ompHookProvenanceDir,
        provenanceLabel: 'OMP coordination extension',
      })
    : { installed: [] as string[], unresolved: [] as string[] };
  const extensionWritten = extensionBundle.installed.includes(path.basename(paths.extensionPath));

  // Claude/Codex CC hooks + fleet statusline (EI-8191): install the hooks to
  // ~/.papercusp/hooks/cc/ and merge them into ~/.claude/settings.json — the packaged
  // Mac/Windows apps shipped neither, so Claude rendered a blank statusline + lock/coord
  // enforcement was silently off. Cross-platform (Node native on macOS / WSL distro on
  // Windows). Best-effort: sources not shipped ⇒ nothing installed, settings untouched.
  const ccHookSrcDir = await resolveSource('cc hooks', ccHookDirCandidates(operatorAppRoot, explicitRoot));
  const claudeHooks = ccHookSrcDir
    ? await installClaudeHooks(home, ccHookSrcDir)
    : { installed: [] as string[], settingsMerged: false };

  // Context-injection dispatcher + omp hook (omp-context-injection-parity P-003).
  // Same shipping gap EI-8191 fixed for the CC hooks: esbuild cannot trace these
  // fs-read files, so build-desktop-sidecar.sh copies them and this installs them.
  // Without it the packaged app's omp sessions get NO turn-start/mid-turn context.
  const injectHookSrcDir = await resolveSource(
    'injection hooks',
    hookDirCandidates(operatorAppRoot, explicitRoot, 'inject'),
  );
  const injectionHooks = injectHookSrcDir ? await installInjectionHooks(home, injectHookSrcDir) : [];

  // Codex status line (parallel to the Claude statusLine merge above): a plain `codex` reads the
  // user's shared ~/.codex/config.toml, whose default status_line=None renders NOTHING — the
  // "no status lines in codex at all" report. Merge our native [tui].status_line in non-destructively.
  const codexStatusLine = await installCodexStatusLine(home);

  // agent-managed-compaction: render the Claude compaction floor (base + claude overlay)
  // to ~/.papercusp/compaction-strategy.md and @import it from ~/.claude/CLAUDE.md's
  // `# Compact Instructions` (the only supported persistent Claude compaction hook).
  // Best-effort; never blocks install. The compaction .md files sit beside the playbook.
  let compactionStrategyWritten = false;
  if (playbookSource) {
    const strategy = await renderCompactionStrategy(path.dirname(playbookSource));
    if (strategy) {
      await fs.writeFile(paths.compactionStrategyPath, strategy + '\n', { mode: 0o644 });
      compactionStrategyWritten = true;
      await ensureClaudeCompactImport(home, paths.compactionStrategyPath);
    }
  }

  // On-PATH CLI shims (psu-in-desktop-builds-2026-06-23 A2). Written only when
  // the launcher actually resolves — a dev repo or a packaged build that bundled
  // them. The native-console terminal prepends ~/.papercusp/bin to PATH (A2b),
  // so `psu` / `ptool` are then runnable from the in-app terminal. The shims are
  // the launcher only; what the discoverable end-user entry exposes + which
  // profile psu launches with are gated separately (FLAGS.PSU_END_USER + the
  // scoped `user` profile, C1/C2).
  await fs.mkdir(paths.binDir, { recursive: true, mode: 0o700 });
  const psuShimWritten = psuLauncherSource
    ? await writeShim(paths.psuPath, psuLauncherSource, 'superuser launcher (psu)', {
        ...shimRuntimeOptions(psuLauncherSource, 'PAPERCUSP_PSU_LAUNCHER'),
        // WI-38292: psu ALONE gets the re-exec loop. It is the only shim whose
        // target is a long-lived host process that outlives the code it loaded;
        // ptool/onboard/tutorial-runner are short-lived and re-read disk on
        // every invocation already.
        reexecExitCode: PSU_REEXEC_EXIT_CODE,
      })
    : false;
  const ptoolShimWritten = ptoolLauncherSource
    ? await writeShim(
        paths.ptoolPath,
        ptoolLauncherSource,
        'defineTool CLI (ptool)',
        shimRuntimeOptions(ptoolLauncherSource, 'PAPERCUSP_PTOOL_LAUNCHER'),
      )
    : false;
  const papercuspCliWritten = onboardLauncherSource
    ? await writeDispatcherShim(
        paths.papercuspCliPath,
        onboardLauncherSource,
        projectHistoryLauncherSource ?? undefined,
      )
    : false;
  // WI-4244: the 🛡 Sentinel dock pane's launcher shim. Only when `psu` itself
  // landed this pass — sentinel execs the psu shim by its resolved path.
  const psuSentinelShimWritten = psuShimWritten ? await writeSentinelShim(paths.psuSentinelPath, paths.psuPath) : false;
  // The deep-brain pane launcher rides the same gate (voice-public-release-readiness P-014).
  const psuSentinelDeepShimWritten = psuShimWritten
    ? await writeSentinelDeepShim(paths.psuSentinelDeepPath, paths.psuPath)
    : false;
  // The `rg` entry point (P-017). Unconditional — unlike the shims above it has no
  // launcher source to resolve; the thing it needs is either present on the host or
  // the shim says so honestly.
  //
  // The self-exclusion is load-bearing: our own shim lands ON the PATH we are about
  // to search, so a bare `resolveOnPath('rg')` would find it on the SECOND install
  // and conclude ripgrep resolves elsewhere — freezing the shim at whatever the
  // first install wrote and silently ending the refresh-on-every-boot contract every
  // other shim here has.
  const rgOnPath = resolveOnPath('rg', { env: process.env });
  const ripgrepShimWritten = await writeRipgrepShim(paths.ripgrepPath, {
    claudeExecutable: resolveOnPath('claude', { env: process.env }) ?? undefined,
    resolvesElsewhere: rgOnPath !== null && path.resolve(rgOnPath) !== path.resolve(paths.ripgrepPath),
  });
  // Put ~/.papercusp/bin on the user's shell PATH so psu/ptool resolve in ANY
  // terminal they open (the in-app "+" console sets PATH itself, but a plain
  // Terminal does not). Only when a shim actually landed.
  const pathProfilesUpdated =
    psuShimWritten || ptoolShimWritten || papercuspCliWritten || psuSentinelShimWritten
      ? await ensureBinOnPath(home, paths.binDir)
      : [];

  // WI-10001537: a shim refreshed every boot is worthless if an older, unmanaged
  // wrapper EARLIER on PATH keeps winning. Repoint any Papercusp-authored
  // shadower (the retired install-standalone-mcp.sh left one at ~/.local/bin/psu)
  // at the managed shim, so both spellings run the same code. Must run AFTER the
  // shims are written — it links to what this pass just authored.
  await healShadowedManagedShims(home, paths.binDir);

  // Link any user-installed agent CLIs (claude/codex) into the psu bin dir so
  // `psu → <agent>` launches out of the box — without this, a fresh install
  // where claude lives in ~/.local/bin makes psu exit immediately (can't exec it).
  await ensureAgentClisLinked(home, paths.binDir);

  // Keep common agent snippets that invoke `python` working on hosts that only
  // ship `python3`, while preserving any pre-existing managed `python` entry.
  await ensurePythonCompatibilityLinked(home, paths.binDir);

  // WI-3626: keep ~/.papercusp/bin/gh symlinked to the current bundle's gh so
  // buildGithubLoginSpec's `gh auth setup-git` bakes a stable, app-rename-proof
  // path into ~/.gitconfig's credential helper instead of an app-bundle path.
  await ensureGhLinked(home, paths.binDir);
  // Installs predating the stable shim may already have a now-dangling bundle
  // path baked into ~/.gitconfig. Heal only those Papercusp-owned values; keep
  // every blank reset and user-configured helper intact.
  await repairPapercuspGitCredentialHelpers(home, paths.binDir);

  // WI-3334: link the bundled node into ~/.local/bin so the psu/ptool shims'
  // `exec node` resolves even when the shim itself fell back to bare `node`
  // (a shim written by the dev-source operator, which can't resolve the bundled
  // node → resolveShimNode returns bare `node`). The primary operator's install
  // run resolves it (PAPERCUSP_SIDECAR_BIN set), so the link lands regardless.
  await ensureBundledNodeLinked(home);

  // macOS Tutorial.app wrapper (WI-2197): only where it means something (darwin)
  // and only once the dispatcher it invokes actually landed — a DMG install has
  // no postinstall-script hook, so this is provisioned here at first boot,
  // mirroring the Linux .deb's third `.desktop` icon.
  let macTutorialAppWritten = false;
  if (process.platform === 'darwin' && papercuspCliWritten) {
    macTutorialAppWritten = await writeMacTutorialApp(paths.macTutorialAppPath);
    if (macTutorialAppWritten) {
      await fs.rm(path.join(home, 'Applications', 'Papercusp Tutorial.app'), { recursive: true, force: true });
    }
  }

  // Linux tutorial `.desktop` icon (owner 2026-07-06, "4th time"): the Linux leg of the
  // tutorial-icon parity — provisioned HERE at first boot for dev boxes / any non-.deb
  // install, which the .deb postinstall never covers (that only fires on a .deb install,
  // into root /usr/share). Gated on the dispatcher having landed (it is the Exec target).
  let linuxTutorialDesktopWritten = false;
  let linuxTutorialPinned = false;
  if (process.platform === 'linux' && papercuspCliWritten) {
    linuxTutorialDesktopWritten = await writeLinuxTutorialDesktopEntry(
      paths.linuxTutorialDesktopPath,
      paths.papercuspCliPath,
      home,
      operatorAppRoot,
    );
    // Pin it to the dock/taskbar (once) — writing the `.desktop` alone only lands it in
    // the app grid, but the owner wants it ON the taskbar (2026-07-06, 5th report).
    if (linuxTutorialDesktopWritten) {
      linuxTutorialPinned = await pinLinuxTutorialToDock(
        path.basename(paths.linuxTutorialDesktopPath),
        path.join(home, '.papercusp', 'state', 'linux-tutorial-dock-pinned'),
      );
    }
  }

  return {
    ...paths,
    minted: { token: token.minted, agentId: agentId.minted },
    playbookWritten,
    extensionWritten,
    compactionStrategyWritten,
    playbookSource: playbookWritten && playbookSource ? playbookSource : '',
    extensionSource: extensionWritten && extensionSource ? extensionSource : '',
    psuShimWritten,
    ptoolShimWritten,
    papercuspCliWritten,
    psuSentinelShimWritten,
    psuSentinelDeepShimWritten,
    ripgrepShimWritten,
    macTutorialAppWritten,
    linuxTutorialDesktopWritten,
    linuxTutorialPinned,
    psuLauncherSource: psuShimWritten && psuLauncherSource ? psuLauncherSource : '',
    ptoolLauncherSource: ptoolShimWritten && ptoolLauncherSource ? ptoolLauncherSource : '',
    onboardLauncherSource: papercuspCliWritten && onboardLauncherSource ? onboardLauncherSource : '',
    projectHistoryLauncherSource:
      papercuspCliWritten && projectHistoryLauncherSource ? projectHistoryLauncherSource : '',
    pathProfilesUpdated,
    claudeHooksInstalled: claudeHooks.installed,
    injectionHooksInstalled: injectionHooks,
    claudeSettingsMerged: claudeHooks.settingsMerged,
    codexStatusLineMerged: codexStatusLine.merged,
  };
}

export interface RenderSuPlaybookInput {
  /** Which client's tooling overlay to splice in (omp/claude/codex). */
  agent: string;
  /** Base-playbook profile: 'engineer' (default) | 'power'. */
  profile?: string;
  /** Override the operator app root (tests). Defaults to walking up from here. */
  operatorAppRoot?: string;
  /** Override the resolved base path directly (tests / explicit callers). */
  baseSource?: string;
  /**
   * identities-v1 P-003: the base playbook TEXT, when the caller composed it in memory
   * (`composeSuStackSource` — the slot stack rendered under the kernel seal) rather than
   * reading `baseSource` off disk. `baseSource` is still resolved/required: the sibling
   * files (per-agent overlay, compaction protocol, project guide) resolve relative to it.
   */
  baseText?: string;
  /** Dir to resolve the per-agent overlay (`papercusp-su.<agent>.md`) from. Defaults to
   *  dirname(baseSource). Set when baseSource is a blueprint persona whose dir has no
   *  client overlays (domain-generic-agent-personas P-006) — point it at the operator
   *  prompts dir so the client tooling overlay still splices. */
  overlayDir?: string;
  /**
   * Project-guide source to splice at PROJECT_GUIDE_MARKER (P-001 / D-002).
   * - `undefined` (default) → auto-resolve the ENGINEER candidates: the repo's
   *   own `CLAUDE.md`.
   * - an explicit path → read that (the POWER profile passes the managed repo's
   *   guide, resolved from the launch cwd).
   * - `''` → no guide (marker removed). Only read when the base carries the marker.
   */
  projectGuideSource?: string;
  /**
   * identities-v1 P-022 — the per-audience seam. Called with the RESOLVED default guide
   * (the projected CLAUDE.md text + its path) and returns the guide THIS wearer receives:
   * the default plus the parts addressed to the wearer's stack, already passed through
   * `projectGuideAtBudget`. Omitted ⇒ the default guide splices untouched, byte-identical
   * to every pre-P-022 render. Not called when no guide resolved (`text === ''`), so a
   * guide-less launch stays guide-less. This module stays DB-free: the composer that
   * reads `harness_doc_parts` lives in `doc-projection/addressed-project-guide.ts` and
   * role-launch-spec threads it through here.
   */
  composeProjectGuide?: (resolved: { text: string; source: string }) => Promise<ComposedProjectGuide>;
  /**
   * Persona TIER (context-trimming-tiers P-017). 'full' (default) = today's
   * playbook, byte-identical. 'fleet' = the fleet-member tier rendered from
   * the SAME base: FULL-ONLY tagged sections stripped (orientation, named
   * workflows, mid-call interactivity), the AUTO clause compacted + IDEATE
   * dropped (renderModesPolicy('fleet')), and the wire-schema legend filtered
   * to the coordination/work-item/plan/lock spine. The engineering-discipline
   * + shared-dev-environment + project-guide spine is KEPT — fleet members
   * code in the repo.
   */
  tier?: 'full' | 'fleet';
  /**
   * Determinism seam for the "## Wire schemas" legend (identities-v1 P-018). The default
   * renderer derives the legend from the PROCESS-GLOBAL projected-tool registry
   * (`listAllProjectedTools()`, pinned to `globalThis`) — empty in a fresh process and
   * populated by whatever loaded a tool catalog earlier in the same process. An ambient
   * render is therefore ORDER-DEPENDENT under a shared test fork (the pure test lane,
   * isolate:false): a co-resident file that registers tools turns an empty legend into a
   * ~1 KB one and moves every byte-pinned section after it. A pinned-fixture render passes
   * its own renderer (`() => ''` collapses the marker exactly as an empty registry does) so
   * its output depends only on pinned inputs. Receives the tier's entry filter. Omitted ⇒
   * the live registry legend, byte-identical to every pre-seam render.
   */
  renderWireSchemas?: (entryFilter?: (name: string) => boolean) => string;
}

/** FULL-ONLY section tags (P-017): content between these comment markers is
 *  stripped from the FLEET persona tier. Author them in the base .tools.md
 *  (or inside a generated section) around owner-facing / leader-only prose. */
export const PLAYBOOK_FULL_ONLY_BEGIN = '<!-- PAPERCUSP-SU:FULL-ONLY:BEGIN -->';
export const PLAYBOOK_FULL_ONLY_END = '<!-- PAPERCUSP-SU:FULL-ONLY:END -->';

/** Remove just the FULL-ONLY marker COMMENT lines (full tier keeps the content;
 *  no internal marker may leak into a rendered prompt — the psu-prompt-isolation
 *  invariant). */
export function stripFullOnlyMarkers(text: string): string {
  return text
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return t !== PLAYBOOK_FULL_ONLY_BEGIN && t !== PLAYBOOK_FULL_ONLY_END;
    })
    .join('\n');
}

/** Strip every FULL-ONLY tagged block (fleet tier). Unbalanced tags fail soft:
 *  a BEGIN with no END strips nothing further (never truncate the tail). */
export function stripFullOnlySections(text: string): string {
  let out = '';
  let rest = text;
  for (;;) {
    const b = rest.indexOf(PLAYBOOK_FULL_ONLY_BEGIN);
    if (b === -1) return out + rest;
    const e = rest.indexOf(PLAYBOOK_FULL_ONLY_END, b);
    if (e === -1) return out + rest; // unbalanced — keep everything
    out += rest.slice(0, b).replace(/\n+$/, '\n');
    rest = rest.slice(e + PLAYBOOK_FULL_ONLY_END.length).replace(/^\n+/, '\n');
  }
}

/** The wire-schema families a FLEET member keeps (the coordination/work-item/
 *  plan/lock spine); every other tool's legend entry is full-tier only. */
const FLEET_WIRE_SCHEMA_FAMILIES = [
  'coord:',
  'work_items:',
  'plans:',
  'plan_items:',
  'locks:',
  'events:',
  'memory:',
  'improvements:',
];

export interface RenderedSuPlaybook {
  /** The spliced playbook text (base + per-agent overlay at the marker). */
  text: string;
  /** Resolved base-playbook path, '' if none was found. */
  baseSource: string;
  /** Resolved overlay path, '' when the agent has no overlay file. */
  overlaySource: string;
  /** Resolved project-guide path, '' when none was spliced. */
  projectGuideSource: string;
  /**
   * P-022: what the `composeProjectGuide` seam did, when one was supplied and a guide
   * resolved — the wearer's tokens, the addressed part keys spliced, whether the budget
   * cut the tail. `null` when the default guide was spliced untouched.
   */
  projectGuideAddressed: ComposedProjectGuide['addressed'] | null;
}

/** The result of the P-022 per-audience seam — see `RenderSuPlaybookInput.composeProjectGuide`. */
export interface ComposedProjectGuide {
  text: string;
  truncated: boolean;
  addressed: {
    /** The wearer's expanded stack tokens the addressed rows were matched against. */
    tokens: string[];
    /** `part_key`s of the addressed parts spliced after the default guide, in read order. */
    partKeys: string[];
    /** Chars the addressed sections added before the budget seam. */
    addedChars: number;
  } | null;
}

/**
 * Render an SU playbook IN MEMORY: the `papercusp-su-<profile>.tools.md`
 * base with the `papercusp-su.<agent>.md` overlay spliced in at the
 * marker. This is the SAME composition the install path
 * (`writeSplicedPlaybook`) writes to disk — both go through
 * `spliceToolingOverlay` + `readAgentOverlay` over the SAME prompts
 * files, so a `psu` launch and a `~/.papercusp/engineer-collaborator.md`
 * install can never drift.
 *
 * `buildLaunchSpec({ kind: 'su' })` uses this to source the prompt
 * fresh from the prompts dir rather than depending on install having run.
 * Throws when the base profile file can't be found (a real misconfig —
 * surface it; the marker-model base is required).
 */
export async function renderSuPlaybook(input: RenderSuPlaybookInput): Promise<RenderedSuPlaybook> {
  const profile = input.profile ?? 'engineer';
  const tier = input.tier ?? 'full';
  const explicitRoot = !!input.operatorAppRoot;
  const operatorAppRoot = input.operatorAppRoot ?? resolveOperatorAppRoot();
  const baseSource =
    input.baseSource ?? (await firstExisting(playbookCandidates(operatorAppRoot, explicitRoot, profile)));
  if (!baseSource) {
    throw new Error(
      `renderSuPlaybook: base playbook "papercusp-su-${profile}.tools.md" not found ` +
        `(searched from operatorAppRoot=${operatorAppRoot})`,
    );
  }
  const base = input.baseText ?? (await fs.readFile(baseSource, 'utf8'));
  const overlay = await readAgentOverlay(baseSource, input.agent, input.overlayDir);
  const overlaySource = overlay
    ? path.join(input.overlayDir ?? path.dirname(baseSource), `papercusp-su.${input.agent}.md`)
    : '';
  // P-018 determinism seam: a pinned-fixture render injects its own legend renderer so the
  // output cannot depend on the process-global projected-tool registry (see the input doc).
  const renderWire = input.renderWireSchemas ?? renderWireSchemasSection;
  const withWire = spliceGeneratedSection(
    spliceToolingOverlay(base, overlay),
    WIRE_SCHEMAS_MARKER,
    // P-017: the fleet tier keeps only the spine families' legend entries.
    renderWire(
      tier === 'fleet' ? (name) => FLEET_WIRE_SCHEMA_FAMILIES.some((f) => name.startsWith(f)) : undefined,
    ),
  );
  const withLegend = spliceGeneratedSection(withWire, COORD_LEGEND_MARKER, renderCoordLegend());
  const withMap = spliceGeneratedSection(withLegend, WORKSPACE_MAP_MARKER, renderWorkspaceMapSection());
  const withPromo = spliceGeneratedSection(withMap, PROMOTION_MODEL_MARKER, renderPromotionModelSection());
  // Operating modes are profile-agnostic (the AUTO act-don't-ask grant + its AUTO↔loop
  // relationship, plus the IDEATE invent-vs-patch switch and the AUTO×IDEATE table, apply to
  // every interactive su surface), so splice them BEFORE the engineer-only shared-base notes —
  // both engineer + power carry the marker and get the one canonical clause.
  const withAuto = spliceGeneratedSection(withPromo, AUTO_MODE_MARKER, renderModesPolicy(tier));
  // agent-context-firewall P-015: the per-result door cap + the `projection` knob. Rendered
  // from computeTurnDoors (the SAME function applyResultDoor enforces with) so the number the
  // agent is taught cannot drift from the number it is held to. Both tiers get it — a fleet
  // member pays the door exactly like a full session does.
  const withDoor = spliceGeneratedSection(withAuto, RESULT_DOOR_MARKER, renderResultDoorSection());
  // agent-managed-compaction: the agent self-management compaction protocol (client-neutral).
  const withCompaction = spliceGeneratedSection(
    withDoor,
    COMPACTION_MARKER,
    await readCompactionProtocol(baseSource, input.overlayDir),
  );
  // Only the ENGINEER profile works the Papercusp repo (where this pipeline + its green gate live),
  // so the deploy-pipeline note is engineer-only — but the REST of the bundle (wait-loop, peer-wake,
  // coupling, state-plane) is platform behaviour that applies to a power-profile session managing an
  // EXTERNAL repo just as much: `coord:send`, `coord:couple` and `state:read` are operator tools, not
  // repo tools. Gating the whole bundle on the profile withheld all four from su-power, which
  // silently violated D-062's "the coupling prompt goes to ALL agents". Both profiles now get the
  // platform notes; only the repo-specific one is conditional.
  //
  // ELIGIBILITY is computed from `base` — the ORIGINAL file, before any splice — because by
  // now every marker the splices above consumed is gone from the text. A real su playbook
  // carries at least one of these two; a minimal/test base carries neither and stays bare.
  // Deliberately NOT PROJECT_GUIDE_MARKER alone: that is precisely the assumption that broke
  // when the blueprint base (AUTO-MODE yes, PROJECT-GUIDE no) became the live one.
  const isSuPlaybook = base.includes(PROJECT_GUIDE_MARKER) || base.includes(AUTO_MODE_MARKER);
  const withNotes = injectSharedBaseNotes(withCompaction, {
    repoSpecific: profile === 'engineer',
    eligible: isSuPlaybook,
  });
  // Project guide (P-001 / D-002): splice the repo's CLAUDE.md so a psu session
  // gets the full project conventions via psu, not client auto-load. Only read
  // the (large) guide file when the base actually carries the marker.
  let text = withNotes;
  let projectGuideSource = '';
  let projectGuideAddressed: RenderedSuPlaybook['projectGuideAddressed'] = null;
  if (withNotes.includes(PROJECT_GUIDE_MARKER)) {
    const guide = await resolveProjectGuideText(baseSource, input.projectGuideSource);
    projectGuideSource = guide.source;
    // P-022: the per-audience seam — the default guide is what every reader gets; the
    // composer (when supplied, and only when a guide resolved) appends the parts addressed
    // to THIS wearer's stack and holds the whole thing to the budget. No composer, or no
    // guide ⇒ the default splices untouched, byte-identical to every earlier render.
    let guideText = guide.text;
    if (input.composeProjectGuide && guide.text) {
      const composed = await input.composeProjectGuide(guide);
      guideText = composed.text;
      projectGuideAddressed = composed.addressed;
    }
    text = spliceGeneratedSection(withNotes, PROJECT_GUIDE_MARKER, renderProjectGuideSection(guideText));
  }
  // P-017 fleet tier: strip every FULL-ONLY tagged block (base + generated
  // sections alike). Applied LAST so tags survive every splice above. The
  // FULL tier keeps the content but drops the marker comment lines — no
  // internal marker leaks into a rendered prompt (psu-prompt-isolation).
  text = tier === 'fleet' ? stripFullOnlySections(text) : stripFullOnlyMarkers(text);
  return { text, baseSource, overlaySource, projectGuideSource, projectGuideAddressed };
}
