/**
 * Curated `papercusp-su` tool catalog for the in-process `su` target.
 *
 * The real SU surface is the full ~226-tool superuser catalog
 * (`listMcpProjections()` over the populated projection registry). We do
 * NOT enumerate it live here, on purpose:
 *
 *   - **Hermetic.** `listMcpProjections()` reads a registry that is only
 *     populated by the 283 side-effect imports in
 *     `@papercusp/operator-core/lib/agent-tools` (+ the agent-mcp read-side
 *     barrel). Booting that from a test target pulls the whole operator
 *     tool chain (operator-converse, PG-touching creators, …) at import —
 *     heavy and fragile. The `su` suite is a behavioral probe of the
 *     *playbook*, not an integration test of the dispatcher, so it should
 *     not require the operator runtime to be booted.
 *   - **Bounded cost.** 226 tool schemas is ~40-80k input tokens *per model
 *     call*; a curated ~40-tool surface keeps each scenario's matrix run
 *     cheap while still letting the model pick the right tool.
 *   - **Faithful where it counts.** The tool *names* + the load-bearing
 *     args (the `harness` scope arg on `docs:*`/`plans:*`, the
 *     `design-phase:*` group, the absence of any `features:update` write)
 *     mirror the real surface — which is exactly what the scenario asserts
 *     measure (tool *selection*, not tool *results*).
 *
 * If the suite later wants to track the live surface, swap `SU_CATALOG`
 * for a filtered `listMcpProjections()` behind a flag — the rest of the
 * target is catalog-shape-agnostic.
 */

/** One catalog entry: the canonical colon-form MCP name + a concise
 *  description + a minimal JSON-Schema for the args the model can pass. */
export interface SuCatalogEntry {
  /** Canonical projected name, colon form (e.g. `docs:get`). */
  name: string;
  description: string;
  /** JSON-Schema `object` describing the tool's args. */
  input: Record<string, unknown>;
}

/** A `harness`-scope arg shared by the context-only readers (`docs:*`,
 *  `plans:*`). The playbook's hard rule: at operator scope you NAME the
 *  harness (`'all'` for Papercusp's own docs/plans, else a slug) — never
 *  stall on `harness_required`. */
const HARNESS_ARG = {
  harness: {
    type: 'string',
    description:
      "Harness slug to scope to. Pass 'all' for Papercusp's own (operator-level) docs/plans, or a managed harness slug. Required at operator scope.",
  },
} as const;

const obj = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
});

/**
 * The curated SU catalog. Names + arg shapes are real; descriptions are
 * one-liners distilled from each tool's playbook guidance. Deliberately
 * representative, not exhaustive — covers the groups the scenarios exercise
 * (docs / plans / design-phase / work_items / coord / search /
 * locks / memory / blueprint / harness) plus a believable SU spread.
 *
 * Deliberately ABSENT: any `features:update` / raw-SQL write verb, and the
 * retired `messages:*` mail surface (retire-work-item-mail-surface-2026-07-26).
 * The SU agent has no such tool; feature-pipeline state advances through the
 * pipeline roles + `work_items:comment` (the retired `messages:send`'s
 * successor for `to_feature_id` hand-offs — durable, work-item-scoped,
 * per the retire-work-item-mail-surface-2026-07-26 D-004 ruling; `coord:send`
 * is reserved for live/wakeable direction at an agent, not this hand-off).
 * SU-S05 asserts the model doesn't invent a raw write.
 */
