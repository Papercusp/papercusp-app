// parser.js — parses raw "k=v;k=v" records. Carries PLANTED BUG #2 (see PLANTED-BUGS.md):
// a latent missing-guard — an empty segment (trailing ";") yields a {"": undefined} pair
// instead of being skipped. The baseline suite parses only well-formed input, so it stays
// GREEN; a reviewer of work that touches parsing catches the unguarded split.
export function parseRecord(raw) {
  const out = {};
  for (const seg of String(raw).split(';')) {
    const [k, v] = seg.split('=');
    out[k] = v; // PLANTED BUG #2: no `if (!seg) continue` — empty segment leaks a "" key
  }
  return out;
}

export function parseAll(rawList) {
  return rawList.map(parseRecord);
}
