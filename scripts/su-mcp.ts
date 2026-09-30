#!/usr/bin/env tsx
/**
 * su-mcp.ts — a Bash-drivable HTTP client for the `papercusp-su` MCP.
 *
 * WHY THIS EXISTS (2026-06-22): Claude Code can mark an HTTP MCP server
 * "disconnected" after a single transient transport hiccup and NOT auto-reconnect
 * for the rest of the session — stranding every papercusp-su tool
 * (coord / fleet / work_items / plans / …) even though the operator's
 * `/api/mcp` endpoint is perfectly healthy. That reconnect gap is client-side, not
 * a server fault (verified: `initialize` + `tools/call` both answer HTTP 200). This
 * script is the fallback: drive the same tools over plain HTTP from Bash until the
 * TUI reconnects, so a dropped MCP client never blocks an agent.
 *
 * The endpoint is STATELESS streamable-HTTP (no `Mcp-Session-Id`, no
 * initialize/initialized handshake) — a single POST `tools/call` returns the
 * result as one SSE `data:` frame.
 *
 * TOKEN PARITY WITH THE NATIVE MCP TOOL: this client adopts the SAME result
 * encoding the operator ships (token-efficient-tool-result-formats /
 * token-efficient-agent-io) — it requests `format=compact` EXPLICITLY (→ TOON for
 * arrays, JSON for objects, ~30% leaner reads), the same optimized output the
 * native MCP transport gets by default. We send it explicitly rather than relying
 * on the `transport==='mcp'` default so the optimization can't silently diverge
 * (e.g. via the `Accept` header). Override per call with `--format=json` (lossless
 * `full`) or `--format=csv`/`tsv`/`md` (`tabular`), exactly like the MCP path's
 * `_meta.format`. We never request `structuredContent`, so the result is never
 * doubly-encoded (compact + JSON) — same as the agent-facing MCP default.
 *
 * Usage:
 *   tsx scripts/su-mcp.ts --list                       # list available tool names
 *   tsx scripts/su-mcp.ts <group:verb> '<jsonArgs>'    # call a tool
 *   echo '<jsonArgs>' | tsx scripts/su-mcp.ts <group:verb>   # args on stdin
 * Flags:
 *   --workspace=<ws>   default $PAPERCUSP_WORKSPACE or 'papercusp-workspace'
 *   --client=<id>      identity to act AS — default $PAPERCUSP_SID or the config's
 *                      static-client default (pass your own su-… id to own writes)
 *   --profile=<p>      optional profile
 *   --format=<f>       result encoding: compact (default — TOON/CSV, token-optimized)
 *                      | json (full/lossless) | toon | csv | tsv | md | full | tabular
 *   --raw              print the full JSON-RPC result incl. _meta (default: unwrap a
 *                      single text content to its text — the compact-encoded payload)
 * Examples:
 *   tsx scripts/su-mcp.ts coord:whoami
 *   tsx scripts/su-mcp.ts work_items:create '{"kind":"task","title":"x","harness":"papercusp","assign_to":"su-…"}' --client=su-…
 *
 * Config: the bearer + base URL are read from the `papercusp-su` server block in
 * ~/.claude.json (so it stays in sync if the token rotates — NO secret is baked
 * into this file). Override with PAPERCUSP_MCP_URL + PAPERCUSP_MCP_BEARER.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decode, isResultFormat, type ResultFormat } from '@papercusp/result-encoding';

interface ServerCfg {
  url: string;
  headers?: { Authorization?: string };
}

/** Recursively find the `papercusp-su` MCP server block anywhere in ~/.claude.json
 *  (it can live under top-level mcpServers or a projects[cwd].mcpServers map). */
function findServer(node: unknown): ServerCfg | null {
  if (!node || typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;
  const su = obj['papercusp-su'];
  if (su && typeof su === 'object' && typeof (su as ServerCfg).url === 'string') {
    return su as ServerCfg;
  }
  for (const k of Object.keys(obj)) {
    const found = findServer(obj[k]);
    if (found) return found;
  }
  return null;
}

function loadConfig(): { base: string; bearer: string } {
  const envUrl = process.env.PAPERCUSP_MCP_URL;
  const envBearer = process.env.PAPERCUSP_MCP_BEARER;
  if (envUrl && envBearer) {
    const u = new URL(envUrl);
    return { base: `${u.protocol}//${u.host}${u.pathname}`, bearer: envBearer };
  }
  const raw = readFileSync(join(homedir(), '.claude.json'), 'utf8');
  const srv = findServer(JSON.parse(raw));
  if (!srv) {
    throw new Error(
      'papercusp-su server not found in ~/.claude.json — set PAPERCUSP_MCP_URL + PAPERCUSP_MCP_BEARER to override.',
    );
  }
  const u = new URL(srv.url);
  const base = `${u.protocol}//${u.host}${u.pathname}`; // drop the templated ?query
  const bearer = (srv.headers?.Authorization ?? '').replace(/^Bearer\s+/i, '');
  if (!bearer) throw new Error('papercusp-su server block has no Authorization bearer.');
  return { base, bearer };
}

function parseArgs(argv: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) flags[m[1]] = m[2] ?? '1';
    else positional.push(a);
  }
  return { flags, positional };
}

