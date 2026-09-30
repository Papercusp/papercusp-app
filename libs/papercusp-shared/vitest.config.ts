import { defineVitestConfig } from '@papercusp/test-config/vitest-config';
import { mergeConfig } from 'vitest/config';

// The esbuild merge forces the automatic JSX runtime so component tests
// (Tooltip.test.tsx) need no explicit `import React` — these components, like
// the operator's, omit it and rely on the build's automatic runtime. Mirrors
// libs/marketplace-public-ui + libs/agent-chat.
export default mergeConfig(defineVitestConfig({ layer: 'unit' }), {
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
});
