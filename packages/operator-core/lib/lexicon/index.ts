/**
 * Server-side lexicon surface. Importing this module wires the brand-pack
 * selector (the `./configure` side effect) and re-exports the resolver so
 * server code can emit user-facing strings through the active pack:
 *
 *   import { term } from '@papercusp/operator-core/lib/lexicon';
 *   notify(`${term('pot')} ready`); // "Pot ready" | "Hive ready"
 */
import './configure';

export {
  activePackId,
  type BoundLexicon,
  type BrandPackId,
  getPack,
  lexiconFor,
  resolveTerm,
  term,
  type TermKey,
  type TermOptions,
} from '@papercusp/lexicon';

export { activeServerPackId, refreshLexiconPack } from './configure';
