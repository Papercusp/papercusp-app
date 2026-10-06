/** The seven public blueprint operation tool names (P-017, D-009), in a module
 * with no imports. `operation-contract` re-exports them beside the wire schemas;
 * a caller that needs only the names (the connected-app spend check) imports
 * them here, so naming a tool never loads the operation service and the blueprint
 * compile graph behind it — that static edge closed an import cycle through
 * `projected-tool-deps` which left module-scope reads undefined mid-evaluation. */
export const BLUEPRINT_OPERATION_TOOLS = {
  submit: 'blueprint:submit',
  status: 'blueprint:status',
  result: 'blueprint:result',
  events: 'blueprint:events',
  cancel: 'blueprint:cancel',
  signal: 'blueprint:signal',
  resume: 'blueprint:resume',
} as const;

export type BlueprintOperationVerb = keyof typeof BLUEPRINT_OPERATION_TOOLS;
