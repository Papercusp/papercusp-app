/** Type declarations for the pure helpers exported by chaos-runner.mjs. */
export function formatEvent(evt: Record<string, unknown>): string;
export function clampSteps(n: number | string, max?: number): number;
export function pickIndex(len: number, rnd: number): number;
