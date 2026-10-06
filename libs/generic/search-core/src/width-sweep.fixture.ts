/**
 * A deterministic corpus and embedder for the width-sweep parity test
 * (width-sweep.spec.ts). They are shared by the test and by the harness that
 * captured the test's expected numbers from the pre-move papercusp CLI, so both
 * see exactly the same bytes.
 *
 * Shape of the corpus: every document is ~5,200 characters of prose. The region
 * around characters 2,800-3,600 is dense with words owned by that document, so
 * a probe cut from character 3,000 is findable only when the embedded prefix
 * reaches it. That makes the width sweep's numbers move with the width.
 *
 * The embedder reads at most FIXTURE_WINDOW_CHARS characters, the way a real
 * model truncates at its input window, so widths past the window embed to
 * identical vectors. Query vectors carry a constant positive offset (an
 * asymmetric model's cosine offset), which a rank-based measure must ignore.
 */

/** Characters the fixture embedder reads before it truncates. */
export const FIXTURE_WINDOW_CHARS = 4500;

const DIMS = 96;
const QUERY_OFFSET = 0.35;

const COMMON = [
  'the', 'system', 'agent', 'reads', 'every', 'record', 'before', 'writing', 'a', 'summary',
  'of', 'what', 'changed', 'and', 'why', 'it', 'matters', 'for', 'later', 'work', 'plans',
  'items', 'tests', 'files', 'runs', 'build', 'check', 'value', 'report', 'shows', 'result',
  'gate', 'queue', 'branch', 'commit', 'sweep', 'owner', 'review', 'search', 'index', 'rows',
  'table', 'query', 'vector', 'space', 'model', 'window', 'input', 'output', 'number', 'time',
  'budget', 'target', 'batch', 'label', 'cache', 'store', 'layer', 'path', 'step',
];

const SYLLABLES = [
  'ka', 'lo', 'mir', 'ten', 'vos', 'dra', 'quel', 'bin', 'sor', 'phy', 'nax', 'tur', 'gel',
  'wim', 'zar', 'fen', 'rho', 'cus', 'pli', 'dem', 'yor', 'hask', 'jun', 'ble',
];

/** mulberry32: a small seeded PRNG, so the corpus is identical on every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a, 32-bit. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface FixtureDoc {
  key: string;
  text: string;
}

/**
 * `n` documents, most recent first. Owned words are built from syllables
 * indexed by the document number, so neighbouring documents share some
 * syllables and a probe's true parent competes with real distractors.
 */
export function fixtureCorpus(n = 14): FixtureDoc[] {
  const out: FixtureDoc[] = [];
  for (let d = 0; d < n; d++) {
    const rnd = mulberry32(1000 + d);
    const own = Array.from(
      { length: 12 },
      (_, k) =>
        SYLLABLES[(d * 7 + k * 3) % SYLLABLES.length] +
        SYLLABLES[(d * 5 + k * 11) % SYLLABLES.length] +
        SYLLABLES[(d + k) % SYLLABLES.length],
    );
    let text = '';
    while (text.length < 5200) {
      const pos = text.length;
      const ownRate = pos >= 2800 && pos < 3600 ? 0.35 : 0.06;
      const word =
        rnd() < ownRate ? own[Math.floor(rnd() * own.length)] : COMMON[Math.floor(rnd() * COMMON.length)];
      text += word + (rnd() < 0.08 ? '. ' : ' ');
    }
    out.push({ key: `doc-${String(d).padStart(2, '0')}`, text });
  }
  return out;
}

/** Embed one text: hashed bag of words over the first FIXTURE_WINDOW_CHARS characters. */
export function fixtureEmbedOne(kind: 'document' | 'query', text: string): number[] {
  const v = new Array<number>(DIMS).fill(kind === 'query' ? QUERY_OFFSET : 0);
  const words = text.slice(0, FIXTURE_WINDOW_CHARS).toLowerCase().match(/[a-z]+/g) ?? [];
  for (const w of words) {
    const h = fnv1a(w);
    v[h % DIMS] += 1;
    v[(h >>> 8) % DIMS] += (h & 1) === 0 ? 0.5 : -0.5;
  }
  return v;
}

/** The fixture embedder in the shape the width sweep injects. */
export async function fixtureEmbed(kind: 'document' | 'query', texts: readonly string[]): Promise<number[][]> {
  return texts.map((t) => fixtureEmbedOne(kind, t));
}
