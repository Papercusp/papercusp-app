// Regenerate src/routeTree.gen.ts from src/routes/** WITHOUT running vite.
//
// WHY (EI: flapping release gate): routeTree.gen.ts is a TanStack-Router
// GENERATED file and is .gitignored. It is only ever written by the vite plugin
// (dev/build). Any environment that TYPECHECKS without first running vite — most
// importantly the green-checkpoint's separate `papercusp-checkpoint` checkout,
// which runs `npm run test` → typecheck-ratchet.test.ts → `tsc --noEmit` with no
// dev server — sees a STALE/absent route tree. So the moment anyone adds a route
// (e.g. src/routes/quick-panel.tsx), the checkpoint's `createFileRoute('/x')`
// fails TS2345 ("'/x' not assignable to keyof FileRoutesByPath") and REDS THE
// RELEASE GATE for the whole fleet — while every local tree (with a running vite)
// looks clean. This script makes route-tree generation available as a plain,
// checkout-independent, dev-server-independent step so the typecheck path can
// regenerate before tsc. It uses the SAME @tanstack/router-generator engine the
// vite plugin uses, with the config mirrored from vite.config.ts.
import { Generator, getConfig } from '@tanstack/router-generator';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const config = getConfig(
  {
    target: 'react',
    routesDirectory: './src/routes',
    generatedRouteTree: './src/routeTree.gen.ts',
    // Mirror vite.config.ts so the generated tree matches what the app builds.
    autoCodeSplitting: true,
    disableLogging: true,
  },
  root,
);

const generator = new Generator({ config, root });
await generator.run();
