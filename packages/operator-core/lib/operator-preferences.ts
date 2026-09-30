import { readOperatorState, writeOperatorState } from './operator-state-pg';

/**
 * Operator preferences storage (workspace-scoped).
 *
 * Source of truth is `harness_shared.operator_preferences` (PG, migration
 * 022). The JSONB payload stores the markdown body as `{ content: "..." }`.
 * Was previously `<papercuspRoot>/system/operator/preferences.md`; the
 * file format is preserved (the LLM prompt + the parsing logic still
 * operate on the raw markdown text).
 *
 * Standing approvals (§4 Phase 4e) are encoded as a specific entry
 * shape so the server-side classifier can read them without re-parsing
 * markdown. Format (single line):
 *
 *   - [OPERATOR-PROPOSED-USER-CONFIRMED-<YYYY-MM-DD>] [STANDING-APPROVE]
 *     capability=<cap>, target=<harness-slug>
 */

export interface StandingApproval {
  capability: string;
  targetHarness: string;
  confirmedAt: string; // ISO date
}

export interface OperatorPreferences {
  /** Raw preferences.md text, for prompt assembly. */
  raw: string;
  /** Structured standing approvals parsed from the markdown. */
  standingApprovals: StandingApproval[];
}

async function readMarkdown(): Promise<string> {
  const raw = await readOperatorState<{ content?: string }>('operator_preferences');
  return typeof raw?.content === 'string' ? raw.content : '';
}

async function writeMarkdown(content: string): Promise<void> {
  await writeOperatorState('operator_preferences', { content });
}

const APPROVAL_RE =
  /\[OPERATOR-PROPOSED-USER-CONFIRMED-(\d{4}-\d{2}-\d{2})\]\s*\[STANDING-APPROVE\][\s\S]*?capability=([^\s,]+)[\s\S]*?target=([^\s\n]+)/g;

export async function loadPreferences(): Promise<OperatorPreferences> {
  const raw = await readMarkdown();
  return { raw, standingApprovals: parseStandingApprovals(raw) };
}

export function parseStandingApprovals(markdown: string): StandingApproval[] {
  const out: StandingApproval[] = [];
  for (const m of markdown.matchAll(APPROVAL_RE)) {
    out.push({ confirmedAt: m[1], capability: m[2], targetHarness: m[3] });
  }
  return out;
}

/** Append a provenance-tagged entry. Atomic via PG upsert. */
export async function appendPreferenceEntry(entry: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const headerPattern = new RegExp(`(^|\\n)## ${today}\\n`);
  const existing = await readMarkdown();
  const trimmed = entry.trimEnd();
  let next: string;
  if (headerPattern.test(existing)) {
    next = `${existing.trimEnd()}\n${trimmed}\n`;
  } else {
    const sep = existing.trim() ? '\n\n' : '';
    next = `${existing.trimEnd()}${sep}## ${today}\n${trimmed}\n`;
  }
  await writeMarkdown(next);
}

/**
 * Parse preferences.md into a flat list of entries. Each entry is one
 * top-level bullet (lines that start with `- `). Sub-bullets are folded
 * into the parent's body for round-trip preservation.
 *
 * Provenance tags `[USER-TYPED]` / `[OPERATOR-PROPOSED-USER-CONFIRMED-…]` /
 * `[STANDING-APPROVE]` / `[DISMISS]` / `[EDIT]` are extracted into the
 * `tags` field for the settings UI's filter.
 */
export interface PreferenceEntry {
  /** Stable hash of (date + body); used as URL key for delete. */
  key: string;
  /** Section header for this entry (YYYY-MM-DD). */
  date: string;
  /** Raw entry markdown including the leading `- ` and any sub-bullets. */
  body: string;
  /** Provenance + kind tags found in the body. */
  tags: string[];
  /** Best-effort ISO of when this entry was added (the section header). */
  addedAt: string;
}

const TAG_RE = /\[([A-Z][A-Z0-9_-]+(?:-\d{4}-\d{2}-\d{2})?)\]/g;

export async function listPreferenceEntries(): Promise<PreferenceEntry[]> {
  const raw = await readMarkdown();
  if (!raw) return [];
  const out: PreferenceEntry[] = [];
  const sections = raw.split(/^## /m).filter((s: string) => s.trim());
  for (const sec of sections) {
    const firstNL = sec.indexOf('\n');
    if (firstNL < 0) continue;
    const date = sec.slice(0, firstNL).trim();
    const tail = sec.slice(firstNL + 1);
    const lines = tail.split('\n');
    let cur: string[] = [];
    const flush = () => {
      const body = cur.join('\n').trim();
      if (!body) return;
      const tags: string[] = [];
      for (const m of body.matchAll(TAG_RE)) tags.push(m[1]);
      out.push({
        key: hashEntry(date, body),
        date,
        body,
        tags,
        addedAt: dateToIso(date),
      });
      cur = [];
    };
    for (const ln of lines) {
      if (/^-\s/.test(ln)) {
        flush();
        cur.push(ln);
      } else if (cur.length) {
        cur.push(ln);
      }
    }
    flush();
  }
  return out;
}

export async function removePreferenceEntry(key: string): Promise<boolean> {
  const entries = await listPreferenceEntries();
  const target = entries.find((e) => e.key === key);
  if (!target) return false;
  const raw = await readMarkdown();
  const updated = raw.replace(target.body, '').replace(/\n{3,}/g, '\n\n');
  await writeMarkdown(updated);
  return true;
}

function hashEntry(date: string, body: string): string {
  let h = 0;
  const s = `${date}::${body}`;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

function dateToIso(date: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00:00.000Z` : new Date(0).toISOString();
}
