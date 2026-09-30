/**
 * git-sync-attribution — derive per-agent commit groups from the dirty file set +
 * a live path→agent attribution map (git-sync-dx-hardening-2026-06-17 P-004).
 *
 * DERIVED, never authored (the plan's hard constraint): the attribution map is built
 * by the caller from data agents ALREADY emit — coord:declare-intent `current_files`
 * + the file-lock holder — so agents stay 100% git-free. This module is PURE: no git,
 * no PG, just partitioning + commit-message shaping, so the grouping is unit-testable
 * in isolation. The caller (syncOneRepo) does the actual `git add`/`commit` + applies
 * git-sync's CI-skip marker; this only decides WHAT goes in each commit and WHY.
 */

/** Who a dirty file is attributed to (resolved by the caller from declare-intent / locks). */
export interface FileAttribution {
  /** Stable owner id — the grouping key + the Co-Authored-By identity. */
  agent: string;
  /** Human label for the trailer name (falls back to `agent`). */
  agentLabel?: string;
  /** The agent's declared intent — becomes the commit subject. */
  intent?: string;
  /** Co-Authored-By email (best-effort; a synthetic agents address if unknown). */
  email?: string;
  /** Work-item id(s) the agent had claimed when it made these edits — from the edit
   *  ledger (deterministic-commit-workitem-attribution P-001/P-003). Drives the
   *  `Papercusp-Work-Item:` trailer + the git_sync_commit_attribution rows (P-004). */
  workItems?: string[];
  /** The agent's plan slug at edit time (provenance; best-effort). */
  planSlug?: string;
  /** The agent's session id — for the `Papercusp-Session:` trailer + the link rows. */
  sessionId?: string;
}

/** One commit git-sync will make this tick. */
export interface AttributedCommitGroup {
  /** Owner id, or null for the catch-all (unattributable remainder). */
  agent: string | null;
  /** Repo-relative paths to `git add --` for this commit. */
  files: string[];
  /** Commit subject (the agent's intent, or the default for the catch-all). */
  subject: string;
  /** "Name <email>" for a Co-Authored-By trailer, or null (catch-all / unknown). */
  coAuthor: string | null;
  /** Work-item id(s) for this commit's `Papercusp-Work-Item:` trailer + link rows (P-004). */
  workItems?: string[];
  /** Plan slug (provenance). */
  planSlug?: string;
  /** Session id for the `Papercusp-Session:` trailer + link rows (P-004). */
  sessionId?: string;
}

/** The git-sync default subject (unchanged from today's single-commit message stem). */
export const DEFAULT_GIT_SYNC_SUBJECT = 'chore(git-sync): auto-commit';

/** Clamp a one-line subject to the 72-char budget at a word boundary (WI-38568):
 *  a mid-word clip ("…and focused dom") reads as a typo in every hive's public
 *  history. Cut at the last space past a floor so we keep most of the budget, and
 *  append … so a truncated subject reads as truncated. 71 + '…' stays within 72. */
export function clampSubject(full: string): string {
  if (full.length <= 72) return full;
  const clipped = full.slice(0, 71);
  const lastSpace = clipped.lastIndexOf(' ');
  const cut = lastSpace > 40 ? clipped.slice(0, lastSpace) : clipped;
  return `${cut.replace(/[\s,;:.-]+$/, '')}…`;
}

/** Sanitize a free-text intent into a single-line commit subject (clamped). */
export function intentToSubject(intent: string | undefined, agentLabel: string | undefined): string {
  const line = (intent ?? '').replace(/\s+/g, ' ').trim();
  if (!line) return DEFAULT_GIT_SYNC_SUBJECT;
  const who = agentLabel ? ` (${agentLabel.trim()})` : '';
  return clampSubject(`${line}${who}`);
}

/** Per-file staged diff stats (one `git diff --numstat` row); null counts = binary. */
export interface FileDiffStat {
  file: string;
  added: number | null;
  deleted: number | null;
}

/** Parse `git diff --numstat` output (`added\tdeleted\tpath`, `-` = binary). Pure;
 *  non-matching lines (blank, warnings) are skipped. A rename row keeps git's
 *  `old => new` / `{old => new}/rest` label as-is — the subject only renders
 *  basenames/areas, so the arrow form stays readable. */
export function parseNumstat(stdout: string): FileDiffStat[] {
  const out: FileDiffStat[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    out.push({
      file: m[3],
      added: m[1] === '-' ? null : Number(m[1]),
      deleted: m[2] === '-' ? null : Number(m[2]),
    });
  }
  return out;
}

/** Path roots whose SECOND segment is the meaningful area (apps/api → api). */
const AREA_ROOTS = new Set(['apps', 'packages', 'libs']);

