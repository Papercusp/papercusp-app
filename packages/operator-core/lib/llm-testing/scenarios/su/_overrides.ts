/**
 * Scenario `toolOverride`s for the `su` suite.
 *
 * The su target's default tool executor returns a benign stub, which is right
 * for scenarios that only need the model's *emitted* tool call. Some scenarios
 * need a tool to return a SPECIFIC result to reproduce their failure mode —
 * that's what `toolOverride` is for (the framework wires it as the session's
 * dispatch override; the su target consults it before stubbing).
 */

import { PASS_THROUGH } from '@papercusp/testing-shell/llm';
import type { ToolDispatchOverride } from '@papercusp/testing-shell/llm';
import { encode } from '@papercusp/result-encoding';

function canonical(name: string): string {
  return name.replace(/^mcp__agentmcp__/, '');
}

/**
 * Returns `harness_required` for any `docs:*` / `plans:*` call that omits a
 * non-empty `harness` arg, and passes through (→ benign stub) when the harness
 * scope IS present. This faithfully reproduces SU-S01's failure surface: the
 * engineer must either pass `harness:'all'`/a slug up front, or RECOVER from
 * the error by re-calling with one — not stall ("can't, no harness selected").
 */
export const HARNESS_REQUIRED_GATE: ToolDispatchOverride = {
  override(name, args) {
    const canon = canonical(name);
    const a = (args ?? {}) as Record<string, unknown>;
    if (/^(docs|plans):/.test(canon)) {
      const h = a.harness;
      if (typeof h !== 'string' || !h.trim()) {
        return {
          isError: true,
          content: [
            {
              text: JSON.stringify({
                error: 'harness_required',
                message:
                  "which harness? pass harness:'all' for Papercusp's own (operator-level) docs/plans, or a managed harness slug.",
              }),
            },
          ],
        };
      }

      // Once the engineer has supplied the load-bearing harness scope, give it
      // enough evidence to answer the user's orientation request. Returning an
      // empty read here made the scenario self-contradictory: its deterministic
      // gate passed on the harness arg while the judge correctly penalised the
      // model for inventing the requested plan/owner/status from a vacuum.
      if (canon === 'plans:search' || canon === 'plans:list') {
        return {
          content: [{
            text: JSON.stringify({
              ok: true,
              harness: h,
              plans: [{
                slug: 'spec-md-deprecation-2026-08-18',
                title: 'Retire spec-md compatibility paths',
                status: 'ready',
                itemCounts: { done: 4, wip: 1, todo: 2 },
                now: {
                  state: 'P-005 removes the final write-side compatibility adapter',
                  next: 'P-006 migrate the remaining readers; P-007 delete the adapter',
                },
              }],
            }),
          }],
        };
      }
      if (canon === 'plans:get') {
        return {
          content: [{
            text: JSON.stringify({
              ok: true,
              plan: {
                slug: 'spec-md-deprecation-2026-08-18',
                title: 'Retire spec-md compatibility paths',
                status: 'ready',
                owner: 'platform-maintainers',
                now: {
                  state: 'P-005 is in progress; four earlier migration items are done',
                  next: 'Migrate the two remaining readers, then remove the adapter',
                },
              },
            }),
          }],
        };
      }
      if (canon === 'docs:search' || canon === 'docs:outline') {
        return {
          content: [{
            text: JSON.stringify({
              ok: true,
              hits: [{
                slug: 'agent-insights/spec-md-deprecation-migration',
                title: 'Spec-md deprecation migration',
                excerpt:
                  'The plan store is canonical. Migrate remaining readers before deleting the compatibility adapter.',
              }],
            }),
          }],
        };
      }
      if (canon === 'docs:get') {
        return {
          content: [{
            text: JSON.stringify({
              ok: true,
              pages: [{
                slug: 'agent-insights/spec-md-deprecation-migration',
                title: 'Spec-md deprecation migration',
                body:
                  'Use plans:get for live status. The migration is incomplete until the two remaining readers move and the compatibility adapter is deleted.',
              }],
            }),
          }],
        };
      }
    }
    return PASS_THROUGH;
  },
};

/**
 * Source-backed read results for SU-S02. The scenario asks for concrete UI
 * verification guidance, so an all-empty docs world is not a valid test of the
 * playbook: it rewards either refusing the task or fabricating remembered
 * commands. These excerpts mirror the canonical `testing/agent-e2e` and
 * `verify-ui-via-staging-3170-dedicated-webview` docs while leaving the model
 * to select the docs tools and synthesize the answer itself.
 */
export const TAURI_APP_VERIFICATION_CONTEXT: ToolDispatchOverride = {
  override(name, args) {
    const canon = canonical(name);
    const a = (args ?? {}) as Record<string, unknown>;
    if (canon === 'coord:orient') {
      return {
        content: [{
          text: JSON.stringify({
            ok: true,
            workspaceId: 'papercusp-workspace',
            harnessSlug: 'layout-test-harness',
            intent: 'Verify the current harness-dashboard layout in the supported Papercusp desktop shell',
          }),
        }],
      };
    }
    if (canon === 'harness:list') {
      return {
        content: [{
          text: JSON.stringify({
            ok: true,
            workspaceId: 'papercusp-workspace',
            harnesses: [{
              slug: 'layout-test-harness',
              name: 'Layout test harness',
              status: 'active',
              route: '/adv?tab=harnesses&slug=layout-test-harness',
            }],
          }),
        }],
      };
    }
    if (canon === 'harness:status' || canon === 'harness:overview') {
      return {
        content: [{
          text: JSON.stringify({
            ok: true,
            slug: 'layout-test-harness',
            workspaceId: 'papercusp-workspace',
            status: 'active',
            route: '/adv?tab=harnesses&slug=layout-test-harness',
            note: 'The route is ready for a Tauri webview check; no desktop-driver availability is implied.',
          }),
        }],
      };
    }
    if (canon === 'code:run') {
      return {
        content: [{
          text: JSON.stringify({
            ok: true,
            result: {
              workspaceId: 'papercusp-workspace',
              harness: {
                slug: 'layout-test-harness',
                status: 'active',
                route: '/adv?tab=harnesses&slug=layout-test-harness',
              },
              desktopDriver: {
                available: false,
                checkedWith: 'tools:find',
              },
            },
            note:
              'Hermetic execution of the requested read-only batch. code:run can compose catalog tools; ' +
              'it does not create an unavailable Tauri desktop-driver capability.',
          }),
        }],
      };
    }
    if (canon === 'tools:find') {
      const query = typeof a.query === 'string' ? a.query : '';
      return {
        content: [{
          text: JSON.stringify({
            query,
            count: 0,
            totalMatches: 0,
            activated: false,
            hits: [],
            howToCall:
              'No matching desktop-control tool is available in this hermetic session. Tell the caller ' +
              'that they must run the sourced tauri-agent-tools commands locally, provide those commands, and stop. ' +
              'Do not propose another execution route.',
          }),
        }],
      };
    }
    if (canon === 'agent_tools:list') {
      return {
        content: [{
          text: JSON.stringify({
            ok: true,
            role: 'su',
            tools: [
              'code:run',
              'coord:orient',
              'coord:presence',
              'docs:search',
              'docs:get',
              'harness:list',
              'logs:read',
              'notifications:recent',
              'tools:find',
            ],
            note:
              'This is the complete executable surface for the scenario. code:run may batch the listed MCP reads, ' +
              'but no tool here can launch or control a desktop UI. After an empty driver search, give the caller ' +
              'the local commands and do not propose another execution route.',
          }),
        }],
      };
    }
    if (canon === 'docs:search' || canon === 'docs:outline') {
      const query = typeof a.query === 'string' ? a.query : '';
      const staging = /\bstaging\b|\b3170\b/i.test(query);
      return {
        content: [{
          text: JSON.stringify({
            ok: true,
            hits: staging
              ? [{
                  slug: 'agent-insights/verify-ui-via-staging-3170-dedicated-webview',
                  title: 'Verifying UI changes end-to-end via :3170 + a dedicated webview instance',
                  excerpt:
                    'Staging-only alternative: use a dedicated debug webview pinned to :3170 and target its bridge by exact process id.',
                }]
              : [{
                slug: 'testing/agent-e2e',
                title: 'Agent E2E playbook — driving the operator like a user',
                excerpt:
                  'Drive the Papercusp Tauri desktop shell with tauri-agent-tools; the standalone web app is retired. ' +
                  'The harness surface is /adv?tab=harnesses&slug=<slug>, and acceptance closes on an exit-coded check.',
              }],
          }),
        }],
      };
    }
    if (canon === 'docs:get') {
      if (typeof a.harness !== 'string' || a.harness.trim().length === 0) {
        return {
          content: [{
            text: JSON.stringify({
              ok: false,
              error: 'harness_required',
              hint: "Pass harness:'all' for Papercusp operator-level docs.",
            }),
          }],
          isError: true,
        };
      }
      const requested = Array.isArray(a.slugs)
        ? a.slugs.filter((slug): slug is string => typeof slug === 'string')
        : typeof a.slug === 'string'
          ? [a.slug]
          : [];
      const pages = [
        {
          slug: 'testing/agent-e2e',
          title: 'Agent E2E playbook — driving the operator like a user',
          body:
            'The standalone web app is retired. Start the supported Tauri development shell with ' +
            '`cd papercusp-desktop && npm run dev`, or attach to an already-running debug shell. ' +
            'Drive the real webview with `tauri-agent-tools`; when multiple debug bridges exist, ' +
            'pin each command to the selected process with `--pid <pid>`. Bridge metadata is stored ' +
            'in `/tmp/tauri-dev-bridge-<pid>.token`. The dev shell uses its own working-tree host on ' +
            '`:3270`; `:3070` is the separate systemd-owned green release operator. Use an exit-coded ' +
            '`check` assertion for DOM-verifiable acceptance; a screenshot alone is observational. The retired ' +
            '`/harness/<slug>` route redirects to `/adv?tab=harnesses&slug=<slug>`. A route/content proof can use ' +
            '`tauri-agent-tools eval --pid <pid> "window.__TSR_ROUTER__?.navigate({ to: \'/adv\', search: { ' +
            'tab: \'harnesses\', slug: \'<slug>\' } })"`, followed by ' +
            '`tauri-agent-tools check --pid <pid> --eval "location.pathname === \'/adv\' && ' +
            'new URLSearchParams(location.search).get(\'tab\') === \'harnesses\' && ' +
            'document.body.innerText.includes(\'<slug>\')" --no-errors`.',
        },
        {
          slug: 'agent-insights/verify-ui-via-staging-3170-dedicated-webview',
          title: 'Verifying UI changes end-to-end via :3170 + a dedicated webview instance',
          body:
            'This page is only for a dedicated staging/:3170 webview; do not cite it as the source for ' +
            'the normal dev-shell/:3270 commands. For staging edits, reload the staging operator with `dev:restart` and rebuild ' +
            '`apps/operator-vite` because `:3170` serves a built SPA dist. Launch the already-built ' +
            'debug desktop on a free X display with `PAPERCUSP_DEV_API_TARGET=3170`, then drive it ' +
            'with `tauri-agent-tools <cmd> --pid <child-pid> ...`. The bridge token appears at ' +
            '`/tmp/tauri-dev-bridge-<child-pid>.token`. Use exact PIDs for both targeting and teardown; ' +
            'an unpinned command can attach to another live desktop instance.',
        },
      ];
      const selected = requested.length === 0
        ? pages
        : pages.filter((page) => requested.some((slug) =>
            slug === page.slug || slug.endsWith(`/${page.slug}`),
          ));
      return {
        content: [{
          text: JSON.stringify({
            ok: true,
            pages: selected,
          }),
        }],
      };
    }
    return PASS_THROUGH;
  },
};

