/**
 * Text normalization + phonemization — ported statement-for-statement from
 * kokoro-js@1.2.1's `dist/kokoro.js` (upstream `m()` and helpers; Apache-2.0,
 * https://github.com/hexgrad/kokoro). Pure text transforms — no transformers
 * dependency, only the tiny `phonemizer` (espeak-ng WASM binding) package.
 */
import type { phonemize as EspeakPhonemize } from 'phonemizer';

/**
 * phonemizer's emscripten build registers PROCESS-WIDE handlers when it is evaluated:
 *
 *   process.on('uncaughtException', (e) => { if (!(e instanceof ExitStatus)) throw e })
 *   process.on('unhandledRejection', (e) => { throw e })
 *
 * Throwing inside an 'uncaughtException' handler makes Node exit with code 7, so while
 * this module was a static import, ANY stray error anywhere in the host process — an
 * aborted request body's ECONNRESET, a forgotten rejection — killed the whole operator,
 * overriding the host's own handlers (WI-10004324: the :3170 host died this way
 * 2026-09-30 10:51 and stayed down 7 minutes). The package is therefore loaded lazily,
 * on first use, and exactly the listeners its evaluation added are removed again.
 */
export const EMSCRIPTEN_PROCESS_HOOKS = ['uncaughtException', 'unhandledRejection'] as const;

/**
 * Run `load` and remove every listener it added to the process-wide crash events.
 * Anything registered before the call is left untouched, so a host's own handlers
 * survive. (A handler some OTHER code registers during the same await window would be
 * removed too; hosts register theirs at boot, long before the first phonemize call.)
 */
export async function importWithoutProcessCrashHooks<T>(load: () => Promise<T>): Promise<T> {
  // The plain EventEmitter view: `process.listeners` is overloaded per event name and
  // rejects a union of names.
  const emitter: NodeJS.EventEmitter = process;
  const before = new Map(EMSCRIPTEN_PROCESS_HOOKS.map((event) => [event, new Set(emitter.listeners(event))]));
  try {
    return await load();
  } finally {
    for (const event of EMSCRIPTEN_PROCESS_HOOKS) {
      const kept = before.get(event)!;
      for (const listener of emitter.listeners(event)) {
        if (!kept.has(listener)) emitter.removeListener(event, listener as (...args: unknown[]) => void);
      }
    }
  }
}

let espeakLoad: Promise<typeof EspeakPhonemize> | null = null;

function loadEspeak(): Promise<typeof EspeakPhonemize> {
  espeakLoad ??= importWithoutProcessCrashHooks(() => import('phonemizer')).then((m) => m.phonemize);
  // A failed load must not be cached forever: the next call retries.
  espeakLoad.catch(() => {
    espeakLoad = null;
  });
  return espeakLoad;
}

async function espeakPhonemize(text: string, language: string): Promise<string[]> {
  return (await loadEspeak())(text, language);
}

/** Upstream `o()`: read a year/time-like number the way a speaker would. */
function splitNum(match: string): string {
  if (match.includes('.')) return match;
  if (match.includes(':')) {
    const [h, m] = match.split(':').map(Number);
    if (m === 0) return `${h} o'clock`;
    if (m < 10) return `${h} oh ${m}`;
    return `${h} ${m}`;
  }
  const year = parseInt(match.slice(0, 4), 10);
  if (year < 1100 || year % 1000 < 10) return match;
  const left = match.slice(0, 2);
  const right = parseInt(match.slice(2, 4), 10);
  const suffix = match.endsWith('s') ? 's' : '';
  if (year % 1000 >= 100 && year % 1000 <= 999) {
    if (right === 0) return `${left} hundred${suffix}`;
    if (right < 10) return `${left} oh ${right}${suffix}`;
  }
  return `${left} ${right}${suffix}`;
}

