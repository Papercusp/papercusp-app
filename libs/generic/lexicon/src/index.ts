/**
 * @papercusp/lexicon — a generic terminology resolver.
 *
 * Maps a canonical term key to a display label keyed by the active brand pack.
 * The mechanism is brand-neutral; the shipped packs (`classic`, `the-hive`)
 * are data. Selection (which pack is active) is injected by the host via
 * {@link configureLexicon} — the lib never imports a flag system.
 *
 * - Pure, framework-agnostic: {@link resolveTerm}, {@link lexiconFor},
 *   {@link getPack}.
 * - Ambient (host-selected pack): {@link term}, {@link activePackId},
 *   {@link configureLexicon}.
 */
export type {
  BrandPack,
  BrandPackId,
  BuiltInTermKey,
  TermForms,
  TermKey,
  TermOptions,
} from './types';

export {
  BRAND_PACKS,
  BRAND_PACK_IDS,
  CLASSIC_PACK,
  DEFAULT_PACK_ID,
  THE_HIVE_PACK,
} from './packs';

export {
  type BoundLexicon,
  getPack,
  lexiconFromPack,
  lexiconFor,
  resolveTerm,
} from './resolver';

export {
  activePackId,
  configureLexicon,
  isLexiconConfigured,
  type LexiconHost,
  term,
} from './config';
