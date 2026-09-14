/**
 * User-facing configuration surface: the settings namespace a
 * **Plugin configuration** card edits.
 *
 * The plugin's `cordis.yml` row config stays the composition layer (`base` for
 * the settings scope), so the card only ever stores what a user actually
 * changed and "reset" simply clears a field. `installSection` keeps working on
 * a deployment with no settings provider, where the row config is the whole
 * truth.
 *
 * The effective configuration is therefore resolved, not assigned: the
 * controller re-resolves it whenever the scope attaches, detaches, or commits a
 * change, so a threshold edited in the card applies to the next step with no
 * restart. An invalid write is refused by `validate` before it is persisted,
 * and an invalid *stored* value falls back to the previous effective config
 * with a warning instead of taking the plugin down.
 *
 * @module dsh-context-rollover/settings
 */

import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig } from './config.ts'
import type { ResolvedRolloverConfig, RolloverConfig } from './config.ts'

/** Settings namespace the browser card also keys its registration on. */
export const SETTINGS_NAMESPACE = 'context-rollover'

/**
 * User-editable slice of the configuration. Every field is optional and has no
 * schema default: an absent field means "use the composition value", which is
 * what makes the card able to show and reset per-field overrides.
 */
export interface RolloverSettings {
  /** Automatic rollover pressure point as a fraction of the context window. */
  thresholdRatio?: number
  /** One-time checkpoint reminder point as a fraction of the context window. */
  reminderThresholdRatio?: number
  /** Recent verbatim tail kept across a rollover, as a fraction of the window. */
  retainRatio?: number
  /** Absolute recent-tail budget in tokens; overrides `retainRatio` when set. */
  retainTokens?: number
  /** Maximum accepted handoff text size in characters. */
  handoffMaxChars?: number
  /** Mount the `notes` tool and render notes into checkpoints. */
  notesEnabled?: boolean
  /** Mount the `history` tool. */
  historyEnabled?: boolean
  /** Intercept the session's compaction backend; `false` yields to it. */
  preempt?: boolean
}

/** The engine's own defaults, so the schema and the composition layer agree. */
const ENGINE_DEFAULTS = resolveConfig({})

/** Schemastery validation for {@link RolloverSettings}. */
export const RolloverSettingsSchema: z<RolloverSettings> = z.object({
  thresholdRatio: z.number().default(ENGINE_DEFAULTS.thresholdRatio),
  reminderThresholdRatio: z.number().default(ENGINE_DEFAULTS.reminderThresholdRatio),
  retainRatio: z.number().default(ENGINE_DEFAULTS.retainRatio),
  retainTokens: z.number().step(1).min(0),
  handoffMaxChars: z.number().step(1).min(0).default(ENGINE_DEFAULTS.handoffMaxChars),
  notesEnabled: z.boolean().default(ENGINE_DEFAULTS.notesEnabled),
  historyEnabled: z.boolean().default(ENGINE_DEFAULTS.historyEnabled),
  preempt: z.boolean().default(ENGINE_DEFAULTS.preempt),
})

/**
 * The composition layer the settings scope resolves over: the row config with
 * the engine's defaults filled in, minus fields that mean "unset".
 *
 * A card renders this layer, so it must be the *effective* configuration — an
 * empty base would show empty inputs for every value the user has not touched,
 * which reads as "no value" rather than "the default".
 * @param rowConfig - the plugin row's configuration.
 * @returns every field a card can edit, with nothing absent but deliberate.
 */
export function settingsBase(rowConfig: RolloverConfig): RolloverSettings {
  const resolved = resolveConfig(rowConfig)
  return {
    thresholdRatio: resolved.thresholdRatio,
    reminderThresholdRatio: resolved.reminderThresholdRatio,
    retainRatio: resolved.retainRatio,
    ...(resolved.retainTokens === null ? {} : { retainTokens: resolved.retainTokens }),
    handoffMaxChars: resolved.handoffMaxChars,
    notesEnabled: resolved.notesEnabled,
    historyEnabled: resolved.historyEnabled,
    preempt: resolved.preempt,
  }
}

/**
 * Structural view of the settings service this plugin installs into.
 *
 * Deliberately not a type import of the settings package: the plugin resolves
 * against both host lines, and neither publishes that package's root types on
 * the public line. Only `installSection` is used, and it is the documented
 * consumer entry point.
 */
interface SettingsSectionHost<T> {
  installSection(
    owner: Context,
    ns: string,
    schema: unknown,
    entry: T,
    hooks: {
      readonly validate?: (value: T) => void
      setSource(current: () => T): void
      onChange(): void
    },
  ): void
}

/** What the controller hands the settings section. */
export interface SettingsHooks {
  /**
   * Adopt a new effective configuration. Called for every attach, detach, and
   * committed change.
   * @param config - the resolved configuration to apply.
   */
  (config: ResolvedRolloverConfig): void
}

/**
 * Resolve one settings snapshot into an effective configuration.
 * @param value - merged composition + user value.
 * @returns the validated configuration.
 * @throws when a ratio or budget is out of range (which is also what refuses a
 * write before it is persisted).
 */
export function resolveSettings(value: RolloverSettings): ResolvedRolloverConfig {
  return resolveConfig(value as RolloverConfig)
}

/** Drop `undefined` members so a merge cannot erase a composition field. */
function definedOnly(value: RolloverSettings): RolloverSettings {
  const kept: Record<string, unknown> = {}
  for (const [key, member] of Object.entries(value)) {
    if (member !== undefined) kept[key] = member
  }
  return kept as RolloverSettings
}

/**
 * Install the settings section for one controller.
 *
 * Registration is deferred until the settings service exists, so a deployment
 * without one simply keeps its row config. When the section later attaches,
 * `setSource` delivers the authoritative thunk and `onChange` re-resolves it.
 * @param ctx - host context owning the section's lifetime.
 * @param base - the plugin row's configuration, used as the composition layer.
 * @param adopt - receives the effective configuration on every change.
 */
export function installSettings(ctx: Context, base: RolloverConfig, adopt: SettingsHooks): void {
  // What the card renders: the resolved composition layer, so every control
  // shows the value actually in force rather than an empty box. Nothing is
  // adopted here — the controller already resolved the full row config, and
  // this layer deliberately carries only the fields a card can edit.
  const scopeBase = settingsBase(base)
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = (settingsCtx as unknown as { settings: SettingsSectionHost<RolloverSettings> }).settings
    if (settings === undefined || typeof settings.installSection !== 'function') {
      // A settings service that is not a provider (no installSection) would
      // leave the configuration card unservable: say so rather than hiding it.
      ctx.logger.warn(
        'context rollover: the mounted settings service cannot own a namespace, so the configuration card is unavailable',
      )
      return
    }
    let source = (): RolloverSettings => scopeBase
    settings.installSection(ctx, SETTINGS_NAMESPACE, RolloverSettingsSchema, scopeBase, {
      // Refuse a write the engine could not run with, rather than storing it
      // and failing at the next rollover.
      validate: (value: RolloverSettings) => { resolveSettings(value) },
      setSource: (current) => { source = current },
      onChange: () => {
        try {
          adopt(resolveConfig({ ...base, ...definedOnly(source()) }))
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(
            `context rollover: ignoring invalid stored settings (${message}); keeping the previous values`,
          )
        }
      },
    })
  })
}
