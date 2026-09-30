import { defineVitestConfig } from '@papercusp/test-config/vitest-config';
import { mergeConfig } from 'vitest/config';

export default mergeConfig(
  defineVitestConfig({
    layer: 'unit',
    include: ['src/**/*.spec.ts'],
  }),
  {
    root: __dirname,
    test: { globals: true },
  },
);
