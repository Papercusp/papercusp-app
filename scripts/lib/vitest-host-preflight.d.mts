export declare function hostPreflight(input: { root: string; files: string[]; env: NodeJS.ProcessEnv }):
  | { verdict: 'admit'; setEnv: Record<string, string> }
  | { verdict: 'skipped'; reason: string }
  | { verdict: 'refuse'; message: string };

/** vitest globalSetup for the standalone (test-config-exempt) configs: throws on refuse, sets the marker on admit. */
export declare function setup(project: { vitest: { state: { getPaths(): string[] } } }): Promise<void>;
