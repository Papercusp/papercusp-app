import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  commitsForWorkItems,
  exportMissingWorkItemsByIdBatches,
  exportWorkItemsByIdBatches,
  githubWebUrl,
  isTemplateCarrierPlan,
  loadProjectHistoryPlansFromExport,
  parseGitLog,
  parseProjectHistoryGenerateArgs,
  PROJECT_HISTORY_FILE_READ_CONCURRENCY,
  projectHistoryOutputIsCurrent,
  readExportedWorkItems,
  removeProjectHistoryExportDirectory,
  renderProjectHistory,
  repositoryFromRemote,
  WORK_ITEMS_EXPORT_IDS_BATCH_SIZE,
  workItemRows,
} from './project-history-cli.ts';
import type { ProjectHistoryDocument } from '@papercusp/plan-parser/project-history';

test('project-history args derive portable defaults and accept equals syntax', () => {
  const options = parseProjectHistoryGenerateArgs([
    '--harness=sidestage',
    '--project-name', 'SideStage',
    '--output', 'apps/api/src/history.snapshot.ts',
    '--generated-at', '2026-08-15T00:00:00.000Z',
  ], '/repo', { PAPERCUSP_WORKSPACE: 'workspace' }, new Date(0));

  assert.deepEqual(options, {
    workspace: 'workspace',
    harness: 'sidestage',
    planPrefix: 'sidestage-',
    projectId: 'sidestage',
    projectName: 'SideStage',
    repoRoot: '/repo',
    extraRepoRoots: [],
    output: '/repo/apps/api/src/history.snapshot.ts',
    format: 'typescript',
    exportName: 'PROJECT_HISTORY',
    generatedAt: '2026-08-15T00:00:00.000Z',
    check: false,
    repositoryUrl: null,
    repositoryWebUrl: null,
    defaultBranch: null,
  });
});

test('project-history accepts an empty prefix to include every harness plan', () => {
  const options = parseProjectHistoryGenerateArgs([
    '--harness', 'sidestage',
    '--prefix=',
  ], '/repo', {}, new Date(0));

  assert.equal(options.planPrefix, null);
});

