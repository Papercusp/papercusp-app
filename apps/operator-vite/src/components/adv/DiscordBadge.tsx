import { useEffect, useRef, useState } from 'react';
import { Tooltip } from '@/app/harness/Tooltip';

interface DiscordData {
  isShared: boolean;
  discord: { guildId: string; inviteUrl: string } | null;
  widget: { presenceCount: number | null; name: string | null } | null;
}

const POLL_MS = 5 * 60 * 1000;

export default function DiscordBadge({ slug }: { slug: string | null }) {
  const [data, setData] = useState<DiscordData | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!slug) { setData(null); return; }

    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/harness/${slug}/discord`);
        if (!res.ok || cancelled) return;
        const json = (await res.json()) as DiscordData;
        if (!cancelled) setData(json);
      } catch { /* network error — stay silent */ }
      if (!cancelled) {
        timerRef.current = setTimeout(load, POLL_MS);
      }
    }
    void load();
    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [slug]);

  if (!data?.isShared || !data.discord) return null;

  const inviteUrl = data.discord.inviteUrl || `https://discord.gg/Q2GZV9Jw`;
  const count = data.widget?.presenceCount ?? null;

  return (
    <>
      <Tooltip label={count !== null ? `${count} online — join the Discord` : 'Join the Discord'}>
        <a
          href={inviteUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="pc-discord-badge"
        >
          {/* Discord logo SVG */}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057c.002.022.015.043.031.056a19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
          </svg>
          {count !== null && (
            <span className="pc-discord-badge__dot" aria-hidden />
          )}
          <span className="pc-discord-badge__label">
            {count !== null ? `${count} online` : 'Discord'}
          </span>
        </a>
      </Tooltip>
      <style>{`
        .pc-discord-badge {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          align-self: center;
          padding: 5px 10px;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0;
          text-decoration: none;
          border-radius: 6px;
          border: 1px solid rgba(88, 101, 242, 0.45);
          background: rgba(88, 101, 242, 0.14);
          color: #a5b4fc;
          flex-shrink: 0;
          transition: background 120ms ease, color 120ms ease;
        }
        .pc-discord-badge:hover {
          background: rgba(88, 101, 242, 0.28);
          color: #e7f7ff;
          border-color: rgba(88, 101, 242, 0.7);
        }
        .pc-discord-badge__dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: #86efac;
          box-shadow: 0 0 6px rgba(134, 239, 172, 0.7);
          flex-shrink: 0;
          animation: pc-discord-pulse 2s ease-in-out infinite;
        }
        @keyframes pc-discord-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.35; }
        }
        .pc-discord-badge__label {
          text-transform: uppercase;
        }
      `}</style>
    </>
  );
}
