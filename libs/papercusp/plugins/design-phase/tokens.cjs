"use strict";
/**
 * DTCG token store reader for the design-phase plugin.
 *
 * Loaded by index.cjs via require('./tokens'). Kept in a separate file
 * because mixing JS string literals with shell-escape-sensitive
 * characters in the main file caused issues during incremental edits.
 *
 * v0.1 reads design/tokens/base.json from the workspace root. Future
 * versions will scan a directory of files and merge.
 */
const fs = require('node:fs/promises');
const path = require('node:path');

// DTCG metadata keys — defined as constants so we don't write them as
// literal strings everywhere (avoids $-escape friction).
const TYPE_KEY = '$type';
const VALUE_KEY = '$value';
const DESC_KEY = '$description';
const META_PREFIX_CHAR = '$';

async function tryRead(p) {
  try { return await fs.readFile(p, 'utf-8'); }
  catch (e) { if (e && e.code === 'ENOENT') return null; throw e; }
}

async function loadDtcgFile() {
  // Walk up from cwd looking for design/tokens/base.json. The dev
  // server runs from apps/operator/ (1 level deep); the standalone
  // prod build runs from .next/standalone/apps/operator/ (4 levels
  // deep). Fixed-relpath lists missed the prod cwd; this walks up
  // until it hits the repo root or runs out of parents.
  const seeds = [
    process.cwd(),
    __dirname,
  ];
  const seen = new Set();
  for (const seed of seeds) {
    let cur = seed;
    for (let i = 0; i < 12; i++) {
      const candidate = path.resolve(cur, 'design/tokens/base.json');
      if (!seen.has(candidate)) {
        seen.add(candidate);
        const raw = await tryRead(candidate);
        if (raw !== null) {
          try {
            return { source: candidate, doc: JSON.parse(raw) };
          } catch (e) {
            return { source: candidate, error: 'parse: ' + e.message };
          }
        }
      }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  return null;
}

function flattenDtcg(doc, prefix) {
  if (!prefix) prefix = [];
  const out = [];
  if (!doc || typeof doc !== 'object') return out;
  for (const k of Object.keys(doc)) {
    if (k.charAt(0) === META_PREFIX_CHAR) continue; // skip $schema/$description/etc.
    const val = doc[k];
    if (val && typeof val === 'object' && TYPE_KEY in val && VALUE_KEY in val) {
      const id = prefix.concat([k]).join('.');
      out.push({
        id,
        type: val[TYPE_KEY],
        value: val[VALUE_KEY],
        description: val[DESC_KEY] || null,
        group: prefix.join('.') || null,
      });
    } else if (val && typeof val === 'object') {
      const child = flattenDtcg(val, prefix.concat([k]));
      for (const c of child) out.push(c);
    }
  }
  return out;
}

async function loadAllTokens() {
  const r = await loadDtcgFile();
  if (!r) return { source: null, tokens: [], error: null };
  if (r.error) return { source: r.source, tokens: [], error: r.error };
  return { source: r.source, tokens: flattenDtcg(r.doc) };
}

async function listTokens(category) {
  const r = await loadAllTokens();
  let tokens = r.tokens;
  if (typeof category === 'string') {
    const cat = category.toLowerCase();
    tokens = tokens.filter((t) => t.id.toLowerCase().startsWith(cat + '.') || t.type === cat);
  }
  return { source: r.source, error: r.error || null, count: tokens.length, tokens };
}

async function readToken(id) {
  const r = await loadAllTokens();
  return r.tokens.find((t) => t.id === id) || null;
}

module.exports = { loadAllTokens, listTokens, readToken };
