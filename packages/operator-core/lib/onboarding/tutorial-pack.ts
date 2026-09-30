/**
 * Tutorial content pack — loader + registry
 * (plan agent-first-onboarding-2026-07-03, P-012).
 *
 * The onboarding tutor's canonical section content lives as a CONTENT PACK:
 *
 *   apps/operator/prompts/tutorial/<chapter>/<nn>-<slug>.md
 *
 * Each file is frontmatter + two markdown sections:
 *
 *   ---
 *   id: ch1-01-server-gui-tutorial
 *   chapter: 1
 *   order: 1
 *   title: Server, GUI & Tutorial — the three icons
 *   docSlugs: system/repo-conventions, testing
 *   ---
 *
 *   ## Brief
 *   (2–4 sentences — what the tutor says for the section)
 *
 *   ## Details
 *   (the fuller explanation behind the "[2] More details" option)
 *
 * `docSlugs` names the /internal/docs pages the section is grounded in —
 * tutorial-pack.test.ts enforces that every slug resolves to a live page in
 * apps/operator-docs, so pack content can never drift onto dead docs.
 *
 * At handoff time the launch-context endpoint renders packIndexMarkdown()
 * into the tutor prompt's {{TUTORIAL_PACK_INDEX}} token: an index with FILE
 * PATHS (not inlined bodies), so the launch-context stays small and the tutor
 * reads each section file only when the tutorial reaches it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface TutorialSection {
  id: string;
  chapter: number;
  order: number;
  title: string;
  /** /internal/docs slugs this section is grounded in (may be empty). */
  docSlugs: string[];
  /** The `## Brief` body — the 2–4 sentence section script. */
  brief: string;
  /** The `## Details` body — behind "[2] More details" (null if absent). */
  details: string | null;
  /** Absolute path of the pack file this section came from. */
  file: string;
}

/** Pull one `## <heading>` section's body out of a markdown string. */
function extractHeadingBody(body: string, heading: string): string | null {
  const m = body.match(new RegExp(`^## ${heading}\\s*$`, 'm'));
  if (!m || m.index === undefined) return null;
  const rest = body.slice(m.index + m[0].length);
  const next = rest.search(/^## /m);
  const section = (next === -1 ? rest : rest.slice(0, next)).trim();
  return section || null;
}

/**
 * Parse one pack file. Hand-rolled frontmatter (`key: value` lines between
 * `---` fences) — the format is deliberately too simple to need a YAML dep.
 * Throws with the file path on any malformation so the sync test names the
 * offending file.
 */
export function parseTutorialSection(raw: string, file = '<inline>'): TutorialSection {
  const lines = raw.split('\n');
  if (lines[0]?.trim() !== '---') throw new Error(`${file}: missing frontmatter opening ---`);
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end === -1) throw new Error(`${file}: unterminated frontmatter`);

  const meta: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    if (!line.trim()) continue;
    const m = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!m) throw new Error(`${file}: bad frontmatter line ${JSON.stringify(line)}`);
    meta[m[1]] = m[2].trim();
  }
  for (const key of ['id', 'chapter', 'order', 'title']) {
    if (!meta[key]) throw new Error(`${file}: frontmatter missing ${key}`);
  }
  const chapter = Number(meta.chapter);
  const order = Number(meta.order);
  if (!Number.isInteger(chapter) || !Number.isInteger(order)) {
    throw new Error(`${file}: chapter/order must be integers (got ${meta.chapter}/${meta.order})`);
  }

  const body = lines.slice(end + 1).join('\n');
  const brief = extractHeadingBody(body, 'Brief');
  if (!brief) throw new Error(`${file}: missing (or empty) ## Brief section`);

  return {
    id: meta.id,
    chapter,
    order,
    title: meta.title,
    docSlugs: (meta.docSlugs ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    brief,
    details: extractHeadingBody(body, 'Details'),
    file,
  };
}

/**
 * Locate the pack root from the operator's cwd (dev: apps/operator; packaged
 * sidecar keeps prompts/ next to its cwd). Same fallback-chain pattern as
 * resolveTutorPromptSource. Null when no pack is installed — a legal state:
 * the tutor then grounds every section with docs:search.
 */
