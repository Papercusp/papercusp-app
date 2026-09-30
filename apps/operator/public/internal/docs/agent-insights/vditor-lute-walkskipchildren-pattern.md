# Vditor Lute renderers — the WalkSkipChildren selective-override pattern
URL: /internal/docs/agent-insights/vditor-lute-walkskipchildren-pattern

When overriding a Lute renderer in vditor's IR pipeline, return WalkSkipChildren (=1) for the custom case and ["", WalkContinue] for the default fall-through. Returning WalkContinue with custom HTML breaks subsequent renders.

When you register a `SetJSRenderers({ renderers: { Md2VditorIRDOM: { renderX: ... } } })` callback for vditor (3.11.x), the return value `[html: string, walkStop: number]` controls two things at once: what HTML to emit AND whether Lute should recurse into the node's children. Get the walk-stop wrong and rendering breaks in a way that's hard to diagnose — subsequent siblings of the same type just don't render at all.

## The constants

```js
window.Lute.WalkContinue    // 0
window.Lute.WalkSkipChildren // 1
window.Lute.WalkStop        // 2
```

They live on the `Lute` class, not on a per-instance Lute object. Read them once at module init.

## The pattern

For nodes you take over completely (emit your own complete tag pair):

```js
renderCodeSpan(node, entering) {
  if (!entering) return ['', WalkContinue]; // closing pass: emit nothing
  const content = node.Content();
  if (!isMyCase(content)) return ['', WalkContinue]; // fall through to default
  // My case: emit complete <code>X</code>, do NOT recurse.
  return [`<code data-my-attr="${escape(content)}">${escape(content)}</code>`, WalkSkipChildren];
}
```

Three rules:

1. **Selective takeover.** Return `['', WalkContinue]` for cases you don't want to customize — Lute then uses its default renderer for that node.
2. **Custom HTML always pairs with `WalkSkipChildren`.** If you emit a complete `<code>...</code>` and return `WalkContinue`, Lute also fires the per-marker sub-renderers (`renderCodeSpanOpenMarker`, `renderCodeSpanContent`, `renderCodeSpanCloseMarker`) which compose into broken HTML — and as a side effect *subsequent siblings of the same node type stop rendering*. Confirmed empirically: a document with 4 code spans and a `WalkContinue` override produced only 1 in the DOM.
3. **The closing pass returns `['', WalkContinue]`.** When `entering` is false, the open-tag side of your selective takeover is already in the HTML stream; you don't need to do anything.

## Reading content at open-tag time

The catch with `renderCodeSpan` (and other inline-node renderers): when `entering: true` fires, the node's children haven't rendered yet — you can't inspect rendered text. But `node.Content()` returns the source text directly, which is what you need for "decide based on content."

```js
const content = node.Content(); // "todo", "P-001", "agent-plan-tracking", ...
```

For list items: `node.Content()` returns the full text including inline code (`"P-001 todo First"`); `node.Text()` returns it with code spans stripped (`"P-001  First"`).

## Reaching the per-instance Lute

The constants live on the global `Lute` class, but `SetJSRenderers` is a method on the *instance* held by each vditor:

```js
vditor.vditor.lute.SetJSRenderers({ renderers: { Md2VditorIRDOM: ... } });
```

Note the double `.vditor.vditor.lute` — the outer is the React wrapper, the inner is vditor's internal state. See `apps/operator/app/admin/plans/PlanEditor.tsx` for the production wiring via the `MarkdownEditor`'s `onInstance` prop (vs. the React-fiber walk used in the P-001 spike — see [react-fiber-walk-for-imperative-instances](./react-fiber-walk-for-imperative-instances)).

## Common renderers and their non-obvious shapes

Looking at `apps/operator/node_modules/vditor/dist/types/index.d.ts`, several inline nodes also have *sub-marker* renderers:

* `renderCodeSpan` + `renderCodeSpanOpenMarker` + `renderCodeSpanContent` + `renderCodeSpanCloseMarker`
* `renderInlineMath` + `renderInlineMathOpenMarker` + `renderInlineMathContent` + `renderInlineMathCloseMarker`
* `renderEmphasis` + `renderEmAsteriskOpenMarker` + `renderEmAsteriskCloseMarker` + `renderEmUnderscoreOpenMarker` + `renderEmUnderscoreCloseMarker`
* `renderStrong` + four marker variants

If you override the wrapping renderer, the markers still fire by default. `WalkSkipChildren` is what tells Lute to skip them too. If you want to customize just one marker, register the specific marker renderer instead.

## When NOT to override at all

If your decoration logic depends on the rendered DOM (cross-element walking, regex-replacing prose), use the read-mode `Vditor.preview({ renderers })` static path with `after()` for post-render decoration, or the editor's `input(value)` callback in IR mode. The Lute renderer hook is for **per-node** decisions at parse time.

## See also

* [react-fiber-walk-for-imperative-instances](./react-fiber-walk-for-imperative-instances) — reaching the vditor instance from outside the wrapper.
* `apps/operator/app/admin/plans/plan-renderers-ir.ts` — production use (status-pill decoration).
* `apps/operator/app/admin/plans/plan-renderers-ir.test.ts` — unit coverage on the selective-override + walk-stop contract.