test('exported Markdown remains the complete plan enumeration when plans:list is truncated', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'project-history-cli-test-'));
  try {
    await Promise.all([
      fs.writeFile(join(directory, 'demo-a.md'), '# A\n', 'utf8'),
      fs.writeFile(join(directory, 'demo-b.md'), '# B\n', 'utf8'),
      fs.writeFile(join(directory, 'other.md'), '# Other\n', 'utf8'),
    ]);

    const plans = await loadProjectHistoryPlansFromExport(directory, [{
      slug: 'demo-a',
      updated: '2026-08-15T00:00:00.000Z',
    }], 'demo-');

    assert.deepEqual(plans.map((plan) => plan.filePath), ['demo-a.md', 'demo-b.md']);
    assert.equal(plans[0]?.updatedAt, '2026-08-15T00:00:00.000Z');
    assert.equal(plans[1]?.updatedAt, null);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('archived plans stay in the History artifact — plans:export writes them under archive/', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'project-history-cli-archive-'));
  try {
    // Exactly the layout plans:export produces: live plans at the root, archived ones under
    // `archive/`. `archived` is a reversible declutter flag, and archiving the implementation plan
    // is a normal post-ship closeout step — so a shipped plan must NOT drop out of the product
    // History artifact just because it was tidied away (WI-39765).
    await fs.mkdir(join(directory, 'archive'), { recursive: true });
    await Promise.all([
      fs.writeFile(join(directory, 'demo-live.md'), '# Live\n', 'utf8'),
      fs.writeFile(join(directory, 'archive', 'demo-archived.md'), '# Archived\n', 'utf8'),
      // A template carrier is still a process artifact wherever it lives.
      fs.writeFile(
        join(directory, 'archive', 'demo-acceptance.md'),
        '---\nslug: demo-acceptance\ntemplate: rubric\n---\n\nbody\n',
        'utf8',
      ),
      // The prefix filter applies inside archive/ too.
      fs.writeFile(join(directory, 'archive', 'other-archived.md'), '# Other\n', 'utf8'),
    ]);

    const plans = await loadProjectHistoryPlansFromExport(directory, [{
      slug: 'demo-archived',
      updated: '2026-08-15T05:37:16.793Z',
    }], 'demo-');

    // Sorted by SLUG across both directories, not root-then-archive.
    assert.deepEqual(plans.map((plan) => plan.filePath), ['archive/demo-archived.md', 'demo-live.md']);
    assert.equal(plans[0]?.markdown, '# Archived\n');
    // Archived plans keep their `updated` metadata — which is why loadPlans() lists with
    // includeArchived:true.
    assert.equal(plans[0]?.updatedAt, '2026-08-15T05:37:16.793Z');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a harness with no archived plans exports no archive/ directory and still loads', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'project-history-cli-no-archive-'));
  try {
    await fs.writeFile(join(directory, 'demo-live.md'), '# Live\n', 'utf8');

    const plans = await loadProjectHistoryPlansFromExport(directory, [], 'demo-');

    assert.deepEqual(plans.map((plan) => plan.filePath), ['demo-live.md']);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a genuinely unreadable export directory throws instead of reading as empty', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'project-history-cli-unreadable-'));
  try {
    // A FILE where the loader expects a directory: ENOTDIR, not ENOENT. Only ENOENT ("this
    // harness has no archived plans") may degrade to an empty enumeration — a real read failure
    // that silently produced zero plans would delete history exactly as WI-39765 did.
    await fs.writeFile(join(directory, 'archive'), 'not a directory\n', 'utf8');
    await fs.writeFile(join(directory, 'demo-live.md'), '# Live\n', 'utf8');

    await assert.rejects(() => loadProjectHistoryPlansFromExport(directory, [], 'demo-'));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('template-carrier plans are excluded from the History artifact, ordinary plans are not', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'project-history-cli-template-'));
  try {
    // A rubric carrier, exactly as plans:export writes it (frontmatter `template: rubric`).
    await fs.writeFile(join(directory, 'demo-acceptance.md'), [
      '---',
      'title: Demo — acceptance',
      'slug: demo-acceptance',
      'status: superseded',
      'template: rubric',
      '---',
      '',
      '## Now',
      '',
    ].join('\n'), 'utf8');
    // POSITIVE CONTROL: an ordinary plan carries no `template:` key and MUST survive, so a
    // passing test cannot be satisfied by a filter that simply drops everything.
    await fs.writeFile(join(directory, 'demo-real.md'), [
      '---',
      'title: Demo — real product work',
      'slug: demo-real',
      'status: shipped',
      '---',
      '',
      '## Now',
      '',
    ].join('\n'), 'utf8');
    // A real plan that merely DISCUSSES templates in its body must not be dropped.
    await fs.writeFile(join(directory, 'demo-prose.md'), [
      '---',
      'title: Demo — mentions templates in prose',
      'slug: demo-prose',
      '---',
      '',
      'We considered whether template: rubric should gate this.',
      '',
    ].join('\n'), 'utf8');

    const plans = await loadProjectHistoryPlansFromExport(directory, [], null);

    assert.deepEqual(plans.map((plan) => plan.filePath), ['demo-prose.md', 'demo-real.md']);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('template-carrier detection keys on frontmatter, not body prose', () => {
  assert.equal(isTemplateCarrierPlan('---\nslug: a\ntemplate: rubric\n---\n\nbody\n'), true);
  assert.equal(isTemplateCarrierPlan('---\nslug: a\n---\n\ntemplate: rubric\n'), false);
  assert.equal(isTemplateCarrierPlan('---\nslug: a\ntemplate:\n---\n\nbody\n'), false);
  assert.equal(isTemplateCarrierPlan('no frontmatter at all\n'), false);
});

test('marker-referenced work item exports stay within the public 2,000-id schema ceiling', () => {
  const ids = Array.from({ length: WORK_ITEMS_EXPORT_IDS_BATCH_SIZE + 1 }, (_, index) => `WI-${index + 1}`);
  const batches: string[][] = [];

  const written = exportWorkItemsByIdBatches([...ids, ids[0]!], (batch) => {
    batches.push([...batch]);
    return batch.length;
  });

  assert.equal(written, ids.length);
  assert.deepEqual(batches.map((batch) => batch.length), [WORK_ITEMS_EXPORT_IDS_BATCH_SIZE, 1]);
  assert.deepEqual(batches.flat(), ids, 'deduplicated marker ids retain their first-seen order');
  assert.ok(batches.every((batch) => batch.length <= WORK_ITEMS_EXPORT_IDS_BATCH_SIZE));
});

test('marker-referenced export skips rows already materialized by the harness export', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'project-history-missing-id-export-'));
  try {
    await Promise.all([
      fs.writeFile(join(directory, 'WI-2.json'), '{"id":"WI-2"}\n', 'utf8'),
      // A same-named directory is not a materialized row and must not suppress
      // the ID export for WI-3.
      fs.mkdir(join(directory, 'WI-3.json')),
    ]);
    const batches: string[][] = [];

    const written = await exportMissingWorkItemsByIdBatches(
      directory,
      ['WI-1', 'WI-2', 'WI-3', 'WI-1', 'WI-4'],
      (batch) => {
        batches.push([...batch]);
        return batch.length;
      },
    );

    assert.equal(written, 3);
    assert.deepEqual(batches, [['WI-1', 'WI-3', 'WI-4']]);
  } finally {
    await removeProjectHistoryExportDirectory(directory);
  }
});

