import type { CustomProjectConfig } from 'lost-pixel';

export const config: CustomProjectConfig = {
  storybookShots: {
    storybookUrl: './storybook-static',
  },
  imagePathBaseline: './lostpixel-baseline',
  imagePathCurrent:  './lostpixel-current',
  imagePathDifference: './lostpixel-diff',
  threshold: 0.05,
  failOnDifference: true,
  generateOnly: !!process.env.LOST_PIXEL_GENERATE_ONLY,
};
