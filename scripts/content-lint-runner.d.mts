export const RESULT_BANNER: string;

export function childExitCode(input: {
  status: number | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
}): number;

export function runContentLint(argv?: string[]): number;
