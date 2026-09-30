import type { Meta, StoryObj } from '@storybook/react-vite';
import { HostCheckBanner } from './HostCheckBanner';

const meta: Meta<typeof HostCheckBanner> = {
  component: HostCheckBanner,
};
export default meta;

type Story = StoryObj<typeof HostCheckBanner>;

const passwordlessAuth = {
  '/api/auth/me': {
    user: { has_password: false },
    autoLogin: true,
  },
};

function withMocks(mocks: Record<string, unknown>) {
  return (Story: any) => {
    (window as any).__fetchMocks = mocks;
    return <Story />;
  };
}

export const Allowed_NoBanner: Story = {
  decorators: [withMocks({
    ...passwordlessAuth,
    '/api/provision/host-check': {
      ok: true, decision: 'allow',
      signals: { activeUsers: ['marsh'], configuredUsers: ['marsh'], isShared: false },
    },
  })],
};

export const GatedShared: Story = {
  decorators: [withMocks({
    ...passwordlessAuth,
    '/api/provision/host-check': {
      ok: true, decision: 'gate',
      signals: { activeUsers: ['marsh', 'alex'], configuredUsers: ['marsh'], isShared: true },
    },
  })],
};

export const AlreadyAcked: Story = {
  decorators: [withMocks({
    ...passwordlessAuth,
    '/api/provision/host-check': {
      ok: true, decision: 'allow-acked',
      signals: { activeUsers: ['marsh', 'alex'], configuredUsers: ['marsh'], isShared: true },
    },
  })],
};
