import type { CustomProjectConfig } from 'lost-pixel';

/**
 * Lost Pixel — visual regression for the @papercusp/ui-primitives stories.
 *
 * Per testing-spec §1.11: Storybook stories ARE the test cases. Adding
 * a story = adding a visual test. Run:
 *
 *   npm run build-storybook --workspace libs/ui-primitives
 *   npm run lostpixel --workspace libs/ui-primitives
 *
 * Baselines live in `lostpixel-baseline/`; current runs in `lostpixel-current/`;
 * diffs in `lostpixel-diff/`. Update baselines (intentional change) by
 * deleting the affected baseline image and re-running.
 *
 * Spec §1.11 mandates git-lfs for the baseline blobs. With only 4 stories
 * and tiny PNGs (~10–50 KB each) we commit them directly to keep the
 * setup simple; revisit when the story count grows past ~50 images.
 */
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
