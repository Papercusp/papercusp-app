import { defineVitestConfig } from '@papercusp/test-config/vitest-config';

// Keep source Phone journeys in the recorded e2e lane. The test starts its own
// PostgreSQL server and invokes the real Phone CLIs; it never contacts a carrier.
export default defineVitestConfig({ layer: 'e2e' });
