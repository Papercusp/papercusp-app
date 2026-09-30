import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scanSource, manifestCovers, buildReport } from './plugin-doctor.ts';

function expect(actual: unknown) {
  return {
    toBe(expected: unknown) {
      assert.equal(actual, expected);
    },
    toEqual(expected: unknown) {
      assert.deepEqual(actual, expected);
    },
    toContain(expected: unknown) {
      if (Array.isArray(actual)) {
        assert.ok(actual.includes(expected));
        return;
      }
      if (typeof actual !== 'string') throw new TypeError('expected a string');
      assert.ok(actual.includes(String(expected)));
    },
    toBeTruthy() {
      assert.ok(actual);
    },
  };
}

describe('scanSource', () => {
  it('detects ctx.spawn literal binaries', () => {
    const { found } = scanSource('a.ts', `
      await ctx.spawn('git', ['status']);
      await ctx.spawn("ffmpeg", ['-i', 'a.mp4']);
    `);
    expect(found.map((f) => f.cap)).toEqual(['compute:exec:git', 'compute:exec:ffmpeg']);
  });

  it('detects ctx.fetch hostnames from absolute URLs', () => {
    const { found } = scanSource('a.ts', `
      await ctx.fetch('https://api.github.com/repos');
      await ctx.fetch('http://api.foo.com/v1');
    `);
    expect(found.map((f) => f.cap)).toEqual(['http:fetch:api.github.com', 'http:fetch:api.foo.com']);
  });

  it('detects ctx.secrets.read and ctx.secrets?.read', () => {
    const { found } = scanSource('a.ts', `
      const a = ctx.secrets.read('GH_TOKEN');
      const b = ctx.secrets?.read('OPENAI_API_KEY');
    `);
    expect(found.map((f) => f.cap)).toEqual([
      'secrets:read:GH_TOKEN',
      'secrets:read:OPENAI_API_KEY',
    ]);
  });

  it('detects ctx.hookBus.emit and ctx.hookBus.on', () => {
    const { found } = scanSource('a.ts', `
      ctx.hookBus.emit('mytool.done', { x: 1 });
      ctx.hookBus.on('task.completed', () => {});
    `);
    expect(found.map((f) => f.cap)).toEqual([
      'events:emit:mytool.done',
      'events:listen:task.completed',
    ]);
  });

  it('flags dynamic ctx.spawn as unverified', () => {
    const { found, unverified } = scanSource('a.ts', `
      const bin = 'git';
      await ctx.spawn(bin, []);
    `);
    expect(found).toEqual([]);
    expect(unverified[0].cap).toBe('ctx.spawn(<dynamic>)');
  });

  it('flags template-literal ctx.fetch as unverified', () => {
    const { unverified } = scanSource('a.ts', 'await ctx.fetch(`https://${host}/x`);');
    expect(unverified.find((u) => u.cap.includes('template-literal'))).toBeTruthy();
  });

  it('records line numbers in `where`', () => {
    const { found } = scanSource('a.ts', `line 1\nawait ctx.spawn('git');\n`);
    expect(found[0].where).toBe('a.ts:2');
  });

  it('follows `const spawn = ctx.spawn` aliases', () => {
    const { found } = scanSource('a.ts', `
      const spawn = ctx.spawn;
      if (!spawn) return;
      await spawn('git', ['status']);
    `);
    expect(found.map((f) => f.cap)).toContain('compute:exec:git');
  });

  it('follows destructured `const { spawn } = ctx` aliases', () => {
    const { found } = scanSource('a.ts', `
      const { spawn } = ctx;
      await spawn('ffmpeg', []);
    `);
    expect(found.map((f) => f.cap)).toContain('compute:exec:ffmpeg');
  });
});

describe('manifestCovers', () => {
  it('exact match', () => {
    expect(manifestCovers('compute:exec:git', 'compute:exec:git')).toBe(true);
  });

  it('subdomain wildcard', () => {
    expect(manifestCovers('http:fetch:*.googleapis.com', 'http:fetch:api.googleapis.com')).toBe(true);
    expect(manifestCovers('http:fetch:*.googleapis.com', 'http:fetch:googleapis.com')).toBe(false);
    expect(manifestCovers('http:fetch:*.googleapis.com', 'http:fetch:api.evil.com')).toBe(false);
  });

  it('prefix wildcard', () => {
    expect(manifestCovers('secrets:read:YT_*', 'secrets:read:YT_API_KEY')).toBe(true);
    expect(manifestCovers('secrets:read:YT_*', 'secrets:read:YT_')).toBe(false);
    expect(manifestCovers('secrets:read:YT_*', 'secrets:read:GH_TOKEN')).toBe(false);
  });

  it('rejects bare-* per @plugin contract', () => {
    expect(manifestCovers('compute:exec:*', 'compute:exec:git')).toBe(false);
  });

  it('mismatched prefix never covers', () => {
    expect(manifestCovers('http:fetch:api.foo.com', 'compute:exec:api.foo.com')).toBe(false);
  });
});

describe('buildReport', () => {
  const where = (cap: string) => ({ cap, where: 'a.ts:1' });

  it('flags used-but-undeclared as missing', () => {
    const r = buildReport(
      ['compute:exec:git'],
      [where('compute:exec:git'), where('compute:exec:ffmpeg')],
      [],
    );
    expect(r.missing.map((f) => f.cap)).toEqual(['compute:exec:ffmpeg']);
    expect(r.unused).toEqual([]);
  });

  it('flags declared-but-unused as unused', () => {
    const r = buildReport(['compute:exec:git', 'compute:exec:ffmpeg'], [where('compute:exec:git')], []);
    expect(r.missing).toEqual([]);
    expect(r.unused).toEqual(['compute:exec:ffmpeg']);
  });

  it('skips non-source-detectable namespaces from unused check', () => {
    const r = buildReport(
      ['ui:dashboard-tab', 'roles:register:narrator', 'tasks:read', 'compute:exec:git'],
      [where('compute:exec:git')],
      [],
    );
    expect(r.unused).toEqual([]);
  });

  it('wildcard-declared cap counts as used when a source cap matches', () => {
    const r = buildReport(
      ['http:fetch:*.googleapis.com'],
      [where('http:fetch:api.googleapis.com')],
      [],
    );
    expect(r.missing).toEqual([]);
    expect(r.unused).toEqual([]);
  });

  it('passes unverified findings through unchanged', () => {
    const u = where('ctx.spawn(<dynamic>)');
    const r = buildReport(['compute:exec:git'], [], [u]);
    expect(r.unverified).toEqual([u]);
  });
});
