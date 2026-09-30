/**
 * no-pg-register.mjs — the `--import` entry that installs `no-pg-hooks.mjs`.
 *
 * Node's resolution hooks run on a dedicated loader thread and are installed via
 * `module.register()`, so a hooks file cannot be handed to `--import` directly;
 * this shim is the registration half. Spawned by `child-driver.ts` as
 * `node --import tsx --import <this file> peer-child.ts` — tsx first, so the
 * child's TypeScript still loads, then this, so `@papercusp/db-org` is diverted
 * before any substrate module resolves it. See no-pg-hooks.mjs for the why and
 * the measured numbers.
 */

import { register } from 'node:module';

register(new URL('./no-pg-hooks.mjs', import.meta.url));
