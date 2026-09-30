/**
 * Tests for buildPgUrl — the connection-string builder (env fallbacks + encoding).
 * Run with: node --test src/pg-client.test.ts
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPgUrl } from './pg-client.ts';

function expect(actual: unknown) {
  return {
    toBe(expected: unknown) {
      assert.equal(actual, expected);
    },
    toContain(expected: string) {
      if (typeof actual !== 'string') throw new TypeError('expected a string');
      assert.ok(actual.includes(expected));
    },
  };
}

const PG_ENV = ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of PG_ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of PG_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('buildPgUrl', () => {
  it('uses libpq-style defaults when nothing is provided', () => {
    expect(buildPgUrl()).toBe('postgresql://postgres@localhost:5432/postgres');
  });

  it('honors explicit options', () => {
    expect(buildPgUrl({ host: 'h', port: 6000, user: 'u', password: 'p', database: 'd' })).toBe(
      'postgresql://u:p@h:6000/d',
    );
  });

  it('falls back to PG* env vars', () => {
    process.env.PGHOST = 'env-host';
    process.env.PGPORT = '7000';
    process.env.PGUSER = 'env-user';
    process.env.PGDATABASE = 'env-db';
    expect(buildPgUrl()).toBe('postgresql://env-user@env-host:7000/env-db');
  });

  it('omits the password section when there is no password', () => {
    expect(buildPgUrl({ user: 'solo' })).toBe('postgresql://solo@localhost:5432/postgres');
  });

  it('URL-encodes user, password, and database', () => {
    expect(buildPgUrl({ user: 'a b', password: 'p@ss:/', database: 'd/b' })).toBe(
      'postgresql://a%20b:p%40ss%3A%2F@localhost:5432/d%2Fb',
    );
  });

  it('prefers explicit options over env', () => {
    process.env.PGHOST = 'env-host';
    expect(buildPgUrl({ host: 'opt-host' })).toContain('@opt-host:');
  });
});