/** Short area token for a repo-relative path: apps/api/… → 'api', db/… → 'db', README.md → 'root'. */
function pathArea(f: string): string {
  const segs = f.split('/');
  if (segs.length === 1) return 'root';
  if (AREA_ROOTS.has(segs[0]) && segs.length >= 2) return segs[1];
  return segs[0];
}

/** Dir label for the subject middle: apps/api/… → 'apps/api', db/… → 'db', a root file → its name. */
function pathDirLabel(f: string): string {
  const segs = f.split('/');
  if (segs.length === 1) return f;
  if (AREA_ROOTS.has(segs[0]) && segs.length >= 2) return `${segs[0]}/${segs[1]}`;
  return segs[0];
}

const basename = (f: string) => f.slice(f.lastIndexOf('/') + 1);

/**
 * WI-38594 [owner 2026-08-13]: compose a DIFF-derived commit subject —
 * `sync(<areas>): <what> (<n> files, +A/-D)` — so the subject describes the commit's
 * actual CONTENT; the agent's intent line (today's subject) is demoted to the commit
 * BODY by the callers, so nothing is lost. Pure. `stats` optional (a failed numstat
 * omits the ±counts rather than blocking the commit). The middle degrades
 * (basenames → dir labels → bounded dir list → bare file count) until the subject
 * fits the 72-char budget; the final form is word-boundary-clamped as a last resort.
 */
export function diffDerivedSubject(files: string[], stats?: FileDiffStat[]): string {
  const fs = [...new Set(files)].sort();
  if (fs.length === 0) return DEFAULT_GIT_SYNC_SUBJECT;
  const areas = [...new Set(fs.map(pathArea))].sort();
  const areaPart = areas.length <= 4 ? areas.join(',') : `${areas.slice(0, 3).join(',')} +${areas.length - 3}`;
  let counts = '';
  if (stats && stats.length > 0) {
    let add = 0;
    let del = 0;
    for (const s of stats) {
      add += s.added ?? 0;
      del += s.deleted ?? 0;
    }
    counts = `, +${add}/-${del}`;
  }
  const tail = ` (${fs.length} file${fs.length === 1 ? '' : 's'}${counts})`;
  const dirLabels = [...new Set(fs.map(pathDirLabel))];
  const middles: string[] = [];
  if (fs.length <= 2) middles.push(fs.map(basename).join(', '));
  if (dirLabels.length <= 4) middles.push(dirLabels.join(' + '));
  else middles.push(`${dirLabels.slice(0, 3).join(' + ')} +${dirLabels.length - 3} more`);
  for (const middle of middles) {
    const full = `sync(${areaPart}): ${middle}${tail}`;
    if (full.length <= 72) return full;
  }
  return clampSubject(`sync(${areaPart}): ${fs.length} file${fs.length === 1 ? '' : 's'}${counts}`);
}

/** "Name <email>" for a Co-Authored-By trailer (best-effort), or null when no identity. */
export function coAuthorTrailer(a: FileAttribution): string | null {
  const name = (a.agentLabel ?? a.agent ?? '').trim();
  if (!name) return null;
  const email = (a.email ?? `${a.agent}@agents.papercusp`).trim();
  return `${name} <${email}>`;
}

/**
 * Partition `dirtyFiles` into per-agent commit groups + a catch-all remainder.
 *
 * - Files present in `attribution` group under their agent; the rest fall to the
 *   catch-all (agent=null) — exactly what gets committed as a single lump today.
 * - Deterministic: agent groups sorted by id, files sorted within each, catch-all LAST.
 * - The catch-all group is ALWAYS appended (even with zero files — the caller skips an
 *   empty `git add`), so the unattributable remainder is committed just as today.
 *
 * When `attribution` is empty, the only group is the catch-all over ALL dirty files —
 * i.e. the flag-OFF / no-data behavior degrades to today's single commit.
 */
export function groupFilesForAttribution(
  dirtyFiles: string[],
  attribution: Map<string, FileAttribution>,
  opts: { defaultSubject?: string } = {},
): AttributedCommitGroup[] {
  const defaultSubject = opts.defaultSubject ?? DEFAULT_GIT_SYNC_SUBJECT;
  // An agent may move between work-items before one git-sync tick. Grouping by
  // agent alone makes whichever file is visited first donate its provenance to
  // every other dirty file from that agent. Partition by the complete commit
  // provenance instead, while retaining the agent as the author identity.
  const byProvenance = new Map<string, { attr: FileAttribution; files: string[] }>();
  const remainder: string[] = [];
  for (const f of dirtyFiles) {
    const a = attribution.get(f);
    if (!a) {
      remainder.push(f);
      continue;
    }
    const key = JSON.stringify([
      a.agent,
      a.intent ?? null,
      [...(a.workItems ?? [])].sort(),
      a.planSlug ?? null,
      a.sessionId ?? null,
      a.agentLabel ?? null,
      a.email ?? null,
    ]);
    let g = byProvenance.get(key);
    if (!g) {
      g = { attr: a, files: [] };
      byProvenance.set(key, g);
    }
    g.files.push(f);
  }
  const groups: AttributedCommitGroup[] = [...byProvenance.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, g]) => ({
      agent: g.attr.agent,
      files: g.files.slice().sort(),
      subject: intentToSubject(g.attr.intent, g.attr.agentLabel),
      coAuthor: coAuthorTrailer(g.attr),
      workItems: g.attr.workItems,
      planSlug: g.attr.planSlug,
      sessionId: g.attr.sessionId,
    }));
  groups.push({ agent: null, files: remainder.slice().sort(), subject: defaultSubject, coAuthor: null });
  return groups;
}

