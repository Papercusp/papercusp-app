export const HOSTED_PSU_CUSTOMER_ENV: 'PAPERCUSP_PSU_HOSTED_CUSTOMER';
export const HOSTED_PSU_MAX_ARGS: number;

export type HostedPsuArgvResult = { ok: true; argv: string[] } | { ok: false; reason: string };

export function isHostedPsuCustomer(env?: NodeJS.ProcessEnv): boolean;
export function parseHostedPsuCustomerArgv(argv: unknown): HostedPsuArgvResult;