test('large temporary exports retry transient ENOTEMPTY removal races', async () => {
  const calls: Array<{ directory: string; options: Record<string, unknown> }> = [];

  await removeProjectHistoryExportDirectory('/tmp/project-history-export', async (directory, options) => {
    calls.push({ directory, options });
  });

  assert.deepEqual(calls, [{
    directory: '/tmp/project-history-export',
    options: { recursive: true, force: true, maxRetries: 5, retryDelay: 20 },
  }]);
});

test('large exported work-item reads use bounded parallelism and preserve every row', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'project-history-read-batches-'));
  const count = PROJECT_HISTORY_FILE_READ_CONCURRENCY * 2 + 1;
  const names = Array.from({ length: count }, (_, index) => `WI-${index + 1}.json`);
  await Promise.all(names.map((name) => fs.writeFile(join(directory, name), '', 'utf8')));
  let active = 0;
  let maxActive = 0;

  try {
    const { items } = await readExportedWorkItems(directory, async (file, encoding) => {
      active++;
      maxActive = Math.max(maxActive, active);
      assert.equal(encoding, 'utf8');
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      const id = file.split('/').at(-1)!.replace(/\.json$/, '');
      return JSON.stringify({ id, title: id, kind: 'change', state: 'done' });
    });

    assert.equal(items.length, count);
    assert.equal(new Set(items.map((item) => item.id)).size, count);
    assert.equal(maxActive, PROJECT_HISTORY_FILE_READ_CONCURRENCY);
  } finally {
    await removeProjectHistoryExportDirectory(directory);
  }
});

// REPLACES 'work-item ledger reads stay in timeout-resistant batches', which asserted
// the 25-id chunking and passed for the entire life of WI-39831 — while every one of
// those batches returned zero rows. The batches were not too slow, they were too BIG
// for the result projector, so the test certified the exact mechanism that was broken.
// What actually needed guarding is that a TRUNCATED payload is never read as an EMPTY
// one; that is what these two tests pin.
test('a bounded-payload projection envelope is REFUSED, never read as "no work items"', () => {
  // Verbatim shape observed from `ptool tools:invoke { work_items:get }` on 2026-08-18:
  // past the transport budget the projector drops `results` entirely and substitutes a
  // summary string plus a `_projection` report.
  const truncated = {
    summary: '[payload preview omitted: serialized projection exceeded transport budget]',
    _projection: {
      kind: 'bounded-payload',
      truncated: true,
      tier: 'trimmed',
      forced: true,
      originalChars: 14904,
      returnedChars: 2673,
      omittedCount: 13,
      omitted: [
        { path: '$.results[0].workItem.terminalCompletionEvidence.filesChanged', reason: 'nested value omitted at projection depth limit' },
        { path: '$.results[0].workItem.payload._completionEvidence', reason: 'nested value omitted at projection depth limit' },
      ],
    },
  };

  assert.throws(
    () => workItemRows(truncated),
    /TRUNCATED by the result projector/,
    'a truncated payload must fail loudly — returning [] here is the WI-39831 defect',
  );

  // The `summary`-only variant (no _projection report) must fail the same way, or the
  // guard is trivially bypassed by a projector that reports less.
  assert.throws(
    () => workItemRows({ summary: 'anything' }),
    /TRUNCATED by the result projector/,
  );
});

test('the PRE-FIX implementation is kept as a control and demonstrably swallows the same envelope', () => {
  // A guard test that has never failed is a guard nobody has tested. Rather than mutate
  // the shared tree to prove falsifiability (unsafe here — git-sync sweeps it mid-probe),
  // the defective implementation lives on permanently as a control, per the repo's
  // "keep a deliberately-wrong implementation in the test file" rule.
  //
  // This is verbatim what workItemRows did before WI-39831: no envelope check.
  const legacyWorkItemRows = (payload: unknown): unknown[] => {
    const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null;
    const results = Array.isArray(root?.results) ? root.results as Record<string, unknown>[] : [];
    return results
      .map((row) => (row.workItem && typeof row.workItem === 'object' ? row.workItem : null))
      .filter((row) => row !== null);
  };

  const truncated = {
    summary: '[payload preview omitted: serialized projection exceeded transport budget]',
    _projection: { kind: 'bounded-payload', truncated: true, omittedCount: 13 },
  };

  // The control returns a clean, plausible, WRONG empty array — indistinguishable from
  // a project with no completed work. This is the whole defect in one assertion.
  assert.deepEqual(legacyWorkItemRows(truncated), [], 'control must reproduce the silent zero');
  // And the shipped implementation must NOT agree with it.
  assert.throws(() => workItemRows(truncated), /TRUNCATED by the result projector/);

  // Calibration: on a well-formed payload the two agree, so the control is measuring the
  // envelope handling specifically and not merely being broken in general.
  const wellFormed = { results: [{ ok: true, workItem: { id: 'WI-1', title: 'a' } }] };
  assert.deepEqual(legacyWorkItemRows(wellFormed), workItemRows(wellFormed));
});

