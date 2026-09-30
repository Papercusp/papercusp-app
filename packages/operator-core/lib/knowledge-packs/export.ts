/**
 * export — distill a hive's shared learnings into a publishable pack
 * (learning-packs-2026-06-11 P-016).
 *
 * Writes the standard pack shape (`knowledge-packs/<packId>/manifest.yaml` +
 * one-learning-per-file md) into a target directory — by convention a member
 * repo of the hive, so the project's normal commit/push flow carries it; the
 * Comb listing then points at that repo with `listing_ref = packId`
 * (./publish wires publishListingToCupboard).
 *
 * Default scope is ORGANIC rows only (what THIS hive learned) — re-exporting
 * another pack's seeded content under your name needs the explicit
 * `includePackRows: true` opt-in.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getMemoryBackend, type MemoryEntry } from '../memory/backend';
import { hiveScopeKey } from '../memory/hive-scope';
import { LEARNING_KINDS, type LearningKind } from './pack-format';

export interface ExportPackInput {
  potSlug: string;
  packId: string;
  title: string;
  description: string;
  /** Three-part semver. Default 1.0.0. */
  version?: string;
  author?: string;
  /** Absolute dir the `knowledge-packs/<packId>/` tree is written under. */
  targetDir: string;
  /** Also export rows that came from installed packs. Default false. */
  includePackRows?: boolean;
}

export interface ExportPackResult {
  ok: boolean;
  error?: string;
  packDir?: string;
  exported?: number;
  skippedPackRows?: number;
}

/** Kebab item id from a row's text (stable enough for a one-shot export). */
function itemIdFrom(text: string, taken: Set<string>): string {
  const base =
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .split('-')
      .slice(0, 6)
      .join('-') || 'learning';
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  taken.add(id);
  return id;
}

/** Split a "Title — body" row back into title/body; degrade to a derived title. */
function titleAndBody(text: string): { title: string; body: string } {
  const sep = text.indexOf(' — ');
  if (sep > 0 && sep <= 120) {
    return { title: text.slice(0, sep).trim(), body: text.slice(sep + 3).trim() };
  }
  const firstStop = text.search(/[.!?]\s/);
  const title = (firstStop > 0 && firstStop <= 90 ? text.slice(0, firstStop) : text.slice(0, 80)).trim();
  return { title, body: text.trim() };
}

function rowKind(e: MemoryEntry): LearningKind {
  return (LEARNING_KINDS as readonly string[]).includes(e.kind ?? '')
    ? (e.kind as LearningKind)
    : 'feedback';
}

export async function exportHiveLearningsToPack(input: ExportPackInput): Promise<ExportPackResult> {
  const version = input.version ?? '1.0.0';
  if (!/^\d+\.\d+\.\d+$/.test(version)) return { ok: false, error: 'version must be three-part semver' };
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(input.packId)) return { ok: false, error: 'packId must be kebab-case' };

  const backend = getMemoryBackend();
  const avail = await backend.available();
  if (!avail.ok) return { ok: false, error: `memory_unavailable: ${avail.reason}` };

  const entries = await backend.list({ scope: hiveScopeKey(input.potSlug) });
  const isPackRow = (e: MemoryEntry) => e.metadata?.source === 'pack';
  const exportable = input.includePackRows === true ? entries : entries.filter((e) => !isPackRow(e));
  const skippedPackRows = entries.length - exportable.length;
  if (exportable.length === 0) {
    return { ok: false, error: 'nothing_to_export', skippedPackRows };
  }

  const packDir = join(input.targetDir, 'knowledge-packs', input.packId);
  await rm(packDir, { recursive: true, force: true });
  await mkdir(packDir, { recursive: true });

  const esc = (s: string) => s.replace(/\n/g, ' ').trim();
  await writeFile(
    join(packDir, 'manifest.yaml'),
    [
      `id: ${input.packId}`,
      `title: ${esc(input.title)}`,
      `description: ${esc(input.description)}`,
      `version: ${version}`,
      ...(input.author ? [`author: ${esc(input.author)}`] : []),
      '',
    ].join('\n'),
    'utf8',
  );

  // Derive ids up front (sequentially — the dedupe set isn't concurrency-safe),
  // then write the files. Each file carries an explicit `id:` frontmatter so a
  // re-imported pack keeps the SAME pack_item_id even if the file is later
  // renamed — provenance/upgrade-diff stability (P-013) can't rely on the
  // filename stem alone. learning-packs-2026-06-11 P-016.
  const taken = new Set<string>();
  const planned = exportable.map((e) => {
    const { title, body } = titleAndBody(e.text);
    return { id: itemIdFrom(title, taken), title, body, kind: rowKind(e) };
  });
  await Promise.all(
    planned.map(({ id, title, body, kind }) =>
      writeFile(
        join(packDir, `${id}.md`),
        `---\nid: ${id}\ntitle: ${esc(title)}\nkind: ${kind}\n---\n\n${body}\n`,
        'utf8',
      ),
    ),
  );

  return { ok: true, packDir, exported: exportable.length, skippedPackRows };
}