/** Upstream `c()`: read a currency amount. */
function flipMoney(match: string): string {
  const bill = match[0] === '$' ? 'dollar' : 'pound';
  if (isNaN(Number(match.slice(1)))) return `${match.slice(1)} ${bill}s`;
  if (!match.includes('.')) {
    const suffix = match.slice(1) === '1' ? '' : 's';
    return `${match.slice(1)} ${bill}${suffix}`;
  }
  const [b, c] = match.slice(1).split('.');
  const cents = parseInt(c.padEnd(2, '0'), 10);
  const centUnit = match[0] === '$' ? (cents === 1 ? 'cent' : 'cents') : cents === 1 ? 'penny' : 'pence';
  return `${b} ${bill}${b === '1' ? '' : 's'} and ${cents} ${centUnit}`;
}

/** Upstream `g()`: read a decimal point-wise. */
function pointNum(match: string): string {
  const [a, b] = match.split('.');
  return `${a} point ${b.split('').join(' ')}`;
}

/** Upstream text normalization (the big replace chain), verbatim. */
export function normalizeText(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/«/g, '“')
    .replace(/»/g, '”')
    .replace(/[“”]/g, '"')
    .replace(/\(/g, '«')
    .replace(/\)/g, '»')
    .replace(/、/g, ', ')
    .replace(/。/g, '. ')
    .replace(/！/g, '! ')
    .replace(/，/g, ', ')
    .replace(/：/g, ': ')
    .replace(/；/g, '; ')
    .replace(/？/g, '? ')
    .replace(/[^\S \n]/g, ' ')
    .replace(/  +/, ' ')
    .replace(/(?<=\n) +(?=\n)/g, '')
    .replace(/\bD[Rr]\.(?= [A-Z])/g, 'Doctor')
    .replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, 'Mister')
    .replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, 'Miss')
    .replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, 'Mrs')
    .replace(/\betc\.(?! [A-Z])/gi, 'etc')
    .replace(/\b(y)eah?\b/gi, "$1e'a")
    .replace(/\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/g, splitNum)
    .replace(/(?<=\d),(?=\d)/g, '')
    .replace(/[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b/gi, flipMoney)
    .replace(/\d*\.\d+/g, pointNum)
    .replace(/(?<=\d)-(?=\d)/g, ' to ')
    .replace(/(?<=\d)S/g, ' S')
    .replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S")
    .replace(/(?<=X')S\b/g, 's')
    .replace(/(?:[A-Za-z]\.){2,} [a-z]/g, (m) => m.replace(/\./g, '-'))
    .replace(/(?<=[A-Z])\.(?=[A-Z])/gi, '-')
    .trim();
}

const PUNCTUATION = ';:,.!?¡¿—…"«»“”(){}[]';
const PUNCTUATION_PATTERN = new RegExp(`(\\s*[${PUNCTUATION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}]+\\s*)+`, 'g');

/** Upstream `m()`: normalize → phonemize the non-punctuation chunks → post-fixups. */
export async function phonemize(text: string, language: 'a' | 'b' = 'a', norm = true): Promise<string> {
  if (norm) text = normalizeText(text);
  // Split on punctuation, preserving the punctuation runs verbatim.
  const sections: Array<{ match: boolean; text: string }> = [];
  let lastIndex = 0;
  for (const m of text.matchAll(PUNCTUATION_PATTERN)) {
    if (lastIndex < m.index!) sections.push({ match: false, text: text.slice(lastIndex, m.index) });
    if (m[0].length > 0) sections.push({ match: true, text: m[0] });
    lastIndex = m.index! + m[0].length;
  }
  if (lastIndex < text.length) sections.push({ match: false, text: text.slice(lastIndex) });

  const lang = language === 'a' ? 'en-us' : 'en';
  const ps = (
    await Promise.all(sections.map(async ({ match, text: t }) => (match ? t : (await espeakPhonemize(t, lang)).join(' '))))
  ).join('');

  let processed = ps
    .replace(/kəkˈoːɹoʊ/g, 'kˈoʊkəɹoʊ')
    .replace(/kəkˈɔːɹəʊ/g, 'kˈəʊkəɹəʊ')
    .replace(/ʲ/g, 'j')
    .replace(/r/g, 'ɹ')
    .replace(/x/g, 'k')
    .replace(/ɬ/g, 'l')
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, ' ')
    .replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, 'z');
  if (language === 'a') processed = processed.replace(/(?<=nˈaɪn)ti(?!ː)/g, 'di');
  return processed.trim();
}
