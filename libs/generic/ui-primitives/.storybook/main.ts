import type { StorybookConfig } from '@storybook/react-vite';

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-docs'],
  framework: { name: '@storybook/react-vite', options: {} },
  typescript: { check: false, reactDocgen: 'react-docgen' },
  core: { disableTelemetry: true },
};

export default config;
