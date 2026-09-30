import type { PapercuspApi } from '@papercusp/plugin-sdk';

interface Props {
  slug: string;
  api: PapercuspApi;
  readOnly: boolean;
}

export default function PiTab({ slug, api }: Props): JSX.Element {
  // Default to a same-origin /pi route so the iframe loads from whatever
  // host:port the operator itself is on. Hardcoding localhost:3055 broke
  // when the operator ran on a different port (3070 prod build) or when
  // the user accessed via a non-localhost hostname (port-forwarded /
  // remote dev environments). Override via plugin config `piUrl` if
  // there's a real cross-origin pi service.
  const piUrlOverride = api.config?.get?.('piUrl') as string | undefined;
  const piUrl = piUrlOverride && piUrlOverride.length > 0 ? piUrlOverride : '/pi';
  const url = `${piUrl.replace(/\/$/, '')}?harness=${encodeURIComponent(slug)}`;
  return (
    <iframe
      src={url}
      style={{ display: 'block', width: '100%', height: 'calc(100vh - 56px)', border: 'none' }}
      title="Pi"
    />
  );
}
