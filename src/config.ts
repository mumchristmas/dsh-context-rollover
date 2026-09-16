/**
 * Plugin configuration: validated once at load, resolved against model context
 * windows at runtime. Ratios scale defaults across models; absolute overrides
 * stay available for stable experiments.
 *
 * @module dsh-context-rollover/config
 */

import z from '@deepseek-ai/schemastery'

/** Model-facing configuration surface for the rollover engine. */
export interface RolloverConfig {
  /**
   * Automatic rollover pressure point as a fraction of the routed model's
   * context window. Defaults to `0.75`, which is deliberately below the stock
   * `compaction-basic` default (`0.8`): the plugin intercepts compaction in
   * every session, so it must reach the window first.
   */
  thresholdRatio?: number
  /**
   * One-time checkpoint reminder point as a fraction of the context window.
   * Defaults to `0.6`.
   */
  reminderThresholdRatio?: number
  /**
   * Width of the last-chance band, as a fraction of the context window. The
   * band sits immediately **below** {@link thresholdRatio}, so it reserves room
   * without moving the rollover: inside it the model is told, once per window,
   * that this is the final stretch and how much prompt growth is left before
   * the window is replaced. `0` disables the band, which is the behavior every
   * release before this one had. Defaults to `0.1`.
   *
   * Below the rollover point rather than above it on purpose: the automatic
   * rollover has to keep firing before any other compaction backend's
   * threshold, or a summarizer wins the session. A band that pushed the
   * rollover later would silently do exactly that.
   */
  lastChanceRatio?: number
  /**
   * Never let a rollover shadow the newest direct human message while its turn
   * is still open. A long autonomous turn can push the request that started it
   * out of the retained tail; this keeps the request (and the work after it)
   * in the fresh window at the cost of a smaller rollover. Defaults to `true`.
   */
  pinActiveRequest?: boolean
  /**
   * Recent verbatim tail retained across a rollover, as a fraction of the
   * context window. Defaults to `0.1`.
   */
  retainRatio?: number
  /**
   * Absolute recent-tail budget in tokens; overrides `retainRatio` when set.
   */
  retainTokens?: number
  /** Maximum accepted handoff text size in characters. Defaults to `20000`. */
  handoffMaxChars?: number
  /** Mount the `notes` tool and render notes into rollover checkpoints. */
  notesEnabled?: boolean
  /** Mount the `history` tool. */
  historyEnabled?: boolean
  /** Base directory for note files; defaults to `<dsh home>/notes/<session id>`. */
  notesDir?: string
  /**
   * Intercept the session's compaction backend: measure pressure and roll the
   * window over before that backend reaches its own threshold, in any session
   * of any agent preset. `false` yields every automatic path (pressure and
   * overflow) to that backend while model-requested `new_context` rollovers
   * keep working. Defaults to `true`.
   */
  preempt?: boolean
  /**
   * Mount this plugin as `ctx.compaction` itself instead of as an
   * interceptor. Only for deployments that disable `compaction-basic`; a
   * session whose realm already provides compaction refuses the second
   * provider. Defaults to `false` (interceptor).
   */
  backend?: boolean
}

/** Schemastery validation for {@link RolloverConfig}. */
export const Config: z<RolloverConfig> = z.object({
  thresholdRatio: z.number(),
  reminderThresholdRatio: z.number(),
  lastChanceRatio: z.number(),
  pinActiveRequest: z.boolean(),
  retainRatio: z.number(),
  retainTokens: z.number().step(1).min(0),
  handoffMaxChars: z.number().step(1).min(0),
  notesEnabled: z.boolean(),
  historyEnabled: z.boolean(),
  notesDir: z.string(),
  preempt: z.boolean(),
  backend: z.boolean(),
})

/** Resolved and validated rollover configuration. */
export interface ResolvedRolloverConfig {
  readonly thresholdRatio: number
  readonly reminderThresholdRatio: number
  readonly lastChanceRatio: number
  readonly pinActiveRequest: boolean
  readonly retainRatio: number
  /** `null` keeps the ratio-based tail budget. */
  readonly retainTokens: number | null
  readonly handoffMaxChars: number
  readonly notesEnabled: boolean
  readonly historyEnabled: boolean
  readonly notesDir: string | undefined
  readonly preempt: boolean
  readonly backend: boolean
}

/** Reject a ratio that cannot represent a fraction of a context window. */
function validateRatio(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new TypeError(`context-rollover: ${name} must be in (0, 1], got ${String(value)}`)
  }
}

/**
 * Validate and fill configuration defaults. Invalid values fail plugin load
 * (misconfiguration fails loud).
 * @param config - raw configuration from the plugin's cordis.yml row.
 * @returns the resolved configuration.
 */
export function resolveConfig(config: RolloverConfig): ResolvedRolloverConfig {
  const thresholdRatio = config.thresholdRatio ?? 0.75
  const reminderThresholdRatio = config.reminderThresholdRatio ?? 0.6
  const requestedLastChance = config.lastChanceRatio ?? 0.1
  const retainRatio = config.retainRatio ?? 0.1
  validateRatio('thresholdRatio', thresholdRatio)
  validateRatio('reminderThresholdRatio', reminderThresholdRatio)
  validateRatio('retainRatio', retainRatio)
  // The band is a width, not a point: zero is the documented way to switch the
  // last-chance protocol off, so it carries its own check rather than the
  // strictly-positive one the other ratios use.
  if (!Number.isFinite(requestedLastChance) || requestedLastChance < 0 || requestedLastChance > 1) {
    throw new TypeError(`context-rollover: lastChanceRatio must be in [0, 1], got ${String(requestedLastChance)}`)
  }
  if (reminderThresholdRatio > thresholdRatio) {
    throw new TypeError(
      `context-rollover: reminderThresholdRatio (${reminderThresholdRatio}) must not exceed `
      + `thresholdRatio (${thresholdRatio})`,
    )
  }
  // The band reserves room *before* the rollover, so it cannot be wider than
  // the point it sits under. That is clamped rather than refused: an existing
  // deployment with a very low `thresholdRatio` was valid before the band
  // existed, and a new default must not turn it into a load failure. The card
  // refuses the pair outright, so a human never writes it on purpose.
  const lastChanceRatio = Math.min(requestedLastChance, thresholdRatio)
  const retainTokens = config.retainTokens ?? null
  if (retainTokens !== null && (!Number.isSafeInteger(retainTokens) || retainTokens < 0)) {
    throw new TypeError(`context-rollover: retainTokens must be a non-negative integer, got ${String(retainTokens)}`)
  }
  const handoffMaxChars = config.handoffMaxChars ?? 20000
  if (!Number.isSafeInteger(handoffMaxChars) || handoffMaxChars <= 0) {
    throw new TypeError(`context-rollover: handoffMaxChars must be a positive integer, got ${String(handoffMaxChars)}`)
  }
  return {
    thresholdRatio,
    reminderThresholdRatio,
    lastChanceRatio,
    pinActiveRequest: config.pinActiveRequest ?? true,
    retainRatio,
    retainTokens,
    handoffMaxChars,
    notesEnabled: config.notesEnabled ?? true,
    historyEnabled: config.historyEnabled ?? true,
    notesDir: config.notesDir,
    preempt: config.preempt ?? true,
    backend: config.backend ?? false,
  }
}
