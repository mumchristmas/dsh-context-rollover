/**
 * Browser-safe mode vocabulary: the projection key the Web switch reads, the
 * command that records a selection, and the two mode names.
 *
 * Kept free of host imports so the client bundle can share it without pulling
 * `node:crypto` or the session package into the browser. The host half
 * re-exports these from `./mode.ts`.
 *
 * @module dsh-context-rollover/mode-key
 */

/** Which context-management policy one session uses. */
export type RolloverMode = 'rollover' | 'compact'

/** The command whose durable record carries the mode. */
export const MODE_COMMAND = 'rollover'

/** Projection key the Web client reads for its switch. */
export const MODE_PROJECTION_KEY = 'contextRolloverMode'

/** The two legal mode values, in switch order (on = rollover). */
export const MODE_VALUES: readonly RolloverMode[] = ['rollover', 'compact']
