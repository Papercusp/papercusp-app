import { defineVitestConfig } from '@papercusp/test-config';

export default defineVitestConfig({
  layer: 'unit',
  include: ['src/main-loop.test.ts'],
});
