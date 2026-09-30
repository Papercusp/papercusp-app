/**
 * Tests for plugin-cli.ts CI surfaces (--accept-defaults, --set, list).
 * Interactive prompt flows are not unit-tested — the smoke matrix covers them.
 *
 * Run: cd libs/papercusp/packages/cli && npx tsx --test src/plugin-cli.test.ts
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cmdPluginEnable, cmdPluginDisable, cmdPluginConfig, cmdPluginRename } from './plugin-cli.ts';

import { papercuspRoot, _resetPapercuspRootForTests } from './papercusp-root.ts';

// EI-214: run the WHOLE suite against an isolated PAPERCUSP_HOME. Fixtures
// previously went into the user's real global-plugins and relied on after()
// for cleanup — a killed run leaked them, and every pipeline finalize then
// fired the broken fixtures' hooks. With a /tmp root, debris can never land
// in the real dir no matter how the process dies. (plugin-cli.ts resolves its
// dirs lazily for exactly this reason — keep it that way.)
process.env.PAPERCUSP_HOME = mkdtempSync(join(tmpdir(), 'pcli-root-'));
_resetPapercuspRootForTests();

const HARNESS = `plugin-cli-test-${process.pid}`;
const SLUG = `pcli-fixture-${process.pid}`;
const ROOT = papercuspRoot();
const HARNESS_DIR = join(ROOT, 'harnesses', HARNESS);
const PLUGIN_DIR = join(ROOT, 'global-plugins', SLUG);
const ENABLED_PATH = join(HARNESS_DIR, 'enabled-plugins.json');
const CONFIG_PATH = join(HARNESS_DIR, 'plugin-configs', `${SLUG}.json`);

before(async () => {
  await fs.mkdir(PLUGIN_DIR, { recursive: true });
  await fs.writeFile(
    join(PLUGIN_DIR, 'papercusp.json'),
    JSON.stringify(
      {
        name: SLUG,
        version: '0.1.0',
        kind: 'plugin',
        description: 'pcli test fixture',
        configSchema: {
          type: 'object',
          required: ['accountId'],
          properties: {
            accountId: { type: 'string', default: 'acct-default' },
            verbose: { type: 'boolean', default: false },
            maxRetries: { type: 'integer', minimum: 0, maximum: 10, default: 3 },
          },
        },
        defaultConfig: { accountId: 'acct-default', verbose: false, maxRetries: 3 },
      },
      null,
      2,
    ),
  );
});

after(async () => {
  // Belt-and-braces: the whole isolated root is /tmp debris — remove it all.
  await fs.rm(ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(HARNESS_DIR, { recursive: true, force: true });
});

describe('cmdPluginEnable --accept-defaults', () => {
  it('writes config from defaults and registers in enabled-plugins.json', async () => {
    await cmdPluginEnable([SLUG, '--harness', HARNESS, '--accept-defaults']);
    const enabled = JSON.parse(await fs.readFile(ENABLED_PATH, 'utf8'));
    assert.equal(enabled.enabled[SLUG].version, '0.1.0');
    assert.match(enabled.enabled[SLUG].configHash, /^sha256-/);
    const cfg = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
    // pruneSchemaDefaults (c31829b) strips values equal to the schema default
    // before persisting — an all-defaults config serializes as {} and the
    // runtime re-derives the defaults from the schema. (The old full-object
    // expectation went stale unnoticed because this node:test file sits
    // outside the Vitest gate.)
    assert.deepEqual(cfg, {});
  });

  it('exits non-zero for an unknown plugin slug', async () => {
    const exit = process.exit;
    let exitCode: number | null = null;
    (process as { exit: typeof process.exit }).exit = ((c?: number) => {
      exitCode = c ?? 0;
      throw new Error('process.exit-stub');
    }) as typeof process.exit;
    try {
      await assert.rejects(
        () => cmdPluginEnable(['definitely-not-installed', '--harness', HARNESS, '--accept-defaults']),
      );
      assert.equal(exitCode, 1);
    } finally {
      (process as { exit: typeof process.exit }).exit = exit;
    }
  });
});

describe('cmdPluginDisable', () => {
  it('removes the entry but preserves config on disk', async () => {
    await cmdPluginEnable([SLUG, '--harness', HARNESS, '--accept-defaults']);
    await cmdPluginDisable([SLUG, '--harness', HARNESS]);
    const enabled = JSON.parse(await fs.readFile(ENABLED_PATH, 'utf8'));
    assert.equal(enabled.enabled[SLUG], undefined);
    assert.equal(existsSync(CONFIG_PATH), true);
  });

  it('is a no-op when not enabled', async () => {
    await fs.mkdir(HARNESS_DIR, { recursive: true });
    await fs.writeFile(ENABLED_PATH, JSON.stringify({ enabled: {} }));
    await cmdPluginDisable(['not-enabled', '--harness', HARNESS]);
    const enabled = JSON.parse(await fs.readFile(ENABLED_PATH, 'utf8'));
    assert.deepEqual(enabled.enabled, {});
  });
});

describe('cmdPluginRename', () => {
  const OLD = `pcli-rename-old-${process.pid}`;
  const NEW = `pcli-rename-new-${process.pid}`;
  const OLD_DIR = join(ROOT, 'global-plugins', OLD);
  const NEW_DIR = join(ROOT, 'global-plugins', NEW);
  const RENAME_HARNESS = `pcli-rename-harness-${process.pid}`;
  const RENAME_HARNESS_DIR = join(ROOT, 'harnesses', RENAME_HARNESS);
  const GRANTS_PATH = join(ROOT, 'granted-capabilities.json');

  before(async () => {
    await fs.mkdir(OLD_DIR, { recursive: true });
    await fs.writeFile(
      join(OLD_DIR, 'papercusp.json'),
      JSON.stringify({ name: OLD, version: '0.0.1', kind: 'plugin' }),
    );
  });

  after(async () => {
    await fs.rm(OLD_DIR, { recursive: true, force: true });
    await fs.rm(NEW_DIR, { recursive: true, force: true });
    await fs.rm(RENAME_HARNESS_DIR, { recursive: true, force: true });
    // Strip any test grant keys we may have left behind.
    if (existsSync(GRANTS_PATH)) {
      const data = JSON.parse(await fs.readFile(GRANTS_PATH, 'utf8'));
      const grants = data.grants ?? {};
      for (const k of Object.keys(grants)) {
        if (k.startsWith(OLD) || k.startsWith(NEW)) delete grants[k];
      }
      data.grants = grants;
      await fs.writeFile(GRANTS_PATH, JSON.stringify(data, null, 2));
    }
  });

  beforeEach(async () => {
    // Reset every iteration: re-create OLD dir, drop NEW, drop harness state, drop test grant keys.
    await fs.rm(NEW_DIR, { recursive: true, force: true });
    await fs.rm(RENAME_HARNESS_DIR, { recursive: true, force: true });
    if (!existsSync(OLD_DIR)) {
      await fs.mkdir(OLD_DIR, { recursive: true });
      await fs.writeFile(
        join(OLD_DIR, 'papercusp.json'),
        JSON.stringify({ name: OLD, version: '0.0.1', kind: 'plugin' }),
      );
    }
    if (existsSync(GRANTS_PATH)) {
      const data = JSON.parse(await fs.readFile(GRANTS_PATH, 'utf8'));
      const grants = data.grants ?? {};
      for (const k of Object.keys(grants)) {
        if (k.startsWith(OLD) || k.startsWith(NEW)) delete grants[k];
      }
      data.grants = grants;
      await fs.writeFile(GRANTS_PATH, JSON.stringify(data, null, 2));
    }
  });

  it('moves the global-plugins dir + migrates per-harness state', async () => {
    await fs.mkdir(join(RENAME_HARNESS_DIR, 'plugin-configs'), { recursive: true });
    await fs.mkdir(join(RENAME_HARNESS_DIR, 'plugin-data', OLD), { recursive: true });
    await fs.writeFile(
      join(RENAME_HARNESS_DIR, 'enabled-plugins.json'),
      JSON.stringify({ enabled: { [OLD]: { version: '0.0.1', enabledAt: 'x', configHash: 'sha256-x' } } }),
    );
    await fs.writeFile(
      join(RENAME_HARNESS_DIR, 'plugin-configs', `${OLD}.json`),
      JSON.stringify({ k: 'v' }),
    );
    await fs.writeFile(
      join(RENAME_HARNESS_DIR, 'plugin-data', OLD, 'runtime.json'),
      JSON.stringify({ runtime: 'old' }),
    );

    await cmdPluginRename([OLD, NEW]);

    assert.equal(existsSync(OLD_DIR), false, 'old dir gone');
    assert.equal(existsSync(NEW_DIR), true, 'new dir created');
    assert.equal(existsSync(join(RENAME_HARNESS_DIR, 'plugin-configs', `${OLD}.json`)), false);
    assert.equal(existsSync(join(RENAME_HARNESS_DIR, 'plugin-configs', `${NEW}.json`)), true);
    assert.equal(existsSync(join(RENAME_HARNESS_DIR, 'plugin-data', OLD)), false);
    assert.equal(existsSync(join(RENAME_HARNESS_DIR, 'plugin-data', NEW)), true);
    const enabled = JSON.parse(
      await fs.readFile(join(RENAME_HARNESS_DIR, 'enabled-plugins.json'), 'utf8'),
    );
    assert.equal(enabled.enabled[NEW]?.version, '0.0.1');
    assert.equal(enabled.enabled[OLD], undefined);
  });

  it('rewrites granted-capabilities keys keyed by old slug', async () => {
    const baseGrants = existsSync(GRANTS_PATH)
      ? JSON.parse(await fs.readFile(GRANTS_PATH, 'utf8'))
      : { grants: {} };
    baseGrants.grants ??= {};
    baseGrants.grants[`${OLD}:harnessA:tasks:read`] = { grantedAt: 'x' };
    baseGrants.grants[`${OLD}@0.0.1:harnessB:secrets:read:FOO`] = { grantedAt: 'x' };
    baseGrants.grants['unrelated-plugin:harnessA:tasks:read'] = { grantedAt: 'x' };
    await fs.writeFile(GRANTS_PATH, JSON.stringify(baseGrants, null, 2));

    await cmdPluginRename([OLD, NEW]);

    const grants = JSON.parse(await fs.readFile(GRANTS_PATH, 'utf8')).grants;
    assert.equal(grants[`${OLD}:harnessA:tasks:read`], undefined);
    assert.equal(grants[`${OLD}@0.0.1:harnessB:secrets:read:FOO`], undefined);
    assert.ok(grants[`${NEW}:harnessA:tasks:read`], 'first renamed grant present');
    assert.ok(grants[`${NEW}@0.0.1:harnessB:secrets:read:FOO`], 'versioned renamed grant present');
    assert.ok(grants['unrelated-plugin:harnessA:tasks:read'], 'unrelated grant preserved');
  });

  it('rejects when old slug does not exist', async () => {
    const exit = process.exit;
    let exitCode: number | null = null;
    (process as { exit: typeof process.exit }).exit = ((c?: number) => {
      exitCode = c ?? 0;
      throw new Error('process.exit-stub');
    }) as typeof process.exit;
    try {
      await assert.rejects(() => cmdPluginRename(['definitely-not-installed', NEW]));
      assert.equal(exitCode, 1);
    } finally {
      (process as { exit: typeof process.exit }).exit = exit;
    }
  });

  it('rejects when new slug already exists', async () => {
    await fs.mkdir(NEW_DIR, { recursive: true });
    await fs.writeFile(join(NEW_DIR, 'papercusp.json'), '{}');
    const exit = process.exit;
    let exitCode: number | null = null;
    (process as { exit: typeof process.exit }).exit = ((c?: number) => {
      exitCode = c ?? 0;
      throw new Error('process.exit-stub');
    }) as typeof process.exit;
    try {
      await assert.rejects(() => cmdPluginRename([OLD, NEW]));
      assert.equal(exitCode, 1);
    } finally {
      (process as { exit: typeof process.exit }).exit = exit;
    }
  });

  it('rejects when old and new are the same', async () => {
    const exit = process.exit;
    let exitCode: number | null = null;
    (process as { exit: typeof process.exit }).exit = ((c?: number) => {
      exitCode = c ?? 0;
      throw new Error('process.exit-stub');
    }) as typeof process.exit;
    try {
      await assert.rejects(() => cmdPluginRename([OLD, OLD]));
      assert.equal(exitCode, 1);
    } finally {
      (process as { exit: typeof process.exit }).exit = exit;
    }
  });
});

describe('cmdPluginConfig --set', () => {
  it('updates config keys and re-hashes', async () => {
    await cmdPluginEnable([SLUG, '--harness', HARNESS, '--accept-defaults']);
    const before = JSON.parse(await fs.readFile(ENABLED_PATH, 'utf8')).enabled[SLUG].configHash;
    await cmdPluginConfig([SLUG, '--harness', HARNESS, '--set', 'accountId=acct-prod', '--set', 'verbose=true', '--set', 'maxRetries=7']);
    const cfg = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
    assert.deepEqual(cfg, { accountId: 'acct-prod', verbose: true, maxRetries: 7 });
    const after = JSON.parse(await fs.readFile(ENABLED_PATH, 'utf8')).enabled[SLUG].configHash;
    assert.notEqual(before, after);
  });

  it('coerces booleans + numbers correctly', async () => {
    await cmdPluginEnable([SLUG, '--harness', HARNESS, '--accept-defaults']);
    await cmdPluginConfig([SLUG, '--harness', HARNESS, '--set', 'maxRetries=42', '--set', 'verbose=false']);
    const cfg = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
    assert.equal(cfg.maxRetries, 42);
    assert.equal(cfg.verbose, false);
  });

  it('supports dotted keys for nested config', async () => {
    await cmdPluginEnable([SLUG, '--harness', HARNESS, '--accept-defaults']);
    await cmdPluginConfig([SLUG, '--harness', HARNESS, '--set', 'nested.key.path=hello']);
    const cfg = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
    assert.equal((cfg.nested as { key: { path: string } }).key.path, 'hello');
  });
});
