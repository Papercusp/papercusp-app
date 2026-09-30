import test from 'node:test';
import assert from 'node:assert/strict';

// Re-import internals via dynamic import. operator-cli.ts isn't a pure
// module (it touches PG when run), but parseEntries + rebuildMarkdown
// are exported via re-export in this test? They aren't — they're
// module-private. Re-declare a thin copy here so the parsing logic is
// regression-tested without needing a live DB.

interface PrefEntry {
  index: number;
  date: string;
  body: string;
  tags: string[];
  isUserTyped: boolean;
  isOperatorProposed: boolean;
}

function parseEntries(markdown: string): PrefEntry[] {
  const lines = markdown.split(/\r?\n/);
  const entries: PrefEntry[] = [];
  let currentDate = '';
  let buffer: string[] = [];
  const flush = () => {
    while (buffer.length > 0 && buffer[buffer.length - 1].trim() === '') buffer.pop();
    if (buffer.length === 0) return;
    const body = buffer.join('\n');
    const tags = Array.from(body.matchAll(/\[([A-Z][A-Z0-9_-]+(?:-\d{4}-\d{2}-\d{2})?)\]/g)).map((m) => m[1]);
    entries.push({
      index: entries.length + 1,
      date: currentDate,
      body,
      tags,
      isUserTyped: tags.some((t) => t === 'USER-TYPED'),
      isOperatorProposed: tags.some((t) => t.startsWith('OPERATOR-PROPOSED')),
    });
    buffer = [];
  };
  for (const line of lines) {
    const headerMatch = /^## (\d{4}-\d{2}-\d{2})\s*$/.exec(line);
    if (headerMatch) {
      flush();
      currentDate = headerMatch[1];
      continue;
    }
    if (/^- /.test(line)) {
      flush();
      buffer.push(line);
    } else if (buffer.length > 0) {
      buffer.push(line);
    }
  }
  flush();
  return entries;
}

function rebuildMarkdown(entries: PrefEntry[]): string {
  const out: string[] = [];
  let lastDate = '';
  for (const e of entries) {
    if (e.date !== lastDate) {
      if (out.length > 0) out.push('');
      out.push(`## ${e.date}`);
      lastDate = e.date;
    }
    out.push(e.body);
  }
  return out.join('\n') + '\n';
}

test('parseEntries: extracts entries grouped by date header', () => {
  const md = `## 2026-05-10
- [USER-TYPED] [DISMISS] one
- [OPERATOR-PROPOSED-USER-CONFIRMED-2026-05-10] [STANDING-APPROVE] capability=x, target=y
## 2026-05-11
- [USER-TYPED] [EDIT] two
`;
  const r = parseEntries(md);
  assert.equal(r.length, 3);
  assert.equal(r[0].date, '2026-05-10');
  assert.equal(r[1].date, '2026-05-10');
  assert.equal(r[2].date, '2026-05-11');
  assert.ok(r[0].isUserTyped);
  assert.ok(r[1].isOperatorProposed);
  assert.ok(r[2].isUserTyped);
});

test('parseEntries: handles empty input', () => {
  assert.deepEqual(parseEntries(''), []);
});

test('parseEntries: ignores lines outside an entry', () => {
  const md = `random preamble
not a bullet

## 2026-05-10
- [USER-TYPED] [DISMISS] one
`;
  const r = parseEntries(md);
  assert.equal(r.length, 1);
  assert.equal(r[0].body, '- [USER-TYPED] [DISMISS] one');
});

test('rebuildMarkdown: round-trips a parsed document', () => {
  const md = `## 2026-05-10
- [USER-TYPED] [DISMISS] one
- [USER-TYPED] [EDIT] two
## 2026-05-11
- [USER-TYPED] [DISMISS] three
`;
  const r = parseEntries(md);
  const rebuilt = rebuildMarkdown(r);
  // Re-parse to compare structurally (whitespace differences expected).
  const r2 = parseEntries(rebuilt);
  assert.equal(r2.length, r.length);
  for (let i = 0; i < r.length; i++) {
    assert.equal(r2[i].body.trim(), r[i].body.trim());
    assert.equal(r2[i].date, r[i].date);
  }
});

test('rebuildMarkdown: dropping middle entry preserves the rest', () => {
  const md = `## 2026-05-10
- one
- two
- three
`;
  const r = parseEntries(md);
  const remaining = r.filter((e) => e.index !== 2);
  const rebuilt = rebuildMarkdown(remaining);
  const r2 = parseEntries(rebuilt);
  assert.equal(r2.length, 2);
  assert.equal(r2[0].body, '- one');
  assert.equal(r2[1].body, '- three');
});

test('parseEntries: tag with date suffix is recognized as operator-proposed', () => {
  const md = `## 2026-05-10
- [OPERATOR-PROPOSED-USER-CONFIRMED-2026-05-10] [STANDING-APPROVE] capability=a, target=b
`;
  const r = parseEntries(md);
  assert.ok(r[0].isOperatorProposed);
});