export const SU_CATALOG: ReadonlyArray<SuCatalogEntry> = [
  // --- docs (context-only readers, harness-scoped) ---
  {
    name: 'docs:outline',
    description:
      'Full table-of-contents of the engineering docs (cached per session). Docs-first entry point for "how does X work".',
    input: obj({ ...HARNESS_ARG }),
  },
  {
    name: 'docs:get',
    description: 'Fetch one or more doc pages by slug; narrow a long page with a heading anchor.',
    input: obj({
      slugs: { type: 'array', items: { type: 'string' } },
      heading: { type: 'string' },
      ...HARNESS_ARG,
    }, ['slugs', 'harness']),
  },
  {
    name: 'docs:search',
    description: 'Full-text search the docs when you do not know the page slug.',
    input: obj({ query: { type: 'string' }, ...HARNESS_ARG }, ['query']),
  },
  {
    name: 'docs:author',
    description:
      'Create or replace a PG-canonical manual / agent-insights page. This is the only supported durable docs write; never hand-write the projected MDX file.',
    input: obj({
      slug: { type: 'string' },
      title: { type: 'string' },
      description: { type: 'string' },
      body: { type: 'string' },
      documents: { type: 'array', items: { type: 'string' } },
      tags: { type: 'array', items: { type: 'string' } },
      plans: { type: 'array', items: { type: 'string' } },
      section: { type: 'string', description: 'Defaults to agent-insights.' },
      status: { type: 'string', enum: ['active', 'draft', 'superseded'] },
      verify: { type: 'boolean' },
      overwrite: { type: 'boolean' },
      ...HARNESS_ARG,
    }, ['slug', 'title', 'body']),
  },
  // --- plans (PG-canonical project history, harness-scoped) ---
  {
    name: 'plans:list',
    description:
      'List plans (project history). By default archived plans are hidden; pass includeArchived:true ' +
      'for a complete lifecycle census. Use status only to filter to one stored lifecycle state.',
    input: obj({
      status: {
        type: 'string',
        enum: ['draft', 'ready', 'active', 'awaiting-acceptance', 'shipped', 'superseded'],
      },
      includeArchived: {
        type: 'boolean',
        description: 'Include archived plans. Default false.',
      },
      ...HARNESS_ARG,
    }),
  },
  {
    name: 'plans:get',
    description: 'Fetch one plan by slug: frontmatter, ## Now, items, decisions.',
    input: obj({ slug: { type: 'string' }, ...HARNESS_ARG }, ['slug']),
  },
  {
    name: 'plans:search',
    description: 'Search plans by content.',
    input: obj({ query: { type: 'string' }, ...HARNESS_ARG }, ['query']),
  },
  {
    name: 'plans:set-now',
    description: "Update a plan's ## Now (state + next).",
    input: obj({ slug: { type: 'string' }, state: { type: 'string' }, next: { type: 'string' }, ...HARNESS_ARG }, ['slug']),
  },
  {
    name: 'plans:set-status',
    description:
      "Flip one plan item's status. Flipping to `wip` AUTO-CLAIMS the item for you (rejected with claim_conflict when a live peer holds it); done/dropped releases your claim.",
    input: obj({
      slug: { type: 'string' },
      item: { type: 'string', description: 'P-NNN' },
      status: { type: 'string', enum: ['todo', 'wip', 'blocked', 'needs-human', 'done', 'dropped'] },
      note: { type: 'string' },
      ...HARNESS_ARG,
    }, ['slug', 'item', 'status']),
  },
  {
    name: 'plan_items:claim',
    description:
      'Take the live, heartbeat-leased grip on a plan item — what you call when you actually START it.',
    input: obj({
      plan: { type: 'string', description: 'plan slug' },
      item: { type: 'string', description: 'plan-item id (P-NNN)' },
      intent: { type: 'string', description: 'one line on what you are doing' },
      harness: { type: 'string' },
    }, ['plan', 'item']),
  },
  // --- work items (the unified work surface) ---
  {
    name: 'work_items:list',
    description: 'List work items (feature/bug/change/task/chunk) by kind/assignee/status.',
    input: obj({ kind: { type: 'string' }, assignedBy: { type: 'string' }, status: { type: 'string' }, slug: { type: 'string' } }),
  },
  {
    name: 'work_items:get',
    description:
      'Fetch one OR many work items with acceptance + lifecycle. Use id for one or ids (1–100) for a native bulk read; correlate the keyed results by id.',
    input: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'One work-item id (the scalar form).' },
        ids: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 100,
          description: 'Many work-item ids in one native bulk read.',
        },
        harness: { type: 'string' },
      },
    },
  },
  {
    name: 'work_items:claim',
    description:
      'Claim a directed work item and start it. Pass `row` as headerless CSV in column order ' +
      'id,assignee?,harness?,force?,reason?; the shortest valid row is the exact WI-/EI- id returned ' +
      'by coord:orient. Prefer this direct claim over rediscovering the backing plan.',
    input: obj({
      row: {
        type: 'string',
        description: 'Headerless CSV: id,assignee?,harness?,force?,reason?.',
      },
    }, ['row']),
  },
  {
    name: 'work_items:complete',
    description: 'Record structured completion evidence. Omit state for record-only; a terminal close requires state and assumptions. Finishing a held task does not establish independent plan acceptance; preserve pending gates. Bug closes additionally require rootCauseVerification; discover that full schema before using it.',
    input: obj({
      id: { type: 'string' },
      harness: { type: 'string' },
      state: { type: 'string', description: 'Explicit terminal intent; done/resolved means successful close, dropped/closed means discard. Omit for record-only.' },
      assumptions: { anyOf: [{ const: 'none' }, { type: 'array', items: { type: 'string' } }] },
      completion: obj({
        summary: { type: 'string' },
        verification: obj({
          testsRun: { type: 'string' },
          testResult: { type: 'string' },
          verifiedHow: { type: 'string' },
          filesChanged: { type: 'array', items: { type: 'string' } },
          addedTests: { type: 'boolean' },
        }),
        deferred: { type: 'array', items: { type: 'string' } },
      }, ['summary']),
    }, ['id', 'completion']),
  },
  {
    // KEYED lifecycle write: the real schema has conditional terminal evidence
    // (`completionRef` + `assumptions`) that cannot fit a positional row.
    name: 'work_items:set_state',
    description:
      'Set lifecycle state for one or many work-items. Use { id, state } for one, { ids, state } for one homogeneous bulk mutation, or items[] for per-item states. Terminal states require completionRef and assumptions; prefer work_items:complete for terminal evidence.',
    input: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        ids: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 200,
          description: 'Many ids receiving the same state.',
        },
        items: {
          type: 'array',
          minItems: 1,
          maxItems: 200,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              state: { type: 'string' },
              harness: { type: 'string' },
              completionRef: { type: 'string' },
              assumptions: { oneOf: [{ type: 'array', items: { type: 'string' } }, { const: 'none' }] },
            },
            required: ['id', 'state'],
          },
        },
        state: {
          type: 'string',
          enum: ['open', 'wip', 'blocked', 'needs-human', 'done', 'dropped'],
        },
        harness: { type: 'string' },
        completionRef: { type: 'string' },
        assumptions: { oneOf: [{ type: 'array', items: { type: 'string' } }, { const: 'none' }] },
        force: { type: 'boolean' },
      },
    },
  },
  // --- harness / status ---
  {
    name: 'harness:status',
    description: 'Feature-status snapshot for one harness.',
    input: obj({ slug: { type: 'string' } }, ['slug']),
  },
  {
    name: 'harness:list',
    description: 'List harnesses in a workspace.',
    input: obj({ workspace: { type: 'string' } }),
  },
  {
    name: 'harness:overview',
    description:
      "One COMPOUND 'state of X' read: a harness's status + escalations (with `harness`) or the harness index (without), PLUS the cross-cutting open-issues snapshot — harness:status + harness:escalation [+ harness:list] + work_items:list folded into ONE round-trip. Use it for a multi-part/full-picture request. A single fact such as active/current phase is one direct harness:status call, not this wrapper.",
    input: obj({
      harness: { type: 'string' },
      issueState: { type: 'string' },
      issuesLimit: { type: 'number' },
    }),
  },
  {
    name: 'harness:create',
    description: 'Instantiate a harness from a blueprint.',
    input: obj({ slug: { type: 'string' }, blueprint: { type: 'string' } }, ['slug', 'blueprint']),
  },
  // --- work items / work intake ---
  {
    name: 'work_items:create',
    description: 'File a discovered problem that is out of current scope (title, severity, topics). Requires a `kind` (e.g. bug).',
    input: obj({ kind: { type: 'string' }, title: { type: 'string' }, severity: { type: 'string' } }, ['kind', 'title']),
  },
  // --- search (workspace-global) ---
  {
    name: 'search:fulltext',
    description: 'Cheap BM25 full-text search across escalations/turns/decisions.',
    input: obj({ query: { type: 'string' }, scope: { type: 'array', items: { type: 'string' } } }, ['query']),
  },
  {
    name: 'search:semantic',
    description: 'Hybrid semantic search when phrasing is paraphrased.',
    input: obj({ query: { type: 'string' }, mode: { type: 'string' } }, ['query']),
  },
  // --- coordination (live working memory) ---
  {
    name: 'coord:declare-intent',
    description:
      'Declare what you are working on right now (intent, files, plan slug) so peers see you. Passing `items` CLAIMS those plan items as your lane (requires current_plan_slug) — an unclaimed lane is invisible to the Mug and peers.',
    input: obj({
      intent: { type: 'string' },
      current_files: { type: 'array', items: { type: 'string' } },
      current_plan_slug: { type: 'string' },
      items: {
        type: 'array',
        items: { type: 'string', pattern: '^P-\\d{3,}$' },
        description:
          'Plan items you are taking (your LANE) — each is auto-claimed; requires current_plan_slug. Pass [] to release the lane.',
      },
      harness: { type: 'string' },
    }, ['intent']),
  },
  {
    name: 'coord:send',
    description:
      'Send a coordination message with required to, summary and expects. body is an ARRAY of sections, never a string. ' +
      "Directed expects:action/answer requires body and forYouBecause on at least one section; broadcasts, human, ack and none are exempt. " +
      "For expects other than none, joined section text must fit 600 characters. basedOn is output-only: omit it.",
    input: obj({
      to: { type: 'array', minItems: 1, items: { type: 'string' } },
      summary: { type: 'string', minLength: 1 },
      expects: { type: 'string', enum: ['ack', 'answer', 'action', 'none'] },
      body: {
        type: 'array', minItems: 1, maxItems: 20,
        items: {
          ...obj({
            text: { type: 'string' },
            premises: { type: 'array', items: { type: 'string' } },
            forYouBecause: {
              ...obj({
                relation: { type: 'string', enum: ['holds-a-lock-on', 'owns', 'is-blocked-on', 'awaits', 'same-fleet', 'other'] },
                ref: { type: 'string', minLength: 1 },
                note: { type: 'string', minLength: 1 },
              }, ['relation']),
              description: "Why this recipient. relation:other requires note.",
            },
            youMayNotKnow: { type: 'array', items: obj({
              ref: { type: 'string', minLength: 1 },
              provenance: { type: 'string', enum: ['computed', 'authored'] },
            }, ['ref', 'provenance']) },
            couldNotDetermine: { type: 'array', items: obj({
              what: { type: 'string', minLength: 1 }, note: { type: 'string', minLength: 1 },
            }, ['what']) },
          }, ['text']),
          additionalProperties: false,
        },
      },
      blocking: { type: 'boolean' },
      why: obj({ goalRef: { type: 'string' }, note: { type: 'string' } }, ['goalRef']),
      related_msg_id: { type: 'string' },
      plan_slug: { type: 'string' },
      wake: { type: 'string', enum: ['required', 'optimistic'] },
      backstop: { type: 'string' },
    }, ['to', 'summary', 'expects']),
  },
  {
    name: 'coord:handoff',
    description:
      'Record a work transition. Open a handoff to other agents with to[] + summary (optionally plan/items, body, next_action, files_modified, commit), or accept an existing handoff with accept_msg_id alone. Use it to transfer work, not as a free-text FYI.',
    input: obj({
      accept_msg_id: { type: 'string', description: 'Accept an existing handoff; use this form alone.' },
      to: { type: 'array', items: { type: 'string' } },
      plan_slug: { type: 'string' },
      summary: { type: 'string' },
      body: { type: 'string' },
      next_action: { type: 'string' },
      files_modified: { type: 'array', items: { type: 'string' } },
      commit: { type: 'string' },
      items: { type: 'array', items: { type: 'string' }, maxItems: 40 },
      note: { type: 'string' },
    }),
  },
  {
    name: 'coord:presence',
    description: 'List active coordination agents and their declared intent.',
    input: obj({ workspace: { type: 'string' } }),
  },
  // --- modes (standing session posture; SU-S32 registers AUDIT through this) ---
  {
    name: 'mode:set',
    description:
      'Enter/exit an official session mode (auto | drain | audit | grade | goal | …) for yourself or a peer. Same-axis modes auto-switch; overlay modes such as AUDIT stack and grant NO autonomy. `reason` is why; `instructions` is the SCOPE the mode is about and is asserted as a standing fact that survives compaction. Pass ownerDirected:true ONLY when the human owner explicitly asked for the mode.',
    input: obj({
      mode: { type: 'string' },
      reason: { type: 'string' },
      instructions: { type: 'string' },
      enabled: { type: 'boolean' },
      agent: { type: 'string' },
      ownerDirected: { type: 'boolean' },
    }, ['mode', 'reason']),
  },
  {
    name: 'coord:inbox',
    description: 'Read your coordination inbox (messages/handoffs/escalations).',
    input: obj({ since_ts: { type: 'string' } }),
  },
  {
    name: 'coord:orient',
    description:
      'One wake-orientation + session-bootstrap read: your assignments + claimable backlog + inbox summary + recent plan-events, AND — when you pass `intent` — a memory recall for it + a coord:declare-intent. Folds fleet:assignments + work_items:list + coord:inbox + coord:plan-events + memory:search + coord:declare-intent into ONE round-trip. Call it at the START of a turn instead of those separately.',
    input: obj({
      intent: {
        type: 'string',
        description: 'Your one-line intent for this turn — declared to peers AND used as the memory-recall query.',
      },
      planSlug: { type: 'string' },
      planItems: { type: 'array', items: { type: 'string', pattern: '^P-\\d{3,}$' } },
      harness: { type: 'string' },
    }),
  },
  // messages:send / messages:inbox RETIRED 2026-07-26 — retire-work-item-mail-
  // surface-2026-07-26 P-007 (superseded by coord:send / coord:inbox).
  // --- locks (file + resource coordination) ---
  {
    name: 'locks:acquire',
    description:
      'Acquire a multi-file lock held across several edits + the commit. On a confirmed peer hold, pass wake_on_grant:true to queue a one-shot wake, then end your turn instead of polling.',
    input: obj({
      paths: { type: 'array', items: { type: 'string' } },
      intent: { type: 'string' },
      ttl_sec: { type: 'number' },
      wake_on_grant: {
        type: 'boolean',
        description: 'Queue a one-shot wake when a peer releases a busy path; end the current turn after queueing.',
      },
    }, ['paths', 'intent']),
  },
  {
    name: 'locks:queue',
    description: 'See who holds which file locks.',
    input: obj({ owner: { type: 'string' } }),
  },
  // --- design-phase (the UI design loop) ---
  {
    name: 'design-phase:list_tokens',
    description: 'List the DTCG design tokens (brand colors, spacing, type). Check before hand-rolling UI.',
    input: obj({}),
  },
  {
    name: 'design-phase:read_token',
    description: 'Read one design token value.',
    input: obj({ id: { type: 'string' } }, ['id']),
  },
  {
    name: 'design-phase:search_registry',
    description: 'Search the component registry for an existing component before building a new one.',
    input: obj({ query: { type: 'string' } }, ['query']),
  },
  {
    name: 'design-phase:get_registry_component',
    description: 'Get a registry component definition.',
    input: obj({ id: { type: 'string' } }, ['id']),
  },
  {
    name: 'design-phase:record_review',
    description: 'Record a reviewer verdict on a design.',
    input: obj({ verdict: { type: 'string' } }, ['verdict']),
  },
  // --- memory (semantic, durable facts) ---
  {
    name: 'memory:search',
    description: 'Search the user\'s persistent memories by semantic similarity.',
    input: obj({ query: { type: 'string' }, harness_slug: { type: 'string' } }, ['query']),
  },
  {
    name: 'memory:remember',
    description: 'Write a stable curated fact (user pref / convention / decision).',
    input: obj({ body: { type: 'string' }, kind: { type: 'string' } }, ['body']),
  },
  // --- blueprint surface ---
  {
    name: 'blueprint:validate',
    description: 'Validate / inspect a harness blueprint.',
    input: obj({ blueprint: { type: 'string' } }),
  },
  {
    name: 'blueprint:extend',
    description: 'Author a child blueprint by overriding a built-in.',
    input: obj({ base: { type: 'string' }, name: { type: 'string' } }, ['base', 'name']),
  },
  // --- misc high-value SU verbs ---
  {
    name: 'notifications:recent',
    description: "The app's recent toast/error stream — first stop for 'why did the app error?'.",
    input: obj({}),
  },
  {
    // Compact row-encoded read tool (token-efficient-agent-io P-004). Results
    // arrive as self-describing TOON: a `[N]{cols}:` row header carrying the
    // field names INLINE, then N rows of VALUES in that order. It was
    // HEADERLESS CSV until EI-136 measured a ~1/3 column-shift misread — with no
    // inline names the reader had to reach for the prompt legend thousands of
    // tokens away. The P-013 read gate (SU-S08) measures whether the model maps
    // row positions to columns correctly.
    name: 'audit:list',
    description: 'Recent audit events. Returns compact TOON: a `[N]{id,ts,actor,action,subject}:` row header then N rows of comma-separated VALUES in that column order (the header names the columns — map positions to it).',
    input: obj({}),
  },
  {
    name: 'agent_tools:list',
    description:
      'The authoritative, self-describing tool catalog for a role. Inspect it before claiming or offering ' +
      'an execution capability; a route whose launcher is absent must not be offered.',
    input: obj({ asRole: { type: 'string' } }),
  },
  {
    name: 'tools:find',
    description:
      'Search the full live MCP catalog for a capability before offering an execution route. Take a hit\'s ' +
      'exact name + arg schema to tools:invoke; no matching tool means that route is unavailable in this session.',
    input: obj({ query: { type: 'string' } }, ['query']),
  },
  {
    name: 'tools:invoke',
    description:
      'Call any tool returned by tools:find under its exact colon-form name, even when that tool is not loaded ' +
      'directly in the bounded SU catalog. The nested call keeps the target tool\'s real schema and gates.',
    input: obj({
      name: { type: 'string', description: 'Exact colon-form tool name returned by tools:find.' },
      args: {
        type: 'object',
        additionalProperties: true,
        description: 'Arguments matching the target tool\'s argSchema. Defaults to {}.',
      },
    }, ['name']),
  },
  {
    name: 'repomix:pack',
    description: 'Pack a repo (or subset) into one LLM-friendly document for a holistic view.',
    input: obj({ path: { type: 'string' } }),
  },
  {
    name: 'capability:read',
    description:
      'Read a local file with bounded line windows. Use file_path plus offset/limit, or tail for the last lines; ' +
      'raw:true returns undecorated text.',
    input: obj({
      file_path: { type: 'string' },
      offset: { type: 'number' },
      limit: { type: 'number' },
      tail: { type: 'number' },
      raw: { type: 'boolean' },
    }, ['file_path']),
  },
  {
    name: 'logs:read',
    description:
      'Read and server-side-filter host service logs. Empty entries are meaningful only after checking ' +
      'journalError, unitsUnknown, unitsHistorical, and windowOutsideJournal.',
    input: obj({
      unit: {
        oneOf: [
          { type: 'string' },
          { type: 'array', items: { type: 'string' } },
        ],
      },
      since: { type: 'string' },
      until: { type: 'string' },
      grep: { type: 'string' },
      limit: { type: 'number' },
      scope: { type: 'string', enum: ['user', 'system', 'all'] },
    }),
  },
  {
    name: 'dev:pg_query',
    description:
      'Run one bounded READ-ONLY PostgreSQL SELECT/WITH/EXPLAIN. Pass positiveControlSql when zero rows ' +
      'would support an absence claim; this tool cannot mutate data.',
    input: obj({
      sql: { type: 'string' },
      describe: { type: 'string' },
      maxRows: { type: 'number' },
      timeoutMs: { type: 'number' },
      positiveControlSql: { type: 'string' },
      allowUnscoped: { type: 'boolean' },
    }),
  },
  {
    name: 'dev:pipeline_position',
    description:
      'Read where an edit is: working tree, committed on staging, promoted to main, and deployed. ' +
      'For a path it also identifies the process that runs the code and the exact activation/restart call.',
    input: obj({
      path: { type: 'string' },
      sha: { type: 'string' },
      marker: { type: 'string' },
    }),
  },
  {
    name: 'git-sync:run',
    description:
      'FIRE git-sync NOW instead of waiting for its cron tick. dryRun:true previews; a real call runs the ' +
      'same locked commit/push action as the background routine and reports local commit separately from remote egress.',
    input: obj({
      installSlug: { type: 'string' },
      harness: { type: 'string' },
      dryRun: { type: 'boolean' },
      reason: { type: 'string' },
    }),
  },
  {
    name: 'dev:restart',
    description:
      'Coordinated audited restart for operator services. target:"staging" reloads :3170; dry-run unless ' +
      'confirm:true, and authorize:true records the deliberate restart when the runtime gate requires it.',
    input: obj({
      target: {
        type: 'string',
        enum: ['dev', 'staging', 'gateway', 'bg-host', 'embed-sidecar', 'mcp-proxy', 'desktop-dev'],
      },
      confirm: { type: 'boolean' },
      authorize: { type: 'boolean' },
      max_drain_sec: { type: 'number' },
      reason: { type: 'string' },
    }),
  },
  // --- code execution / tool orchestration (code-execution-tool-orchestration B-CX) ---
  // Descriptions mirror the real `code:run` / `code:tools` defineTool descriptions verbatim so the
  // behavior gate (SU-S13/S14) measures whether the playbook's CODE_RUN_NUDGE + these descriptions
  // make the model REACH for code:run on a many-tool-calls task (and NOT for a single call).
  {
    name: 'code:tools',
    description:
      'On-demand typed signatures for code:run. No args → the namespace index (cheap). ' +
      '{ namespaces } / { names } → full TS `tools.ns.verb(args)` signatures for just those, scoped ' +
      'to your allowed set. Read the signatures, then write a code:run script.',
    input: obj({
      namespaces: { type: 'array', items: { type: 'string' }, description: 'Render full signatures for just these namespaces (e.g. ["work_items","coord"]).' },
      names: { type: 'array', items: { type: 'string' }, description: 'Render signatures for these exact tool names (e.g. ["plans:set-status"]).' },
    }),
  },
  {
    name: 'code:run',
    description:
      'Run a multi-step tool-orchestration script (tools.ns.verb(args) + JS control flow) in one ' +
      "call; returns ONLY the script's returned summary. Collapses many tool round-trips into one. " +
      'Use dryRun:true to preview write-effect mutations without executing them.',
    input: obj(
      {
        script: {
          type: 'string',
          description:
            'Plain JavaScript body only (TypeScript annotations such as `: any` are not supported). ' +
            'Call tools via `await tools.ns.verb(args)`; `return` a compact summary.',
        },
        dryRun: { type: 'boolean', description: 'Preview: record effect:write tool calls without executing them (reads still run).' },
        timeoutSec: { type: 'number', description: 'Wall-clock budget (default 30s).' },
      },
      ['script'],
    ),
  },
  // --- su-ideate learning loop: the IDEATE/GRADE ritual (su-ideate-learning-substrate-2026-07-10) ---
  // The verbs the P-014 IDEATE/GRADE contracts mandate — advertised so the mode-batteries (SU-S28
  // ground→file lens-tagged→close-tick; SU-S29 low grade + critique wakes the originator) can
  // actually exercise the ritual. Arg shapes mirror the real blender:* / improvements:capture tools.
  {
    name: 'blender:ideation-feedback',
    description:
      'GROUND an IDEATE pass: the composite learning read over the su-ideate ledger — prior grades + ' +
      'critiques (prior art), realized won/lost outcomes, per-lens win-rates, and the federated frontier. ' +
      'Open every pass with this instead of a blank page.',
    input: obj({
      scope: { type: 'string', description: "'mine' = your own graded ideas/outcomes; default = the pot-wide su-ideate read." },
      intent: { type: 'string', description: "the pass's one-line focus — ranks priming by relevance when passed." },
    }),
  },
  {
    name: 'improvements:capture',
    description:
      'FILE a papercusp improvement you found (friction / gap / idea). For an IDEATE pass use ' +
      "kind:'feature' and TAG the lens you ran via ideation.lens (+ a bet + cheapExperiment when it is a " +
      'real bet) so the row is attributable to the lens that produced it. Use body for the repro/context; ' +
      'toolFailure is the structured shorthand that can derive bounded title/body text. No quality gate, no quota.',
    input: obj(
      {
        kind: { type: 'string', enum: ['bug', 'change', 'feature'], description: "feature = a proposal worth designing; bug/change = a concrete defect/tweak." },
        title: {
          type: 'string',
          description: 'one-line summary; required unless toolFailure is supplied.',
        },
        body: { type: 'string', description: 'repro / context / the correct-state, especially for a bug.' },
        toolFailure: {
          type: 'object',
          description: 'Structured tool-call failure shorthand; title/body may be derived when omitted.',
          properties: {
            toolName: { type: 'string' },
            errorCode: { type: 'string' },
            status: { type: 'string' },
            message: { type: 'string' },
            schemaRevision: { type: 'string' },
            fieldPath: { type: 'string' },
            runtimeVersion: { type: 'string' },
            reproduced: { type: 'boolean' },
            clearServerMismatch: { type: 'boolean' },
            hardInternal: { type: 'boolean' },
            directEvidence: {
              type: 'object',
              properties: {
                kind: {
                  type: 'string',
                  enum: ['valid-input-reproduction', 'server-contract-mismatch', 'hard-internal'],
                },
                expected: { type: 'string' },
                actual: { type: 'string' },
              },
              required: ['kind', 'expected', 'actual'],
            },
          },
          required: ['toolName', 'message'],
        },
        lane: { type: 'string', enum: ['improvement', 'observation'], description: "'observation' = a raw signal to mine later; default = improvement." },
        ideation: {
          type: 'object',
          description: "IDEATE-pass provenance for a kind:'feature' origination (persisted on payload.ideation).",
          properties: {
            lens: { type: 'string', description: "the generative stance that produced the idea (analogical / first-principles / reframing / constraint-removal / risk-first / user-value / cost-leverage)." },
            bet: { type: 'string', description: 'the concrete upside if the idea pans out.' },
            cheapExperiment: {
              type: 'object',
              description:
                'the cheap falsifiable first experiment (ScoutExperiment shape: hypothesis, method, falsifiableSignal; the anti-bullshit gate on "bettable").',
              properties: {
                hypothesis: { type: 'string', description: 'what we believe will be true if the idea has merit.' },
                method: { type: 'string', description: 'the cheap first test to run, build, or measure.' },
                falsifiableSignal: {
                  type: 'string',
                  description: 'the observable that would prove the hypothesis wrong.',
                },
              },
              required: ['hypothesis', 'method', 'falsifiableSignal'],
            },
          },
        },
      },
    ),
  },
  {
    name: 'blender:route-idea',
    description:
      'ROUTE a broad-scope idea onward — the ones that want a plan draft, not a single change. Writes a ' +
      'routed-idea ledger row (what later attributes the outcome back to the lens). Re-route an already-' +
      'filed feature by id, or route a fresh draft straight to a draft plan.',
    input: obj({
      featureId: { type: 'string', description: 'an already-filed su feature (EI id) to re-route onto the plan rail (XOR draft).' },
      draft: {
        type: 'object',
        description: 'a fresh idea to route straight to a draft plan (XOR featureId).',
        properties: {
          title: { type: 'string' },
          framing: { type: 'string', description: 'the why / the reframe.' },
          mechanism: { type: 'string', description: 'the how — the concrete mechanism.' },
          bet: { type: 'string' },
          lens: { type: 'string' },
        },
        required: ['title', 'framing', 'mechanism'],
      },
      rail: { type: 'string', enum: ['plan'], description: "the routing rail (plan rail first)." },
    }, ['rail']),
  },
  {
    name: 'blender:ideate-pass-record',
    description:
      'CLOSE the pass with a ledgered su-ideate tick (ideas filed, observations mined) — the measurable ' +
      'record that makes the loop a loop. A pass that files ideas but records no tick is an OPEN loop: it ' +
      'forfeits the priming the next pass grounds on.',
    input: obj(
      {
        ideasFiled: { type: 'number', description: 'how many ideas this pass filed/routed onward.' },
        observationsMined: { type: 'number', description: 'how many raw observations the pass examined (the denominator of yield).' },
        notes: { type: 'string', description: 'a short note on the pass (theme, corpus, what was skipped).' },
      },
      ['ideasFiled'],
    ),
  },
  {
    name: 'blender:grade-idea',
    description:
      'GRADE a routed su-ideate idea 1–5 (5 = clear win, 1 = clear loss) with a critique. A LOW grade ' +
      '(≤3) plus feedback WAKES the originator to revise (P-005); above it, the feedback is an unwoken FYI. ' +
      'REFUSES a row you authored — no self-grading (D-012), the teaching signal must stay honest.',
    input: obj({
      ideaId: { type: 'string', description: "the routed idea's ledger id (XOR routedRef)." },
      routedRef: { type: 'string', description: 'the routed artifact ref — "plan:<slug>" | "wi:<id>" | "gym:<id>" (XOR ideaId).' },
      grade: { type: 'number', description: '1–5 integer.' },
      feedback: { type: 'string', description: 'the critique shown to the originator / next cycles — the signal to revise against.' },
    }, ['grade']),
  },
];