test('a genuinely empty result set is still an empty array, not a throw', () => {
  // The guard must distinguish "did not fit" from "nothing matched" — collapsing those
  // two is the whole bug, in either direction.
  assert.deepEqual(workItemRows({ results: [], counts: { ok: 0, failed: 0 } }), []);
  assert.deepEqual(
    workItemRows({ results: [{ ok: true, id: 'WI-1', workItem: { id: 'WI-1', title: 'a' } }] }),
    [{ id: 'WI-1', title: 'a' }],
  );
});

test('repository metadata converts common GitHub remotes without guessing other hosts', () => {
  assert.equal(githubWebUrl('git@github.com:Papercusp/sidestage.git'), 'https://github.com/Papercusp/sidestage');
  assert.equal(githubWebUrl('ssh://git@github.com/Papercusp/sidestage.git'), 'https://github.com/Papercusp/sidestage');
  assert.equal(githubWebUrl('ssh://git@example.test/Papercusp/sidestage.git'), null);
  assert.deepEqual(repositoryFromRemote('git@example.test:repo.git', null, 'main'), {
    provider: 'git',
    url: 'git@example.test:repo.git',
    webUrl: null,
    defaultBranch: 'main',
  });
});

test('git records preserve files and distinguish trailers from body references', () => {
  const raw = [
    ['abc1234', 'feat: one', '2026-08-15T00:00:00Z', 'Build WI-2\n\nPapercusp-Work-Item: WI-1\n', '\nsrc/z.ts\nsrc/a.ts\nsrc/z.ts\n'],
    ['def5678', 'chore: unrelated', '2026-08-14T00:00:00Z', 'No work item here', '\nREADME.md\n'],
  ].map((fields) => `\u001e${fields.join('\0')}`).join('');
  const commits = parseGitLog(raw);
  assert.deepEqual(commits[0]?.files, ['src/a.ts', 'src/z.ts']);

  const linked = commitsForWorkItems(commits, ['WI-1', 'WI-2'], new Set(['abc1234']));
  assert.equal(linked.length, 1);
  assert.equal(linked[0]?.remoteStatus, 'confirmed');
  assert.deepEqual(linked[0]?.links, [
    { workItemId: 'WI-1', attribution: 'authoritative' },
    { workItemId: 'WI-2', attribution: 'body-reference' },
  ]);
});

test('TypeScript rendering is a stable generated module', () => {
  const document = {
    schemaVersion: 2,
    project: { id: 'demo', name: 'Demo', repository: null },
    source: {
      kind: 'papercusp-plan-export',
      workspace: 'workspace',
      harness: 'demo',
      planPrefix: 'demo-',
      generatedAt: '2026-08-15T00:00:00.000Z',
      planCount: 0,
      generator: 'test',
    },
    plans: [],
  } satisfies ProjectHistoryDocument;

  const rendered = renderProjectHistory(document, 'typescript', 'DEMO_HISTORY');
  assert.match(rendered, /export const DEMO_HISTORY = \{/);
  assert.match(rendered, /"schemaVersion": 2/);
  assert.ok(rendered.endsWith('as const;\n'));
});

test('check freshness ignores generatedAt drift but detects content drift', () => {
  const document = {
    schemaVersion: 2,
    project: { id: 'demo', name: 'Demo', repository: null },
    source: {
      kind: 'papercusp-plan-export',
      workspace: 'workspace',
      harness: 'demo',
      planPrefix: 'demo-',
      generatedAt: '2026-08-15T00:00:00.000Z',
      planCount: 0,
      generator: 'papercusp project-history generate',
    },
    plans: [],
  } satisfies ProjectHistoryDocument;
  const current = renderProjectHistory(document, 'typescript', 'DEMO_HISTORY');
  const later = renderProjectHistory({
    ...document,
    source: { ...document.source, generatedAt: '2026-08-15T01:00:00.000Z' },
  }, 'typescript', 'DEMO_HISTORY');
  const changed = renderProjectHistory({
    ...document,
    project: { ...document.project, name: 'Changed' },
  }, 'typescript', 'DEMO_HISTORY');

  assert.equal(projectHistoryOutputIsCurrent(current, later, 'typescript'), true);
  assert.equal(projectHistoryOutputIsCurrent(current, changed, 'typescript'), false);
});
