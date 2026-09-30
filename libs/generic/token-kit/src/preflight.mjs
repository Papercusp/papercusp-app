// Preflight checks for token sources (run before Style Dictionary).
// Generic — no Restart-specific values; extractable to the shared kit.
//   1. zero-token source file (Style Dictionary refuses to emit anything)
//   2. tree-merge collision (a token with both $value and child tokens)
//   3. $schema/_meta duplicated across source files
import { readFileSync } from 'node:fs';

function hasTokens(node) {
  if (!node || typeof node !== 'object') return false;
  if ('$value' in node) return true;
  return Object.keys(node).some((k) => !k.startsWith('$') && !k.startsWith('_') && hasTokens(node[k]));
}
function walk(node, parts, out) {
  if (!node || typeof node !== 'object') return;
  if ('$value' in node) {
    out.push({ path: parts.join('.'), hasChildren: Object.keys(node).some((k) => !k.startsWith('$') && !k.startsWith('_')) });
  }
  for (const k of Object.keys(node)) {
    if (k.startsWith('$') || k.startsWith('_')) continue;
    walk(node[k], [...parts, k], out);
  }
}

export function preflight(sourceFiles) {
  const errors = [];
  const seenRoot = new Map();
  for (const f of sourceFiles) {
    let json;
    try { json = JSON.parse(readFileSync(f, 'utf8')); }
    catch (e) { errors.push(`${f}: invalid JSON — ${e.message}`); continue; }

    if (!hasTokens(json)) { errors.push(`${f}: zero tokens — Style Dictionary will emit nothing. Add a token or delete the file.`); continue; }

    const toks = [];
    walk(json, [], toks);
    for (const t of toks) if (t.hasChildren) errors.push(`${f}: "${t.path}" has both $value and child tokens — SD silently skips transforms here. Rename one side.`);

    for (const k of Object.keys(json)) {
      if (k === '$schema' || k.startsWith('_')) {
        const prev = seenRoot.get(k);
        if (prev && prev !== f) errors.push(`${f}: root key "${k}" also in ${prev}. Keep it in one source file only.`);
        else seenRoot.set(k, f);
      }
    }
  }
  if (errors.length) {
    console.error('✗ design-tokens preflight failed:');
    for (const e of errors) console.error('  ' + e);
    process.exit(1);
  }
  console.log(`✓ preflight clean (${sourceFiles.length} source files)`);
}
