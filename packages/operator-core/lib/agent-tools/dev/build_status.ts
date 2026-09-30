/**
 * dev:build_status — local-host build + service reachability check.
 *
 * Reads .next mtime, tails the prod log, and probes :3055 / :3070.
 * Used by the /dev right rail and the future Build block.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { buildStatus, flagFlakeSuspects, testFlakeRollup } from '../../dev-data';
import { buildKey } from '../../events/await/catalog';

const TOOL_NAME = 'dev:build_status';

/**
 * Keep the default build panel result below the generic result-door budget.
 * The door itself is a transport backstop; this smaller domain budget keeps the
 * default response parseable for JSON-speaking callers such as ptool.
 */
export const BUILD_STATUS_RESPONSE_BUDGET_CHARS = 5_000;
const BUILD_STATUS_LOG_TAIL_CHARS = 1_200;
const BUILD_STATUS_TIGHT_LOG_TAIL_CHARS = 600;
const BUILD_STATUS_TEXT_CHARS = 360;
const BUILD_STATUS_TIGHT_TEXT_CHARS = 180;
const BUILD_STATUS_ARRAY_LIMIT = 8;
const BUILD_STATUS_TIGHT_ARRAY_LIMIT = 3;

type JsonRecord = Record<string, unknown>;

function serializedChars(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' ? serialized.length : Number.MAX_SAFE_INTEGER;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function clipBuildText(value: unknown, maxChars: number): unknown {
  if (typeof value !== 'string' || value.length <= maxChars) return value;
  const omitted = value.length - maxChars;
  const suffix = `…[truncated +${omitted} chars]`;
  return value.slice(0, Math.max(0, maxChars - suffix.length)) + suffix;
}

function compactBuildValue(
  value: unknown,
  opts: { textChars: number; arrayLimit: number; depth?: number },
): unknown {
  const depth = opts.depth ?? 0;
  if (typeof value === 'string') return clipBuildText(value, opts.textChars);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 3) return '[nested detail omitted; use fullRead]';
  if (Array.isArray(value)) {
    return value
      .slice(0, opts.arrayLimit)
      .map((entry) => compactBuildValue(entry, { ...opts, depth: depth + 1 }));
  }
  const out: JsonRecord = {};
  for (const [key, entry] of Object.entries(value as JsonRecord).slice(0, 16)) {
    out[key] = compactBuildValue(entry, { ...opts, depth: depth + 1 });
  }
  return out;
}

function compactFlakeSuspect(value: unknown, textChars: number): JsonRecord | unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return compactBuildValue(value, { textChars, arrayLimit: BUILD_STATUS_TIGHT_ARRAY_LIMIT });
  }
  const source = value as JsonRecord;
  const out: JsonRecord = {};
  for (const field of [
    'file_path', 'fails', 'passes', 'both_status_shas', 'flake_rate',
    'last_fail', 'last_pass', 'reason',
  ]) {
    if (source[field] !== undefined) {
      out[field] = compactBuildValue(source[field], {
        textChars,
        arrayLimit: BUILD_STATUS_TIGHT_ARRAY_LIMIT,
      });
    }
  }
  return out;
}

function compactBuildStatus(
  payload: JsonRecord,
  opts: { logTailChars: number; textChars: number; arrayLimit: number },
): { data: JsonRecord; clippedFields: string[] } {
  const data: JsonRecord = {};
  const clippedFields: string[] = [];

  for (const field of ['prodBuild', 'devBuild', 'dev3055Reachable', 'prod3070Reachable']) {
    if (payload[field] !== undefined) data[field] = compactBuildValue(payload[field], opts);
  }

  if ('prodLogTail' in payload) {
    data.prodLogTail = clipBuildText(payload.prodLogTail, opts.logTailChars);
    if (typeof payload.prodLogTail === 'string' && payload.prodLogTail.length > opts.logTailChars) {
      data.prodLogTail_truncated = true;
      data.prodLogTail_full_chars = payload.prodLogTail.length;
      clippedFields.push('prodLogTail');
    }
  }

  const suspects = payload.flake_suspects;
  if (Array.isArray(suspects)) {
    data.flake_suspects = suspects
      .slice(0, opts.arrayLimit)
      .map((suspect) => compactFlakeSuspect(suspect, opts.textChars));
    if (suspects.length > opts.arrayLimit) {
      data.flake_suspects_total = suspects.length;
      data.flake_suspects_truncated = true;
      clippedFields.push('flake_suspects');
    }
  }

  if ('awaitable' in payload) {
    data.awaitable = compactBuildValue(payload.awaitable, {
      textChars: opts.textChars,
      arrayLimit: opts.arrayLimit,
    });
  }

  return { data, clippedFields };
}

/**
 * Shape the default build-status read before it reaches the generic result
 * door. Small responses retain their historical shape; oversized responses
 * carry explicit clipping metadata and a full-detail re-read path.
 */
