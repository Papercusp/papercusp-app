/**
 * POST /api/flags/preset { name: 'production' | 'testing' }
 *
 * Atomic preset apply.
 *
 * Ported from app/api/flags/preset/route.ts. `auth: 'loopback'` (auth-tier Wave 1).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { z } from 'zod';

import { ALL_FLAG_KEYS } from '@papercusp/flags';
import { setFlag, clearAllFlagOverrides } from '@papercusp/flags/server';
import { publishFlagChange, reinitFlagBackend } from '../../../flag-bus';
import { resetPosthogConfigForTest } from '../../../posthog-config';
import '../../../flag-bus';
import { defineTool } from '@papercusp/agent-mcp';

const CONFIG_PATH = path.join(os.homedir(), '.papercusp', 'posthog.json');
const Body = z.object({ name: z.enum(['production', 'testing']) });

function readConfig(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(cfg: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}

export default defineTool({
  method: 'POST',
  path: '/flags/preset',
  auth: 'loopback',
  input: Body,
  async handler(req, ctx) {
    const { name } = ctx.input;
    if (name === 'production') {
      const cfg = readConfig();
      cfg.testingFeatures = false;
      writeConfig(cfg);
      resetPosthogConfigForTest();
      // Symmetric inverse of the 'testing' preset (which turns flags on): clear
      // the stored runtime overrides so production truly returns to bundled
      // defaults instead of leaving flags pinned on. (2026-06-18)
      const clearedOverrides = await clearAllFlagOverrides();
      reinitFlagBackend();
      publishFlagChange(null);
      return Response.json({ ok: true, preset: 'production', testingFeatures: false, clearedOverrides });
    }
    const cfg = readConfig();
    cfg.testingFeatures = true;
    writeConfig(cfg);
    resetPosthogConfigForTest();
    reinitFlagBackend();
    const results: Record<string, boolean | string> = {};
    for (const key of ALL_FLAG_KEYS) {
      const r = await setFlag(key, true);
      results[key] = r.ok ? true : r.reason;
    }
    publishFlagChange(null);
    return Response.json({
      ok: true,
      preset: 'testing',
      testingFeatures: true,
      results,
    });
  },
});
