/**
 * What the settings card knows about the compaction backends around it.
 *
 * A rollover threshold is only meaningful next to the threshold of whatever
 * backend serves the session: if the backend fires first, the session is
 * summarised before this plugin's rollover can run, however the plugin is
 * configured. The card therefore reads this report and warns.
 *
 * Three sources feed it, in decreasing directness:
 *
 * - **observed** — backends the running plugin actually resolved for a session,
 *   with the threshold each one publishes. Exact, but only after a session on
 *   that composition has done a step.
 * - **presets** — compositions whose rows mount a compaction module at all,
 *   read from the agent-preset roster. Says "a backend exists here"; the
 *   threshold is the module's own default unless configured.
 * - **stockThresholdRatio** — the default the stock backend would run at with
 *   no configuration, which is what a composition that mounts it and says
 *   nothing else will use.
 *
 * @module dsh-context-rollover/backends
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CompactionEngine } from '@deepseek-ai/dsh-compaction'

/** Absolute path the browser card reads the report from. */
export const BACKEND_ROUTE = '/context-rollover/backends'

/** Default pressure point of the stock backend (`compaction-basic`). */
export const STOCK_BACKEND_THRESHOLD = 0.8

/** Structural read of a backend's published threshold; never required. */
interface BackendShape {
  readonly config?: { readonly thresholdRatio?: number }
}

/**
 * The threshold a backend acts at, when it publishes one. Backends differ in
 * configuration surface, so an unreadable threshold is unknown rather than a
 * failure.
 * @param engine - the resolved backend.
 * @returns the ratio, or undefined when it cannot be read.
 */
export function readBackendThreshold(engine: CompactionEngine): number | undefined {
  const ratio = (engine as unknown as BackendShape).config?.thresholdRatio
  return typeof ratio === 'number' && Number.isFinite(ratio) ? ratio : undefined
}

/** One backend the plugin has resolved for a session. */
export interface BackendObservation {
  /** Backend service name, or `compaction` when it publishes none. */
  readonly name: string
  /** Threshold it acts at, or null when it does not publish one. */
  readonly thresholdRatio: number | null
}

/** The report the settings card renders. */
export interface BackendReport {
  /** Backends resolved for a session so far, first-seen first. */
  readonly observed: readonly BackendObservation[]
  /** Preset ids whose composition mounts a compaction module. */
  readonly presets: readonly string[]
  /** The stock backend's unconfigured threshold. */
  readonly stockThresholdRatio: number
  /** The plugin's own effective values. */
  readonly self: {
    readonly thresholdRatio: number
    readonly reminderThresholdRatio: number
    readonly preempt: boolean
  }
  /**
   * The strictest backend threshold the plugin knows about — what a rollover
   * threshold must stay below. Null when nothing at all is known.
   */
  readonly safeBelow: number | null
}

/** Minimal roster shape this module reads, without a preset-package peer. */
interface CompositionReadableRoster {
  compositionInventory(): Promise<readonly {
    readonly id: string
    readonly rows: readonly { readonly moduleName: string }[]
  }[]>
}

/**
 * Collect the backend report.
 * @param ctx - host context; a missing roster simply omits the preset list.
 * @param observed - backends the controller has resolved, in first-seen order.
 * @param self - the plugin's effective configuration.
 * @returns the report the card renders.
 */
export async function collectBackendReport(
  ctx: Context,
  observed: readonly BackendObservation[],
  self: BackendReport['self'],
): Promise<BackendReport> {
  const presets: string[] = []
  const roster = (ctx as unknown as { get(name: string): unknown }).get('agentPresets') as
    | CompositionReadableRoster
    | undefined
  if (roster !== undefined && typeof roster.compositionInventory === 'function') {
    try {
      for (const composition of await roster.compositionInventory()) {
        if (composition.rows.some(row => row.moduleName.includes('compaction'))) presets.push(composition.id)
      }
    } catch {
      // A roster that cannot describe itself leaves the card with the rest of
      // the report; the guidance still holds.
    }
  }
  const thresholds = observed
    .map(observation => observation.thresholdRatio)
    .filter((ratio): ratio is number => ratio !== null)
  if (thresholds.length === 0 && presets.length > 0) thresholds.push(STOCK_BACKEND_THRESHOLD)
  return {
    observed,
    presets,
    stockThresholdRatio: STOCK_BACKEND_THRESHOLD,
    self,
    safeBelow: thresholds.length === 0 ? null : Math.min(...thresholds),
  }
}

/**
 * Serve the report to the browser card at {@link BACKEND_ROUTE}.
 *
 * Optional on purpose: a profile without a web server (headless) composes no
 * route, and the card falls back to the stock default it already knows.
 * @param ctx - host context; the route registers only when `webServer` exists.
 * @param report - reads the current report for one request.
 */
export function registerBackendRoute(
  ctx: Context,
  report: () => Promise<BackendReport>,
): void {
  ctx.inject(['webServer'], (webCtx) => {
    const server = (webCtx as unknown as {
      webServer: { register(route: {
        kind: 'exact'
        path: string
        handler: (req: { method?: string }, res: {
          writeHead(status: number, headers?: Record<string, string>): { end(body?: string): void }
          end(body?: string): void
        }) => void
      }): () => void }
    }).webServer
    webCtx.effect(() => server.register({
      kind: 'exact',
      path: BACKEND_ROUTE,
      handler: (req, res) => {
        void (async () => {
          if (req.method !== 'GET') {
            res.writeHead(405, { 'content-type': 'text/plain' })
            res.end('method not allowed')
            return
          }
          const body = JSON.stringify(await report())
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(body)
        })()
      },
    }), 'context-rollover backend report route')
  })
}
