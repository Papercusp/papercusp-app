import { defineVitestConfig } from '@papercusp/test-config';

// Without a config of its own this package's `vitest run` walked UP to the
// repository root config and ran the entire monorepo topology (236 files /
// 2,118 tests) from this directory instead of its own 3 files — and exited 1,
// because two apps/web tests resolve fixtures relative to process.cwd().
export default defineVitestConfig({ layer: 'unit' });
