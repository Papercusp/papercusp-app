import type { Meta, StoryObj } from '@storybook/react-vite';
import ApiKeyStatus from './ApiKeyStatus';

const meta: Meta<typeof ApiKeyStatus> = {
  component: ApiKeyStatus,
};
export default meta;

type Story = StoryObj<typeof ApiKeyStatus>;

function withMocks(mocks: Record<string, unknown>) {
  return (Story: any) => {
    (window as any).__fetchMocks = mocks;
    return <Story />;
  };
}

export const Loading: Story = {
  decorators: [withMocks({ '/api/credentials': new Promise(() => {}) /* never resolves */ })],
};

export const AnthropicOnly: Story = {
  decorators: [withMocks({
    '/api/credentials': { anthropic_api_key: 'sk-ant-…', openai_api_key: null, github_pat: null },
  })],
};

export const AllConfigured: Story = {
  decorators: [withMocks({
    '/api/credentials': {
      anthropic_api_key: 'sk-ant-…',
      openai_api_key: 'sk-…',
      github_pat: 'ghp_…',
    },
  })],
};

export const NoneConfigured: Story = {
  decorators: [withMocks({
    '/api/credentials': { anthropic_api_key: null, openai_api_key: null, github_pat: null },
  })],
};
