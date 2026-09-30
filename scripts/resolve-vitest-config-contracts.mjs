#!/usr/bin/env node
/**
 * Native-Node bridge for lint:tests' resolved Vitest include/exclude audit.
 *
 * The caller batches every distinct route config into one stdin payload. Keep
 * stdout tolerant of config-module chatter: the final marker is the only
 * machine-readable line the caller consumes.
 */

import { resolveConfig } from 'vitest/node';

const MARKER = 'PC_VITEST_CONFIG_CONTRACTS=';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const input = JSON.parse(await readStdin());
const requests = Array.isArray(input.requests) ? input.requests : [];
const results = [];

for (const request of requests) {
  try {
    const { vitestConfig } = await resolveConfig({
      root: request.root,
      config: request.config,
    });
    results.push({
      ok: true,
      config: {
        root: vitestConfig.root,
        ...(vitestConfig.dir ? { dir: vitestConfig.dir } : {}),
        include: vitestConfig.include,
        exclude: vitestConfig.exclude,
      },
    });
  } catch (error) {
    results.push({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

process.stdout.write(`${MARKER}${JSON.stringify({ results })}\n`);