/**
 * Normalize a text content payload for machine-friendly stdout.
 *
 * Compact MCP responses identify their encoding with `format: <format>\n`.
 * TOON and JSON are lossless, so decode either one and emit canonical compact
 * JSON. CSV/TSV are intentionally left untouched because their decoders coerce
 * values to strings; Markdown is display-only. Unknown markers and malformed
 * lossless payloads also remain raw so this recovery client never invents a
 * value or hides the server's response.
 */
const FORMAT_MARKER_RE = /^format:\s*(\S+)\r?\n/;

export function normalizeResultText(text: string): string {
  const marker = FORMAT_MARKER_RE.exec(text);
  const formatText = marker?.[1];
  const format: ResultFormat | undefined = formatText && isResultFormat(formatText)
    ? formatText
    : marker
      ? undefined
      : 'json';

  // Only JSON and TOON preserve the original value exactly. The marker is
  // retained for lossy/display-only formats so callers can still inspect the
  // representation they explicitly requested.
  if (format !== 'json' && format !== 'toon') return text;

  const body = marker ? text.slice(marker[0].length) : text;
  try {
    return JSON.stringify(decode(body, format)) ?? 'null';
  } catch {
    return text;
  }
}

async function main(): Promise<void> {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const { base, bearer } = loadConfig();

  const client =
    flags.client ?? process.env.PAPERCUSP_SID ?? '28dbf719-6c0e-4f42-a0d2-56d6be156634';
  const workspace = flags.workspace ?? process.env.PAPERCUSP_WORKSPACE ?? 'papercusp-workspace';
  const profile = flags.profile ?? process.env.PAPERCUSP_PROFILE ?? '';
  // Token parity: explicitly request the operator's compact encoding (TOON/CSV) —
  // the same optimization the native MCP transport applies by default — instead of
  // relying on the implicit transport default. `--format=json` for lossless.
  const format = flags.format ?? 'compact';
  const qs = new URLSearchParams({ superuser: '1', client, workspace, format });
  if (profile) qs.set('profile', profile);
  const url = `${base}?${qs.toString()}`;

  const rpc = async (method: string, params: unknown): Promise<Record<string, unknown>> => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const text = await res.text();
    // streamable-HTTP → SSE frames (`data: {...}`); also tolerate a plain JSON body.
    let payload: Record<string, unknown> | null = null;
    if (text.includes('data:')) {
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        try {
          const j = JSON.parse(t.slice(5).trim());
          if (j && (j.result !== undefined || j.error !== undefined)) payload = j;
        } catch {
          /* skip non-JSON data lines */
        }
      }
    } else {
      try {
        payload = JSON.parse(text);
      } catch {
        /* fall through */
      }
    }
    if (!payload) throw new Error(`unparseable MCP response (HTTP ${res.status}): ${text.slice(0, 600)}`);
    if (payload.error) throw new Error(`MCP error: ${JSON.stringify(payload.error)}`);
    return payload.result as Record<string, unknown>;
  };

  if (flags.list !== undefined) {
    const r = await rpc('tools/list', {});
    const names = ((r.tools as { name: string }[]) ?? []).map((t) => t.name).sort();
    console.log(JSON.stringify(names, null, 2));
    console.error(`${names.length} tools (workspace=${workspace}, client=${client})`);
    return;
  }

  const tool = positional[0];
  if (!tool) {
    console.error(
      "usage: tsx scripts/su-mcp.ts <group:verb> '<jsonArgs>' [--workspace=] [--client=] [--raw]\n" +
        '       tsx scripts/su-mcp.ts --list',
    );
    process.exit(2);
  }
  let argStr = positional[1];
  if (argStr === undefined && !process.stdin.isTTY) {
    try {
      argStr = readFileSync(0, 'utf8').trim();
    } catch {
      /* no stdin */
    }
  }
  const args = argStr ? JSON.parse(argStr) : {};
  const result = await rpc('tools/call', { name: tool, arguments: args });

  const content = result?.content as { type: string; text: string }[] | undefined;
  if (!flags.raw && Array.isArray(content) && content.length === 1 && content[0]?.type === 'text') {
    console.log(normalizeResultText(content[0].text));
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
  if (result?.isError) process.exit(1);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
