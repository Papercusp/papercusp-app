// ranker.js — scores + orders items. Carries PLANTED BUG #1 (see PLANTED-BUGS.md):
// a latent off-by-one in `topN` — `slice(0, n - 1)` returns n-1 items, not n. The
// baseline suite only checks ordering, never the count for a non-trivial n, so it
// stays GREEN; a careful reviewer/validator of any work touching ranking catches it.
export function scoreItem(item) {
  return (item.weight ?? 1) * (item.signal ?? 0);
}

export function rankItems(items) {
  return [...items].sort((a, b) => scoreItem(b) - scoreItem(a));
}

export function topN(items, n) {
  const ranked = rankItems(items);
  return ranked.slice(0, n - 1); // PLANTED BUG #1: off-by-one — should be slice(0, n)
}
