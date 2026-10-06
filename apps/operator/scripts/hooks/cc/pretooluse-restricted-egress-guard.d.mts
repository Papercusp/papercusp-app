export declare const PROVIDER_PREFILTER: RegExp[];

export declare const RESTRICTED_EGRESS_MATCHER: string;

export declare function egressTexts(toolName: string, toolInput: Record<string, unknown> | undefined): string[];

export declare function prefilterHits(texts: readonly string[]): boolean;

export declare function restrictedRuntimePaths(env?: NodeJS.ProcessEnv, cwd?: string): string[];

export declare function isRestrictedRuntimePath(target: string, roots: readonly string[]): boolean;

export declare function sandboxedBashCommand(
  command: string,
  opts?: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    uid?: number;
    exists?: (p: string) => boolean;
    bwrap?: string;
    unshare?: string;
  },
): string | null;

export declare function decideEgress(params: {
  toolName: string;
  toolInput?: Record<string, unknown>;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  sandbox?: (command: string) => string | null;
}): Promise<
  | { decision: 'allow' }
  | { decision: 'deny'; reason: string }
  | { decision: 'rewrite'; updatedInput: Record<string, unknown> }
>;
