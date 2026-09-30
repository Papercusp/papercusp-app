/**
 * Integration tests for `papercusp init --from <blueprint>` — the E1b
 * blueprint-instantiation path (harness-blueprint-distribution-2026-06-03).
 *
 * Run with:
 *   cd libs/papercusp/packages/cli && npx tsx --test src/init-blueprint.test.ts
 *
 * Each test spawns the real `papercusp init` CLI against an isolated
 * PAPERCUSP_HOME temp root, so it exercises the real composed extends-resolver
 * + resolveAndValidate + thin-child write + dependency validation.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_BIN = join(__dirname, '..', 'bin', 'papercusp');

function runCli(args: string[], env: NodeJS.ProcessEnv): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(CLI_BIN, args, {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('papercusp init --from <blueprint>', () => {
  let home: string;

  before(async () => {
    home = await fs.mkdtemp(join(tmpdir(), 'init-bp-home-'));
  });
  after(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it('instantiates the built-in `coding` blueprint as a thin-child .papercusp/blueprint.yaml', async () => {
    const slug = 'myproj';
    const r = runCli(['init', slug, '--from', 'coding'], { PAPERCUSP_HOME: home });
    assert.equal(r.code, 0, `init failed: ${r.stderr || r.stdout}`);

    const projectDir = join(home, 'projects', slug);
    const bpFile = join(projectDir, '.papercusp', 'blueprint.yaml');
    assert.ok(existsSync(bpFile), 'expected .papercusp/blueprint.yaml to be written');

    // The git-canonical artifact is the THIN child (matches harness:create) —
    // the loader resolves `extends: coding` lazily.
    const parsed = parseYaml(await fs.readFile(bpFile, 'utf8'));
    assert.deepEqual(parsed, { id: slug, extends: 'coding' });

    // SPEC.md is retired (D-002); AGENTS.md conventions stub is seeded.
    assert.ok(!existsSync(join(projectDir, 'SPEC.md')), 'SPEC.md must NOT be written (retired)');
    assert.ok(existsSync(join(projectDir, 'AGENTS.md')), 'AGENTS.md conventions stub expected');
  });

  it('fails UPFRONT with "needs plugin X" when the blueprint declares an absent plugin', async () => {
    // An installed-tier blueprint extending coding that declares a plugin which
    // is neither installed nor installable (marketplace pointed at a dead port).
    const bpDir = join(home, 'blueprints', 'needs-plugin');
    await fs.mkdir(bpDir, { recursive: true });
    await fs.writeFile(
      join(bpDir, 'blueprint.yaml'),
      ['id: needs-plugin', 'extends: coding', 'dependencies:', '  plugins:', '    - bogus-plugin-xyz', ''].join('\n'),
      'utf8',
    );

    const r = runCli(['init', 'proj2', '--from', 'needs-plugin'], {
      PAPERCUSP_HOME: home,
      // Dead marketplace → the auto-install of the absent plugin fails fast.
      PAPERCUSP_MARKETPLACE_URL: 'http://127.0.0.1:1',
      PAPERCUSP_ACCEPT_CAPABILITIES: '1',
    });
    assert.notEqual(r.code, 0, 'init should fail when a declared plugin cannot be installed');
    assert.match(`${r.stderr}${r.stdout}`, /needs plugin bogus-plugin-xyz/);
  });

  it('errors clearly when --from names neither a blueprint nor an installed template', () => {
    const r = runCli(['init', 'proj3', '--from', 'no-such-thing'], { PAPERCUSP_HOME: home });
    assert.notEqual(r.code, 0);
    assert.match(`${r.stderr}${r.stdout}`, /neither a blueprint .* nor an installed template/);
  });
});
