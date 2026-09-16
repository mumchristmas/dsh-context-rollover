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
 * Structural view of the projection registry this module can read through.
 *
 * Deliberately not a type import: the projection package's root types are not
 * published on every supported host line, and `stateOf` is the only member
 * used here.
 */
export interface ModeProjectionReader {
  /**
   * Read one registered unit's current host state, folding the session's own
   * log up to its cursor on first use and incrementally after that.
   * @param session - the session whose state is read.
   * @param key - the registered unit key.
   * @returns the current state, or `undefined` when the key is unregistered.
   */
  stateOf(session: Session, key: string): unknown
}

/**
 * The mode a session runs: the newest recorded selection, or `rollover` when
 * the session never selected one. A resumed or forked session therefore keeps
 * the choice it was made under.
 *
 * Read through the session projection when the deployment has that registry:
 * the projection is the host's own incremental fold of exactly this decision,
 * so the answer is synchronous, current to the session cursor, and free of the
 * full-log scan this otherwise repeats on every step. The registry answers only
 * for a projection it has actually registered, so an absent or unregistered
 * registry falls back to folding the log directly — the same answer, at the
 * cost of a scan.
 * @param session - session whose mode to resolve.
 * @param projections - the projection registry, when the deployment has one.
 * @returns the session's effective context-management mode.
 */
export function sessionMode(session: Session, projections?: ModeProjectionReader): RolloverMode {
  const projected = projectedMode(session, projections)
  if (projected !== undefined) return projected
  let mode: RolloverMode = 'rollover'
  for (const event of sessionEvents(session)) {
    const selected = modeFromEvent(event)
    if (selected !== undefined) mode = selected
  }
  return mode
}

/**
 * The projected mode, when a registry can serve one.
 *
 * A registry read is host state, not plugin state: it may throw for a session
 * it does not own, and declining to answer is a normal outcome rather than a
 * failure. Either way the caller falls back to the log, so a hostile or
 * half-initialized registry can never decide a session's context policy.
 * @param session - session whose mode to resolve.
 * @param projections - the projection registry, when the deployment has one.
 * @returns the projected mode, or `undefined` when none is available.
 */
function projectedMode(
  session: Session,
  projections: ModeProjectionReader | undefined,
): RolloverMode | undefined {
  if (projections === undefined) return undefined
  try {
    const state = projections.stateOf(session, MODE_PROJECTION_KEY)
    return state === 'rollover' || state === 'compact' ? state : undefined
  } catch {
    return undefined
  }
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
