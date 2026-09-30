// Postgres peer entry. Requires `postgres` (postgres-js) as a peer dep.

export { pgListenChannel } from './server/pg-listen-channel';
export type {
  PgListenChannelOptions,
  PgBusChannel,
} from './server/pg-listen-channel';