export function shapeBuildStatus(
  payload: JsonRecord,
  rereadArgs: { harness?: string } = {},
  opts: { unbounded?: boolean } = {},
): JsonRecord {
  const originalChars = serializedChars(payload);
  if (opts.unbounded || originalChars <= BUILD_STATUS_RESPONSE_BUDGET_CHARS) return payload;

  const fullReadArgs: JsonRecord = { detail: 'full' };
  if (rereadArgs.harness !== undefined) fullReadArgs.harness = rereadArgs.harness;
  const fullRead = { tool: TOOL_NAME, args: fullReadArgs };
  const note =
    `Response was bounded from ${originalChars} to fit the ${BUILD_STATUS_RESPONSE_BUDGET_CHARS}-character ` +
    'build-status read budget; clipped fields carry their own *_truncated/full_chars metadata. ' +
    `Re-call ${TOOL_NAME} with the args in \`projection.fullRead\` for complete detail.`;

  const makeCandidate = (optsForCompact: {
    logTailChars: number;
    textChars: number;
    arrayLimit: number;
  }): JsonRecord => {
    const compacted = compactBuildStatus(payload, optsForCompact);
    const omittedFields = Object.keys(payload).filter((field) => !(field in compacted.data));
    for (const field of compacted.clippedFields) {
      if (!omittedFields.includes(field)) omittedFields.push(field);
    }
    const shaped: JsonRecord = {
      ...compacted.data,
      projection: {
        kind: 'bounded',
        truncated: true,
        originalChars,
        returnedChars: 0,
        omittedFields,
        fullRead,
      },
      projectionNote: note,
    };
    for (let i = 0; i < 4; i++) {
      (shaped.projection as JsonRecord).returnedChars = serializedChars(shaped);
    }
    return shaped;
  };

  let shaped = makeCandidate({
    logTailChars: BUILD_STATUS_LOG_TAIL_CHARS,
    textChars: BUILD_STATUS_TEXT_CHARS,
    arrayLimit: BUILD_STATUS_ARRAY_LIMIT,
  });
  if (serializedChars(shaped) > BUILD_STATUS_RESPONSE_BUDGET_CHARS) {
    shaped = makeCandidate({
      logTailChars: BUILD_STATUS_TIGHT_LOG_TAIL_CHARS,
      textChars: BUILD_STATUS_TIGHT_TEXT_CHARS,
      arrayLimit: BUILD_STATUS_TIGHT_ARRAY_LIMIT,
    });
  }
  if (serializedChars(shaped) > BUILD_STATUS_RESPONSE_BUDGET_CHARS) {
    shaped = makeCandidate({
      logTailChars: 240,
      textChars: 120,
      arrayLimit: 1,
    });
  }
  if (serializedChars(shaped) > BUILD_STATUS_RESPONSE_BUDGET_CHARS) {
    // The normal payload cannot reach this branch, but keep the invariant true
    // if a future additive field has an unexpectedly large scalar value.
    shaped = makeCandidate({ logTailChars: 120, textChars: 80, arrayLimit: 0 });
  }
  return shaped;
}

export default defineTool({
  name: 'dev:build_status',
  profile: 'engineer',
  description: 'Local-host build mtime + bin/prod log tail + dev/prod server reachability.',
  capability: 'intel:read',
  guidance: {
    when: `Read recent build status from the dev panel — pass/fail per harness.`,
    notWhen: `For ONE harness's smoke tests, use harness-specific tools. dev:build_status is the cross-harness dev panel feed.`,
    seeAlso: [
      'dev:service_health (live service health)',
      'dev:pipeline_position (where an edit is in the deploy pipeline)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger', 'cup'],
  args: z.object({
    // Harness-scoped callers commonly pass their ambient harness to every
    // diagnostic read. Build status is intentionally workspace-wide, so this
    // compatibility field is accepted but does not filter the result.
    harness: z
      .string()
      .max(120)
      .optional()
      .describe('Optional ambient harness label accepted for compatibility; this cross-workspace feed is not filtered by it.'),
    detail: z
      .enum(['summary', 'full'])
      .optional()
      .describe('Default summary is bounded for JSON callers; pass full only when complete diagnostic detail is required.'),
  }),
  async handler(args) {
    const result = await buildStatus();
    // event-await-discoverability P-001: if you're re-reading this to see a build/
    // deploy finish, sleep on the event instead of polling the panel.
    const awaitable = {
      hint: 'Waiting on a build/deploy? Don\'t re-poll — events:await the deploy or the gate (or use deploy:await / checkpoint:await), then END YOUR TURN. Full list: events:catalog.',
      events: [buildKey('deploy'), buildKey('checkpoint')],
      sugar: ['deploy:await', 'checkpoint:await'],
    };
    // Flake-suspect detector (EI-7443): surface statistically-identifiable repeat
    // flakes (fails >= 5 AND >= 2 commits with BOTH a pass and a fail) so a
    // release-fixer sees flake-vs-regression up front instead of re-deriving it
    // from scratch on every red gate. Additive — best-effort, never blocks the
    // existing build-status response on a PG hiccup.
    let flakeSuspects: ReturnType<typeof flagFlakeSuspects> = [];
    try {
      const { entries } = await testFlakeRollup(7);
      flakeSuspects = flagFlakeSuspects(entries, 7);
    } catch (err) {
      console.warn(
        `[dev:build_status] flake-suspect scan skipped (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return {
      data: shapeBuildStatus(
        { ...result, flake_suspects: flakeSuspects, awaitable },
        { harness: args.harness },
        { unbounded: args.detail === 'full' },
      ),
    };
  },
});