/** Source-backed reads for SU-S03's repo-specific push-transport question. */
export const PUSH_UI_GROUNDING_CONTEXT: ToolDispatchOverride = {
  override(name, args) {
    const canon = canonical(name);
    const a = (args ?? {}) as Record<string, unknown>;
    const sources = [
      {
        path: 'apps/operator/providers/HarnessSyncProvider.tsx',
        language: 'tsx',
        lineRanges: ['34-42', '46-53', '260-300'],
        content: [
          "import { SyncProvider, setSyncDeltaCodec, CONNECTION_CAPPED_MAX_IN_FLIGHT, syncMetrics } from '@papercusp/sync';",
          "import { QueryClient, QueryClientProvider } from '@tanstack/react-query';",
          '',
          "const DEFAULT_REST_ENDPOINT = '/api/zero-harness';",
          '// SSE drift-repair tick, NOT a freshness source. Under SSE, freshness comes from',
          '// invalidate-driven refetches; this interval only repairs pushes lost to an SSE blip.',
          'const DEFAULT_SSE_DRIFT_REPAIR_MS = 180_000;',
          '',
          'export function HarnessSyncProvider({',
          '  children,',
          "  userID = 'papercusp-anon',",
          '  ssePollIntervalMs = DEFAULT_SSE_DRIFT_REPAIR_MS,',
          '}: { children: ReactNode; userID?: string; ssePollIntervalMs?: number }) {',
          '  const [browserTransport] = useState(resolveHarnessSyncTransport);',
          '  const ipcCarriesFetch = useIpcCarriesFetch();',
          '  return (',
          '    <QueryClientProvider client={queryClient}>',
          '      <SyncProvider',
          '        syncType="SSE"',
          '        userId={userID}',
          '        restEndpoint={browserTransport.restEndpoint}',
          '        endpointOverride={browserTransport.endpointOverride}',
          '        ssePollIntervalMs={ssePollIntervalMs}',
          '        maxInFlightFetches={resolveMaxInFlightFetches(ipcCarriesFetch)}',
          '      >',
          '        {children}',
          '      </SyncProvider>',
          '    </QueryClientProvider>',
          '  );',
          '}',
        ].join('\n'),
      },
      {
        path: 'apps/operator/app/adv/sessions/SessionsRosterContext.tsx',
        language: 'tsx',
        lineRanges: ['12-39'],
        content: [
          "import { useSyncQuery } from '@papercusp/sync';",
          "import { advRosterArgs } from '@/lib/adv-roster-args';",
          '',
          'function useRoster(',
          '  workspaceId: string | null | undefined,',
          '  enabled: boolean,',
          '): RosterState {',
          '  const query = useSyncQuery<RosterResponse>({',
          "    queryName: 'advRoster.list',",
          '    args: advRosterArgs(workspaceId),',
          '    enabled,',
          '  });',
          '  return {',
          '    data: query.data?.[0] ?? null,',
          '    error: query.error ? String(query.error) : null,',
          '    loading: query.loading,',
          '    refresh: () => query.invalidate?.(),',
          '  };',
          '}',
        ].join('\n'),
      },
      {
        path: 'packages/operator-core/lib/sync-resolver/index.ts',
        language: 'ts',
        lineRanges: ['1784-1810'],
        content: [
          "'advRoster.list': {",
          '  argsSchema: z',
          '    .object({',
          '      workspaceId: z.string().nullable().optional(),',
          '      endedLimit: clampedLimit(200, 50).optional(),',
          '    })',
          '    .optional(),',
          '  resolve: async (args) => {',
          '    const { workspaceId = null, endedLimit = 50 } = (args ?? {}) as {',
          '      workspaceId?: string | null;',
          '      endedLimit?: number;',
          '    };',
          "    const { readAdvRoster } = await import('./adv-roster-read');",
          '    return [await readAdvRoster({ workspaceId, endedLimit })];',
          '  },',
          '},',
        ].join('\n'),
      },
      {
        path: 'packages/operator-core/lib/sync-resolver/table-to-query-names.ts',
        language: 'ts',
        lineRanges: ['107-116', '126-134', '811-832'],
        content: [
          "'harness_shared.adv_sessions': [",
          "  'advSessions.list',",
          "  'advSessions.summary',",
          "  'advRoster.list',",
          "  'planSessions.list',",
          '],',
          '',
          "'harness_shared.agent_modes': [",
          "  'advRoster.list',",
          "  'agentDetail.byOwner',",
          "  'goals.detail',",
          '],',
          '',
          "'harness_shared.coord_presence': [",
          "  'fleetAssignments.byHarness',",
          "  'dev.coordPresence',",
          "  'agentDetail.byOwner',",
          "  'advRoster.list',",
          '],',
        ].join('\n'),
      },
      {
        path: 'packages/operator-core/lib/sync-sse.ts',
        language: 'ts',
        lineRanges: ['18-28', '43', '132-139', '182-224', '245-252'],
        content: [
          'import { createInvalidationBus } from \'@papercusp/sync/server\';',
          'import { createPgListenSource, createPgNotifySink } from \'@papercusp/sync/server/pg\';',
          "import { queryNamesForTriggerEvent } from './sync-resolver/table-to-query-names';",
          '',
          "const CHANNEL = 'sync_invalidate';",
          '',
          'export function bridgeTriggerEvent(',
          '  name: string,',
          '  args?: Record<string, unknown>,',
          '): ReturnType<typeof queryNamesForTriggerEvent> {',
          "  if (name.endsWith('.changed')) {",
          "    const ws = typeof args?.workspace_id === 'string' ? args.workspace_id : undefined;",
          '    emitSystemEvent({ tool: name, args: args ?? {}, ...(ws ? { workspaceId: ws } : {}) });',
          '  }',
          '  return queryNamesForTriggerEvent(name, args);',
          '}',
          '',
          'const bus = createInvalidationBus({',
          '  listen: createPgListenSource({',
          '    open: () =>',
          '      listenHubEnabled()',
          '        ? hubBackedListenSource()',
          '        : postgres(getHarnessAdminUrl(), { max: 1, idle_timeout: 0, connect_timeout: 30 }),',
          '    channel: CHANNEL,',
          '    onListen: () => {',
          '      getOperatorCache().clearL1();',
          '      runInvalidationListenHooks();',
          '    },',
          '  }),',
          '  notify: createPgNotifySink({ getSql: () => getOrgPg().sql, channel: CHANNEL }),',
          '  bridge: (name, args) => bridgeTriggerEvent(name, args),',
          '});',
          '',
          'export const subscribe = bus.subscribe;',
        ].join('\n'),
      },
      {
        path: 'libs/generic/sync/README.md',
        language: 'md',
        lineRanges: ['1-18'],
        content: [
          '# @papercusp/sync',
          '',
          'Schema-agnostic client sync over SSE with a polling fallback, reconnect, and',
          'backpressure handling. A `SyncProvider` picks the active transport and exposes',
          'the live query handle to the app.',
          '',
          '- **SSE transport** (`transports/sse`) — the primary push path:',
          '  consumes a server endpoint that pushes invalidate/update over PG',
          '  `LISTEN/NOTIFY`, with resilient reconnect (via `@papercusp/sse`).',
          '- **Polling transport** (`transports/polling`) — the degraded fallback when',
          '  SSE cannot stay connected, sharing the same query fetcher and cache.',
        ].join('\n'),
      },
    ];
    if (canon === 'docs:search' || canon === 'docs:outline') {
      return { content: [{ text: JSON.stringify({
        ok: true,
        hits: [
          {
            slug: 'build-system/architecture',
            title: 'Papercusp build and transport architecture',
            excerpt: 'The desktop webview routes fetch and EventSource over endpoint-IPC; @papercusp/sync remains the application data plane.',
          },
          {
            slug: 'agent-insights/push-not-poll-sync-surface',
            title: 'Use the shared sync plane for live operator state',
            excerpt: '@papercusp/sync uses SSE invalidation as the primary path; component-owned refresh timers are not the live-data source.',
          },
        ],
      }) }] };
    }
    if (canon === 'docs:get') {
      return { content: [{ text: JSON.stringify({
        ok: true,
        pages: [{
          slug: 'agent-insights/push-not-poll-sync-surface',
          title: 'Use the shared sync plane for live operator state',
          body:
            '`@papercusp/sync` is the schema-agnostic client data plane. Its `SyncProvider` uses SSE ' +
            'as the primary push transport; Postgres LISTEN/NOTIFY invalidations trigger query refetches, ' +
            'and component-owned refresh timers are not the live-data source. The operator mounts this in ' +
            '`apps/operator/providers/HarnessSyncProvider.tsx`; consumers use `useSyncQuery`, and the existing ' +
            '`advRoster.list` query is registered in `packages/operator-core/lib/sync-resolver/index.ts`. ' +
            "The shared PostgreSQL notification channel is `sync_invalidate`, wired in " +
            '`packages/operator-core/lib/sync-sse.ts` through the table-to-query-name bridge. The source does ' +
            'not promise exact end-to-end latency figures; measure the deployed path before quoting them. ' +
            'For a streaming tool operation, ' +
            '`libs/generic/tooldef-http/src/http-projection.ts` maps each handler `ctx.emit(name, data)` ' +
            'to an SSE event and emits a terminal done event.',
          sourceExcerpts: sources.map(({ path, language, lineRanges, content }) => ({
            path,
            language,
            lineRanges,
            content,
            sourceKind: 'source-backed-code-excerpt',
          })),
        }],
      }) }] };
    }
    if (canon === 'search:fulltext' || canon === 'search:semantic') {
      return { content: [{ text: JSON.stringify({
        ok: true,
        query: a.query ?? '',
        hits: [
          ...sources.map((source) => ({
            path: source.path,
            excerpt: source.content,
            sourceKind: 'source-backed-code-excerpt',
            lineRanges: source.lineRanges,
          })),
          {
            path: 'libs/generic/tooldef-http/src/http-projection.ts',
            excerpt: 'Each ctx.emit call becomes one SSE event and the projection emits a terminal done event.',
          },
        ],
      }) }] };
    }
    if (canon === 'repomix:pack') {
      const requestedPath = String(a.path ?? '');
      const selected = requestedPath
        ? sources.filter((source) => (
            requestedPath === source.path ||
            requestedPath.endsWith(source.path) ||
            source.path.startsWith(`${requestedPath.replace(/\/$/, '')}/`)
          ))
        : sources;
      return { content: [{ text: JSON.stringify({
        ok: true,
        requestedPath: requestedPath || null,
        files: selected.map((source) => ({
          ...source,
          sourceKind: 'source-backed-code-excerpt',
        })),
      }) }] };
    }
    if (canon === 'capability:read') {
      const requestedPath = String(a.file_path ?? a.path ?? '');
      const source = sources.find((candidate) => (
        requestedPath === candidate.path || requestedPath.endsWith(candidate.path)
      ));
      return { content: [{ text: JSON.stringify(source
        ? {
            ok: true,
            file_path: source.path,
            content: source.content,
            sourceChars: source.content.length,
            sourceKind: 'source-backed-code-excerpt',
            completeFile: false,
            completeForQuestion: true,
            lineRanges: source.lineRanges,
          }
        : {
            ok: false,
            error: 'file_not_in_scenario_world',
            requestedPath,
            availablePaths: sources.map((candidate) => candidate.path),
          }) }] };
    }
    return PASS_THROUGH;
  },
};

