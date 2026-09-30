import type { Preview } from '@storybook/react-vite';

const preview: Preview = {
  parameters: {
    backgrounds: {
      default: 'harness',
      values: [
        { name: 'harness', value: '#0c0e16' },
        { name: 'light',   value: '#ffffff' },
      ],
    },
    layout: 'padded',
  },
};

export default preview;
