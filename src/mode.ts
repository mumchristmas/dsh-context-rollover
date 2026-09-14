/**
 * Per-session context-management mode.
 *
 * The plugin intercepts compaction in every session; this module owns the
 * per-session switch over what happens *after* interception is considered:
 * `rollover` (this plugin crosses the boundary) or `compact` (the session's own
 * backend keeps its native policy and this plugin stands down for it).
 *
 * The choice is recorded with the session's own known event vocabulary — the
 * `/rollover on|off` command's durable `command/run` record — so the log stays
 * readable by any DSH build (an out-of-repo event type would be "unknown and
 * not ignorable" to a reader without this plugin) and the choice survives
 * reload, fork, and resume. A session projection exposes the current value to
 * the Web client, which is what a UI switch reads.
 *
 * @module dsh-context-rollover/mode
 */

import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { sessionEvents } from './compat.ts'
import { MODE_COMMAND, MODE_PROJECTION_KEY } from './mode-key.ts'
import type { RolloverMode } from './mode-key.ts'

export { MODE_COMMAND, MODE_PROJECTION_KEY, MODE_VALUES } from './mode-key.ts'
export type { RolloverMode } from './mode-key.ts'

/**
 * Runtime schema shared by the projection's state and wire halves.
 *
 * Deliberately a plain `parse` object rather than a zod schema: the projection
 * registry only ever calls `parse`, and this package must resolve on both host
 * lines without taking a schema-library dependency of its own.
 */
export const modeSchema: { parse(value: unknown): RolloverMode } = {
  parse(value: unknown): RolloverMode {
    if (value === 'rollover' || value === 'compact') return value
    throw new TypeError(`context-rollover: invalid context-management mode ${String(value)}`)
  },
}

/**
 * The mode one `/rollover` argument selects, when it selects one at all.
 * `on`/`rollover` and `off`/`compact` are synonyms so the switch, the command,
 * and the docs can each use their natural word.
 * @param rawInput - the exact text following the command name.
 * @returns the selected mode, or `undefined` for a non-selecting argument.
 */
export function modeFromArgument(rawInput: string): RolloverMode | undefined {
  switch (rawInput.trim()) {
    case 'on':
    case 'rollover':
      return 'rollover'
    case 'off':
    case 'compact':
      return 'compact'
    default:
      return undefined
  }
}

/** The mode one logged event records, when that event is a mode selection. */
function modeFromEvent(event: SessionEvent): RolloverMode | undefined {
  if (event.type !== 'command/run') return undefined
  const data = event.data as { readonly name?: unknown; readonly args?: unknown }
  if (data.name !== MODE_COMMAND || typeof data.args !== 'string') return undefined
  return modeFromArgument(data.args)
}

/**
 * The mode a session runs: the newest recorded selection, or `rollover` when
 * the session never selected one. Read from the durable log on every call, so a
 * resumed or forked session keeps the choice it was made under.
 * @param session - session whose log to fold.
 * @returns the session's effective context-management mode.
 */
export function sessionMode(session: Session): RolloverMode {
  let mode: RolloverMode = 'rollover'
  for (const event of sessionEvents(session)) {
    const selected = modeFromEvent(event)
    if (selected !== undefined) mode = selected
  }
  return mode
}

/**
 * Session projection exposing {@link sessionMode} to clients. Registered
 * through `ctx.sessionProjections` when the deployment has that registry; the
 * plugin works without it (the switch simply has no live value to read).
 */
export const modeProjectionDefinition = {
  key: MODE_PROJECTION_KEY,
  stateSchema: modeSchema,
  init: (): RolloverMode => 'rollover',
  // Same-reference returns for uninterested events: the registry publishes on
  // `Object.is`, so an unchanged reference produces no client traffic.
  apply: (state: RolloverMode, event: SessionEvent): RolloverMode => modeFromEvent(event) ?? state,
  wire: { viewSchema: modeSchema, view: (state: RolloverMode): RolloverMode => state },
  stateVersion: 1,
}
