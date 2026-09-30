'use client';

/**
 * Coverage — the `/admin/testing` view of the surface census
 * (deterministic-coverage-census-2026-08-17 P-005).
 *
 * WHAT THIS PANEL MAY NOT DO, stated first because it is the one way it would go wrong:
 * it may not compute a coverage number. Every percentage, count and marker it renders
 * arrives from `readCoverage` through the `testing.coverage` sync query — the same
 * derivation the `testing:coverage` tool and both state cells resolve through.
 *
 * The temptation is specific and would look like ordinary UI code: the panel is handed a
 * `rows` array, so totalling it or dividing by its length is the obvious next line. It
 * would also be wrong every time, because `rows` is capped by `limit` while the
 * aggregates are computed across the whole population — a client-side ratio would be
 * computed over one PAGE and would always look better than the truth.
 *
 * So the only arithmetic below is `formatPct`, which formats a number the server
 * computed, and renders `null` as NOT MEASURED rather than as 0%.
 */

import { useMemo } from 'react';
import { parseAsBoolean, parseAsStringEnum, useQueryState } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { Checkbox } from '../../../harness/Checkbox';
import { Select } from '../../../harness/Select';
import { Table } from '../../../harness/Table';

type Rung = 'l1' | 'l2' | 'l3' | 'l4';

const RUNG_LABEL: Record<Rung, string> = {
  l1: 'L1 executed',
  l2: 'L2 conformant',
  l3: 'L3 intent-tested',
  l4: 'L4 hardened',
};

interface FidelityMarker {
  counts: Record<string, number>;
  weakest: string | null;
  declaredPct: number | null;
}

interface Aggregate {
  surfaces: number;
  meets: number;
  below: number;
  waived: number;
  pct: number | null;
  fidelity: FidelityMarker;
  basis: { countedOver: string; boundedByLimit: boolean; limitAppliesTo: string };
}

interface CoveragePayload {
  scope: { workspace: string; harness: string };
  verdict: 'measured' | 'not-measured';
  censusUnknown: string[] | null;
  census: {
    surfaces: number;
    retired: number;
    lastCensusAt: string | null;
    ageMs: number | null;
    providersRegistered: number;
    providersEnabled: number;
    fidelity: FidelityMarker;
  };
  coverage: Aggregate & { floor: Rung; floorMeans: string; byRung: Record<Rung, Aggregate> };
  byKind: Array<Aggregate & { kind: string }>;
  rows: Array<{
    kind: string;
    surfaceId: string;
    sourceFile: string | null;
    fidelity: string;
    depth: number;
    waived: boolean;
  }>;
  count: number;
  total: number;
  truncatedByLimit: boolean;
}

/**
 * The single most important function in this file.
 *
 * `null` means the ratio HAS NO DENOMINATOR — an empty census — and it must never render
 * as "0%". Those read identically to a human skimming a dashboard and mean opposite
 * things: one says nothing is proven, the other says nobody measured. A dash plus the
 * NOT MEASURED banner is the honest rendering.
 */
export function formatPct(value: number | null): string {
  return value === null ? '—' : `${value}%`;
}

/** The weakest fidelity in a population caps what its number means — so it is shown WITH
 *  the number, never in a legend elsewhere on the page. */
function FidelityChip({ marker }: { marker: FidelityMarker }): React.ReactElement | null {
  if (marker.weakest === null) return null;
  const weak = marker.weakest !== 'declared';
  return (
    <span
      className="pc-test-chip"
      title={
        `Weakest fidelity in this population: ${marker.weakest}. ` +
        `${marker.declaredPct ?? 0}% of these surfaces were derived from a live code registry ` +
        `(declared — cannot drift). A coverage number over a weak census is not the same claim ` +
        `as one over a declared census.`
      }
      style={{
        marginLeft: 6,
        fontSize: 11,
        opacity: 0.75,
        color: weak ? 'var(--warn, #b45309)' : undefined,
      }}
    >
      {marker.weakest}
      {marker.declaredPct !== null && marker.declaredPct < 100 ? ` · ${marker.declaredPct}% declared` : ''}
    </span>
  );
}

