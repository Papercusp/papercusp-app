'use client';

import { findStep } from './steps';

export function StepPlaceholder({ id }: { id: string }) {
  const def = findStep(id);
  return (
    <div className="pc-step">
      <p className="pc-step__lead">
        <em>This step is not implemented yet.</em>
      </p>
      <p className="pc-step__hint">
        ID: <code>{id}</code>
        {def?.required ? ' (required)' : ' (optional)'}
      </p>
    </div>
  );
}
