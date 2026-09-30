type PostgresOptions = Record<string, unknown>;

function postgresBrowserShim(_url?: string, _options?: PostgresOptions): never {
  throw new Error('postgres is server-only and cannot run in the operator-vite browser bundle');
}

export type Sql = never;
export default postgresBrowserShim;
