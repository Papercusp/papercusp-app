import type { PapercuspApi } from '@papercusp/plugin-sdk';

interface Props {
  slug: string;
  api: PapercuspApi;
  readOnly: boolean;
}

/**
 * Build-time host fallback (see index.ts). At marketplace runtime the tab
 * is rendered straight from the manifest's `iframeUrlConfigKey`; this
 * component is only used by build-time hosts that resolve `componentId`
 * against an in-host registry.
 */
export default function DocsTab({ api }: Props): JSX.Element {
  const docsUrl =
    (api.config?.get?.('docsUrl') as string | undefined) ??
    'http://localhost:3055/project-docs';
  return (
    <iframe
      src={docsUrl}
      style={{ display: 'block', width: '100%', height: 'calc(100vh - 56px)', border: 'none' }}
      title="Docs"
    />
  );
}
