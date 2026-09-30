import * as BloomFilterModule from 'bloom-filters/dist/bloom/bloom-filter.js';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveBloomFilter(mod: any): any {
  for (let i = 0; i < 3; i++) {
    if (typeof mod === 'function' && typeof mod.create === 'function') return mod;
    if (mod && typeof mod === 'object' && 'default' in mod) mod = mod.default;
    else break;
  }
  return mod;
}
const BloomFilter = resolveBloomFilter(BloomFilterModule);
import type {
  BloomQueryRequest,
  BloomQueryResponse,
  ManifestEntry,
  Versioned,
} from './protocol';

export interface BloomHandlerAdapters<TRow extends Versioned, TFilter> {
  loadManifest: (args: {
    filter: TFilter;
    sort?: string;
    limit: number;
    offset: number;
  }) => Promise<ManifestEntry[]>;

  loadRows: (ids: string[]) => Promise<TRow[]>;

  count: (filter: TFilter) => Promise<number>;
}

export function createBloomHandler<TRow extends Versioned, TFilter>(
  adapters: BloomHandlerAdapters<TRow, TFilter>,
) {
  return async function handle(
    req: BloomQueryRequest<TFilter>,
  ): Promise<BloomQueryResponse<TRow>> {
    const manifest = await adapters.loadManifest({
      filter: req.filter,
      sort: req.sort,
      limit: req.limit,
      offset: req.offset,
    });

    let missingIds: string[];
    if (!req.bloom) {
      missingIds = manifest.map((m) => m.id);
    } else {
      // `bloom-filters` accepts the JSON produced by saveAsJSON().
      // The bloom-filters v3 types incorrectly declare `fromJSON(json: JSON)`
      // where JSON is the global (JSON.parse/stringify) namespace rather than
      // a plain object. At runtime the library accepts the object produced by
      // saveAsJSON(), so we cast here and keep consumer code clean.
      const bloom = BloomFilter.fromJSON(req.bloom as never);
      missingIds = manifest
        .filter((m) => !bloom.has(`${m.id}:${m.v}`))
        .map((m) => m.id);
    }

    const [rows, total] = await Promise.all([
      missingIds.length
        ? adapters.loadRows(missingIds)
        : Promise.resolve([] as TRow[]),
      adapters.count(req.filter),
    ]);

    return { manifest, rows, total };
  };
}

export type { BloomHandlerAdapters as Adapters };
export type { BloomQueryRequest, BloomQueryResponse, Versioned, ManifestEntry } from './protocol';
