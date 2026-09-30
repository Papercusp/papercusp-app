/**
 * defineUITool — convenience helper for tools that return UI fragments.
 *
 * Wraps defineTool. The handler returns `{ data, html?, externalUrl? }`
 * and this helper:
 *   - Calls @mcp-ui/server's `createUIResource` to build a spec-shaped
 *     UIResource payload.
 *   - Adds it to the ToolResponse's uiResources[] alongside `data`.
 *
 * Tools that need richer control (multiple resources, base64 blobs,
 * adapter configs) can drop down to defineTool and construct the
 * UIResource manually.
 *
 * Example:
 *   defineUITool({
 *     name: 'dispatch:card',
 *     capability: 'tasks:read',
 *     args: z.object({ slug: z.string() }),
 *     async handler({ slug }, ctx) {
 *       return {
 *         data: { ok: true },
 *         html: `<div>Dispatching to ${slug}…</div>`,
 *         uri: `ui://dispatch-card/${slug}`,
 *       };
 *     },
 *   });
 */

import { createUIResource } from '@mcp-ui/server';
import { defineTool } from '@papercusp/tooldef';
import type {
  StandardSchemaV1,
  ToolDefinition,
  ToolDefinitionInput,
  ToolResponse,
  UIResourceContent,
} from '@papercusp/tooldef';

export interface UIToolHandlerResult<T = unknown> {
  data: T;
  /** Inline HTML fragment. Rendered in a sandboxed iframe by the client. */
  html?: string;
  /** External URL to embed (alternative to html). Use one or the other. */
  externalUrl?: string;
  /**
   * URI for the UIResource. Must start with `ui://`. Defaults to
   * `ui://<tool-name>/<random-suffix>` if omitted.
   */
  uri?: `ui://${string}`;
  /** Optional metadata (e.g. preferred frame size, theme hints). */
  metadata?: Record<string, unknown>;
  /** Pagination cursor passthrough. */
  nextCursor?: string;
}

export interface UIToolDefinitionInput<TArgs extends StandardSchemaV1 = StandardSchemaV1>
  extends Omit<ToolDefinitionInput<TArgs>, 'handler'> {
  handler: (
    args: StandardSchemaV1.InferOutput<TArgs>,
    ctx: import('@papercusp/tooldef').ToolContext,
  ) => Promise<UIToolHandlerResult>;
}

function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function defineUITool<TArgs extends StandardSchemaV1>(
  input: UIToolDefinitionInput<TArgs>,
): ToolDefinition<TArgs> {
  return defineTool({
    ...input,
    handler: async (args, ctx) => {
      const r = await input.handler(args, ctx);
      const uiResources: UIResourceContent[] = [];
      if (r.html || r.externalUrl) {
        const uri = (r.uri ?? `ui://${input.name ?? 'tool'}/${rand()}`) as `ui://${string}`;
        const ui = createUIResource({
          uri,
          content: r.html
            ? { type: 'rawHtml', htmlString: r.html }
            : { type: 'externalUrl', iframeUrl: r.externalUrl! },
          encoding: 'text',
          metadata: r.metadata,
        });
        uiResources.push(ui as UIResourceContent);
      }
      const response: ToolResponse = { data: r.data };
      if (uiResources.length) response.uiResources = uiResources;
      if (r.nextCursor) response.nextCursor = r.nextCursor;
      return response;
    },
  });
}
