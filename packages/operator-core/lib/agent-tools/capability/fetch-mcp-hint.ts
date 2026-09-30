/**
 * capability:fetch — the corrective that fires on the FAILURE PATH when a fetch
 * lands on the MCP streamable-HTTP endpoint and is rejected by the transport.
 *
 * WHY THIS IS NOT JUST MORE PROSE (EI-20233057540755917). `capability:fetch`
 * already carries "for MCP streamable-HTTP POSTs send Accept: application/json,
 * text/event-stream" in BOTH its description and its `guidance.when` — always-on
 * text, read while CHOOSING a tool, never while REPAIRING a rejected call. The
 * same shape was measured on locks:list (EI-20206183390542424): the always-on
 * prose said "omit workspace/harness" three times and 22 distinct agents passed
 * them anyway. So the correction has to live where the caller actually is at the
 * moment they are stuck — on the response — which is also why it costs nothing
 * against the prompt-weight budget.
 *
 * THE MISREADING THIS EXISTS TO KILL. A 405 from `/api/mcp` is not a broken
 * host, not an auth wall, and not a wrong port: the transport refused the HTTP
 * METHOD, which means the request reached a mounted route — positive evidence
 * the operator is UP. Both measured GET callers read it as a failure and went
 * looking for the fault elsewhere. Naming that inversion is the most valuable
 * half of this hint; the runnable command is the second half.
 *
 * Deliberately NOT a `defineTool` guidance field: guidance is prompt-resident on
 * every turn for every agent, and this is worth saying only to the caller who
 * just hit it.
 */

/** The MCP streamable-HTTP mount. Matched on pathname, so query strings and the
 *  `?superuser=1` form both resolve here. */
const MCP_PATHNAME = '/api/mcp';

export interface McpEndpointHintInput {
  /** The absolute URL that was fetched. */
  url: string;
  /** The HTTP method actually sent (already defaulted by the caller). */
  method: string;
  /** The response status. */
  status: number;
}

/** Default ports, so the emitted `--port` is runnable rather than illustrative. */
function portFor(parsed: URL): string {
  if (parsed.port) return parsed.port;
  return parsed.protocol === 'https:' ? '443' : '80';
}

/**
 * Returns a corrective string for an MCP-endpoint transport rejection, or null
 * when the response is none of our business. Null is the common case by design:
 * this must stay silent for ordinary fetches, including successful POSTs to the
 * very same endpoint.
 */
export function mcpEndpointHint(input: McpEndpointHintInput): string | null {
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    // An unparseable URL is not an MCP endpoint we can speak about.
    return null;
  }
  if (parsed.pathname !== MCP_PATHNAME) return null;

  const port = portFor(parsed);
  const door =
    `node scripts/mcp-call.mjs <ns:verb> --json-file <args.json> ` +
    `--client <your-agent-id> --port ${port}`;

  if (input.status === 405) {
    return (
      `${input.method.toUpperCase()} ${MCP_PATHNAME} → 405 is the MCP transport refusing the ` +
      `HTTP METHOD, not an auth wall and not a down host: reaching it at all proves the ` +
      `operator on :${port} is up with the route mounted. For a liveness answer use ` +
      `dev:service_health, which reports that directly. This endpoint speaks JSON-RPC over ` +
      `POST — method POST, headers { "Accept": "application/json, text/event-stream", ` +
      `"Content-Type": "application/json" }, body a JSON-RPC envelope such as ` +
      `{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}. But a hand-rolled POST clears ` +
      `only the FIRST gate, and the second one is invisible to a status check because every ` +
      `shape of it is ALSO HTTP 200: without a superuser bearer, initialize still succeeds, ` +
      `tools/list returns a JSON-RPC error (-32603 "mcp_auth_failed: superuser_invalid_bearer") ` +
      `and NO tools — which reads as a healthy server that simply has none — and tools/call ` +
      `returns a result with isError and "request_rejected: superuser_invalid_bearer". Prefer ` +
      `the door that resolves that credential for you: ${door}`
    );
  }

  if (input.status === 406) {
    return (
      `${MCP_PATHNAME} → 406 is Accept negotiation, not a rejected payload: the MCP ` +
      `streamable-HTTP transport requires BOTH types — send ` +
      `"Accept": "application/json, text/event-stream". application/json alone is refused. ` +
      `To call a tool from a shell instead: ${door}`
    );
  }

  return null;
}
