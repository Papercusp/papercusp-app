'use client';

/**
 * `useLexicon()` — the client half of the flag-gated lexicon layer
 * (the-hive-lexicon-2026-06-06 P-003).
 *
 * Returns a term resolver bound to the active brand pack, selected by the
 * `the-hive` feature flag. A `HarnessLexiconProvider` may overlay the exact
 * selected harness's resolved blueprint lexicon for domain nouns such as
 * workUnit → deliverable. Both inputs are reactive; internal identifiers stay
 * unchanged (identities-v1-2026-08-30 P-025).
 *
 * Lives in apps/operator/lib (not operator-vite) so BOTH the operator-vite
 * components and the apps/operator/app page implementations they render can
 * import it via `@/lib/useLexicon`. The lib (@papercusp/lexicon) stays
 * brand-neutral; this hook is the host glue that maps the flag → a BrandPackId.
 * Internal identifiers never change — presentation only (D-001).
 */
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { FLAGS } from '@papercusp/flags';
import {
  type BoundLexicon,
  type BrandPackId,
  type BuiltInTermKey,
  type TermOptions,
  lexiconFor,
} from '@papercusp/lexicon';

import { useFlag } from './flag-hooks';

export type HarnessDomainTermKey = 'workUnit' | 'reviewGate';
export type OperatorLexicon = BoundLexicon<HarnessDomainTermKey>;

type TermForms = { one: string; other: string };
type HarnessLexiconOverrides = Readonly<Record<string, string>>;

const EMPTY_OVERRIDES: HarnessLexiconOverrides = Object.freeze({});
const HarnessLexiconContext = createContext<HarnessLexiconOverrides>(EMPTY_OVERRIDES);

const DOMAIN_FALLBACKS: Readonly<Record<HarnessDomainTermKey, TermForms>> = {
  workUnit: { one: 'Work item', other: 'Work items' },
  reviewGate: { one: 'Review gate', other: 'Review gates' },
};

function upperFirst(value: string): string {
  return value ? `${value.charAt(0).toLocaleUpperCase()}${value.slice(1)}` : value;
}

/** Blueprint lexicon values are singular strings; inflect the final word for UI plural forms. */
function pluralizeLabel(label: string): string {
  const match = /^(.*?)([A-Za-z]+)$/.exec(label);
  if (!match) return `${label}s`;
  const [, prefix, word] = match;
  let plural: string;
  if (/[^aeiou]y$/i.test(word)) plural = `${word.slice(0, -1)}ies`;
  else if (/(?:s|x|z|ch|sh)$/i.test(word)) plural = `${word}es`;
  else plural = `${word}s`;
  return `${prefix}${plural}`;
}

function wantsPlural(opts: TermOptions | undefined): boolean {
  if (opts?.count !== undefined && Number.isFinite(opts.count)) return Math.abs(opts.count) !== 1;
  return Boolean(opts?.plural);
}

function resolveForms(forms: TermForms, opts: TermOptions | undefined): string {
  const label = wantsPlural(opts) ? forms.other : forms.one;
  return opts?.lower ? label.toLocaleLowerCase() : label;
}

function overrideForms(value: string): TermForms {
  const one = upperFirst(value.trim());
  return { one, other: pluralizeLabel(one) };
}

function readOverrides(value: unknown): HarnessLexiconOverrides {
  if (!value || typeof value !== 'object') return EMPTY_OVERRIDES;
  const identity = (value as { identity?: unknown }).identity;
  if (!identity || typeof identity !== 'object') return EMPTY_OVERRIDES;
  const lexicon = (identity as { lexicon?: unknown }).lexicon;
  if (!lexicon || typeof lexicon !== 'object' || Array.isArray(lexicon)) return EMPTY_OVERRIDES;
  const entries = Object.entries(lexicon as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0)
    .map(([key, label]) => [key, label.trim()]);
  return entries.length > 0 ? Object.freeze(Object.fromEntries(entries)) : EMPTY_OVERRIDES;
}

export interface HarnessLexiconProviderProps {
  harnessSlug: string;
  children: ReactNode;
}

/**
 * Bind descendants to one exact harness's resolved blueprint lexicon. A slug
 * change takes effect synchronously (the previous slug's overrides are not
 * rendered once), while abort + a cancellation guard discard stale responses.
 */
export function HarnessLexiconProvider({ harnessSlug, children }: HarnessLexiconProviderProps) {
  const slug = harnessSlug.trim();
  const [resolved, setResolved] = useState<{ slug: string; overrides: HarnessLexiconOverrides }>({
    slug: '',
    overrides: EMPTY_OVERRIDES,
  });

  useEffect(() => {
    if (!slug) {
      setResolved({ slug: '', overrides: EMPTY_OVERRIDES });
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    void fetch(`/api/harness/${encodeURIComponent(slug)}/blueprint-params`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => (response.ok ? readOverrides(await response.json()) : EMPTY_OVERRIDES))
      .then((overrides) => {
        if (!cancelled) setResolved({ slug, overrides });
      })
      .catch(() => {
        if (!cancelled) setResolved({ slug, overrides: EMPTY_OVERRIDES });
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [slug]);

  const overrides = resolved.slug === slug ? resolved.overrides : EMPTY_OVERRIDES;
  return createElement(HarnessLexiconContext.Provider, { value: overrides }, children);
}

/**
 * The active brand pack id, reactive to live flag changes. Prefer
 * {@link useLexicon} unless you need the raw id (e.g. to branch on it).
 */
export function useLexiconPackId(): BrandPackId {
  return useFlag(FLAGS.THE_HIVE) ? 'the-hive' : 'classic';
}

/**
 * A term resolver bound to the active brand pack:
 *
 *   const t = useLexicon();
 *   <h1>{t('pot', { plural: true })}</h1>   // "Pots" | "Hives"
 *   <span>{t('cupboard')}</span>            // "Cupboard" | "Comb"
 */
export function useLexicon(): OperatorLexicon {
  const packId = useLexiconPackId();
  const overrides = useContext(HarnessLexiconContext);
  return useMemo(() => {
    const brand = lexiconFor(packId);
    return ((key: BuiltInTermKey | HarnessDomainTermKey, opts?: TermOptions) => {
      const override = overrides[key];
      if (override) return resolveForms(overrideForms(override), opts);
      if (key in DOMAIN_FALLBACKS) {
        return resolveForms(DOMAIN_FALLBACKS[key as HarnessDomainTermKey], opts);
      }
      return brand(key as BuiltInTermKey, opts);
    }) as OperatorLexicon;
  }, [packId, overrides]);
}