/**
 * Derive a per-repo attribution map from the live presence roster + this repo's path.
 *
 * Presence `current_files` are workspace-root-relative (superproject paths). For the
 * SUPERPROJECT (`repoRelPrefix=''`) they match the dirty paths directly; for a SUBMODULE
 * we strip the submodule prefix so they match the submodule-relative dirty paths (the
 * pathspec mismatch the audits flagged). Files outside this repo are dropped. When two
 * agents claim the same path (rare — file locks serialize edits), first-declared wins
 * (stable by the input order the caller passes).
 */
/** One active agent's declared work, as the caller resolves it from presence/declare-intent. */
export interface AttributionRosterEntry {
  agent: string;
  agentLabel?: string;
  intent?: string;
  email?: string;
  /** Workspace-root-relative paths the agent is working on (coord:declare-intent current_files). */
  files: string[];
  /** Work-item id(s) the agent has claimed (P-003 — from the edit ledger / claim). */
  workItems?: string[];
  planSlug?: string;
  sessionId?: string;
}

export function attributionMapForRepo(
  roster: AttributionRosterEntry[],
  repoRelPrefix: string,
  superRoot?: string,
): Map<string, FileAttribution> {
  const prefix = repoRelPrefix ? repoRelPrefix.replace(/\/?$/, '/') : '';
  // P-004 review: tolerate ABSOLUTE current_files (an agent may declare full paths — the Edit
  // tool + lock hook key on absolute paths) by stripping the superproject root to recover the
  // superproject-relative path the map keys on. A no-op when files are already repo-relative.
  const sr = superRoot ? superRoot.replace(/\/?$/, '/') : '';
  const map = new Map<string, FileAttribution>();
  for (const a of roster) {
    for (const raw of a.files ?? []) {
      const abs = sr && raw.startsWith(sr) ? raw.slice(sr.length) : raw;
      const f = abs.replace(/^\.?\//, '');
      let rel: string | null;
      if (!prefix) {
        // Superproject: keep the path as-is. A submodule's INNER file (libs/x/foo.ts) simply
        // won't match the superproject's gitlink-level dirty paths (which see `libs/x` modified,
        // not its contents), so it harmlessly fails to attribute here — no need to pre-drop it.
        rel = f;
      } else if (f.startsWith(prefix)) {
        rel = f.slice(prefix.length);
      } else {
        rel = null;
      }
      if (rel == null || rel === '') continue;
      if (!map.has(rel)) {
        map.set(rel, {
          agent: a.agent,
          agentLabel: a.agentLabel,
          intent: a.intent,
          email: a.email,
          workItems: a.workItems,
          planSlug: a.planSlug,
          sessionId: a.sessionId,
        });
      }
    }
  }
  return map;
}

/**
 * P-006: the set of agent ids to ASSIGN a git-sync escalation to — the agents who declared
 * the quarantined/failing files — instead of a fleet broadcast (the F5 "assigns to no one").
 * `scope` is 'superproject' or a submodule path (matching ScopedContentError/ScopedOversized);
 * each file is resolved through the right per-repo map. Returns the deduped agent ids (empty
 * when nothing is attributable → the caller falls back to a broadcast). Pure + testable.
 */
export function agentsForScopedFiles(
  roster: AttributionRosterEntry[],
  scopedFiles: Array<{ scope: string; file: string }>,
  superRoot?: string,
): string[] {
  const agents = new Set<string>();
  const cache = new Map<string, Map<string, FileAttribution>>();
  for (const { scope, file } of scopedFiles) {
    const prefix = scope === 'superproject' ? '' : scope;
    let m = cache.get(prefix);
    if (!m) {
      m = attributionMapForRepo(roster, prefix, superRoot);
      cache.set(prefix, m);
    }
    const hit = m.get(file);
    if (hit) agents.add(hit.agent);
  }
  return [...agents];
}
