import { defineVitestConfig } from '@papercusp/test-config/vitest-config';
import { mergeConfig } from 'vitest/config';

export default mergeConfig(defineVitestConfig({ layer: 'unit' }), {
  test: { globals: true },
});
