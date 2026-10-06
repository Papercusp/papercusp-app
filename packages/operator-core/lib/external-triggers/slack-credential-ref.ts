/** Shared Slack token-storage references, independent of trigger ingestion. */
export const SLACK_SOCKET_PLUGIN = 'slack-socket';
const FIELD = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function slackSocketCredentialRef(field: string): string {
  if (!FIELD.test(field)) throw new Error('slack_socket_credential_field_invalid');
  return `${SLACK_SOCKET_PLUGIN}:${field}`;
}

export function slackSocketCredentialField(ref: string | null): string {
  const prefix = `${SLACK_SOCKET_PLUGIN}:`;
  if (!ref?.startsWith(prefix) || !FIELD.test(ref.slice(prefix.length))) {
    throw new Error('slack_socket_credential_ref_invalid');
  }
  return ref.slice(prefix.length);
}
