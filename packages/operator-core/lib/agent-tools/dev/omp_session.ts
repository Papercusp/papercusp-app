/**
 * dev:omp_session — find + read the omp session file for a spawn_id.
 *
 * Two modes:
 *   - mode='find'  → returns { id, filePath, cwd, timestamp, matchKind, timeDriftMs }
 *                    matchKind tells the caller how confident the link is.
 *   - mode='read'  → returns { header, turns[], totalLines, truncated }
 *                    pass filePath OR spawnId (which will resolve first).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { findOmpSessionForSpawn, readOmpSession } from '../../omp-sessions';

export default defineTool({
  name: 'dev:omp_session',
  profile: 'engineer',
  description:
    'Find and read the omp session JSONL file for a spawn_id, by cwd + start-time match against ~/.omp/agent/sessions/.',
  capability: 'intel:read',
  guidance: {
    when: `Inspect an OMP CLI session's state — useful when debugging long-running CLI flows.`,
    notWhen: `For PRODUCTION agent runs, the orchestrator owns sessions. dev:omp_session is the CLI-tool inspector.`,
    seeAlso: [
      'dev:claude_session (Claude Code session inspector)',
      'dev:sessions (production orchestrator sessions)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger', 'cup'],
  args: z.object({
    spawnId: z.string().min(1).optional(),
    filePath: z.string().min(1).optional(),
    mode: z.enum(['find', 'read']).optional(),
    limit: z.number().int().positive().max(5000).optional(),
    windowMs: z.number().int().positive().max(600_000).optional(),
  }),
  async handler(args) {
    const mode = args.mode ?? (args.filePath ? 'read' : 'find');

    if (mode === 'find') {
      if (!args.spawnId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'spawnId required for find' }) }],
        };
      }
      const result = await findOmpSessionForSpawn(args.spawnId, args.windowMs ?? 60_000);
      return {
        content: [
          { type: 'text', text: JSON.stringify(result ?? { error: 'no match' }) },
        ],
      };
    }

    // mode === 'read'
    let filePath = args.filePath;
    if (!filePath) {
      if (!args.spawnId) {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ error: 'spawnId or filePath required' }) },
          ],
        };
      }
      const found = await findOmpSessionForSpawn(args.spawnId, args.windowMs ?? 60_000);
      if (!found) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'no session found' }) }],
        };
      }
      filePath = found.filePath;
    }
    const result = readOmpSession({ filePath, limit: args.limit });
    if (!result) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'unreadable session file' }) }],
      };
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
});
