/**
 * Pure resolution: given a pack (or pack id) and a term key, return the
 * display label with the requested form + casing. No host state, no flags —
 * the caller supplies the pack. Framework-agnostic so both the React hook and
 * the server twin build on it.
 */
import { BRAND_PACKS, DEFAULT_PACK_ID } from './packs';
import type {
  BrandPack,
  BrandPackId,
  TermKey,
  TermOptions,
} from './types';

/** Resolve a pack id to its {@link BrandPack}, falling back to the default. */
export function getPack(id: BrandPackId | undefined): BrandPack {
  return BRAND_PACKS[id ?? DEFAULT_PACK_ID] ?? BRAND_PACKS[DEFAULT_PACK_ID];
}

function applyCase(label: string, lower: boolean | undefined): string {
  return lower ? label.toLowerCase() : label;
}

function pickForm(
  forms: { one: string; other: string },
  opts: TermOptions | undefined,
): string {
  // A finite count selects singular (|count| === 1) vs plural. A non-finite
  // count (NaN / ±Infinity — almost always a caller bug like `count={len}` where
  // `len` came out NaN) is NOT a meaningful "everything else" plural: it falls
  // through to the `plural` flag so an explicit `plural: false` is still honored,
  // rather than silently forcing the plural form regardless of intent.
  if (opts?.count !== undefined && Number.isFinite(opts.count)) {
    return Math.abs(opts.count) === 1 ? forms.one : forms.other;
  }
  return opts?.plural ? forms.other : forms.one;
}

/**
 * Resolve `key` against an explicit pack. The pack may be a {@link BrandPack}
 * or a {@link BrandPackId}.
 */
export function resolveTerm(pack: BrandPackId, key: TermKey, opts?: TermOptions): string;
export function resolveTerm<TCustom extends string = never>(
  pack: BrandPack<TCustom>,
  key: TermKey<TCustom>,
  opts?: TermOptions,
): string;
export function resolveTerm<TCustom extends string = never>(
  pack: BrandPack<TCustom> | BrandPackId,
  key: TermKey<TCustom>,
  opts?: TermOptions,
): string {
  const resolved = (typeof pack === 'string' ? getPack(pack) : pack) as BrandPack<TCustom>;
  const forms = resolved.terms[key];
  return applyCase(pickForm(forms, opts), opts?.lower);
}

/** A resolver bound to one pack — `t('pot')` style ergonomics. */
export type BoundLexicon<TCustom extends string = never> = (key: TermKey<TCustom>, opts?: TermOptions) => string;

/** Build a resolver bound to a single pack id. */
export function lexiconFor(packId: BrandPackId): BoundLexicon {
  const pack = getPack(packId);
  return (key, opts) => resolveTerm(pack, key, opts);
}

/** Build a resolver bound to an explicit pack, including app-specific term keys. */
export function lexiconFromPack<TCustom extends string = never>(pack: BrandPack<TCustom>): BoundLexicon<TCustom> {
  return (key, opts) => resolveTerm(pack, key, opts);
}
