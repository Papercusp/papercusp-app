/**
 * transcript-wire-fixtures — REAL transcript records, one copy, for every test
 * that claims to know what a backend writes (WI-41499).
 *
 * WHY THIS EXISTS. WI-41498 was a bug in code that HAD tests. The live-stream
 * parser read `payload.arguments` for every codex tool call; current Codex
 * writes `custom_tool_call` with **`input`**, and writes tool output as an
 * ARRAY of `{type:'input_text', text}` blocks. Measured on one live rollout
 * (adv 18014): 170 `custom_tool_call` vs 6 `function_call` — so ~97% of that
 * session's tool chips reached the HUD conversation popup naming a tool and
 * showing nothing it was called with, and 30 of 31 results rendered as a raw
 * `[{"type":"input_text",…}]` dump.
 *
 * `session-timeline-parsers.test.ts` was green throughout. It had NO
 * `custom_tool_call` case at all, and its output case passed `output:'patched'`
 * — a STRING, a shape no current Codex build writes. Every assertion in it was
 * about an INVENTED payload, so it could only ever confirm that the parser
 * agreed with the test author. That is the failure this module exists to make
 * impossible: the fixtures below are **transcribed from real files on disk**
 * (trimmed and redacted, never reshaped), and `readFields` names the exact
 * paths the parser depends on so a live-wire guard can check the same paths
 * against real transcripts and fail loudly when a backend moves one.
 *
 * Sources (dev box, 2026-08-25):
 *  - codex  ~/.papercusp/su-codex-homes/session-18014/sessions/2026/08/24/
 *           rollout-2026-08-24T21-22-31-01a03683-….jsonl  (8.1 MB, live)
 *  - omp    ~/.papercusp/su-omp-homes/session-17497/agent/sessions/
 *           -papercupai-workspace-papercusp/2026-08-24T10-21-33-155Z_….jsonl
 *  - claude ~/.papercusp/session-claude/<owner>/projects/<munged-cwd>/<uuid>.jsonl
 *
 * NOT a test file on purpose: `transcript-wire-live-guard.test.ts` reads the
 * same fixtures against real on-disk transcripts, and two copies of "what the
 * wire looks like" is the exact defect being fixed.
 */

/**
 * A dotted path into a record, with `[]` marking "descend into every element of
 * this array". `payload.output[].text` means: `payload.output` is an array and
 * each element carries a string `text`.
 */
export type WirePath = string;

/**
 * One condition that identifies a record VARIANT on the wire.
 *
 * `value` matches when the path resolves to that value anywhere (so
 * `message.content[].type` = `tool_use` means "has a tool_use block"), and
 * `type` matches on the coarse JS type — which is how a claude `user` record
 * carrying a bare-string prompt is told apart from one carrying an array of
 * tool_result blocks. Both forms are needed: several real record types share a
 * `type` discriminator and differ only in the shape underneath it.
 */
export interface WireDiscriminator {
  readonly path: WirePath;
  readonly value?: string;
  readonly type?: string;
}

export interface WireFixture {
  /** What this record is, for a test name. */
  readonly name: string;
  /**
   * Conditions that IDENTIFY this record variant on the wire, so the live guard
   * can find real examples of it without re-encoding the parser's dispatch
   * logic. Deliberately disjoint from `readFields`: matching on the fields
   * under test would make the guard vacuous — it could only ever select records
   * that already satisfy it.
   */
  readonly discriminator: readonly WireDiscriminator[];
  /**
   * The exact paths the parser READS. This is the contract under test: a build
   * that stops writing one of these breaks the popup, and the live guard fails
   * naming the path rather than leaving it to be rediscovered from a wall of
   * contentless tool chips.
   */
  readonly readFields: readonly WirePath[];
  /** The record, exactly as written on the wire (text trimmed/redacted only). */
  readonly record: Record<string, unknown>;
}

