'use client';

/**
 * PlanSearchResults — cross-plan content search results.
 *
 * P-104 deliverable. Drives off the rail's `q` nuqs key (debounced
 * 250ms client-side so each keystroke doesn't fire a fetch). The
 * server returns every per-scope match; the scope chips here filter
 * the rendered hits client-side rather than re-querying, keeping
 * interactions snappy.
 *
 * Renders only when the user is typing a query and hasn't yet picked
 * a plan — clicking a hit sets `slug` and the detail view takes over.
 */

import { useEffect, useState } from 'react';
import { useQueryState, parseAsStringEnum } from 'nuqs';
import { usePlanSearch, type SearchScope } from './plans-api';

// `title`/`now`/`items`/`decisions`/`prose` are search-MATCH-LOCATION
// scopes (where the query text matched). `needs-human`/`needs-decision`
// are item-STATUS filters layered on top: they narrow the hits to plans
// that actually carry an item in that bucket (the same two buckets as
// the Needs Human / Needs Decision views).
type StatusFilter = 'needs-human' | 'needs-decision';
type ScopeFilter = 'all' | SearchScope | StatusFilter;

const SCOPE_FILTERS: ScopeFilter[] = [
  'all',
  'title',
  'now',
  'items',
  'decisions',
  'prose',
  'needs-human',
  'needs-decision',
];

/** Chip labels — defaults to the raw value (title/now/items/…). */
const FILTER_LABELS: Partial<Record<ScopeFilter, string>> = {
  'needs-human': 'needs human',
  'needs-decision': 'needs decision',
};

interface Props {
  query: string;
  onPick: (slug: string) => void;
  /** Plans with >=1 needs-human item — backs the `needs-human` chip. */
  needsHumanPlans?: ReadonlySet<string>;
  /** Plans with >=1 actionable (todo) item — backs the `needs-decision` chip. */
  needsDecisionPlans?: ReadonlySet<string>;
}

export default function PlanSearchResults({ query, onPick, needsHumanPlans, needsDecisionPlans }: Props) {
  const debounced = useDebounced(query, 250);
  const { data, loading, error, refresh } = usePlanSearch(debounced);
  const [scope, setScope] = useQueryState(
    'qScope',
    parseAsStringEnum<ScopeFilter>(SCOPE_FILTERS).withDefault('all'),
  );

  const hits = data?.hits ?? [];
  const filtered =
    scope === 'all'
      ? hits
      : scope === 'needs-human'
        ? hits.filter((h) => needsHumanPlans?.has(h.plan))
        : scope === 'needs-decision'
          ? hits.filter((h) => needsDecisionPlans?.has(h.plan))
          : hits
              .map((h) => ({
                ...h,
                matches: h.matches.filter((m) => m.scope === scope),
              }))
              .filter((h) => h.matches.length > 0);

  const showSearching = loading || debounced !== query;

  return (
    <div className="pc-search">
      <header className="pc-search__head">
        <h2>Search</h2>
        <p>
          Cross-plan matches for <code>{query}</code>
        </p>
      </header>

      <div className="pc-search__scopes" role="toolbar" aria-label="Search scope">
        {SCOPE_FILTERS.map((s) => (
          <button
            key={s}
            type="button"
            className={`pc-filter-toggle ${scope === s ? 'is-on' : ''}`}
            onClick={() => setScope(s)}
            aria-pressed={scope === s}
          >
            {FILTER_LABELS[s] ?? s}
          </button>
        ))}
      </div>

      {error ? (
        <div className="pc-plans__placeholder pc-plans__placeholder--error">
          <p>Search failed:</p>
          <code>{error}</code>
          <button type="button" className="pc-plans__retry" onClick={refresh}>
            Retry
          </button>
        </div>
      ) : null}

      {!error && showSearching ? (
        <p className="pc-plans__placeholder">Searching…</p>
      ) : null}

      {!error && !showSearching && !filtered.length ? (
        <div className="pc-search__empty">
          No matches{scope !== 'all' ? ` in ${FILTER_LABELS[scope] ?? scope}` : ''}.
        </div>
      ) : null}

      {!error && !showSearching && filtered.length > 0 ? (
        <ul className="pc-search__hits" role="list">
          {filtered.map((h) => (
            <li key={h.plan}>
              <button
                type="button"
                className="pc-search__hit"
                onClick={() => onPick(h.plan)}
              >
                <div className="pc-search__hit-head">
                  <span className="pc-search__hit-slug">{h.plan}</span>
                  <span className="pc-search__hit-score">{h.score}</span>
                </div>
                <ul className="pc-search__matches" role="list">
                  {h.matches.slice(0, 4).map((m, i) => (
                    <li key={i} className="pc-search__match">
                      <span className={`pc-search__match-scope pc-search__match-scope--${m.scope}`}>
                        {m.scope}
                      </span>
                      <span className="pc-search__match-snippet">{m.snippet}</span>
                    </li>
                  ))}
                  {h.matches.length > 4 ? (
                    <li className="pc-search__more">
                      + {h.matches.length - 4} more
                    </li>
                  ) : null}
                </ul>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
