/**
 * Stop Vditor shipping document content to plantuml.com.
 *
 * cdn-egress-fixes-2026-08-02 P-002. This is the one finding in that audit that
 * is NOT a latency bug: it is egress of user content.
 *
 * WHAT VDITOR DOES. For every ```plantuml block, `plantumlRender` sets:
 *
 *     el.innerHTML =
 *       '<object type="image/svg+xml" data="https://www.plantuml.com/plantuml/svg/~1'
 *       + plantumlEncoder.encode(text) + '"/>'
 *
 * `text` is the diagram SOURCE. It is encoded into the URL and sent to a third
 * party, which renders it and returns the SVG. Any plan, doc or note containing
 * a plantuml block silently posts its contents off-box the moment it is viewed.
 *
 * WHY THE `cdn` OPTION DOES NOT FIX IT — the trap worth remembering. The
 * function SIGNATURE is `plantumlRender(element, cdn)` and it IS called with
 * `mergedOptions.cdn`, so the WI-7088 fix looks like it should cover this. The
 * BODY ignores the parameter entirely and hardcodes plantuml.com
 * (public/vditor/dist/index.js:3897 signature vs :3915 body). The `cdn`
 * argument is a decoy: pointing it at our local mirror changes nothing here.
 *
 * HOW THIS FIXES IT. `plantumlRenderAdapter.getElements` selects
 * `.language-plantuml`, and vditor applies the `transform` hook to the rendered
 * HTML BEFORE plantumlRender runs — verified in both render paths
 * (preview: transform :2468 → plantumlRender :2516; editor: :12372 → :12419).
 * Renaming the class in `transform` means the adapter matches nothing, so the
 * `<object>` is never created and the request is never issued. This is the only
 * interception point that works: by the time plantumlRender has run, the element
 * is already live in the DOM and the browser has already sent the request.
 *
 * WHY FAIL CLOSED (D-003). Zero plantuml blocks exist in our content today, so
 * disabling costs nothing measurable, while the downside of leaving it on is
 * silent content egress. The block still renders — as its own source, in a plain
 * code block — so nothing is hidden from the reader; only the third-party round
 * trip is removed. Re-enabling later means self-hosting a renderer, not flipping
 * this off.
 */

/** The inert class the plantuml adapter will not match. */
export const PLANTUML_NEUTRALIZED_CLASS = 'language-plantuml-neutralized';

/**
 * Rewrite `language-plantuml` so vditor's adapter cannot find it.
 *
 * Idempotent: the negative lookahead refuses to re-match the already-rewritten
 * class, so running this twice (preview re-render, editor live preview) is safe.
 * Scoped to the exact class token so no other language block is affected.
 */
export function neutralizePlantuml(html: string): string {
  return html.replace(/language-plantuml(?![\w-])/g, PLANTUML_NEUTRALIZED_CLASS);
}
