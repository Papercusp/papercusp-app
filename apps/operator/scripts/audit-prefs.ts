#!/usr/bin/env -S npx tsx
/**
 * audit-prefs — CLI for reviewing + curating Operator's preferences.md.
 *
 *   npx tsx apps/operator/scripts/audit-prefs.ts list
 *   npx tsx apps/operator/scripts/audit-prefs.ts list --filter user-typed
 *   npx tsx apps/operator/scripts/audit-prefs.ts list --filter operator-proposed
 *   npx tsx apps/operator/scripts/audit-prefs.ts remove <key>
 *   npx tsx apps/operator/scripts/audit-prefs.ts purge --before 2026-01-01
 *
 * For users with 50+ entries the per-entry settings UI gets unwieldy;
 * this CLI does the same operations against `preferences.md` directly.
 */

import {
  listPreferenceEntries,
  removePreferenceEntry,
} from '@papercusp/operator-core/lib/operator-preferences';

const [, , cmd, ...rest] = process.argv;

async function listCmd() {
  const filterIdx = rest.indexOf('--filter');
  const filter = filterIdx >= 0 ? rest[filterIdx + 1] : 'all';
  let entries = await listPreferenceEntries();
  if (filter === 'user-typed') {
    entries = entries.filter((e) => e.tags.includes('USER-TYPED'));
  } else if (filter === 'operator-proposed') {
    entries = entries.filter((e) => e.tags.some((t) => t.startsWith('OPERATOR-PROPOSED')));
  }
  if (!entries.length) {
    console.log('(no entries)');
    return;
  }
  for (const e of entries) {
    console.log(`\n[${e.key}] ${e.date} · ${e.tags.join(' ')}`);
    console.log(e.body);
  }
}

async function removeCmd() {
  const key = rest[0];
  if (!key) {
    console.error('usage: audit-prefs remove <key>');
    process.exit(1);
  }
  const ok = await removePreferenceEntry(key);
  if (!ok) {
    console.error(`no entry with key=${key}`);
    process.exit(1);
  }
  console.log(`removed ${key}`);
}

async function purgeCmd() {
  const beforeIdx = rest.indexOf('--before');
  const before = beforeIdx >= 0 ? rest[beforeIdx + 1] : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(before)) {
    console.error('usage: audit-prefs purge --before YYYY-MM-DD');
    process.exit(1);
  }
  const cutoff = new Date(`${before}T00:00:00.000Z`).getTime();
  const entries = await listPreferenceEntries();
  let removed = 0;
  for (const e of entries) {
    if (new Date(e.addedAt).getTime() < cutoff) {
      if (await removePreferenceEntry(e.key)) removed++;
    }
  }
  console.log(`removed ${removed} entries with date < ${before}`);
}

(async () => {
  switch (cmd) {
    case 'list':
      await listCmd();
      break;
    case 'remove':
      await removeCmd();
      break;
    case 'purge':
      await purgeCmd();
      break;
    default:
      console.error('usage: audit-prefs <list|remove|purge> [...args]');
      process.exit(1);
  }
})();
