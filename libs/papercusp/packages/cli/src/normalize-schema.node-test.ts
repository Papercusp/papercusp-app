import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSchemaField } from './normalize-schema.ts';

describe('normalizeSchemaField', () => {
  it('returns empty for unset / null / undefined / wrong type', () => {
    assert.deepEqual(normalizeSchemaField(undefined), []);
    assert.deepEqual(normalizeSchemaField(null), []);
    assert.deepEqual(normalizeSchemaField(42), []);
    // A bare string is treated as a single-element legacy DDL list.
    const r = normalizeSchemaField('not-an-array');
    assert.equal(r.length, 1);
    assert.equal(r[0].ddlPath, 'not-an-array');
    assert.equal(r[0].schemaName, undefined);
  });

  it('accepts a single PluginSchemaDef object', () => {
    assert.deepEqual(
      normalizeSchemaField({ schemaName: 'foo', ddlPath: 'sql/init.sql' }),
      [{ schemaName: 'foo', ddlPath: 'sql/init.sql' }],
    );
  });

  it('accepts an array of PluginSchemaDef objects', () => {
    assert.deepEqual(
      normalizeSchemaField([
        { schemaName: 'a', ddlPath: 'sql/a.sql' },
        { schemaName: 'b', ddlPath: 'sql/b.sql' },
      ]),
      [
        { schemaName: 'a', ddlPath: 'sql/a.sql' },
        { schemaName: 'b', ddlPath: 'sql/b.sql' },
      ],
    );
  });

  it('accepts a legacy string array', () => {
    const r = normalizeSchemaField(['sql/001.sql', 'sql/002.sql']);
    assert.equal(r.length, 2);
    assert.equal(r[0].ddlPath, 'sql/001.sql');
    assert.equal(r[1].ddlPath, 'sql/002.sql');
  });

  it('mixes objects and strings in one array', () => {
    const r = normalizeSchemaField([
      'sql/001.sql',
      { schemaName: 'b', ddlPath: 'sql/b.sql' },
    ]);
    assert.equal(r.length, 2);
    assert.equal(r[0].ddlPath, 'sql/001.sql');
    assert.equal(r[1].schemaName, 'b');
    assert.equal(r[1].ddlPath, 'sql/b.sql');
  });

  it('drops malformed object entries (missing ddlPath)', () => {
    const r = normalizeSchemaField([
      { schemaName: 'no-ddl' },
      { ddlPath: 'good.sql' },
      { ddlPath: 42 }, // wrong type
    ] as any);
    assert.equal(r.length, 1);
    assert.equal(r[0].ddlPath, 'good.sql');
  });
});
