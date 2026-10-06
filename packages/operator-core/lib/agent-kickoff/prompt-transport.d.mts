export const KICKOFF_PROMPT_FILE_ENV: 'PAPERCUSP_KICKOFF_PROMPT_FILE';
export const INLINE_KICKOFF_MAX_BYTES: number;

export function prepareKickoffEnvironment(env: Record<string, string>): Record<string, string>;
export function prepareKickoffEnvironment(env: Record<string, string | undefined>): Record<string, string | undefined>;
export function consumeKickoffPromptFile(path: string | null | undefined): string | null;