export default function CoverageTab(): React.ReactElement {
  const [rung, setRung] = useQueryState('rung', parseAsStringEnum<Rung>(['l1', 'l2', 'l3', 'l4']).withDefault('l1'));
  const [gapsOnly, setGapsOnly] = useQueryState('gaps', parseAsBoolean.withDefault(true));

  const { data } = useSyncQuery<CoveragePayload>({
    queryName: 'testing.coverage',
    args: useMemo(() => ({ rung, gapsOnly, limit: 100 }), [rung, gapsOnly]),
  });

  const payload = data?.[0];

  if (!payload) {
    return (
      <div className="pc-test-tab-header">
        <div>Coverage</div>
        <div style={{ opacity: 0.7 }}>Loading the census…</div>
      </div>
    );
  }

  const { census, coverage } = payload;
  const notMeasured = payload.verdict === 'not-measured';

  return (
    <div>
      <div className="pc-test-tab-header">
        <div>
          Coverage — {payload.scope.harness}
          <FidelityChip marker={census.fidelity} />
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <label>
            Floor{' '}
            <Select
              value={rung}
              onChange={(value) => void setRung(value as Rung)}
              ariaLabel="Coverage floor"
              options={(Object.keys(RUNG_LABEL) as Rung[]).map((r) => ({ value: r, label: RUNG_LABEL[r] }))}
            />
          </label>
          <label>
            <Checkbox
              checked={gapsOnly}
              onChange={(checked) => void setGapsOnly(checked)}
              ariaLabel="Show only surfaces below the floor"
            />{' '}
            gaps only
          </label>
        </div>
      </div>

      {/*
        The not-measured banner. Deliberately loud and deliberately ABOVE the numbers:
        an empty census renders a page full of zeroes and dashes that a reader would
        otherwise interpret as "we measured, and it is bad" rather than "nothing measured".
      */}
      {notMeasured && (
        <div
          className="pc-test-card"
          role="status"
          style={{ borderLeft: '3px solid var(--warn, #b45309)', marginBottom: 12 }}
        >
          <div className="pc-test-card-title">NOT MEASURED — this is not 0% coverage</div>
          <div style={{ fontSize: 12, opacity: 0.85 }}>
            No censused surfaces in scope, so every ratio below has no denominator and is shown as “—”.
          </div>
          <ul style={{ fontSize: 12, marginTop: 6 }}>
            {(payload.censusUnknown ?? []).map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="pc-test-card">
        <div className="pc-test-card-title">
          Census
          <FidelityChip marker={census.fidelity} />
        </div>
        <div className="pc-test-card-row">
          <span>Surfaces</span>
          <span>{census.surfaces}</span>
        </div>
        <div className="pc-test-card-row">
          <span>Retired</span>
          <span>{census.retired}</span>
        </div>
        <div className="pc-test-card-row">
          <span>Providers registered / enabled</span>
          {/* Zero here is the WI-39809 state: the census loop has nothing to iterate and
              cannot write a row, however healthy its fires look. */}
          <span>
            {census.providersRegistered} / {census.providersEnabled}
          </span>
        </div>
        <div className="pc-test-card-row">
          <span>Last census</span>
          <span>{census.lastCensusAt ?? 'never'}</span>
        </div>
      </div>

      <div className="pc-test-card">
        <div className="pc-test-card-title">
          At floor {RUNG_LABEL[coverage.floor]} — {formatPct(coverage.pct)}
          <FidelityChip marker={coverage.fidelity} />
        </div>
        <div className="pc-test-card-row">
          <span>Meets / below / waived</span>
          <span>
            {coverage.meets} / {coverage.below} / {coverage.waived}
          </span>
        </div>
        <div style={{ fontSize: 11, opacity: 0.7, marginTop: 4 }}>
          Counted over {coverage.basis.countedOver}; the row list below is capped, these totals are not.
        </div>
      </div>

      <Table<Rung>
        className="pc-test-table"
        rows={Object.keys(RUNG_LABEL) as Rung[]}
        getRowKey={(r) => r}
        columns={[
          { key: 'rung', header: 'Rung', render: (r) => RUNG_LABEL[r] },
          { key: 'meets', header: 'Meets', render: (r) => coverage.byRung[r].meets },
          { key: 'below', header: 'Below', render: (r) => coverage.byRung[r].below },
          { key: 'coverage', header: 'Coverage', render: (r) => formatPct(coverage.byRung[r].pct) },
          {
            key: 'fidelity',
            header: 'Fidelity',
            render: (r) => <FidelityChip marker={coverage.byRung[r].fidelity} />,
          },
        ]}
      />

      <Table
        className="pc-test-table"
        rows={payload.byKind}
        getRowKey={(k) => k.kind}
        columns={[
          { key: 'kind', header: 'Kind', render: (k) => k.kind },
          { key: 'surfaces', header: 'Surfaces', render: (k) => k.surfaces },
          { key: 'meets', header: 'Meets', render: (k) => k.meets },
          { key: 'below', header: 'Below', render: (k) => k.below },
          { key: 'coverage', header: 'Coverage', render: (k) => formatPct(k.pct) },
          {
            key: 'fidelity',
            header: 'Fidelity',
            // Per-kind, NOT the census-wide marker: a global caveat copied onto every
            // row would flag a fully-declared kind as weak, and a caveat that is
            // always present is one readers learn to skip.
            render: (k) => <FidelityChip marker={k.fidelity} />,
          },
        ]}
      />

      <div className="pc-test-card-title">
        {gapsOnly ? 'Gaps' : 'Surfaces'} — showing {payload.count} of {payload.total}
        {payload.truncatedByLimit ? ' (truncated)' : ''}
      </div>
      <Table
        className="pc-test-table"
        rows={payload.rows}
        getRowKey={(row) => `${row.kind}:${row.surfaceId}`}
        columns={[
          { key: 'kind', header: 'Kind', render: (row) => row.kind },
          { key: 'surface', header: 'Surface', render: (row) => row.surfaceId },
          { key: 'sourceFile', header: 'Source file', render: (row) => row.sourceFile ?? '—' },
          { key: 'depth', header: 'Depth', render: (row) => row.depth },
          {
            key: 'fidelity',
            header: 'Fidelity',
            render: (row) => `${row.fidelity}${row.waived ? ' · waived' : ''}`,
          },
        ]}
      />
    </div>
  );
}