export function resolvePackRoot(
  cwd: string = process.cwd(),
  exists: (p: string) => boolean = existsSync,
): string | null {
  const candidates = [
    `${cwd}/prompts/tutorial`,
    `${cwd}/../prompts/tutorial`,
    `${cwd}/apps/operator/prompts/tutorial`,
  ];
  return candidates.find((p) => exists(p)) ?? null;
}

/**
 * Process-lifetime cache of the parsed pack, keyed by root. The pack files are
 * immutable in a packaged build, and this loader is on the tutorial-script
 * endpoint's hot path (re-read on every `papercusp tutorial` launch — 31 file
 * reads + parses each time). Set PAPERCUSP_RELOAD_PROMPTS=1 to bypass the cache
 * in dev (mirrors the repo's prompt hot-reload convention).
 */
const packCache = new Map<string, TutorialSection[]>();

/**
 * Load + validate the whole pack, sorted by (chapter, order, id).
 * Throws on any malformed file or duplicate section id. Memoized per root
 * (see packCache) — a cache hit skips all filesystem work.
 */
export function loadTutorialPack(root: string): TutorialSection[] {
  if (!process.env.PAPERCUSP_RELOAD_PROMPTS) {
    const cached = packCache.get(root);
    if (cached) return cached;
  }
  const sections: TutorialSection[] = [];
  for (const entry of readdirSync(root).sort()) {
    const dir = join(root, entry);
    if (!statSync(dir).isDirectory()) continue; // stray root files aren't sections
    for (const f of readdirSync(dir).sort()) {
      if (!f.endsWith('.md')) continue;
      const file = join(dir, f);
      sections.push(parseTutorialSection(readFileSync(file, 'utf8'), file));
    }
  }
  const seen = new Map<string, string>();
  for (const s of sections) {
    const prior = seen.get(s.id);
    if (prior) throw new Error(`duplicate section id ${s.id}: ${prior} and ${s.file}`);
    seen.set(s.id, s.file);
  }
  const result = sections.sort(
    (a, b) => a.chapter - b.chapter || a.order - b.order || a.id.localeCompare(b.id),
  );
  packCache.set(root, result);
  return result;
}

/**
 * Chapter titles. The pack files carry chapter NUMBERS only; these human titles
 * come from the owner-ratified curriculum (onboarding-tutor.md). Kept here so BOTH
 * the deterministic tutorial runner and the fallback tutor render identical names.
 * The Finale (GUI walkthrough) is not a numbered chapter — it is the gui-tab-tour.
 */
export const CHAPTER_TITLES: Readonly<Record<number, string>> = {
  1: 'Orientation',
  2: 'Directing work',
  3: 'The Fleet',
  4: 'Agent cognition & learning',
  5: 'The platform',
  6: 'Under construction (aspirational p2p)',
};

export interface TutorialChapter {
  number: number;
  title: string;
  /** Section ids in this chapter, in delivery order. */
  sectionIds: string[];
}

/** Group loaded sections into ordered chapters (each with its title + section ids). */
export function chaptersFrom(sections: TutorialSection[]): TutorialChapter[] {
  const byChapter = new Map<number, string[]>();
  for (const s of sections) {
    const list = byChapter.get(s.chapter) ?? [];
    list.push(s.id);
    byChapter.set(s.chapter, list);
  }
  return [...byChapter.keys()]
    .sort((a, b) => a - b)
    .map((number) => ({
      number,
      title: CHAPTER_TITLES[number] ?? `Chapter ${number}`,
      sectionIds: byChapter.get(number)!,
    }));
}

/**
 * Render the index the tutor prompt receives via {{TUTORIAL_PACK_INDEX}}:
 * per chapter, one line per section pointing at its pack FILE (the tutor
 * reads it on arrival) + the doc slugs it is grounded in.
 */
export function packIndexMarkdown(sections: TutorialSection[]): string {
  if (sections.length === 0) {
    return '(no tutorial content pack installed — ground every section with `docs:search` instead)';
  }
  const lines: string[] = [];
  let chapter: number | null = null;
  for (const s of sections) {
    if (s.chapter !== chapter) {
      chapter = s.chapter;
      if (lines.length) lines.push('');
      lines.push(`**Chapter ${chapter}**`);
    }
    const docs = s.docSlugs.length ? ` (docs: ${s.docSlugs.join(', ')})` : '';
    lines.push(`- ${s.id} — ${s.title} → \`${s.file}\`${docs}`);
  }
  return lines.join('\n');
}
