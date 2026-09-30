/**
 * config:terminal-emulator — workspace-local visible-terminal preference.
 *
 * Reuses operator_agent_config rather than inventing a global flag. An absent
 * preference preserves the existing `$TERMINAL` → desktop-aware auto-detection
 * chain, so one user's GNOME preference never changes another installation.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { parseTerminalEmulator, readAgentConfig, writeAgentConfig } from '../../agent-config';

export default defineTool({
  name: 'config:terminal-emulator',
  profile: 'engineer',
  description:
    'Read, set, or clear this workspace’s preferred Linux terminal emulator for visible launches. Set values override $TERMINAL and auto-detection only in this workspace; clear restores the host/default selection chain.',
  capability: 'operator:write',
  guidance: {
    when: 'The owner wants visible agent/session windows to use a specific terminal such as gnome-terminal, konsole, or alacritty.',
    notWhen:
      'To choose headed vs headless — use the launch tool’s headless option. To target an X display — use display.',
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    op: z.enum(['get', 'set', 'clear']).default('get'),
    terminal: z.string().min(1).max(80).optional(),
  }),
  async handler(args) {
    const current = await readAgentConfig();
    if (args.op === 'get') {
      return { data: { ok: true, stored: current.terminal || null, effective: process.env.TERMINAL || null } };
    }
    if (args.op === 'clear') {
      const next = await writeAgentConfig({ ...current, terminal: '' });
      return { data: { ok: true, stored: null, effective: process.env.TERMINAL || null, config: next } };
    }
    const terminal = parseTerminalEmulator(args.terminal);
    if (!terminal) {
      return {
        data: {
          ok: false,
          error: 'invalid_terminal',
          message: 'terminal must be a binary name, not a path or shell command',
        },
      };
    }
    const next = await writeAgentConfig({ ...current, terminal });
    return { data: { ok: true, stored: terminal, effective: process.env.TERMINAL || null, config: next } };
  },
});
