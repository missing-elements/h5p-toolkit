/**
 * What every entry shares, with no Node import: `EmbedError` and the player's files by name. The
 * page's SCORM builder takes them from here, as `build.mjs` imports `node:fs`.
 */

export class EmbedError extends Error {}

/**
 * The player's files, by the names the element looks for beside itself.
 * @internal
 */
export const PLAYER_FILES = ['h5p-player.js', 'h5p-sw.js', 'h5p-jobs.js']
