/**
 * What the composer's rollover control knows about one session right now.
 *
 * The control sits next to the native stat pills and the context-usage donut,
 * and it answers the one question those two do not: *when does this window
 * change*. The answer is a countdown in tokens, and which countdown it is
 * depends on where the window stands against the three configured points
 * (notify, warn, take the window) and on whether this session rolls over at
 * all.
 *
 * The stage is decided here rather than in the browser because the inputs are
 * host state the browser cannot see: the live token measurement behind the next
 * request, the once-per-window claim records in the session log, and whether
 * automatic rollover is armed for this session's realm. The browser receives an
 * enum and numbers, and owns only the words — which is also what keeps the
 * panel's language following the GUI's without a host round trip.
 *
 * @module dsh-context-rollover/status
 */

import type { Context } from '@deepseek-ai/cordis'
import type { RolloverMode } from './mode-key.ts'

/** Absolute path the browser control reads one session's reading from. */
export const STATUS_ROUTE = '/context-rollover/status'

/**
 * Which countdown the control is showing.
 *
 * - `notify` — before the first point: how much growth is left before the
 *   window is reported on.
 * - `warn` — the report has gone out: how much is left before the last-chance
 *   band opens.
 * - `rollover` — inside the band, with automatic rollover armed: how much is
 *   left before this window is taken.
 * - `imminent` — at or past the rollover point: the next safe boundary takes
 *   the window, so there is no countdown left to show.
 * - `compacting` — this window ends in a summary, either because the session is
 *   set to standard compaction or because automatic rollover stands down for a
 *   backend that fires first. Both count down to that backend's point.
 */
export type RolloverStage = 'notify' | 'warn' | 'rollover' | 'imminent' | 'compacting'

/** One session's reading, as the browser control receives it. */
export interface RolloverStatus {
  /** The session's context-management mode. */
  readonly mode: RolloverMode
  /** Which countdown {@link tokensToNext} counts down to. */
  readonly stage: RolloverStage
  /** The prompt the next request would submit, or null before it is measured. */
  readonly promptTokens: number | null
  /** The routed model's context window, or null when it is not known. */
  readonly contextWindow: number | null
  /**
   * Further prompt growth before the action {@link stage} names, or null while
   * nothing is measured. Zero means the action is due at the next boundary.
   */
  readonly tokensToNext: number | null
  /**
   * Where the bar's marks sit, as fractions of the window. The three tier
   * points are the plugin's own configuration; `compact` is the point the
   * compaction backend acts at, which is what the `compacting` stage counts to.
   */
  readonly points: {
    readonly notify: number
    readonly warn: number
    readonly rollover: number
    readonly compact: number
  }
}

/** Everything {@link readStage} decides from. */
export interface StageInput {
  /** The session's context-management mode. */
  readonly mode: RolloverMode
  /** Whether automatic rollover actually runs for this session's realm. */
  readonly armed: boolean
  /** The prompt the next request would submit, or null before it is measured. */
  readonly promptTokens: number | null
  /** The routed model's context window, or null when it is not known. */
  readonly contextWindow: number | null
  /** Whether this window's report has already gone out. */
  readonly notified: boolean
  /** The plugin's three points, and the backend's, as fractions of the window. */
  readonly points: RolloverStatus['points']
}

/**
 * The stage one reading is in, and how much growth is left before its next
 * action.
 *
 * A session that does not roll over — set to standard compaction, or standing
 * down for a backend that fires at or before this plugin's point — is reported
 * as `compacting` whatever its mode says, because that is what will actually
 * happen to the window. Reporting a rollover countdown there would name a
 * boundary that never comes, which is the one thing this control must not do.
 * @param input - the reading to place.
 * @returns the stage and its countdown, either of which may be unmeasurable.
 */
