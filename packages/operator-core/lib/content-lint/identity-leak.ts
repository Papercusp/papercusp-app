/**
 * The IDENTITY-LEAK content detector (EI-19381677675617429).
 *
 * WHY THIS EXISTS AT THE GIT-SYNC LAYER, not only at edit time.
 * There is already an edit-time advisory for this class — the PreToolUse hook
 * `apps/operator/scripts/hooks/cc/pretooluse-content-lint.mjs`. EI-19381677675617429
 * proposed making that hook DENY instead of warn. Measured while picking the item up,
 * that would NOT have prevented the incident the item itself documents:
 *
 *   the hook's matcher is `Edit|Write|MultiEdit|mcp__.*__capability_(edit|write|…)`,
 *   and the leak arrived by `cp` of a host systemd unit into the repo.
 *
 * A file copied in by Bash never reaches the hook at all, so no edit-time verdict —
 * advisory or blocking — can see it. git-sync's content guard is the ROUTE-INDEPENDENT
 * chokepoint: it inspects the dirty set immediately before `git add -A && commit`,
 * whatever wrote it (cp, sed -i, a heredoc, an editor, an agent Edit). Quarantining
 * there closes the exact window the item measured — a leak committed 4m39s before its
 * fix, becoming a gate candidate in between.
 *
 * ONE MATCHER, NOW THREE CONSUMERS. The patterns live in
 * `scripts/lib/identity-leak-patterns.mjs` and are shared with the two CI lints
 * (check-no-box-identity.mjs, check-no-owner-name-tags.mjs) and the edit-time hook.
 * This detector imports that same module rather than restating the regexes — the
 * D-003 rule the registry states in its own header, and the precedent set by
 * `conflict-markers.ts`, which imports its matcher straight from `scripts/`.
 * A detector that disagreed with the gate lint would quarantine files the gate
 * accepts, or pass files the gate later rejects.
 *
 * SCOPE — SUPERPROJECT ONLY. Declared via `repoScope` on the registry entry and
 * enforced in the content guard, because git-sync sweeps the superproject AND every
 * submodule with the same detector list. Measured 2026-08-31 across 38 submodules:
 * 38 files trip the box-identity class and 7 trip the owner-name class. Those are
 * leaks BY DESIGN — `bin/stage-source-tree.sh` redacts identity literals into a COPY
 * of each must-ship file at tar time, so the shipped bundle carries none of them
 * (WI-4419 / desktop-v0-0-12-release-tri-platform#D-004, which rejects per-file
 * enforcement there in as many words). Without the scope, registering this detector
 * would quarantine 45 by-design files from every submodule commit — a fleet-wide
 * stall caused by the guard meant to prevent one.
 *
 * TWO CLASSES, NOT THREE. The shared module exposes a third class,
 * `findIdentityLiterals`, which needs `resolveIdentityLiterals(readCmd)` to discover
 * THIS machine's literals (user, hostname) by running commands. The content guard has
 * no exec seam and must stay pure + fail-open, so that class is deliberately out of
 * scope here and remains covered by its CI lint. The two classes below are pure and
 * machine-agnostic — they match a path SHAPE and a tag SHAPE, so they behave
 * identically on every contributor's checkout.
 */
import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ContentDetectorContext } from './registry';

interface OwnerLeak {
  line: number;
  name: string;
  text: string;
  form?: string;
}

interface BoxIdentityPath {
  line: number;
  user: string;
  text: string;
}

interface IdentityPatternsModule {
  findBoxIdentityPaths(text: string): BoxIdentityPath[];
  findOwnerNameLeaks(text: string): OwnerLeak[];
  isSkippedPath(file: string): boolean;
  renderLeak(row: OwnerLeak): string;
  FIX_HINT: string;
  BOX_IDENTITY_FIX_HINT: string;
}

interface CachedIdentityPatterns {
  fingerprint: string;
  module: IdentityPatternsModule;
}

/**
 * The guard runs from the operator bundle, which may live in a release checkout
 * different from the working tree it is committing. Resolve the detector from
 * the guarded checkout at call time so its rules and its input cannot drift.
 */