/**
 * Anthropic tool-name constraint is `^[a-zA-Z0-9_-]{1,64}$` — colons are
 * illegal, and so are the dots in plugin names (`gitnexus.context`). Map EVERY
 * illegal character to `__` for the request, and keep the reverse map so a
 * model `tool_use` is recorded + dispatched under its canonical name (what the
 * asserts match on). Mapping only `:` let a dotted name reach the API, which
 * refused the whole request (400 `tools.N.custom.name`) and turned every
 * scenario on that catalog into an inconclusive run.
 */
export const ANTHROPIC_TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export function sanitizeToolName(canonical: string): string {
  return canonical.replace(/[^a-zA-Z0-9_-]/g, '__');
}

export interface BuiltCatalog {
  /** Anthropic `tools` array (sanitized names). */
  tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  /** sanitized name → canonical colon name. */
  canonicalBySanitized: Map<string, string>;
}

/** Build the Anthropic `tools` array + the reverse name map from a catalog. */
export function buildCatalog(entries: ReadonlyArray<SuCatalogEntry> = SU_CATALOG): BuiltCatalog {
  const tools: BuiltCatalog['tools'] = [];
  const canonicalBySanitized = new Map<string, string>();
  for (const e of entries) {
    const sanitized = sanitizeToolName(e.name);
    // Fail at construction, not as an API 400 mid-battery: an over-long name,
    // or two canonical names that sanitize to the same wire name (which would
    // silently dispatch one tool's calls as the other's), is a catalog bug.
    if (!ANTHROPIC_TOOL_NAME_RE.test(sanitized)) {
      throw new Error(`buildCatalog: tool "${e.name}" sanitizes to "${sanitized}", which violates ${ANTHROPIC_TOOL_NAME_RE}`);
    }
    const prior = canonicalBySanitized.get(sanitized);
    if (prior !== undefined) {
      throw new Error(`buildCatalog: tools "${prior}" and "${e.name}" both sanitize to "${sanitized}"`);
    }
    canonicalBySanitized.set(sanitized, e.name);
    // Anthropic requires input_schema.type === 'object'.
    const schema =
      e.input && (e.input as { type?: unknown }).type === 'object'
        ? e.input
        : { type: 'object' as const };
    tools.push({ name: sanitized, description: e.description, input_schema: schema });
  }
  return { tools, canonicalBySanitized };
}
