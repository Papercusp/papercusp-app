import { defineConfig } from 'vitest/config';

// Standalone config (mirrors ui-primitives): a clone of this package's own
// repo has no sibling monorepo test-config, so it must not route through
// @papercusp/test-config. jsdom for component tests when they land; the
// component is currently covered end-to-end by its two monorepo consumers'
// suites (LearningTab.test.tsx, ObservationsPanel.test.tsx).
export default defineConfig({
  test: {
    environment: 'jsdom',
  },
});