export function readStage(input: StageInput): {
  readonly stage: RolloverStage
  readonly tokensToNext: number | null
} {
  const { contextWindow, promptTokens, points } = input
  /** Where one point sits in tokens, or null while the window is unknown. */
  const at = (ratio: number): number | null =>
    contextWindow === null ? null : Math.floor(contextWindow * ratio)
  /** Further growth before a point, or null while either side is unknown. */
  const until = (target: number | null): number | null =>
    target === null || promptTokens === null ? null : Math.max(0, target - promptTokens)
  if (input.mode === 'compact' || !input.armed) {
    return { stage: 'compacting', tokensToNext: until(at(points.compact)) }
  }
  const rolloverAt = at(points.rollover)
  if (promptTokens !== null && rolloverAt !== null && promptTokens >= rolloverAt) {
    return { stage: 'imminent', tokensToNext: 0 }
  }
  const warnAt = at(points.warn)
  // A collapsed band (the warn point raised onto the rollover point) is a
  // two-tier ladder by choice, not a broken one: it has no warn stage to be in,
  // so the step after the notice is the new window itself.
  const measured = warnAt !== null && rolloverAt !== null
  const collapsed = measured && warnAt >= rolloverAt
  if (measured && !collapsed && promptTokens !== null && promptTokens >= warnAt) {
    return { stage: 'rollover', tokensToNext: until(rolloverAt) }
  }
  const notifyAt = at(points.notify)
  if (input.notified || (promptTokens !== null && notifyAt !== null && promptTokens >= notifyAt)) {
    return collapsed
      ? { stage: 'rollover', tokensToNext: until(rolloverAt) }
      : { stage: 'warn', tokensToNext: until(warnAt) }
  }
  return { stage: 'notify', tokensToNext: until(notifyAt) }
}

/** The session id a status request names, from its query string. */
export function sessionIdFromUrl(url: string | undefined): string | undefined {
  if (typeof url !== 'string') return undefined
  const query = url.indexOf('?')
  if (query === -1) return undefined
  return new URLSearchParams(url.slice(query + 1)).get('session') ?? undefined
}

/**
 * Serve one session's reading to the browser control at {@link STATUS_ROUTE}.
 *
 * Optional on purpose, like the settings card's route: a profile without a web
 * server composes no route, and the control then shows no countdown at all
 * rather than a stale one.
 * @param ctx - host context; the route registers only when `webServer` exists.
 * @param status - reads the current reading for one session id, or null when no
 *   live session has that id.
 */
export function registerStatusRoute(
  ctx: Context,
  status: (sessionId: string) => RolloverStatus | null,
): void {
  ctx.inject(['webServer'], (webCtx) => {
    const server = (webCtx as unknown as {
      webServer: { register(route: {
        kind: 'exact'
        path: string
        handler: (req: { method?: string, url?: string }, res: {
          writeHead(status: number, headers?: Record<string, string>): { end(body?: string): void }
          end(body?: string): void
        }) => void
      }): () => void }
    }).webServer
    webCtx.effect(() => server.register({
      kind: 'exact',
      path: STATUS_ROUTE,
      handler: (req, res) => {
        void (async () => {
          if (req.method !== 'GET') {
            res.writeHead(405, { 'content-type': 'text/plain' })
            res.end('method not allowed')
            return
          }
          const sessionId = sessionIdFromUrl(req.url)
          const reading = sessionId === undefined ? null : status(sessionId)
          // A session the host does not have is not an error the control can
          // act on: it says "nothing to count down to", which the control shows
          // by leaving the tooltip on the mode alone.
          if (reading === null) {
            res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' })
            res.end('null')
            return
          }
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify(reading))
        })()
      },
    }), 'context-rollover status route')
  })
}

/** Everything one reading is built from, gathered by the host half. */
export interface StatusFacts extends StageInput {}

/**
 * One session's reading, assembled from facts the host half gathered.
 *
 * Kept next to {@link readStage} rather than inside the controller so the whole
 * answer — which stage, which countdown, which numbers the bar draws — is one
 * function over one input, and the controller is left holding only the lookups.
 * @param facts - the session's mode, armament, measurement, and points.
 * @returns the reading the browser control renders.
 */
export function statusOf(facts: StatusFacts): RolloverStatus {
  const { stage, tokensToNext } = readStage(facts)
  return {
    mode: facts.mode,
    stage,
    promptTokens: facts.promptTokens,
    contextWindow: facts.contextWindow,
    tokensToNext,
    points: facts.points,
  }
}
