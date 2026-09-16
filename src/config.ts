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
   * context window. Defaults to `0.79`, one point below the stock
   * `compaction-basic` default (`0.8`): the plugin intercepts compaction in
   * every session, so it must reach the window first, and the ordering guard
   * compares ratios (`otherRatio > thresholdRatio`), which leaves exactly this
   * point of margin.
   *
   * The defaults on all three ratios assume the large-window models that now
   * dominate deployment: a 1M context window turns this point into 790,000
   * tokens and leaves 210,000 tokens of growth before the summarizer's
   * threshold. On a small window the same fractions are far tighter, so treat
   * them as a starting point and re-tune against `get_context_remaining`.
   */
  thresholdRatio?: number
  /**
   * One-time checkpoint reminder point as a fraction of the context window.
   * Defaults to `0.72`.
   *
   * This is the point at which a three-tier ladder still leaves the model a
   * usable span to react *before* the last-chance band begins: with the
   * defaults the band opens at 76% and the rollover fires at 79%.
   *
   * A reminder must land strictly before the band opens, because the engine
   * suppresses an ordinary notice once the band owns the step rather than
   * delivering the weaker message after the stronger one. Resolution enforces
   * that ordering by lowering whichever of the two is derived; the settings card
   * refuses a stated pair that would violate it, so a value written by hand
   * cannot silently become an undeliverable notice.
   */
  reminderThresholdRatio?: number
  /**
   * Where the last-chance stretch begins, as a fraction of the context window.
   * The third and last tier of the ladder, after {@link reminderThresholdRatio}:
   * past this point the model is told, once per window, that this is the final
   * stretch and how much prompt growth is left before the window is replaced.
   * Defaults to `0.76`.
   *
   * A *point*, like its two siblings, even though what it describes is a
   * stretch: an operator reasons about when a tier fires, and the width between
   * this point and {@link thresholdRatio} is arithmetic, not policy. Setting it
   * equal to the rollover point is how the tier is switched off.
   *
   * It sits below the rollover point rather than above it on purpose: the
   * automatic rollover has to keep firing before any other compaction backend's
   * threshold, or a summarizer wins the session. A tier that pushed the
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
 * Clearance the default ladder keeps between the reminder and the last-chance
 * band, as a fraction of the window. The reminder is delivered by an ordinary
 * step, so it needs a step's worth of room in front of the band; a ladder
 * configured to collapse onto the boundary would leave the notice unclaimed.
 */
const LADDER_CLEARANCE = 0.01

/**
 * Validate and fill configuration defaults. Invalid values fail plugin load
 * (misconfiguration fails loud).
 * @param config - raw configuration from the plugin's cordis.yml row.
 * @returns the resolved configuration.
 */
export function resolveConfig(config: RolloverConfig): ResolvedRolloverConfig {
  const thresholdRatio = config.thresholdRatio ?? 0.79
  const lastChanceDefault = config.lastChanceRatio ?? 0.76
  const reminderDefault = config.reminderThresholdRatio ?? 0.72
  const retainRatio = config.retainRatio ?? 0.1
  validateRatio('thresholdRatio', thresholdRatio)
  validateRatio('lastChanceRatio', lastChanceDefault)
  validateRatio('reminderThresholdRatio', reminderDefault)
  validateRatio('retainRatio', retainRatio)
  // ── the ladder ────────────────────────────────────────────────────────────
  //
  // Three points on one line, in the order they fire:
  //
  //     reminder  <  last chance  <  rollover
  //
  // Every one of them is a *point*, so a later tier can never be configured to
  // open after the tier it precedes, and the width of the middle stretch is
  // arithmetic rather than policy. That ordering is not cosmetic: the engine
  // suppresses an ordinary notice once the last-chance tier owns the step,
  // because a weaker message delivered after a stronger one is noise.
  //
  // Each point yields to the room the tier after it leaves, which is what makes
  // a single-field edit supportable: a settings scope hands this function the
  // *whole* effective configuration, so a user who lowers `thresholdRatio`
  // alone would otherwise be tripping over ladder values they never chose. The
  // card refuses a *typed* value that is out of order, which is the mistake a
  // human can still be told how to fix.
  // A derived point keeps clearance from the point after it, so a notice is
  // delivered strictly *before* the next tier opens rather than on its boundary:
  // at the boundary that tier's own guard already owns the step, and a value
  // clamped onto it would be the silent no-op this ladder exists to avoid. The
  // floor is a share of the ceiling rather than a constant, so a harness-sized
  // threshold of a tenth of a percent still resolves to a positive point and a
  // derived default is never the reason a row fails to load.
  const clampDerived = (value: number, ceiling: number): number =>
    Math.max(Math.min(value, ceiling - LADDER_CLEARANCE), ceiling * 0.1)
  // A *stated* point is honored instead, bounded only by the tier after it. That
  // split keeps two opposite uses working at once: an operator may collapse the
  // last-chance point onto the rollover to switch that tier off, while a
  // deployment that lowers only `thresholdRatio` still loads rather than
  // tripping over ladder values it never chose.
  //
  // Both derived points run through the same clamp, and each is bounded by the
  // *resolved* point after it rather than by its stated value: a threshold that
  // pushed the last-chance point down has to carry the reminder down with it,
  // or a collapsed pair would leave tier 1 with no room at all.
  const resolvePoint = (stated: number | undefined, fallback: number, ceiling: number): number =>
    stated === undefined
      ? clampDerived(fallback, ceiling)
      : Math.min(stated, ceiling)
  const lastChanceRatio = resolvePoint(config.lastChanceRatio, lastChanceDefault, thresholdRatio)
  const reminderThresholdRatio = resolvePoint(
    config.reminderThresholdRatio,
    reminderDefault,
    lastChanceRatio,
  )
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
