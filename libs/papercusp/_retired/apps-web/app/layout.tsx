import type { Metadata } from 'next';
import { Toaster } from 'sonner';
import SessionIndicator from './_components/SessionIndicator';
import './globals.css';

export const metadata: Metadata = {
  title: 'Papercusp',
  description: 'Open-source autonomous-harness framework. Build, share, and run multi-agent missions.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
      </head>
      <body>
        <header className="pc-header">
          <a href="/" className="brand" aria-label="papercusp" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <img src="/mascot.svg" alt="" width={28} height={28} />
            <img src="/wordmark.svg" alt="papercusp" height={22} />
          </a>
          <nav>
            <a href="/marketplace">Marketplace</a>
            <a href="/settings/api-keys">Settings</a>
            <SessionIndicator />
          </nav>
        </header>
        <main>{children}</main>
        <Toaster theme="dark" position="top-right" />
      </body>
    </html>
  );
}
