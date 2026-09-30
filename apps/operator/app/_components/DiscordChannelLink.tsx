'use client';

/**
 * DiscordChannelLink — Phase 9 P-054a.
 *
 * Renders a Discord deep-link button when the harness has a
 * `discord_channel_url` set in .papercusp/config.json.
 *
 * Click → discord:// deep-link; falls back to HTTPS in a new tab
 * if the deep-link protocol is not registered (detected via
 * iframe trick with a 500ms timeout).
 */

import React, { useCallback } from 'react';
import { MessageSquare } from 'lucide-react';

interface Props {
  /** The discord_channel_url from shared.json / config.json */
  discordChannelUrl: string | null | undefined;
  className?: string;
}

export function DiscordChannelLink({ discordChannelUrl, className }: Props) {
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (!discordChannelUrl) return;
      e.preventDefault();

      // Try the discord:// deep-link first. If it's not handled
      // within 500ms (no Discord app), open the HTTPS equivalent.
      const httpsUrl = discordChannelUrl.startsWith('discord://')
        ? discordChannelUrl.replace('discord://', 'https://discord.com/')
        : discordChannelUrl;

      const discordProtocolUrl = discordChannelUrl.startsWith('discord://')
        ? discordChannelUrl
        : discordChannelUrl.replace('https://discord.com/', 'discord://');

      // Attempt deep-link via hidden iframe (avoids navigation).
      const iframe = document.createElement('iframe');
      iframe.style.display = 'none';
      iframe.src = discordProtocolUrl;
      document.body.appendChild(iframe);

      // Fallback: open HTTPS after 500ms if deep-link didn't fire.
      const fallback = window.setTimeout(() => {
        window.open(httpsUrl, '_blank', 'noopener,noreferrer');
      }, 500);

      // If the page blurs (Discord opened), cancel the fallback.
      const onBlur = () => {
        window.clearTimeout(fallback);
        window.removeEventListener('blur', onBlur);
      };
      window.addEventListener('blur', onBlur);

      setTimeout(() => {
        document.body.removeChild(iframe);
        window.removeEventListener('blur', onBlur);
      }, 1000);
    },
    [discordChannelUrl],
  );

  if (!discordChannelUrl) return null;

  return (
    <a
      href={discordChannelUrl}
      onClick={handleClick}
      className={className}
      aria-label="Open Discord channel"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}
    >
      <MessageSquare size={14} />
      <span style={{ fontSize: 12 }}>Discord</span>
    </a>
  );
}

export default DiscordChannelLink;
