import { defineVitestConfig } from '@papercusp/test-config/vitest-config';
import { mergeConfig } from 'vitest/config';

// Base shared config + two additions needed for jsdom component tests run from
// inside this submodule:
//   - esbuild jsx:'automatic' — components here omit `import React` and rely on
//     the automatic runtime; without it the transform is classic and the
//     component's own JSX throws "React is not defined".
//   - server.fs.strict:false — the shared fail-on-console setup file lives in
//     the SUPERPROJECT's libs/test-config, outside this submodule's cwd; vite's
//     default fs allow-list otherwise blocks serving it to the jsdom pool.
export default mergeConfig(defineVitestConfig({ layer: 'unit' }), {
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  server: { fs: { strict: false } },
});
