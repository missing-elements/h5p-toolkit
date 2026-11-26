// Written by scripts/sync-h5p-assets.mjs from @missing-elements/h5p-runtime 1.0.2's
// MANIFEST.json (the H5P core at cb64a1f388). Do not edit; run `pnpm sync:assets` in packages/player.

/**
 * The text faces the runtime's stylesheet declares, by file name under its `fonts/`, from its
 * manifest so the two cannot drift. A host that imports it passes URLs in `runtime` instead.
 */
export const FRAME_FONTS = [
  { family: 'Inter', style: 'normal', weight: '400', file: 'inter-400.woff2' },
  { family: 'Inter', style: 'italic', weight: '400', file: 'inter-400-italic.woff2' },
  { family: 'Inter', style: 'normal', weight: '600', file: 'inter-600.woff2' },
  { family: 'Inter', style: 'italic', weight: '600', file: 'inter-600-italic.woff2' },
  { family: 'Inter', style: 'normal', weight: '800', file: 'inter-800.woff2' },
  { family: 'Inter', style: 'italic', weight: '800', file: 'inter-800-italic.woff2' },
  { family: 'Open Sans', style: 'normal', weight: '400', file: 'open-sans-400.woff2' },
  { family: 'Open Sans', style: 'italic', weight: '400', file: 'open-sans-400-italic.woff2' },
  { family: 'Open Sans', style: 'normal', weight: '600', file: 'open-sans-600.woff2' },
  { family: 'Open Sans', style: 'italic', weight: '600', file: 'open-sans-600-italic.woff2' },
  { family: 'Open Sans', style: 'normal', weight: '700', file: 'open-sans-700.woff2' },
  { family: 'Open Sans', style: 'italic', weight: '700', file: 'open-sans-700-italic.woff2' }
] as const