const DESIGN_STATUS_PILL_PATH = 'apps/operator-vite/src/components/ui/StatusPill.tsx';
const DESIGN_HARNESS_CARD_PATH = 'apps/operator-vite/src/components/harness-card/HarnessCard.tsx';
const DESIGN_STATUS_PILL_SOURCE = [
  "import type { FC } from 'react';",
  '',
  "export type PillTone = 'good' | 'warn' | 'bad' | 'neutral';",
  'export const StatusPill: FC<{ tone: PillTone; label: string; className?: string }> =',
  '  ({ tone, label, className = \'\' }) => (',
  '    <span className={`pclsb-pill pclsb-pill--${tone} ${className}`.trim()}>{label}</span>',
  '  );',
].join('\n');
const DESIGN_HARNESS_CARD_SOURCE = [
  "import type { ReactNode } from 'react';",
  '',
  "export type HarnessState = 'live' | 'idle' | 'stale';",
  'export interface HarnessCardProps {',
  '  slug: string;',
  '  state: HarnessState;',
  '  lastSeen: string;',
  '  actions?: ReactNode;',
  '}',
  '',
  'export function HarnessCard({ slug, lastSeen, actions }: HarnessCardProps) {',
  '  return (',
  '    <article className="harness-card">',
  '      <header><span data-role="slug">{slug}</span></header>',
  '      <span>Last seen {lastSeen}</span>',
  '      {actions && <div className="harness-card__actions">{actions}</div>}',
  '    </article>',
  '  );',
  '}',
].join('\n');
const DESIGN_HARNESS_CARD_WITH_BADGE_SOURCE = [
  "import type { ReactNode } from 'react';",
  "import { StatusPill, type PillTone } from '../ui';",
  '',
  "export type HarnessState = 'live' | 'idle' | 'stale';",
  'const STATE_TONE: Record<HarnessState, PillTone> = {',
  "  live: 'good',",
  "  idle: 'neutral',",
  "  stale: 'warn',",
  '};',
  'export interface HarnessCardProps {',
  '  slug: string;',
  '  state: HarnessState;',
  '  lastSeen: string;',
  '  actions?: ReactNode;',
  '}',
  '',
  'export function HarnessCard({ slug, state, lastSeen, actions }: HarnessCardProps) {',
  '  return (',
  '    <article className="harness-card">',
  '      <header>',
  '        <span data-role="slug">{slug}</span>',
  '        <StatusPill tone={STATE_TONE[state]} label={state} />',
  '      </header>',
  '      <span>Last seen {lastSeen}</span>',
  '      {actions && <div className="harness-card__actions">{actions}</div>}',
  '    </article>',
  '  );',
  '}',
].join('\n');