/** The record as a JSONL line, which is what `parseLine` actually takes. */
export function wireLine(f: WireFixture): string {
  return JSON.stringify(f.record);
}

/**
 * Resolve a `WirePath` against a record, returning every value it reaches.
 * An empty result means the path is ABSENT — which is what a wire change looks
 * like from here.
 */
export function resolveWirePath(record: unknown, path: WirePath): unknown[] {
  let cursor: unknown[] = [record];
  for (const rawSeg of path.split('.')) {
    const intoArray = rawSeg.endsWith('[]');
    const seg = intoArray ? rawSeg.slice(0, -2) : rawSeg;
    const next: unknown[] = [];
    for (const node of cursor) {
      if (node == null || typeof node !== 'object') continue;
      const v = (node as Record<string, unknown>)[seg];
      if (v === undefined) continue;
      if (intoArray) {
        if (!Array.isArray(v)) continue;
        next.push(...v);
      } else {
        next.push(v);
      }
    }
    cursor = next;
    if (cursor.length === 0) return [];
  }
  return cursor;
}

/**
 * The coarse JS type of a value — what the guard compares. Coarse on purpose:
 * the point is to catch `input` becoming absent or an array becoming a string,
 * not to pin every nested key of a payload the parser never reads.
 */
export function wireTypeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** Does this record match every condition — i.e. is it an instance of the variant? */
export function matchesDiscriminator(record: unknown, conditions: readonly WireDiscriminator[]): boolean {
  return conditions.every((c) => {
    const found = resolveWirePath(record, c.path);
    if (found.length === 0) return false;
    if (c.value !== undefined && !found.some((v) => v === c.value)) return false;
    if (c.type !== undefined && !found.some((v) => wireTypeOf(v) === c.type)) return false;
    return true;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// codex — rollout jsonl
// ─────────────────────────────────────────────────────────────────────────────

export const CODEX_WIRE_FIXTURES: readonly WireFixture[] = [
  {
    name: 'custom_tool_call (the ~97% case) — args live in `input`, as raw text',
    discriminator: [
      { path: 'type', value: 'response_item' },
      { path: 'payload.type', value: 'custom_tool_call' },
    ],
    readFields: ['payload.type', 'payload.name', 'payload.call_id', 'payload.input'],
    record: {
      timestamp: '2026-08-25T01:22:44.015Z',
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        // Real records carry these too; the parser must ignore them.
        id: 'rs_0d94a1',
        status: 'completed',
        internal_chat_message_metadata_passthrough: null,
        name: 'exec',
        call_id: 'call_lX8Fyf79r9o2c2GDpsFyRkm4',
        // NOT `arguments`, and NOT JSON — raw script text.
        input: 'const hits = ALL_TOOLS.filter(x => /plans|work_items/.test(x.name));\ntext(hits);\n',
      },
    },
  },
  {
    name: 'custom_tool_call_output — `output` is a BLOCK ARRAY, not a string',
    discriminator: [
      { path: 'type', value: 'response_item' },
      { path: 'payload.type', value: 'custom_tool_call_output' },
    ],
    readFields: ['payload.type', 'payload.call_id', 'payload.output[].text'],
    record: {
      timestamp: '2026-08-25T01:22:44.289Z',
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        id: 'rs_0d94a2',
        internal_chat_message_metadata_passthrough: null,
        call_id: 'call_lX8Fyf79r9o2c2GDpsFyRkm4',
        output: [
          { type: 'input_text', text: 'Script completed\nWall time 0.2 seconds\nOutput:' },
          { type: 'input_text', text: 'Total output lines: 1' },
        ],
      },
    },
  },
  {
    // The OTHER real shape of the same record type, found by auditing all 170
    // outputs in the sampled rollout: 164 arrays and 6 bare strings. A
    // backgrounded cell that is still running reports its partial output as
    // plain text. Both must flatten to the same readable string, which is why
    // `blockPayloadText` takes `unknown` rather than a block array.
    name: 'custom_tool_call_output (still-running variant) — `output` is a bare STRING',
    discriminator: [
      { path: 'type', value: 'response_item' },
      { path: 'payload.type', value: 'custom_tool_call_output' },
    ],
    readFields: ['payload.type', 'payload.call_id', 'payload.output'],
    record: {
      timestamp: '2026-08-25T01:33:02.512Z',
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        id: 'rs_0d94e1',
        internal_chat_message_metadata_passthrough: null,
        call_id: 'call_9Kt2ZzQe1mLp0oR4sTuVwXyZ',
        output: 'Script running with cell ID 19\nWall time 31.1 seconds\nOutput:\n',
      },
    },
  },
  {
    // ToolSearch traffic. Distinct from BOTH tool-call shapes above: `arguments`
    // is a real OBJECT here, not the JSON STRING function_call uses and not the
    // raw text custom_tool_call puts in `input`. codexToolCallArgsRaw's
    // `arguments ?? input ?? query` already returns it, so the value reaching the
    // pane is the object — pinning it here is what stops a future "just
    // JSON.parse the arguments" change from silently breaking this record type.
    name: 'response_item/tool_search_call — `arguments` is an OBJECT, not a JSON string',
    discriminator: [
      { path: 'type', value: 'response_item' },
      { path: 'payload.type', value: 'tool_search_call' },
    ],
    readFields: ['payload.type', 'payload.call_id', 'payload.arguments'],
    record: {
      timestamp: '2026-08-31T05:00:35.894Z',
      type: 'response_item',
      payload: {
        type: 'tool_search_call',
        id: 'tsc_0e3db624accab8ba016a950a71d25c87d1b6e20cb95bd83e30',
        call_id: 'call_GsUILTwJYCkvm43tadH28xAq',
        status: 'completed',
        execution: 'client',
        arguments: { query: 'fleet:status loop:checkpoint goals:get' },
        internal_chat_message_metadata_passthrough: { turn_id: '01a05630-84a4-7370-8254-ba1cf7c3d734' },
      },
    },
  },
  {
    // The matching result. NOTE there is no `output` field — the payload is a
    // `tools[]` array — which is why this record produced no tool_result at all
    // until session-timeline-parsers grew a branch for it. `description` is
    // truncated in this fixture ONLY: on the wire it is the tool's entire prompt
    // (a namespace entry carries the whole MCP server instruction block), and the
    // parser deliberately reads names and never descriptions.
    name: 'response_item/tool_search_output — result is `tools[]`, there is NO `output`',
    discriminator: [
      { path: 'type', value: 'response_item' },
      { path: 'payload.type', value: 'tool_search_output' },
    ],
    readFields: ['payload.type', 'payload.call_id', 'payload.tools[].name'],
    record: {
      timestamp: '2026-08-31T05:00:36.005Z',
      type: 'response_item',
      payload: {
        type: 'tool_search_output',
        id: 'tso_01a05630-d524-75f1-8b00-dd5479056750',
        call_id: 'call_GsUILTwJYCkvm43tadH28xAq',
        status: 'completed',
        execution: 'client',
        tools: [
          { type: 'namespace', name: 'mcp__papercusp_su', description: 'Get oriented ONCE per session-with-context …' },
        ],
      },
    },
  },
  {
    name: 'function_call — the minority shape, args in `arguments` as a JSON string',
    discriminator: [
      { path: 'type', value: 'response_item' },
      { path: 'payload.type', value: 'function_call' },
    ],
    readFields: ['payload.type', 'payload.name', 'payload.call_id', 'payload.arguments'],
    record: {
      timestamp: '2026-08-25T01:32:30.390Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        id: 'fc_0d94b1',
        internal_chat_message_metadata_passthrough: null,
        name: 'wait',
        call_id: 'call_5HVc1fREEm78u8woS1eTWvW4',
        arguments: '{"cell_id":"19","yield_time_ms":30000,"max_tokens":12000}',
      },
    },
  },
  {
    name: 'function_call_output — also a BLOCK ARRAY',
    discriminator: [
      { path: 'type', value: 'response_item' },
      { path: 'payload.type', value: 'function_call_output' },
    ],
    readFields: ['payload.type', 'payload.call_id', 'payload.output[].text'],
    record: {
      timestamp: '2026-08-25T01:32:31.002Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        id: 'fc_0d94b2',
        internal_chat_message_metadata_passthrough: null,
        call_id: 'call_5HVc1fREEm78u8woS1eTWvW4',
        output: [{ type: 'input_text', text: 'Script completed\nWall time 0.0 seconds' }],
      },
    },
  },
  {
    // The same record type also arrives as a bare string while a cell is still
    // running. Keep this as a sibling fixture (rather than narrowing the
    // discriminator) so the live guard checks both shapes as one variant group.
    name: 'function_call_output (still-running variant) — `output` is a bare STRING',
    discriminator: [
      { path: 'type', value: 'response_item' },
      { path: 'payload.type', value: 'function_call_output' },
    ],
    readFields: ['payload.type', 'payload.call_id', 'payload.output'],
    record: {
      timestamp: '2026-08-27T23:24:31.847Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        id: 'fco_01a0458a-12e7-79d3-a774-8ab3ebe5f1de',
        call_id: 'call_3NytbeubCVm4GOslHcJZ9OdL',
        output: 'Script running with cell ID 3\nWall time 31.0 seconds\nOutput:\n',
        internal_chat_message_metadata_passthrough: {
          turn_id: '01a04588-0904-7100-8350-0c413abd9522',
          create_time: 1787873071.8474357,
        },
      },
    },
  },
  {
    // A third real shape: tool output handed back as an IMAGE block (a
    // screenshot). Its array elements carry `image_url`/`detail` and NO `text`,
    // so neither sibling could match — the block-array fixture requires
    // `payload.output[].text` and the string fixture requires a bare string —
    // and a live record therefore fit NO fixture at all. Same discriminator, so
    // it stays in the one variant group the guard evaluates with `some()`.
    name: 'function_call_output — IMAGE BLOCK ARRAY (`image_url`, no `text`)',
    discriminator: [
      { path: 'type', value: 'response_item' },
      { path: 'payload.type', value: 'function_call_output' },
    ],
    readFields: ['payload.type', 'payload.call_id', 'payload.output[].image_url'],
    record: {
      timestamp: '2026-09-15T13:52:04.118Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        id: 'fc_3a71c5',
        call_id: 'call_7QpZmK2xVn4RsdTb1eLyWc9A',
        output: [
          {
            type: 'input_image',
            detail: 'auto',
            image_url:
              'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          },
        ],
        internal_chat_message_metadata_passthrough: null,
      },
    },
  },
  {
    name: 'response_item/message assistant — text in `output_text` blocks',
    discriminator: [
      { path: 'type', value: 'response_item' },
      { path: 'payload.type', value: 'message' },
      { path: 'payload.role', value: 'assistant' },
    ],
    readFields: ['payload.type', 'payload.role', 'payload.content[].type', 'payload.content[].text'],
    record: {
      timestamp: '2026-08-25T01:22:43.346Z',
      type: 'response_item',
      payload: {
        type: 'message',
        id: 'msg_0d94c1',
        phase: 'final',
        internal_chat_message_metadata_passthrough: null,
        role: 'assistant',
        content: [{ type: 'output_text', text: "I'm reading the active plan's `## Now` block first." }],
      },
    },
  },
  {
    name: 'response_item/message user — text in `input_text` blocks',
    discriminator: [
      { path: 'type', value: 'response_item' },
      { path: 'payload.type', value: 'message' },
      { path: 'payload.role', value: 'user' },
    ],
    readFields: ['payload.type', 'payload.role', 'payload.content[].type', 'payload.content[].text'],
    record: {
      timestamp: '2026-08-25T01:22:36.408Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'show the turn history' }],
      },
    },
  },
  {
    name: 'response_item/message developer — 244 of 399 messages; MUST be skipped',
    discriminator: [
      { path: 'type', value: 'response_item' },
      { path: 'payload.type', value: 'message' },
      { path: 'payload.role', value: 'developer' },
    ],
    readFields: ['payload.type', 'payload.role'],
    record: {
      timestamp: '2026-08-25T01:22:36.100Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: '<skills_instructions>\n## Skills\n…' }],
      },
    },
  },
  {
    name: 'response_item/reasoning — summary is EMPTY and content encrypted (227 of 227)',
    discriminator: [
      { path: 'type', value: 'response_item' },
      { path: 'payload.type', value: 'reasoning' },
    ],
    readFields: ['payload.type', 'payload.summary'],
    record: {
      timestamp: '2026-08-25T01:22:42.548Z',
      type: 'response_item',
      payload: {
        type: 'reasoning',
        id: 'rs_0d94d1',
        summary: [],
        encrypted_content: 'gAAAAABo…redacted…',
        internal_chat_message_metadata_passthrough: null,
      },
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// omp — agent/sessions jsonl
// ─────────────────────────────────────────────────────────────────────────────

export const OMP_WIRE_FIXTURES: readonly WireFixture[] = [
  {
    name: 'assistant thinking + toolCall — `arguments` is an OBJECT, id is composite',
    discriminator: [
      { path: 'type', value: 'message' },
      { path: 'message.role', value: 'assistant' },
      { path: 'message.content[].type', value: 'thinking' },
      { path: 'message.content[].type', value: 'toolCall' },
    ],
    readFields: [
      'message.role',
      'message.content[].type',
      'message.content[].thinking',
      'message.content[].name',
      'message.content[].id',
      'message.content[].arguments',
    ],
    record: {
      type: 'message',
      id: 'evt_9f2a',
      parentId: null,
      timestamp: '2026-08-24T10:22:19.407Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: "Let me get oriented. I'm a fleet member." },
          {
            type: 'toolCall',
            name: 'read',
            id: '07224da1-9da2-442e-9967-6d0bba3703a4|fc_tmp_4c3fkj9lb5y',
            // Real omp writes an OBJECT here, unlike codex's JSON string.
            arguments: { i: 'Read the schema before first use', path: 'xd://mcp__papercusp_su_scheduler_get_next' },
            intent: 'Read the schema before first use',
          },
        ],
      },
    },
  },
  {
    name: 'assistant text — plain `text` block',
    discriminator: [
      { path: 'type', value: 'message' },
      { path: 'message.role', value: 'assistant' },
      { path: 'message.content[].type', value: 'text' },
    ],
    readFields: ['message.role', 'message.content[].type', 'message.content[].text'],
    record: {
      type: 'message',
      id: 'evt_9f2b',
      timestamp: '2026-08-24T10:22:41.900Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Claimed WI-40012; starting on the resolver.' }],
      },
    },
  },
  {
    /**
     * A turn that FAILED. The provider error is the whole record: `content` is an
     * empty array, so every content-block fixture above matches nothing and the
     * parser's block loop emits no entry at all — a rate-limited session renders
     * as a blank timeline unless something reads `errorMessage`.
     *
     * This is not an exotic variant. When the box's agents are rate-limited it is
     * the DOMINANT one (measured 2026-08-25: 68 of 68 sampled omp assistant
     * records, 53% of the wire), which is what makes it gate-relevant — without a
     * fixture the live guard reds the shared release gate as a function of agent
     * health rather than of any code change (WI-41660).
     */
    name: 'assistant ERROR turn — `content` is EMPTY; the failure lives in `errorMessage`',
    discriminator: [
      { path: 'type', value: 'message' },
      { path: 'message.role', value: 'assistant' },
      { path: 'message.stopReason', value: 'error' },
    ],
    /**
     * `errorStatus` is deliberately NOT read here: only 59 of those 68 records
     * carried one (a retry-budget exhaustion has no HTTP status), so requiring it
     * would fail the variant group on precisely the records it exists to cover.
     * `errorMessage` was present on all 68, always a string.
     */
    readFields: ['message.errorMessage'],
    record: {
      type: 'message',
      id: 'evt_9c71',
      parentId: 'evt_5430',
      timestamp: '2026-08-25T14:28:46.064Z',
      message: {
        role: 'assistant',
        content: [],
        api: 'openrouter',
        provider: 'openrouter',
        model: 'openai/gpt-5.6-luna',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        stopReason: 'error',
        timestamp: 1787668124835,
        errorStatus: 402,
        errorId: 402,
        errorMessage: '402 Insufficient credits. This account never purchased credits.',
      },
    },
  },
  {
    name: 'toolResult role — a MESSAGE role, not a content-block type',
    discriminator: [
      { path: 'type', value: 'message' },
      { path: 'message.role', value: 'toolResult' },
      { path: 'message.content[].type', value: 'text' },
    ],
    readFields: ['message.role', 'message.content[].type', 'message.content[].text'],
    record: {
      type: 'message',
      id: 'evt_9f2c',
      parentId: 'evt_9f2a',
      timestamp: '2026-08-24T10:22:20.534Z',
      message: {
        role: 'toolResult',
        content: [
          { type: 'text', text: '# scheduler:get_next — Atomically claim the next eligible item.' },
          { type: 'text', text: '<system-reminder type="papercusp-orientation">…</system-reminder>' },
        ],
      },
    },
  },
  {
    name: 'user — content is an ARRAY of text blocks, not a string',
    discriminator: [
      { path: 'type', value: 'message' },
      { path: 'message.role', value: 'user' },
      { path: 'message.content[].type', value: 'text' },
    ],
    readFields: ['message.role', 'message.content[].type', 'message.content[].text'],
    record: {
      type: 'message',
      id: 'evt_9f29',
      timestamp: '2026-08-24T10:21:50.768Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: '⟦turn-origin:fleet-kickoff⟧\nDrain the non-p2p bug lane.' }],
      },
    },
  },
  {
    name: 'session — a non-message record that MUST be skipped',
    discriminator: [{ path: 'type', value: 'session' }],
    readFields: ['type'],
    record: {
      type: 'session',
      id: '01a0334a-2863-7021-99d6-20763fed7297',
      // Redacted: the real record carries the agent's absolute cwd. The parser
      // never reads it, and a home path in shipped source reds the identity lint.
      cwd: '<redacted-workspace-root>/papercusp',
      version: '0.4.11',
      timestamp: '2026-08-24T10:21:33.155Z',
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// claude — session-claude projects jsonl
// ─────────────────────────────────────────────────────────────────────────────

export const CLAUDE_WIRE_FIXTURES: readonly WireFixture[] = [
  {
    name: 'assistant tool_use — name/id/input on the content block',
    discriminator: [
      { path: 'type', value: 'assistant' },
      { path: 'message.content[].type', value: 'tool_use' },
    ],
    readFields: [
      'message.content[].type',
      'message.content[].name',
      'message.content[].id',
      'message.content[].input',
    ],
    record: {
      type: 'assistant',
      uuid: 'a1b2c3d4-0000-4000-8000-000000000001',
      parentUuid: 'a1b2c3d4-0000-4000-8000-000000000000',
      sessionId: 'c0ed9f5c-2506-4375-8c97-08001014d8c0',
      timestamp: '2026-08-25T02:56:43.953Z',
      message: {
        content: [
          { type: 'tool_use', name: 'ToolSearch', id: 'toolu_01XnLShooyEUAJMYYyNzn53c', input: { query: 'select:work_items_get' } },
        ],
      },
    },
  },
  {
    name: 'assistant text',
    discriminator: [
      { path: 'type', value: 'assistant' },
      { path: 'message.content[].type', value: 'text' },
    ],
    readFields: ['message.content[].type', 'message.content[].text'],
    record: {
      type: 'assistant',
      uuid: 'a1b2c3d4-0000-4000-8000-000000000002',
      sessionId: 'c0ed9f5c-2506-4375-8c97-08001014d8c0',
      timestamp: '2026-08-25T02:56:43.301Z',
      message: {
        content: [{ type: 'text', text: "I'll start by re-orienting and pulling the carry." }],
      },
    },
  },
  {
    name: 'user tool_result — `content` is an array whose blocks may carry NO text',
    discriminator: [
      { path: 'type', value: 'user' },
      { path: 'message.content[].type', value: 'tool_result' },
    ],
    readFields: ['message.content[].type', 'message.content[].tool_use_id', 'message.content[].content'],
    record: {
      type: 'user',
      uuid: 'a1b2c3d4-0000-4000-8000-000000000003',
      sessionId: 'c0ed9f5c-2506-4375-8c97-08001014d8c0',
      timestamp: '2026-08-25T02:56:46.171Z',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_01XnLShooyEUAJMYYyNzn53c',
            content: [
              { type: 'tool_reference', tool_name: 'mcp__papercusp-su__work_items_get' },
            ],
          },
        ],
      },
    },
  },
  {
    // The MAJORITY shape, and the one the fixtures originally missed: measured
    // across the three newest live transcripts, a tool_result block's `content`
    // is a bare string 43 times and a block array 24 times. Two shapes of one
    // record type, so a reader that handled either alone would blank most of
    // the pane's tool results — the same defect as WI-41498, one backend over.
    name: 'user tool_result (string variant) — `content` is a bare STRING',
    discriminator: [
      { path: 'type', value: 'user' },
      { path: 'message.content[].type', value: 'tool_result' },
    ],
    readFields: ['message.content[].type', 'message.content[].tool_use_id', 'message.content[].content'],
    record: {
      type: 'user',
      uuid: 'a1b2c3d4-0000-4000-8000-000000000005',
      sessionId: 'c0ed9f5c-2506-4375-8c97-08001014d8c0',
      timestamp: '2026-08-25T02:57:10.004Z',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_01Qz9WvUtSrQpOnMlKjIhGfE',
            content: 'packages/operator-core/lib/transcript-wire.ts\n',
          },
        ],
      },
    },
  },
  {
    name: 'user plain prompt — `content` is a bare STRING',
    discriminator: [
      { path: 'type', value: 'user' },
      { path: 'message.content', type: 'string' },
    ],
    readFields: ['message.content'],
    record: {
      type: 'user',
      uuid: 'a1b2c3d4-0000-4000-8000-000000000004',
      sessionId: 'c0ed9f5c-2506-4375-8c97-08001014d8c0',
      timestamp: '2026-08-25T02:56:37.669Z',
      message: { content: '⟦turn-origin:self-compaction⟧\nContinue WI-41499: write the tests.' },
    },
  },
];

/** Every fixture, tagged with the backend whose parser must read it. */
export const ALL_WIRE_FIXTURES: ReadonlyArray<{ backend: 'codex' | 'omp' | 'claude'; fixture: WireFixture }> = [
  ...CODEX_WIRE_FIXTURES.map((fixture) => ({ backend: 'codex' as const, fixture })),
  ...OMP_WIRE_FIXTURES.map((fixture) => ({ backend: 'omp' as const, fixture })),
  ...CLAUDE_WIRE_FIXTURES.map((fixture) => ({ backend: 'claude' as const, fixture })),
];
