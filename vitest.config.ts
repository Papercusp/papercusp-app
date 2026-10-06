import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { resolve } from 'node:path';
import {
  DEFAULT_UNIT_TEST_TIMEOUT_MS,
  gateParticipationConfig,
  sharedHostWorkerCap,
} from '@papercusp/test-config/vitest-config';

// Direct root runs need the workspace aliases used by apps/operator and apps/operator-vite
// source imports.
// Keep this list explicit: loading every workspace tsconfig here would make the generic
// root fallback parse the entire monorepo and could apply an unrelated package's paths.
export const ROOT_VITEST_TSCONFIG_PROJECTS = [
  resolve(__dirname, 'apps/operator/tsconfig.json'),
  resolve(__dirname, 'apps/operator-vite/tsconfig.json'),
] as const;

const ROOT_VITEST_EXCLUDES = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/.next/**',
  '**/.papercusp/**',
  '**/_retired/**',
];

const ROOT_VITEST_GATE_PARTICIPATION = gateParticipationConfig({
  exclude: ROOT_VITEST_EXCLUDES,
});

// Direct repository-root `vitest run <path>` invocations use Vitest's default
// discovery root instead of a workspace config.  Keep the standard Vitest
// exclusions and apply the same scratch/archive exclusions used by the shared
// workspace configs so gate-owned worktrees can never masquerade as canonical
// test files. Reuse the shared gate fragment so direct root runs also emit the
// same test-run evidence as workspace-configured runs.
export default defineConfig({
  plugins: [
    tsconfigPaths({
      ignoreConfigErrors: true,
      projects: [...ROOT_VITEST_TSCONFIG_PROJECTS],
    }),
  ],
  test: {
    ...ROOT_VITEST_GATE_PARTICIPATION,
    // A direct root `vitest run packages/<workspace>/…` bypasses the owning
    // workspace config. Keep its scheduling/deadline envelope aligned with the
    // shared unit contract so the same network-backed unit test cannot get a
    // 5-second deadline here and a 60-second deadline through `test:file`.
    // The owning-config router remains preferred because it also supplies each
    // workspace's setup files; this fallback is still a supported direct-file
    // route and must not manufacture a red verdict by config drift.
    pool: 'forks',
    ...sharedHostWorkerCap('forks'),
    testTimeout: Number(process.env.VITEST_UNIT_TIMEOUT_MS) || DEFAULT_UNIT_TEST_TIMEOUT_MS,
  },
});
