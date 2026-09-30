import type { StorybookConfig } from '@storybook/react-vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const config: StorybookConfig = {
  stories: ['../app/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-docs'],
  framework: { name: '@storybook/react-vite', options: {} },
  typescript: { check: false, reactDocgen: 'react-docgen' },
  core: { disableTelemetry: true },
  // Vite needs to resolve `@/*` paths the same way Next does (per
  // tsconfig.json paths). Aliasing the project root covers the common
  // imports used by stories below.
  viteFinal: async (cfg) => {
    cfg.resolve = cfg.resolve ?? {};
    cfg.resolve.alias = {
      ...(cfg.resolve.alias ?? {}),
      '@': resolve(__dirname, '..'),
    };
    return cfg;
  },
};

export default config;
