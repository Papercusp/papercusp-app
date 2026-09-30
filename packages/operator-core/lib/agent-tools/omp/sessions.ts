/**
 * omp:sessions — local OMP session-history inspector.
 *
 * Operator and OMP always run on the same workstation, so this tool exposes
 * the JSONL session archive under ~/.omp/agent/sessions through the same
 * papercusp-su tool surface as the rest of our agent coordination tools.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import {
  getOmpSessionState,
  listOmpSessions,
  ompSessionsRoot,
  readOmpSession,
  searchOmpSessions,
} from '../../omp-sessions';
import { setAdvSessionOmpThreadId } from '../../adv-sessions';

const RefShape = {
  sessionId: z.string().min(1).optional(),
  filePath: z.string().min(1).optional(),
} as const;

/**
 * The OMP hook includes its working directory when it links an ADV session.
 * Keep that payload contract next to the tool schema so hook-side contract
 * tests can validate the exact emitted shape against the server's parser.
 */
export const ompSessionsLinkArgsSchema = z.object({
  op: z.literal('link'),
  advSessionId: z.number().int().positive(),
  sessionId: z.string().min(1),
  filePath: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
}).strict();

export default defineTool({
  name: 'omp:sessions',
  profile: 'engineer',
  guidance: {
    when: `Inspect local OMP session history: op='list'` +
      ` to find a session id, op='state'/'get'` +
      ` to read it (op='get' accepts sessionId/filePath and limit only)` +
      ` — for continuing a compacted/handed-off session or debugging an overnight OMP agent.` +
      ` For CONTENT search prefer sessions:search (indexed, ranked, cross-client, with context windows);` +
      ` op='search' here is a raw substring grep over the local OMP JSONL archive, for the un-indexed tail or when the index is off.` +
      ` For indexed context-window reads use sessions:read, not omp:sessions op='get'.`,
    notWhen: `Searching transcript CONTENT across clients → sessions:search / search:* (indexed), not op='search'.` +
      ` For Papercusp harness runs stored in Postgres, use the harness/agent_chats/plans tools first.` +
      ` omp:sessions is specifically the local OMP JSONL transcript archive on this workstation.` +
      ` Do not pass context to op='get' or op='state'; context is supported here only by op='search'.` +
      ` For indexed surrounding turns use sessions:read.`,
    chaining: `op='list' → op='state' (compact structured state) or op='get' (bounded raw entries).` +
      ` For content search use sessions:search { query } (indexed) rather than op='search'.` +
      ` To read indexed surrounding turns, chain sessions:search → sessions:read { ref, context? }.`,
    seeAlso: [
      'sessions:search (indexed cross-client content search — prefer for CONTENT)',
      'sessions:list (unified enumeration)',
      'dev:omp_session (inspect a live OMP session state)',
      'omp:config (OMP CLI config)',
    ],
  },
  description: 'List, search, read, and summarize local OMP session JSONL files.',
  capability: 'omp:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 100 }, debugger: { perRun: 100 } },
  args: z.discriminatedUnion('op', [
    z.object({
      op: z.literal('list'),
      limit: z.number().int().positive().max(1000).optional(),
      query: z.string().min(1).optional(),
      cwd: z.string().min(1).optional(),
    }),
    z.object({
      op: z.literal('search'),
      query: z.string().min(1),
      sessionId: z.string().min(1).optional(),
      filePath: z.string().min(1).optional(),
      cwd: z.string().min(1).optional(),
      limit: z.number().int().positive().max(250).optional(),
      context: z.number().int().min(0).max(3).optional(),
    }),
    z.object({
      op: z.literal('get'),
      ...RefShape,
      limit: z.number().int().positive().max(5000).optional(),
    }),
    z.object({
      op: z.literal('state'),
      ...RefShape,
    }),
    ompSessionsLinkArgsSchema,
  ]),
  async handler(args) {
    if (args.op === 'list') {
      const sessions = listOmpSessions({
        limit: args.limit,
        query: args.query,
        cwd: args.cwd,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, root: ompSessionsRoot(), sessions }) }],
      };
    }

    if (args.op === 'search') {
      const result = searchOmpSessions({
        query: args.query,
        sessionId: args.sessionId,
        filePath: args.filePath,
        cwd: args.cwd,
        limit: args.limit,
        context: args.context,
      });
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, root: ompSessionsRoot(), ...result }) }] };
    }

    if (args.op === 'get') {
      const result = readOmpSession({
        id: args.sessionId,
        filePath: args.filePath,
        limit: args.limit,
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result ? { ok: true, ...result } : { ok: false, error: 'session_not_found' }),
          },
        ],
      };
    }

    if (args.op === 'link') {
      const linkResult = await setAdvSessionOmpThreadId(args.advSessionId, args.sessionId);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: linkResult === 'linked' || linkResult === 'already_linked',
              advSessionId: args.advSessionId,
              sessionId: args.sessionId,
              filePath: args.filePath ?? null,
              result: linkResult,
              ...(linkResult === 'conflict' ? { error: 'adv_session_already_linked_to_different_omp_session' } : {}),
              ...(linkResult === 'not_found' ? { error: 'adv_session_not_found' } : {}),
            }),
          },
        ],
      };
    }
    const state = getOmpSessionState({ id: args.sessionId, filePath: args.filePath });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(state ? { ok: true, state } : { ok: false, error: 'session_not_found' }),
        },
      ],
    };
  },
});