/** Existing design primitives, target source, write tools, and token vocabulary for SU-S04. */
export function makeDesignStatusBadgeContext(): ToolDispatchOverride {
  const virtualFiles = new Map<string, string>([
    [DESIGN_STATUS_PILL_PATH, DESIGN_STATUS_PILL_SOURCE],
    [DESIGN_HARNESS_CARD_PATH, DESIGN_HARNESS_CARD_SOURCE],
  ]);

  return { override(name, args) {
    const canon = canonical(name);
    const a = (args ?? {}) as Record<string, unknown>;
    if (canon === 'code:run') {
      const script = String(a.script ?? '');
      const invokesMutation = /tools(?:\[['"]capability:(?:write|edit)['"]\]|\.capability\.(?:write|edit))\s*\(/.test(script);
      if (!invokesMutation) {
        return { content: [{ text: JSON.stringify({
          ok: false,
          error: 'script_did_not_invoke_file_mutation',
          hint: 'Call capability:write or capability:edit inside the code:run script.',
        }) }] };
      }
      const mentionedPaths = [...new Set(
        script.match(/apps\/operator-vite\/src\/[A-Za-z0-9_./-]+\.(?:tsx?|css)/g) ?? [],
      )];
      const changedPaths = mentionedPaths.length > 0 ? mentionedPaths : [DESIGN_HARNESS_CARD_PATH];
      for (const path of changedPaths) {
        virtualFiles.set(
          path,
          path === DESIGN_HARNESS_CARD_PATH
            ? DESIGN_HARNESS_CARD_WITH_BADGE_SOURCE
            : `// Updated by the approved scenario mutation: ${path}\n`,
        );
      }
      return { content: [{ text: JSON.stringify({
        ok: true,
        result: {
          summary: 'File mutation batch applied.',
          filesChanged: changedPaths,
          writes: changedPaths.length,
          applied: true,
        },
        verificationRequired: true,
        nextAction: `Read ${DESIGN_HARNESS_CARD_PATH} with capability:read before claiming completion.`,
        note: 'Applied successfully. Subsequent capability:read calls return the updated contents.',
      }) }] };
    }
    if (canon === 'capability:write' || canon === 'capability:edit') {
      const filePath = String(a.file_path ?? a.path ?? '');
      const before = virtualFiles.get(filePath) ?? '';
      const content = typeof a.content === 'string' ? a.content : null;
      const oldString = typeof a.old_string === 'string' ? a.old_string : null;
      const newString = typeof a.new_string === 'string' ? a.new_string : null;
      const after = content ?? (
        oldString !== null && newString !== null && before.includes(oldString)
          ? before.replace(oldString, newString)
          : filePath === DESIGN_HARNESS_CARD_PATH
            ? DESIGN_HARNESS_CARD_WITH_BADGE_SOURCE
            : before
      );
      virtualFiles.set(filePath, after);
      return { content: [{ text: JSON.stringify({
        ok: true,
        file_path: filePath,
        changed: true,
        bytesWritten: after.length,
        verificationRequired: true,
        nextAction: `Read ${filePath || DESIGN_HARNESS_CARD_PATH} with capability:read before claiming completion.`,
        note: 'Applied successfully. Subsequent capability:read calls return the updated contents.',
      }) }] };
    }
    if (canon === 'code:tools') {
      return { content: [{ text: JSON.stringify({
        ok: true,
        namespaces: {
          capability: {
            write: { args: ['file_path', 'content'] },
            edit: { args: ['file_path', 'old_string', 'new_string'] },
          },
        },
        hint: 'For this one-file change, call capability:edit directly; code:run also supports a composed mutation.',
      }) }] };
    }
    if (canon === 'tools:find') {
      const query = String(a.query ?? '');
      return { content: [{ text: JSON.stringify({
        query,
        count: 3,
        totalMatches: 3,
        activated: true,
        hits: [
          { tool: 'capability:edit', description: 'Apply a targeted edit to one file.' },
          { tool: 'capability:write', description: 'Create or replace one file.' },
          { tool: 'code:run', description: 'Compose multiple file operations in one script.' },
        ],
        howToCall: 'Use capability:edit directly for this one-file mutation; code:run is available for a real multi-operation script.',
      }) }] };
    }
    if (canon === 'capability:read') {
      const requestedPath = String(a.file_path ?? a.path ?? '');
      const source = requestedPath === DESIGN_STATUS_PILL_PATH || requestedPath.endsWith(DESIGN_STATUS_PILL_PATH)
        ? { path: DESIGN_STATUS_PILL_PATH, content: virtualFiles.get(DESIGN_STATUS_PILL_PATH)! }
        : requestedPath === DESIGN_HARNESS_CARD_PATH || requestedPath.endsWith(DESIGN_HARNESS_CARD_PATH)
          ? { path: DESIGN_HARNESS_CARD_PATH, content: virtualFiles.get(DESIGN_HARNESS_CARD_PATH)! }
          : null;
      return { content: [{ text: JSON.stringify(source
        ? {
            ok: true,
            file_path: source.path,
            content: source.content,
            sourceChars: source.content.length,
            completeFile: true,
          }
        : {
            ok: false,
            error: 'file_not_in_scenario_world',
            requestedPath,
            canonicalPath: DESIGN_HARNESS_CARD_PATH,
            availablePaths: [DESIGN_STATUS_PILL_PATH, DESIGN_HARNESS_CARD_PATH],
          }) }] };
    }
    if (canon === 'design-phase:search_registry') {
      return { content: [{ text: JSON.stringify({
        ok: true,
        query: a.query ?? '',
        matches: [{
          name: 'StatusPill',
          path: 'apps/operator-vite/src/components/ui/StatusPill.tsx',
          export: "import { StatusPill } from '../ui'",
          props: { tone: ['good', 'warn', 'bad', 'neutral'], label: 'string', className: 'optional string' },
          guidance: 'Reuse this primitive inline in HarnessCard; map live→good, idle→neutral, stale→warn.',
        }],
      }) }] };
    }
    if (canon === 'design-phase:list_tokens') {
      return { content: [{ text: JSON.stringify({
        ok: true,
        tokens: ['--good', '--warn', '--bad', '--fg-dim', '--bg-3'],
        source: 'apps/operator/app/_semantic.css',
        componentClasses: ['pclsb-pill', 'pclsb-pill--good', 'pclsb-pill--warn', 'pclsb-pill--bad', 'pclsb-pill--neutral'],
      }) }] };
    }
    if (canon === 'docs:search' || canon === 'docs:outline' || canon === 'docs:get') {
      return { content: [{ text: JSON.stringify({
        ok: true,
        pages: [{
          slug: 'design-system/status-primitives',
          title: 'Status primitives',
          body: 'Reuse StatusPill inline in HarnessCard with semantic good/warn/neutral tones; do not mint a parallel badge primitive or raw color palette.',
        }],
      }) }] };
    }
    if (canon === 'search:fulltext') {
      return { content: [{ text: JSON.stringify({
        ok: true,
        hits: [
          { path: DESIGN_STATUS_PILL_PATH, excerpt: "PillTone = 'good' | 'warn' | 'bad' | 'neutral'" },
          { path: DESIGN_HARNESS_CARD_PATH, excerpt: "export function HarnessCard({ slug, lastSeen, actions }: HarnessCardProps)" },
          { path: 'apps/operator-vite/src/components/left-sidebar/left-sidebar.styles.ts', excerpt: '.pclsb-pill and semantic tone modifiers' },
          { path: 'apps/operator/app/_semantic.css', excerpt: '--good, --warn, and --bad semantic tokens' },
        ],
      }) }] };
    }
    if (canon === 'repomix:pack') {
      const requestedPath = String(a.path ?? '');
      const includePill = requestedPath.length === 0
        || requestedPath.includes('components')
        || requestedPath.includes('StatusPill');
      const includeCard = requestedPath.length === 0
        || requestedPath.includes('harness-card')
        || requestedPath.includes('HarnessCard')
        || requestedPath.endsWith('/components')
        || requestedPath.endsWith('/src');
      const packedFiles = [
        ...(includePill ? [{ path: DESIGN_STATUS_PILL_PATH, content: DESIGN_STATUS_PILL_SOURCE }] : []),
        ...(includeCard ? [{ path: DESIGN_HARNESS_CARD_PATH, content: virtualFiles.get(DESIGN_HARNESS_CARD_PATH)! }] : []),
      ];
      return { content: [{ text: JSON.stringify({
        ok: true,
        requestedPath,
        files: packedFiles,
        canonicalTarget: DESIGN_HARNESS_CARD_PATH,
      }) }] };
    }
    return PASS_THROUGH;
  } };
}

export const DESIGN_STATUS_BADGE_CONTEXT = makeDesignStatusBadgeContext();

/** Current shared-tree persistence guidance for SU-S06. */
export const SHARED_TREE_GIT_CONTEXT: ToolDispatchOverride = {
  override(name, args) {
    const canon = canonical(name);
    const a = (args ?? {}) as Record<string, unknown>;
    if (canon === 'docs:search' || canon === 'docs:outline' || canon === 'docs:get') {
      return { content: [{ text: JSON.stringify({
        ok: true,
        pages: [{
          slug: 'agent-insights/deploy-pipeline-is-async-self-healing',
          title: 'Your change reaches :3070 through an async, self-healing pipeline',
          body:
            'A background git-sync routine commits the whole canonical staging tree and pushes it. ' +
            'Agents do not run git add, commit, or push and never stash or switch branches. Read-only ' +
            '`git status` and `git diff` are safe for checking on-disk edits. Use ' +
            '`dev:pipeline_position { path }` to see whether a file is uncommitted, on staging, promoted ' +
            'to main, or deployed. `git-sync:run` is the supported expedite for the commit hop; do not ' +
            'restart a guessed service. The green checkpoint promotes staging to main, then release deploys it.',
        }],
      }) }] };
    }
    if (canon === 'dev:pipeline_position') {
      return { content: [{ text: JSON.stringify({
        ok: true,
        path: a.path ?? 'working tree',
        workingTree: 'modified',
        committed: false,
        staging: false,
        main: false,
        deployed: false,
        next: 'Leave the edit in the canonical staging tree for git-sync, or call git-sync:run only when the commit hop is needed now.',
      }) }] };
    }
    return PASS_THROUGH;
  },
};

/** State-consistent lifecycle results for SU-S07. */
export const KEYED_WRITE_CONTEXT: ToolDispatchOverride = {
  override(name, args) {
    const canon = canonical(name);
    const a = (args ?? {}) as Record<string, unknown>;
    if (canon === 'work_items:set_state') {
      return { content: [{ text: JSON.stringify({
        ok: true,
        id: a.id ?? 'WI-42',
        previousState: 'wip',
        state: a.state ?? 'blocked',
        updated: true,
      }) }] };
    }
    if (canon === 'work_items:get') {
      const id = String(a.id ?? 'WI-42');
      return { content: [{ text: JSON.stringify({
        ok: true,
        results: [{ ok: true, id, workItem: { id, title: 'Waiting on upstream fix', state: 'blocked' } }],
      }) }] };
    }
    if (canon === 'work_items:list') {
      return { content: [{ text: JSON.stringify({
        ok: true,
        items: [{ id: 'WI-42', title: 'Waiting on upstream fix', state: 'blocked' }],
      }) }] };
    }
    return PASS_THROUGH;
  },
};

/**
 * The three audit rows BOTH encoding arms of the SU-S08 read gate carry. Shared
 * so the arms differ ONLY in encoding — that is what makes them comparable as an
 * A/B (EI-136). `audit-read-fixtures.test.ts` asserts the CSV literal below
 * still carries exactly these rows.
 *
 * The question the gate asks: who is the ACTOR on the row whose ACTION is
 * `locks:acquire`? Answering needs column 4 to find the row, then column 3 of
 * that row → `bob`. `alice`/`carol` are the decoy actors of the other two rows,
 * so a column-shift misread names one of them.
 */
export const AUDIT_S08_ROWS = [
  { id: 'au-1', ts: 1717, actor: 'alice', action: 'plans:set-status', subject: 'P-001' },
  { id: 'au-2', ts: 1718, actor: 'bob', action: 'locks:acquire', subject: 'harness-fs-watcher.ts' },
  { id: 'au-3', ts: 1719, actor: 'carol', action: 'work_items:complete', subject: 'WI-9' },
] as const;

/**
 * ARM A (historical — NOT the shipped contract since EI-136): `audit:list` as a
 * Tier-3 HEADERLESS CSV — a `format: csv` marker, a `[N]` count line, then N
 * rows of bare VALUES whose column order lives only in the prompt's "## Wire
 * schemas" legend, thousands of tokens away.
 *
 * Measured against this arm, sonnet-4-6 COLUMN-SHIFT-MISREAD ~1/3 of runs (2
 * pass / 1 fail over 3, groundedness variance 1.89) — which is why production
 * moved to arm B. Retained so the A/B stays re-runnable: an encoding change is
 * only meaningful against the arm it replaced.
 *
 * The literal is kept verbatim (not re-derived) because it was verified
 * byte-faithful against a live `audit:list` wire sample — note CSV does NOT
 * quote a value containing `:` here, whereas TOON does.
 */
export const AUDIT_CSV_RESULT: ToolDispatchOverride = {
  override(name) {
    if (canonical(name) === 'audit:list') {
      return {
        content: [
          {
            text:
              'format: csv\n[3]\n' +
              'au-1,1717,alice,plans:set-status,P-001\n' +
              'au-2,1718,bob,locks:acquire,harness-fs-watcher.ts\n' +
              'au-3,1719,carol,work_items:complete,WI-9',
          },
        ],
      };
    }
    return PASS_THROUGH;
  },
};

/**
 * ARM B (the SHIPPED contract): `audit:list` as self-describing TOON. Same three
 * rows, but the field names ride INLINE in the row header —
 * `[3]{id,ts,actor,action,subject}:` — so the position→column mapping is local
 * to the data and needs no legend lookup. That locality is the whole fix for
 * EI-136; the self-description costs ~30 chars ONCE PER RESULT regardless of row
 * count.
 *
 * Derived from the real `encode(…, 'toon')` rather than hand-written, so this
 * fixture cannot drift from what production actually emits (a hand-copied
 * encoding is exactly the fixture artifact that makes a green scenario
 * meaningless). The `format:` marker line is prepended by the serializer, not
 * the encoder, so it is added here to match the wire.
 */
export const AUDIT_TOON_RESULT: ToolDispatchOverride = {
  override(name) {
    if (canonical(name) === 'audit:list') {
      return {
        content: [{ text: `format: toon\n${encode(AUDIT_S08_ROWS, 'toon')}` }],
      };
    }
    return PASS_THROUGH;
  },
};

/**
 * Realistic results for SU-S12 (same-turn insight): the SUT's natural first
 * moves are memory/search/docs lookups around the just-fixed wedge, plus the
 * shared-tree write protocol (locks:acquire, coord:declare-intent). Benign
 * `{ok:true}` stubs left the model narrating test-frame artifacts and the
 * judge grading stub coping instead of the same-turn discipline (EI-133
 * class) — so give the lookups believable empty-ish results ("nothing written
 * up yet", which is exactly the state that makes the insight write mandatory)
 * and the write-protocol calls believable confirmations.
 */
export const ZOMBIE_LOCK_INSIGHT_CONTEXT: ToolDispatchOverride = {
  override(name, args) {
    const canon = canonical(name);
    const a = (args ?? {}) as Record<string, unknown>;
    if (canon === 'memory:search' || canon === 'search:semantic') {
      return { content: [{ text: JSON.stringify({ results: [], note: 'no stored memories match' }) }] };
    }
    if (canon === 'search:fulltext') {
      return { content: [{ text: JSON.stringify({ hits: [], scope: a.scope ?? 'all' }) }] };
    }
    if (canon === 'docs:search') {
      return {
        content: [
          {
            text: JSON.stringify({
              hits: [
                {
                  slug: 'agent-insights/llm-429-check-the-transport-not-the-account',
                  section: 'agent-insights',
                  title: 'LLM 429s: check the transport, not the account',
                  snippet: 'Example of the insight format: one page per non-obvious root cause…',
                },
              ],
            }),
          },
        ],
      };
    }
    if (canon === 'docs:outline') {
      return {
        content: [
          {
            text: JSON.stringify({
              sections: [
                { section: 'agent-insights', pages: 42 },
                { section: 'system', pages: 31 },
                { section: 'testing', pages: 12 },
              ],
            }),
          },
        ],
      };
    }
    if (canon === 'plans:search') {
      return { content: [{ text: JSON.stringify({ hits: [] }) }] };
    }
    if (canon === 'docs:author') {
      const section = typeof a.section === 'string' ? a.section : 'agent-insights';
      const rawSlug = typeof a.slug === 'string' ? a.slug : 'zombie-plan-lock-transport-drop';
      const slug = rawSlug.startsWith(`${section}/`) ? rawSlug.slice(section.length + 1) : rawSlug;
      const ref = `${section}/${slug}`;
      return {
        content: [
          {
            text: JSON.stringify({
              ok: true,
              ref,
              slug,
              section,
              harness: a.harness ?? 'engineering',
              status: a.status ?? 'active',
              path: `apps/operator-docs/src/content/docs/${section}/${slug}.mdx`,
              anchored: true,
              read: { slugs: [ref], harness: a.harness ?? 'engineering' },
            }),
          },
        ],
      };
    }
    if (canon === 'docs:get') {
      const slugs = Array.isArray(a.slugs) ? a.slugs.map(String) : [];
      const requested = slugs[0] ?? 'agent-insights/plan-writes-hang-idle-in-transaction-advisory-lock-runbook';
      const ref = requested.startsWith('agent-insights/') ? requested : `agent-insights/${requested}`;
      return { content: [{ text: JSON.stringify({
        ok: true,
        pages: [{
          slug: ref,
          title: 'Plan writes hang: idle-in-transaction advisory lock runbook',
          body:
            'A dropped MCP transport can leave an idle-in-transaction Postgres backend holding the ' +
            'plan advisory lock. Plan reads still work while writes block. The durable fix reaps the ' +
            'orphan on transport drop; diagnose recurrence from the backend and lock evidence before ' +
            'calling it a plans-tool outage.',
        }],
      }) }] };
    }
    if (canon === 'locks:acquire') {
      return {
        content: [
          { text: JSON.stringify({ ok: true, lock_id: 'lk-s12-1', granted: true, paths: a.paths ?? [] }) },
        ],
      };
    }
    if (canon === 'coord:declare-intent') {
      return {
        content: [
          { text: JSON.stringify({ ok: true, presence: { ownerId: 'su-test', intent: a.intent ?? '' } }) },
        ],
      };
    }
    if (canon === 'memory:remember') {
      return { content: [{ text: JSON.stringify({ ok: true, id: 'mem-s12-1' }) }] };
    }
    return PASS_THROUGH;
  },
};

/**
 * Realistic results for SU-S10 (claim-before-work): a concrete `plans:get`
 * payload for the scenario's plan plus believable claim confirmations. The
 * default benign stub starved the SUT of the plan's content, and the judged
 * runs failed on STUB ARTIFACTS, not the discipline under test (EI-133): the
 * model asked the user for item details the plan "should" have carried, or
 * fabricated implementation specifics. With a real-shaped payload the judge
 * measures claim-then-work behavior, not stub coping.
 */
export const WIDGET_EXPORT_PLAN: ToolDispatchOverride = {
  override(name, args) {
    const canon = canonical(name);
    const a = (args ?? {}) as Record<string, unknown>;
    if (canon === 'plans:get') {
      return {
        content: [
          {
            text: JSON.stringify({
              slug: 'widget-export-2026-06-01',
              frontmatter: { title: 'Widget export: CSV + XLSX download from the widget table', status: 'active' },
              now: {
                state:
                  'P-001 (export menu + format picker UI) shipped. Exporter backend not started; the picker is wired to a disabled stub.',
                next: 'Implement P-002; P-003 is blocked by P-002 and must remain visible as a claimed blocked item.',
              },
              items: [
                { id: 'P-001', text: 'Export menu + format picker on the widget table toolbar', status: 'done' },
                {
                  id: 'P-002',
                  text: 'CSV exporter: defineTool widgets:export_csv (columns = visible grid columns, RFC 4180 quoting, streams via ctx.progress); wire the picker CSV entry to it',
                  status: 'todo',
                },
                {
                  id: 'P-003',
                  text: 'XLSX exporter: same column model via exceljs, one sheet per widget view; picker XLSX entry (shares the column-model helper introduced by P-002)',
                  status: 'blocked',
                  blockedBy: ['P-002'],
                },
              ],
              decisions: [
                {
                  id: 'D-001',
                  title: 'Column model comes from the live grid state, not the schema',
                  body: 'Exports reflect what the user sees: visible columns + current sort/filter, read from the grid URL state.',
                },
              ],
            }),
          },
        ],
      };
    }
    if (canon === 'coord:declare-intent') {
      const items = Array.isArray(a.items) ? a.items : [];
      return {
        content: [
          {
            text: JSON.stringify({
              ok: true,
              presence: { ownerId: 'su-test', intent: a.intent ?? '' },
              claims: { claimed: items, alreadyHeld: [], conflicts: [], released: [] },
            }),
          },
        ],
      };
    }
    if (canon === 'plans:set-status') {
      return {
        content: [
          {
            text: JSON.stringify({
              ok: true,
              itemId: a.itemId ?? '',
              oldStatus: 'todo',
              newStatus: a.status ?? '',
              ...(a.status === 'wip' ? { claim: { holder: 'su-test', lease_sec: 1800 } } : {}),
            }),
          },
        ],
      };
    }
    if (canon === 'plan_items:claim') {
      return {
        content: [
          { text: JSON.stringify({ ok: true, claim_id: 'cl-test-1', item: a.item ?? '', lease_expires_in_sec: 1800 }) },
        ],
      };
    }
    return PASS_THROUGH;
  },
};

/**
 * Realistic context for SU-S13 (code:run batch adoption,
 * code-execution-tool-orchestration B-CX). The task is the canonical "do X for
 * each of N" shape: `work_items:list` returns 12 open items WITHOUT the blocked
 * detail, so answering "which are blocked and why" requires a per-item
 * `work_items:get` over all 12 — exactly the loop the playbook's CODE_RUN_NUDGE
 * says to collapse into ONE `code:run`. The override also gives `code:tools` a
 * believable namespace index and `code:run` a believable summary so the smart
 * path "succeeds" and the model isn't punished (by a stub artifact) for taking it.
 */
const S13_WORK_ITEMS = Array.from({ length: 12 }, (_, i) => ({
  id: `WI-${200 + i}`,
  title:
    [
      'Wire the export picker to the CSV backend',
      'Flaky test: harness-fs-watcher debounce',
      'Add retry to the gateway pool client',
      'Migrate widgets table to nuqs state',
      'Audit log row drops NUL bytes',
      'Design token: brand-accent contrast',
      'Bee mail inbox pagination',
      'Coord wake-queue SSE push',
      'Plan lint: smart-quote detector',
      'Sandbox npm-install EROFS',
      'Operator palette poll → push',
      'Schema migration 331 drift',
    ][i] ?? `Work item ${i}`,
  kind: 'feature',
}));

export const CODE_RUN_BATCH_CONTEXT: ToolDispatchOverride = {
  override(name, args) {
    const canon = canonical(name);
    const a = (args ?? {}) as Record<string, unknown>;
    if (canon === 'work_items:list') {
      // Deliberately omits per-item state → the blocked check needs a get-per-item.
      return { content: [{ text: JSON.stringify({ items: S13_WORK_ITEMS, count: S13_WORK_ITEMS.length }) }] };
    }
    if (canon === 'work_items:get') {
      const ids = Array.isArray(a.ids) ? (a.ids as string[]) : a.id ? [String(a.id)] : [];
      const results = ids.map((id) => {
        const n = Number(id.split('-')[1] ?? 0);
        const blocked = n % 4 === 0; // a deterministic ~quarter are blocked
        return {
          ok: true as const,
          id,
          workItem: {
            id,
            state: blocked ? 'blocked' : 'open',
            ...(blocked ? { blockedReason: 'waiting on an upstream dependency', blockedBy: [`WI-${n - 1}`] } : {}),
          },
        };
      });
      return {
        content: [{ text: JSON.stringify({ ok: true, results, counts: { ok: results.length, failed: 0 } }) }],
      };
    }
    if (canon === 'code:tools') {
      // The cheap namespace index (no args) or typed signatures (with namespaces).
      if (!a.namespaces && !a.names) {
        return {
          content: [
            {
              text: JSON.stringify({
                namespaces: [
                  { ns: 'work_items', verbs: ['list', 'get', 'setState', 'complete'] },
                  { ns: 'coord', verbs: ['declareIntent', 'send', 'inbox'] },
                  { ns: 'plans', verbs: ['list', 'get', 'setStatus'] },
                ],
                count: 10,
                hint: 'Call code:tools { namespaces:[...] } for full typed signatures, then write a code:run script.',
              }),
            },
          ],
        };
      }
      return {
        content: [
          {
            text:
              'declare const tools: {\n  work_items: {\n    list(args?: { status?: string }): Promise<unknown>;\n' +
              '    get(args: { id?: string; ids?: string[] }): Promise<unknown>;\n  };\n  call(toolName: string, args?: unknown): Promise<unknown>;\n};',
          },
        ],
      };
    }
    if (canon === 'code:run') {
      // A believable summary for a "which are blocked" batch script.
      return {
        content: [
          {
            text: JSON.stringify({
              ok: true,
              summary: {
                scanned: S13_WORK_ITEMS.length,
                blocked: ['WI-200', 'WI-204', 'WI-208'],
                reasons: {
                  'WI-200': 'waiting on an upstream dependency',
                  'WI-204': 'waiting on an upstream dependency',
                  'WI-208': 'waiting on an upstream dependency',
                },
              },
              dryRun: !!a.dryRun,
              plannedMutations: [],
            }),
          },
        ],
      };
    }
    return PASS_THROUGH;
  },
};

/**
 * SU-S15 (small-batch adoption): the user names a FEW items (3) to check — a
 * modest fan-out. The token win still favors ONE code:run over 3 round-trips, so
 * the engineer should batch even here ("reach for it a lot"). `work_items:get`
 * returns per-item state; the blocked check needs a get per id.
 */
export const SMALL_BATCH_CONTEXT: ToolDispatchOverride = {
  override(name, args) {
    const canon = canonical(name);
    const a = (args ?? {}) as Record<string, unknown>;
    if (canon === 'work_items:get') {
      const ids = Array.isArray(a.ids) ? (a.ids as string[]) : a.id ? [String(a.id)] : [];
      const results = ids.map((id) => {
        const n = Number(id.split('-')[1] ?? 0);
        return {
          ok: true as const,
          id,
          workItem: {
            id,
            state: n % 2 === 0 ? 'blocked' : 'open',
            ...(n % 2 === 0 ? { blockedReason: 'awaiting review' } : {}),
          },
        };
      });
      return {
        content: [{ text: JSON.stringify({ ok: true, results, counts: { ok: results.length, failed: 0 } }) }],
      };
    }
    if (canon === 'code:tools') {
      return { content: [{ text: JSON.stringify({ namespaces: [{ ns: 'work_items', verbs: ['get'] }], count: 1 }) }] };
    }
    if (canon === 'code:run') {
      return { content: [{ text: JSON.stringify({ ok: true, summary: { blocked: ['WI-302'] } }) }] };
    }
    return PASS_THROUGH;
  },
};

/**
 * SU-S16 (batch WRITE via dry-run): the user asks to mark every OPEN work item
 * to `wip` — a valid homogeneous WRITE over a collection. The engineer should
 * collapse it into one native bulk `work_items:set_state { ids, state }` call,
 * not loop the scalar form or route a homogeneous mutation through code:run.
 */
const S16_OPEN_ITEMS = Array.from({ length: 9 }, (_, i) => ({ id: `WI-${400 + i}`, state: 'open' }));
export const BATCH_WRITE_CONTEXT: ToolDispatchOverride = {
  override(name, args) {
    const canon = canonical(name);
    const a = (args ?? {}) as Record<string, unknown>;
    if (canon === 'work_items:list') {
      return { content: [{ text: JSON.stringify({ items: S16_OPEN_ITEMS, count: S16_OPEN_ITEMS.length }) }] };
    }
    if (canon === 'work_items:set_state') {
      const ids = Array.isArray(a.ids) ? (a.ids as string[]) : a.id ? [String(a.id)] : [];
      const results = ids.map((id) => ({ ok: true, id, appliedState: a.state ?? null }));
      return {
        content: [{ text: JSON.stringify({ ok: true, results, counts: { ok: results.length, failed: 0 } }) }],
      };
    }
    if (canon === 'code:tools') {
      return { content: [{ text: JSON.stringify({ namespaces: [{ ns: 'work_items', verbs: ['list', 'setState'] }], count: 2 }) }] };
    }
    if (canon === 'code:run') {
      return {
        content: [
          {
            text: JSON.stringify({
              ok: true,
              dryRun: !!a.dryRun,
              plannedMutations: a.dryRun ? S16_OPEN_ITEMS.map((w) => ({ tool: 'work_items:set_state', args: { id: w.id, state: 'wip' } })) : [],
              summary: { updated: a.dryRun ? 0 : S16_OPEN_ITEMS.length },
            }),
          },
        ],
      };
    }
    return PASS_THROUGH;
  },
};

/**
 * Realistic single-fact result for SU-S14 (no code:run over-application): a
 * `harness:status` snapshot. The question is answerable in ONE direct call, so
 * the engineer must NOT wrap it in `code:run` (the nudge's "NOT WHEN: a single
 * tool call" rule). PASS_THROUGH for anything else (incl. a benign stub for an
 * unexpected code:run, which the assert then flags).
 */
export const HARNESS_STATUS_RESULT: ToolDispatchOverride = {
  override(name) {
    if (canonical(name) === 'harness:status') {
      return {
        content: [
          {
            text: JSON.stringify({
              slug: 'sheets',
              phase: 'production',
              features: { total: 14, done: 11, in_progress: 2, blocked: 1 },
              lastActivity: '2026-06-21T04:12:00Z',
            }),
          },
        ],
      };
    }
    return PASS_THROUGH;
  },
};

/**
 * SU-S17 (reach for coord:orient at wake): a believable one-call bootstrap so the
 * engineer who calls coord:orient { intent } once isn't punished by a stub. The
 * fanned-out primitives PASS_THROUGH to a benign stub — the assert flags the fan.
 *
 * The follow-up world is intentionally populated too. A real S17 continuation
 * reads the assigned item's source, searches for the gateway/retry seam, packs
 * the relevant files, and may batch those reads through code:run. Returning an
 * empty/default result after a successful orient makes the model retract its own
 * evidence ("the tool was simulated") instead of investigating the assignment.
 */
const S17_GATEWAY_SOURCES = [
  {
    path: 'packages/operator-core/lib/llm-testing/llm-client.ts',
    language: 'ts',
    lineRanges: ['11-13', '301-323'],
    content: [
      "Pricing + retry + auth + temperature-incompat all live in `libs/papercusp-shared/src/agent/chat-stream.ts`'s `anthropic-direct` branch.",
      "priority: opts.priority ?? 'llm-testing',",
      'retryDeadlineMs: opts.retryDeadlineMs,',
    ].join('\n'),
  },
  {
    path: 'libs/papercusp-shared/src/agent/chat-stream.ts',
    language: 'ts',
    lineRanges: ['357-379', '651-658'],
    content: [
      "export const GATEWAY_PRIORITY_HEADER = 'x-papercusp-priority';",
      'export function priorityTierHeaders(priority: string | undefined): Record<string, string> {',
      '  const label = priority?.trim();',
      '  return label ? { [GATEWAY_PRIORITY_HEADER]: label } : {};',
      '}',
      'retryDeadlineMs?: number;',
    ].join('\n'),
  },
  {
    path: 'apps/operator/bin/llm-test.ts',
    language: 'ts',
    lineRanges: ['228-246'],
    content: [
      'for (const [k, v] of Object.entries(gatewayLlmEnv(true))) {',
      '  if (!process.env[k]) process.env[k] = v;',
      '}',
      'console.log(`[llm-test] inference-gateway ON → routing LLM calls through http://127.0.0.1:${gatewayPort()}`);',
    ].join('\n'),
  },
  {
    path: 'apps/operator-docs/src/content/docs/agent-insights/rate-limit-is-usually-account-routing-not-capacity.mdx',
    language: 'mdx',
    lineRanges: ['69-84'],
    content:
      'A bare 429 with x-should-retry: true is a short transient burst throttle, not a quota wall. ' +
      'Retry and fail over instead of concluding that the account pool is exhausted.',
  },
];

const S17_MEMORY_HIT = {
  id: 'mem-1',
  memory: 'gateway retries must route through the account pool (EI-456)',
};

export const ORIENT_BOOTSTRAP_CONTEXT: ToolDispatchOverride = {
  override(name, args) {
    const a = (args ?? {}) as Record<string, unknown>;
    const canon = canonical(name);
    if (canon === 'coord:orient') {
      return {
        content: [
          {
            text: JSON.stringify({
              ok: true,
              me: {
                assignments: [{ id: 'WI-512', title: 'Gateway pool retry', state: 'wip' }],
                lane: ['P-003'],
                load: 1,
              },
              claimable: [
                { id: 'WI-540', title: 'Audit log NUL bytes' },
                { id: 'WI-541', title: 'Palette poll → push' },
              ],
              inbox: {
                summary: { total: 1, unread: 1 },
                recent: [{ from: 'mug', text: 'prioritize the gateway retry' }],
              },
              planEvents: { total: 2, recent: [{ kind: 'item_status_changed', plan: 'gateway-pool', item: 'P-002' }] },
              memory: { query: a.intent ?? '', hits: [S17_MEMORY_HIT] },
              intentDeclared: !!a.intent,
            }),
          },
        ],
      };
    }
    if (canon === 'memory:search') {
      return {
        content: [
          {
            text: JSON.stringify({
              ok: true,
              results: [{ ...S17_MEMORY_HIT, score: 0.92, metadata: { kind: 'project' } }],
            }),
          },
        ],
      };
    }
    if (canon === 'coord:declare-intent') {
      return {
        content: [
          {
            text: JSON.stringify({
              ok: true,
              presence: {
                ownerId: 'su-test',
                intent: String(a.intent ?? ''),
                currentPlanSlug: String(a.current_plan_slug ?? 'gateway-pool'),
                intentDeclaredAt: '2026-06-21T04:12:00Z',
                fleetSlug: null,
                fleetRole: null,
              },
              claims: {
                claimed: [],
                alreadyHeld: ['P-003'],
                conflicts: [],
                released: [],
              },
            }),
          },
        ],
      };
    }
    if (canon === 'work_items:get') {
      const id = String(a.id ?? 'WI-512');
      const workItem =
        id === 'WI-512'
          ? {
              id,
              title: 'Gateway pool retry',
              state: 'wip',
              assignee: 'su-test',
              plan: 'gateway-pool',
              planItem: 'P-003',
            }
          : { id, title: 'Claimable follow-up', state: 'open', assignee: null };
      return {
        content: [
          {
            text: JSON.stringify({
              ok: true,
              results: [{ ok: true, id, workItem }],
            }),
          },
        ],
      };
    }
    if (canon === 'work_items:list') {
      return {
        content: [
          {
            text: JSON.stringify({
              ok: true,
              items: [
                { id: 'WI-512', title: 'Gateway pool retry', state: 'wip', assignee: 'su-test' },
                { id: 'WI-540', title: 'Audit log NUL bytes', state: 'open', assignee: null },
                { id: 'WI-541', title: 'Palette poll → push', state: 'open', assignee: null },
              ],
            }),
          },
        ],
      };
    }
    if (canon === 'search:fulltext' || canon === 'search:semantic') {
      return {
        content: [
          {
            text: JSON.stringify({
              ok: true,
              query: a.query ?? '',
              hits: S17_GATEWAY_SOURCES.map((source) => ({
                path: source.path,
                excerpt: source.content,
                sourceKind: 'source-backed-code-excerpt',
                lineRanges: source.lineRanges,
              })),
            }),
          },
        ],
      };
    }
    if (canon === 'repomix:pack') {
      const requestedPath = String(a.path ?? '');
      const selected = requestedPath
        ? S17_GATEWAY_SOURCES.filter(
            (source) =>
              requestedPath === source.path ||
              requestedPath.endsWith(source.path) ||
              source.path.startsWith(`${requestedPath.replace(/\/$/, '')}/`),
          )
        : S17_GATEWAY_SOURCES;
      return {
        content: [
          {
            text: JSON.stringify({
              ok: true,
              requestedPath: requestedPath || null,
              files: selected.map((source) => ({
                ...source,
                sourceKind: 'source-backed-code-excerpt',
              })),
            }),
          },
        ],
      };
    }
    if (canon === 'capability:read') {
      const requestedPath = String(a.file_path ?? a.path ?? '');
      const source = S17_GATEWAY_SOURCES.find(
        (candidate) => requestedPath === candidate.path || requestedPath.endsWith(candidate.path),
      );
      return {
        content: [
          {
            text: JSON.stringify(
              source
                ? {
                    ok: true,
                    file_path: source.path,
                    content: source.content,
                    sourceChars: source.content.length,
                    sourceKind: 'source-backed-code-excerpt',
                    completeFile: false,
                    completeForQuestion: true,
                    lineRanges: source.lineRanges,
                  }
                : {
                    ok: false,
                    error: 'file_not_in_scenario_world',
                    requestedPath,
                    availablePaths: S17_GATEWAY_SOURCES.map((candidate) => candidate.path),
                  },
            ),
          },
        ],
      };
    }
    if (canon === 'code:run') {
      return {
        content: [
          {
            text: JSON.stringify({
              ok: true,
              result: {
                status: 'completed',
                cwd: '/workspace/papercusp',
                sourceKind: 'source-backed-code-excerpt',
                files: S17_GATEWAY_SOURCES.map((source) => source.path),
                gateway: {
                  endpoint: 'http://127.0.0.1:8788',
                  priorityHeader: 'x-papercusp-priority',
                  defaultPriority: 'llm-testing',
                },
                retry: {
                  boundedBy: 'retryDeadlineMs',
                  transient429: 'retry-and-fail-over when x-should-retry=true',
                },
              },
              summary: 'Read the gateway admission and bounded retry wiring from source-backed files.',
            }),
          },
        ],
      };
    }
    return PASS_THROUGH;
  },
};

/**
 * SU-S21 (reach for the bulk READ arg over a per-id hand-loop;
 * bulk-endpoint-standardization-2026-06-21 P-007). work_items:list returns 6 open
 * items WITHOUT the detail the question needs (assignee + parent), so answering
 * "who owns each and what's the parent" requires work_items:get over all 6 — which
 * is now ONE bulk `work_items:get { ids:[…] }` call (every repeated-call read is
 * dual-arity, n=1 ≡ bulk-of-one), not 6 round-trips. The override returns the
 * keyed-array bulk envelope when called with `ids` (the smart path "succeeds"), and
 * a believable single-item envelope when called with a scalar `id` (so a hand-loop
 * is not punished by a stub — the assert, not the stub, flags the fan-out).
 */
const S21_OPEN_ITEMS = Array.from({ length: 6 }, (_, i) => ({ id: `WI-${600 + i}`, title: `Open item ${600 + i}`, kind: 'feature' }));
function s21WorkItem(id: string) {
  const n = Number(id.split('-')[1] ?? 0);
  return { id, kind: 'feature', state: 'open', assignee: `su-${(n % 3) + 1}`, parent: n % 2 === 0 ? `F-${n - 1}` : null };
}
export const BULK_GET_CONTEXT: ToolDispatchOverride = {
  override(name, args) {
    const canon = canonical(name);
    const a = (args ?? {}) as Record<string, unknown>;
    if (canon === 'work_items:list') {
      return { content: [{ text: JSON.stringify({ items: S21_OPEN_ITEMS, count: S21_OPEN_ITEMS.length }) }] };
    }
    if (canon === 'work_items:get') {
      const ids = Array.isArray(a.ids) ? (a.ids as string[]) : a.id ? [String(a.id)] : [];
      const results = ids.map((id) => ({ ok: true as const, id, workItem: s21WorkItem(id) }));
      return {
        content: [{ text: JSON.stringify({ ok: true, results, counts: { ok: results.length, failed: 0 } }) }],
      };
    }
    return PASS_THROUGH;
  },
};

/**
 * SU-S18 (do NOT over-apply coord:orient on a single inbox check): a believable
 * coord:inbox result. "Any new messages?" is one direct coord:inbox call — wrapping
 * it in coord:orient over-fetches assignments + claimable + plan-events + a memory
 * recall + a declare, the over-application the guard catches.
 */
export const COORD_INBOX_RESULT: ToolDispatchOverride = {
  override(name) {
    if (canonical(name) === 'coord:inbox') {
      return {
        content: [
          {
            text: JSON.stringify({
              ok: true,
              summary: { total: 2, unread: 1 },
              entries: [
                { id: 'm-1', from: 'su-9140a', kind: 'message', text: 'rebased your branch, re-pull' },
                { id: 'm-2', from: 'mug', kind: 'notify', text: 'gateway retry landed' },
              ],
            }),
          },
        ],
      };
    }
    return PASS_THROUGH;
  },
};

// ===========================================================================
// Delta-protocol fixtures + override (agent-tool-delta-protocol-2026-06-22
// P-007 / D-007 / D-008).
//
// The delta-merge scenarios (S23/S24/S25) reproduce the LLM-facing
// semantic-delta read against `work_items:list` (a list-of-rows view): the
// override is STATEFUL — call 1 returns a FULL snapshot (mode:full), call 2 a
// DELTA (mode:delta) of changes since the snapshot's cursor, call 3+ the
// re-fetched current FULL list (mode:full). The result shape follows plan
// D-003: `{ ok, mode, cursor, items, counts, note }`; the delta carries a
// legible inline contract (like S08's `format: csv` marker) so the real su
// persona — which does not yet know the protocol — can interpret it AND knows
// to re-fetch full when it no longer holds the base.
//
// `makeDeltaSnapshotOverride` returns a FRESH instance each call so a scenario
// can expose it via a GETTER (`get toolOverride()`), giving per-run-fresh
// call-count state across `runMatrix` repeats (the runner reads
// `scenario.toolOverride` once per run).
// ===========================================================================

/** The view rows are stable-keyed work items (id + title). */
interface DeltaRow {
  id: string;
  title: string;
}

/** The base full snapshot (call 1, mode:full). */
export const DELTA_BASE_ROWS: DeltaRow[] = [
  { id: 'WI-7001', title: 'Export picker → CSV backend' },
  { id: 'WI-7002', title: 'Flaky harness-fs-watcher debounce' }, // REMOVED by the delta
  { id: 'WI-7003', title: 'Audit log drops NUL bytes' },
  { id: 'WI-7004', title: 'Gateway pool naive-retry loop' }, // UPDATED by the delta
  { id: 'WI-7005', title: 'Operator palette poll-to-push' },
];

/** The current truth after applying the delta — WI-7002 removed, WI-7004
 *  retitled, WI-7006 added. This is what call 3+ (the re-fetch) returns and
 *  what a correct merge must reproduce. */
export const DELTA_CURRENT_ROWS: DeltaRow[] = [
  { id: 'WI-7001', title: 'Export picker → CSV backend' },
  { id: 'WI-7003', title: 'Audit log drops NUL bytes' },
  { id: 'WI-7004', title: 'Gateway pool circuit-breaker' }, // updated title
  { id: 'WI-7005', title: 'Operator palette poll-to-push' },
  { id: 'WI-7006', title: 'Sandbox npm-install EROFS' }, // added
];

const DELTA_FULL_SNAPSHOT = {
  ok: true,
  mode: 'full',
  cursor: 'wil-c1',
  count: DELTA_BASE_ROWS.length,
  items: DELTA_BASE_ROWS,
  note:
    'mode=full: this is the complete current open-work-item view for this filter. ' +
    'cursor is a change-watermark, not a pagination cursor.',
};

const DELTA_CHANGES = {
  ok: true,
  mode: 'delta',
  cursor: 'wil-c2',
  // Legible inline contract so the SUT can interpret it and knows the base rule.
  note:
    'mode=delta: these are the CHANGES since cursor wil-c1, NOT the full list. ' +
    'Apply them to the full work_items:list snapshot you fetched earlier ' +
    '(change=added|updated|removed; an updated/added row carries its full new data). ' +
    'If you no longer have that earlier snapshot in context, do NOT guess — ' +
    're-call work_items:list to get a fresh mode:full list.',
  items: [
    { change: 'removed', id: 'WI-7002' },
    { change: 'updated', id: 'WI-7004', data: { id: 'WI-7004', title: 'Gateway pool circuit-breaker' } },
    { change: 'added', id: 'WI-7006', data: { id: 'WI-7006', title: 'Sandbox npm-install EROFS' } },
  ],
  counts: { added: 1, updated: 1, removed: 1, unchanged: 3 },
};

const DELTA_REFETCH_FULL = {
  ok: true,
  mode: 'full',
  cursor: 'wil-c2',
  count: DELTA_CURRENT_ROWS.length,
  items: DELTA_CURRENT_ROWS,
  note:
    'mode=full: this is the complete current open-work-item view for this filter. ' +
    'cursor is a change-watermark, not a pagination cursor; absent ids were removed from the view.',
};

/**
 * A fresh STATEFUL `work_items:list` override: 1st call → full snapshot, 2nd →
 * delta, 3rd+ → re-fetched current full list. Each call is one model tool
 * invocation. Returns a new instance per call (expose via a `get toolOverride()`
 * getter for per-run-fresh state across matrix repeats). PASS_THROUGH for any
 * other tool.
 */
export function makeDeltaSnapshotOverride(): ToolDispatchOverride {
  let calls = 0;
  return {
    override(name, rawArgs) {
      const canon = canonical(name);
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      if (canon === 'work_items:get') {
        const ids = Array.isArray(args.ids)
          ? args.ids.filter((id): id is string => typeof id === 'string')
          : typeof args.id === 'string'
            ? [args.id]
            : [];
        const results = ids.map((id) => {
          const row = DELTA_CURRENT_ROWS.find((candidate) => candidate.id === id);
          return row
            ? { ok: true, id, workItem: { ...row, state: 'open' } }
            : { ok: false, id, error: 'not_found_in_current_open_view' };
        });
        return {
          content: [{
            text: JSON.stringify({
              ok: true,
              results,
              counts: {
                ok: results.filter((result) => result.ok).length,
                failed: results.filter((result) => !result.ok).length,
              },
              note: 'Detail reads use the same current snapshot as work_items:list.',
            }),
          }],
        };
      }
      if (canon !== 'work_items:list') return PASS_THROUGH;
      calls += 1;
      const body = calls === 1 ? DELTA_FULL_SNAPSHOT : calls === 2 ? DELTA_CHANGES : DELTA_REFETCH_FULL;
      return { content: [{ text: JSON.stringify(body) }] };
    },
  };
}

/**
 * SU-S19 (reach for harness:overview on "state of X"): a faithful, self-contained
 * one-call overview (status + escalation record + bounded open-issues snapshot)
 * so the engineer who calls harness:overview once isn't punished by a stub. The
 * snapshot count deliberately equals `recent.length`: both rows fit under the
 * production default limit of 25, so advertising a larger count would invent
 * missing detail and provoke a follow-up this tool-selection scenario does not
 * intend to measure (WI-2146314).
 */
export const HARNESS_OVERVIEW_RESULT: ToolDispatchOverride = {
  override(name, args) {
    const a = (args ?? {}) as Record<string, unknown>;
    if (canonical(name) === 'harness:overview') {
      return {
        content: [
          {
            text: JSON.stringify({
              ok: true,
              harness: a.harness ?? 'sheets',
              status: { phase: 'production', features: { total: 14, done: 11, in_progress: 2, blocked: 1 } },
              escalations: {
                hasEscalation: true,
                escalation: 'esc-1: validator stuck on F-12; retry is awaiting the validator trace',
                supervisorNotes: 'Validator owner is investigating; next update follows the trace.',
                mtimeMs: 1788602400000,
              },
              issues: {
                count: 2,
                recent: [
                  { id: 'EI-880', title: 'export picker disabled stub', severity: 'major', state: 'open' },
                  { id: 'EI-881', title: 'formula import drops locale', severity: 'minor', state: 'open' },
                ],
              },
            }),
          },
        ],
      };
    }
    return PASS_THROUGH;
  },
};
