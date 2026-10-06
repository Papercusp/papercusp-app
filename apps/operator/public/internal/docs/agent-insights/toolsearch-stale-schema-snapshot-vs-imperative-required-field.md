# Stale tool schemas are connection snapshots, not automatically schema-generation bugs
URL: /internal/docs/agent-insights/toolsearch-stale-schema-snapshot-vs-imperative-required-field

How to diagnose and recover from stale MCP tool schemas, including connection snapshots, same-process registry revision notifications, tools:find, and tools:invoke.

## What the original incident proved

EI-18783407644768125 observed a connected client's cached `coord:send` schema advertising the removed `expectsReply` field while the live server validator required `expects`. A freshly connected process against the same current server received the correct schema. That ruled out a split JSON-Schema/Zod writer and identified connection-time schema staleness.

`toArgsJsonSchema` derives the advertised schema from the registered Zod schema. The mismatch arose because the client had retained an older `tools/list` snapshot while the dev server hot-reloaded tool definitions in place.

## Invalidation covers membership and same-process contract revisions

Papercusp declares `tools.listChanged:true`. `tools:find` can add a previously invisible tool to a seeded session's mutable surface and emit `notifications/tools/list_changed`. That path still signals **surface membership growth**.

Separately, the MCP host remembers the projected tool-registry revision returned by each session's `tools/list`. After each `tools/call`, it compares that revision with the live registry. A change sends `notifications/tools/list_changed` on the still-open request stream; the remembered revision advances only after the send succeeds. This catches same-process plugin-host refreshes, which unregister and re-register projected tools and advance the contract epoch.

There is no periodic poll. An idle session learns about a registry change on its next tool call. A direct wrapper can remain stale until the signal is sent and the client handles the refreshed listing. This seam covers projected MCP tool contracts; it does not fence serving-build identity, prompt revisions, or database migration frontiers.

## Trimmed-only launch policy changes the population, not the rule

Every SU and role launch now starts from a growable trimmed seed. Claude is seeded too; it no longer receives the full Papercusp catalog at connection time. Native ToolSearch may defer the seed's schemas, but the long tail is discovered with Papercusp `tools:find` and called with `tools:invoke`.

Client behavior after membership or contract-revision notification differs:

* OMP re-fetches on `list_changed` and can materialize a native wrapper.
* Codex may materialize a refreshed wrapper, but acceptance must not depend on it.
* Claude should be treated as not refreshing an existing wrapper; use `tools:invoke` for the discovered tail.

The universal server-side path is stable across all three: `tools:find` returns the live catalog name and argument schema, and `tools:invoke` dispatches that name under the caller's normal authorization context.

## How to diagnose a suspected stale schema

1. **Identify the connection age.** If the session predates the schema change or deployment, its direct wrapper is only a snapshot.
2. **Read the live server shape.** Call `tools:find` for the tool and inspect the returned argument schema. Do not infer current server behavior from an old client wrapper.
3. **Use the universal dispatch path.** Call the target through `tools:invoke { name, args }` when the direct wrapper is absent or suspect.
4. **Reproduce from a fresh session after promotion.** A fresh process must discover the current schema and successfully invoke a representative long-tail tool. Testing before the new source is deployed only proves the old catalog.
5. **Classify the failure.** Fresh `tools:find` current + old wrapper stale means connection snapshot staleness. Fresh `tools:find` and live validation disagreeing on the same server revision is the rarer schema-generation/registration defect.

## Read the discovered argument schema by representation

`tools:find` commonly returns `hits[].argSchema` as compact text from `compactSchemaForResult`. Other callers may supply a JSON-schema object or a JSON-encoded object. Check `typeof` before using object fields such as `properties` or `required`; compact text is an opaque schema description, not an object with those fields.

This bounded `code:run` example selects only the two exact requested tool names, in request order, and returns only their names, availability, representation and argument schemas. It retains compact text byte-for-byte. Arbitrary non-JSON text remains opaque: the example does not validate its grammar or reconstruct JSON-schema properties. Missing hits or schemas, unsupported values, JSON primitives/arrays and malformed JSON-looking text receive a labeled unavailable result. A failed JSON parse beginning with `{`, `[` or a quote is treated as malformed JSON-looking text.

{/* tools-find-argschema-example:start */}

```js
const requested = ["work_items:get", "tools:invoke"];
const discovery = await tools.tools.find({
  query: requested.join(" "),
  limit: 8,
});
const hits = Array.isArray(discovery.hits) ? discovery.hits : [];

function selectSchema(name) {
  const unavailable = (reason) => ({ tool: name, status: "unavailable", reason });
  const hit = hits.find((row) => row && row.tool === name);
  if (!hit) return unavailable("missing-hit");

  let schema = hit.argSchema;
  if (typeof schema === "string") {
    const original = schema;
    const text = original.trim();
    if (!text) return unavailable("missing-schema");
    try {
      schema = JSON.parse(text);
    } catch {
      if (text.startsWith("{") || text.startsWith("[") || text.startsWith('"')) {
        return unavailable("malformed-json");
      }
      return {
        tool: name, status: "available", format: "compact-text", argSchema: original,
      };
    }
  }

  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return unavailable("unsupported-schema");
  }
  return { tool: name, status: "available", format: "json-schema", argSchema: schema };
}

return requested.map(selectSchema);
```

{/* tools-find-argschema-example:end */}

Inspect each available schema to choose the accepted argument keys, then invoke the exact discovered name with `tools:invoke { name, args }`. An unavailable row calls for a narrower discovery read; it does not supply an invented contract. This is caller guidance: the production `tools:find` output is unchanged.

The existing `packages/operator-core/lib/agent-tools/tools/find.test.ts` suite extracts and executes this marked example with compact-schema, object, JSON-encoded-object and unavailable controls. Run `npm run test:file -- packages/operator-core/lib/agent-tools/tools/find.test.ts` to verify it.

## Why a blanket generated-required-set equality test is wrong

`coord:send` deliberately supports both a single-message shorthand and an `items[]` batch. Some fields are optional in the top-level generated schema so the batch form can omit them, while `z.preprocess` enforces the single-message requirements. `work_items:set_state` uses the same intentional duality.

A catalog-wide assertion that generated JSON Schema `required` exactly equals every imperative parse requirement would therefore flag valid tools. Guard a specific shorthand with direct `tool.args.safeParse` tests, and separately test that the live projected schema contains the fields clients need.

## Operational rules

* Treat every direct tool wrapper as connection-scoped schema state.
* Treat `list_changed` as a membership signal and a same-process projected-registry revision signal delivered after a tool call.
* If a session is idle during a registry change, expect its next `tools/call` to send the refresh notification.
* Use a fresh session after deploy for schema acceptance.
* For trimmed long-tail reachability, verify both discovery (`tools:find`) and dispatch (`tools:invoke`).
* Do not reintroduce a full catalog merely to avoid stale wrappers; it restores the context/frame failure while leaving cross-process revision invalidation unsolved.
