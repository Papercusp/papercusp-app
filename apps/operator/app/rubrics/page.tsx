'use client';

/**
 * /rubrics — every rubric + its grading history at a glance
 * (rubrics-tab-scorecard-ui-2026-07-09 P-001..P-003, owner ask 2026-07-09).
 * Deliberately minimal, mirroring /fleet-status. Drill-down is client-side
 * state: rubric list (rubrics.list) → rubric detail with trend + grading
 * history (scorecards.list / rubrics.trend) → full scorecard ratings +
 * evidence (same rows, no extra fetch).
 */
import { useState } from 'react';
import RubricsPanel from '@/app/_components/RubricsPanel';
import RubricDetailPanel from '@/app/_components/RubricDetailPanel';

export default function RubricsPage() {
  const [rubricId, setRubricId] = useState<string | null>(null);

  return (
    <div style={{ padding: '2rem' }}>
      <h1>Rubrics</h1>
      {rubricId ? (
        <RubricDetailPanel rubricId={rubricId} onBack={() => setRubricId(null)} />
      ) : (
        <RubricsPanel onSelect={setRubricId} />
      )}
    </div>
  );
}
