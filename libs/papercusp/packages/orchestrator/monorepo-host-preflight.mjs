// node:test global setup (`node --test --test-global-setup=monorepo-host-preflight.mjs …`).
//
// Inside the Papercusp monorepo, run its restricted-hold preflight once, in the runner process,
// before any test file starts (Decision D-012, WI-10005765). These suites run live-tree code, and
// node:test passes neither the raw test router nor the vitest-root door. The preflight lives in the
// monorepo (<root>/scripts/lib/node-test-host-preflight.mjs); this package cannot import it by
// name, so walk up to it. Outside the monorepo there is no such file and this does nothing.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function globalSetup() {
  for (let dir = dirname(fileURLToPath(import.meta.url)); ; dir = dirname(dir)) {
    const candidate = join(dir, 'scripts/lib/node-test-host-preflight.mjs');
    if (existsSync(candidate)) return (await import(pathToFileURL(candidate).href)).globalSetup();
    if (dirname(dir) === dir) return undefined;
  }
}
