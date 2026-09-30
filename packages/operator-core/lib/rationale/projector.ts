/**
 * The pure domain mapping: a `RationaleSource` → the contributions it places in
 * the topic-keyed index (docs-and-memory-as-projections-2026-06-05 D-003).
 *
 * Deterministic, no I/O. A source contributes one entry per (topic × unit):
 *   - plan      → each decision, under each topic the plan is tagged to.
 *   - work_item → the item, under each topic it's tagged to.
 *   - insight   → the insight, under each of its frontmatter tags.
 *
 * `entryId` is unique WITHIN a source per key (the diff invariant): a decision id,
 * the work-item id, or the insight slug. The same decision under two topics is two
 * distinct `(key, entryId)` contributions — that's how one decision shows up under
 * every relevant subsystem-topic without duplication within a topic.
 */

import type { Contribution } from '@papercusp/projection-index';
import type { RationaleEntry, RationaleSource } from './types';

/**
 * Strip a leading `Date: YYYY-MM-DD` line — a parsed decision body keeps the
 * `Date:` line the plan writer (plans:add-decision) inserts above it, and we carry
 * the date separately, so it should not bleed into the one-line summary.
 */
function stripLeadingDate(body: string): string {
  return body.replace(/^\s*Date:\s*\d{4}-\d{2}-\d{2}\s*\n?/i, '');
}

/** First sentence (or a bounded slice) of a body — the token-lean summary. */
export function firstSentence(text: string, max = 240): string {
  const s = text.trim().replace(/\s+/g, ' ');
  if (!s) return '';
  const m = s.match(/^(.+?[.!?])(\s|$)/);
  const candidate = m ? m[1] : s;
  return candidate.length > max ? candidate.slice(0, max - 1).trimEnd() + '…' : candidate;
}

/** De-dupe + drop empty topic keys so a malformed tag can't crash the diff. */
function cleanTopics(topics: readonly string[]): string[] {
  return [...new Set(topics.map((t) => t.trim()).filter(Boolean))];
}

export function rationaleProjector(record: RationaleSource): Contribution<RationaleEntry>[] {
  switch (record.kind) {
    case 'plan': {
      const topics = cleanTopics(record.topics);
      if (topics.length === 0 || record.decisions.length === 0) return [];
      const out: Contribution<RationaleEntry>[] = [];
      for (const topic of topics) {
        for (const d of record.decisions) {
          out.push({
            key: topic,
            entryId: d.id,
            kind: 'decision',
            sortKey: d.date ?? undefined,
            entry: {
              kind: 'decision',
              ref: `${d.id} @ ${record.slug}`,
              title: d.title,
              summary: firstSentence(stripLeadingDate(d.body)),
              home: record.slug,
              ...(record.planStatus ? { state: record.planStatus } : {}),
              ...(d.date ? { date: d.date } : {}),
            },
          });
        }
      }
      return out;
    }
    case 'work_item': {
      const topics = cleanTopics(record.topics);
      if (topics.length === 0) return [];
      return topics.map((topic) => ({
        key: topic,
        entryId: record.id,
        kind: 'work_item' as const,
        sortKey: record.createdAt ?? undefined,
        entry: {
          kind: 'work_item' as const,
          ref: record.id,
          title: record.title,
          summary: firstSentence(record.summary || record.title),
          home: record.id,
          state: record.state,
          ...(record.createdAt ? { date: record.createdAt } : {}),
        },
      }));
    }
    case 'insight': {
      const topics = cleanTopics(record.tags);
      if (topics.length === 0) return [];
      return topics.map((topic) => ({
        key: topic,
        entryId: record.slug,
        kind: 'insight' as const,
        // Insights have no intrinsic date in frontmatter; slug gives a stable
        // tiebreak via the lib's identity ordering when sortKey is absent.
        entry: {
          kind: 'insight' as const,
          ref: record.slug,
          title: record.title,
          summary: firstSentence(record.description || record.title),
          home: record.slug,
        },
      }));
    }
  }
}
