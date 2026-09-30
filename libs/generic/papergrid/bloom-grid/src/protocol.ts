export interface Versioned {
  id: string;
  v: number;
}

export interface ManifestEntry {
  id: string;
  v: number;
}

export interface BloomQueryRequest<TFilter> {
  filter: TFilter;
  sort?: string;
  limit: number;
  offset: number;
  bloom?: unknown;
}

export interface BloomQueryResponse<TRow extends Versioned> {
  manifest: ManifestEntry[];
  rows: TRow[];
  total: number;
}