const IDENTITY_PATTERNS_RELATIVE = join('scripts', 'lib', 'identity-leak-patterns.mjs');
const identityPatternsCache = new Map<string, CachedIdentityPatterns>();

function identityPatternsPath(repoPath?: string): string {
  return join(resolve(repoPath ?? process.cwd()), IDENTITY_PATTERNS_RELATIVE);
}

function identityPatternsFingerprint(file: string): string {
  const stat = statSync(file);
  const mtime = 'mtimeNs' in stat ? String(stat.mtimeNs) : String(stat.mtimeMs);
  return `${stat.size}:${mtime}`;
}

async function loadIdentityPatterns(repoPath?: string): Promise<IdentityPatternsModule> {
  const file = identityPatternsPath(repoPath);
  const fingerprint = identityPatternsFingerprint(file);
  const cached = identityPatternsCache.get(file);
  if (cached?.fingerprint === fingerprint) return cached.module;

  // The query changes when the guarded working-tree module changes, avoiding
  // Node's URL-keyed ESM cache retaining a pre-change ruleset in a long-lived
  // bg-host process.
  const url = `${pathToFileURL(file).href}?identity-patterns=${encodeURIComponent(fingerprint)}`;
  const module = (await import(/* @vite-ignore */ url)) as IdentityPatternsModule;
  identityPatternsCache.set(file, { fingerprint, module });
  return module;
}

/** One leak row as the shared matcher returns it. */
interface LeakRow {
  line: number;
  text: string;
}

/** Render at most `max` offending lines, then say how many more there were. */
function renderRows(rows: LeakRow[], label: (row: LeakRow) => string, max = 3): string {
  const shown = rows.slice(0, max).map((r) => `    line ${r.line} ${label(r)}: ${r.text}`);
  const rest = rows.length > max ? [`    … and ${rows.length - max} more`] : [];
  return [...shown, ...rest].join('\n');
}

/**
 * The scope predicate — mirrors both CI lints EXACTLY (they filter tracked files
 * through the same `isSkippedPath`), so the guard never quarantines a file the gate
 * would not flag, and never passes one it would.
 */
export async function identityLeakScopeMatches(file: string, repoPath?: string): Promise<boolean> {
  const patterns = await loadIdentityPatterns(repoPath);
  return !patterns.isSkippedPath(file);
}

/**
 * Run both pure identity-leak classes over a file's text.
 *
 * @returns a human-readable error (fed to the escalation body + the content-fixer
 *   prompt), or null when the file is clean. Never throws for content reasons; the
 *   guard additionally treats a throw as fail-open.
 */
export async function findIdentityLeakError(
  file: string,
  text: string,
  repoPath?: string,
): Promise<string | null> {
  const patterns = await loadIdentityPatterns(repoPath);
  const parts: string[] = [];

  // CLASS 1 — named owner-provenance tags (`[owner:<name>]`).
  const named: LeakRow[] = patterns.findOwnerNameLeaks(text) ?? [];
  if (named.length) {
    parts.push(
      `${named.length} named owner-provenance tag(s):\n` +
        `${renderRows(named, (r) => patterns.renderLeak(r as never))}\n${patterns.FIX_HINT}`,
    );
  }

  // CLASS 2 — hardcoded home paths (`/home/<someone>/…`). A path SHAPE, not a value.
  const boxed: Array<LeakRow & { user: string }> = patterns.findBoxIdentityPaths(text) ?? [];
  if (boxed.length) {
    parts.push(
      `${boxed.length} hardcoded home path(s):\n` +
        `${renderRows(boxed, (r) => `(user "${(r as unknown as { user: string }).user}")`)}\n` +
        `${patterns.BOX_IDENTITY_FIX_HINT}`,
    );
  }

  if (!parts.length) return null;
  return (
    `identity leak in ${file} — this names ONE developer's machine or person, is wrong on ` +
    `every other checkout, and ships to users inside the release source drop.\n\n` +
    parts.join('\n\n')
  );
}
