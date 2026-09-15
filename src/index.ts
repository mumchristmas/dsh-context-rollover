/**
 * Context-window rollover: summarization-free window replacement plus the
 * intercepting listener layer that keeps it ahead of any session's compaction
 * backend, host-plane or preset-owned.
 *
 * Responsibilities stay split (the Codex lesson): the `new_context` tool only
 * requests a boundary, the pre-step / turn-stopping listeners decide when the
 * boundary is actually crossed, the token meter measures pressure and delivers
 * one reminder per window, and {@link commitRollover} performs the surface
 * replacement inside DSH's normal compaction transaction.
 *
 * Two mounting roles share one implementation:
 *
 * - {@link apply} (the default plugin) adds an *interceptor*, mounted at the
 *   host plane so it covers every session of every agent preset. Its
 *   `agent/pre-step` listener is registered with `prepend`, so it measures
 *   pressure and crosses the boundary before the session's compaction backend
 *   reaches its own threshold. That backend keeps its service, its identity,
 *   and its own triggers; only its automatic policy comes second.
 * - {@link ContextRolloverEngine} *is* that backend, for deployments that
 *   disable `compaction-basic` and want rollover to be the only policy.
 *
 * @module dsh-context-rollover
 */

import { Context, symbols } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CompactionEngine, ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { CommandId, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { CONTEXT_WINDOW_EXCEEDED_CODE, boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
// Type-only: makes the optional sibling service available to `ctx.get()`, and
// loads the system-prompt Context merge for the `ctx.systemPrompt` key.
import type {} from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { Seq } from './compat.ts'
import { Config as rolloverConfigSchema, resolveConfig } from './config.ts'
import type { RolloverConfig, ResolvedRolloverConfig } from './config.ts'
import type { RolloverReason } from './checkpoint.ts'
import { buildCheckpointText } from './checkpoint.ts'
import { CONTEXT_MANAGEMENT_GUIDANCE } from './guidance.ts'
import { NotesStore } from './notes.ts'
import { sessionEventAt } from './compat.ts'
import {
  claimReminder,
  commitRollover,
  countRollovers,
  measuredPromptTokens,
  priceCheckpoint,
  REMINDER_SUMMARY_PREFIX,
  RolloverRefusedError,
  selectRolloverRange,
  spanSurfaceNodes,
} from './rollover.ts'
import { createCoreRolloverTools, createOptionalRolloverTools } from './tools.ts'
import type { BoundaryCheck, RolloverToolDependencies } from './tools.ts'
import {
  modeFromArgument,
  modeProjectionDefinition,
  sessionMode,
} from './mode.ts'
import type { RolloverMode } from './mode.ts'
import { hostTranslator } from './i18n.ts'
import { installSettings } from './settings.ts'
import {
  collectBackendReport,
  readBackendThreshold,
  registerBackendRoute,
} from './backends.ts'
import type { BackendObservation, BackendReport } from './backends.ts'
import type { PendingRollover } from './state.ts'

/** Cordis plugin name used by loader diagnostics and message-source attribution. */
export const name = 'context-rollover'

/** Services the plugin needs before it is applied. */
export const inject = ['llm', 'tokenMeter', 'sessions', 'tools', 'systemPrompt']

/** Configuration schema the loader validates a plugin row against. */
export const Config: z<RolloverConfig> = rolloverConfigSchema

export type { RolloverConfig, ResolvedRolloverConfig } from './config.ts'
export { buildCheckpointText } from './checkpoint.ts'
export { NotesStore, resolveNotePath } from './notes.ts'
export { collectHistory, readHistoryItem, searchHistory } from './history.ts'
export {
  commitRollover,
  countRollovers,
  rolloverSummarySeqs,
  selectRolloverRange,
  ROLLOVER_PROVIDER,
} from './rollover.ts'
export { createRolloverTools } from './tools.ts'
export { CONTEXT_MANAGEMENT_GUIDANCE } from './guidance.ts'
export { HOST_DICTIONARIES, hostTranslator, pluginLocale } from './i18n.ts'
export type { PluginLocale } from './i18n.ts'
export {
  RolloverSettingsSchema,
  SETTINGS_NAMESPACE,
  installSettings,
  resolveSettings,
} from './settings.ts'
export type { RolloverSettings } from './settings.ts'
export {
  BACKEND_ROUTE,
  STOCK_BACKEND_THRESHOLD,
  collectBackendReport,
  readBackendThreshold,
  registerBackendRoute,
} from './backends.ts'
export type { BackendObservation, BackendReport } from './backends.ts'
export {
  modeFromArgument,
  modeProjectionDefinition,
  MODE_PROJECTION_KEY,
  sessionMode,
} from './mode.ts'
export type { RolloverMode } from './mode.ts'

/** Identity of one agent turn for per-turn engine bookkeeping. */
function turnKey(sessionId: string, turn: number): string {
  return `${sessionId}#${turn}`
}

/**
 * Minimal agent-preset roster shape, read without a peer dependency on the
 * preset package (the published package mirror does not carry it): resolved
 * at call time through the service store, so rosterless deployments simply
 * observe no roster. Only the `serviceFor` read is used.
 */
interface AgentPresetRoster {
  serviceFor(agent: { ctx: Context }, name: 'compaction'): CompactionEngine | undefined
}

/** Read the agent-preset roster when this deployment has one. */
function rosterOf(ctx: Context): AgentPresetRoster | undefined {
  const roster = (ctx as unknown as { get(name: string): unknown }).get('agentPresets')
  if (roster === undefined || roster === null
    || typeof (roster as AgentPresetRoster).serviceFor !== 'function') return undefined
  return roster as AgentPresetRoster
}

/** Resolve a Cordis traced service proxy to the concrete registered instance. */
function concreteCompaction(engine: CompactionEngine): CompactionEngine {
  return (engine as CompactionEngine & { [symbols.original]?: CompactionEngine })[symbols.original] ?? engine
}

/**
 * Cross-module brand marking a compaction backend as this plugin's engine.
 *
 * `instanceof` only recognizes this module copy's constructor, and the Web
 * profile deliberately loads this module through two different paths — the
 * host bundle row and the agent-preset row sit behind separate realms. A
 * global symbol is readable from every copy, so one row recognizes the other's
 * engine instead of mistaking it for a foreign backend and preempting a
 * session that plugin already owns.
 */
const ENGINE_BRAND = Symbol.for('dsh.context-rollover.backend')

/**
 * Whether a backend is this plugin's rollover engine, from any module copy.
 * @param engine - one resolved compaction backend.
 * @returns true when the backend is a rollover engine.
 */
function isRolloverEngine(engine: CompactionEngine): boolean {
  if (engine instanceof ContextRolloverEngine) return true
  return (engine as unknown as Record<symbol, unknown>)[ENGINE_BRAND] === true
}

/** Minimal shape of the human-command registry this plugin contributes to. */
interface CommandRegistry {
  register(definition: {
    readonly name: string
    readonly description: string
    /**
     * Declaring an input descriptor is what lets a composer claim the text
     * after `/name ` as this command's argument. Without it a Web composer
     * executes the bare token and drops the argument before the host ever
     * parses the line.
     */
    readonly input?: { readonly hint: string }
    readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
  }): () => void
}

/**
 * Rollover policy and listeners over one context.
 *
 * The controller never provides `ctx.compaction`: it is the layer that runs
 * *first* on the shared lifecycle events. When it is mounted as the only
 * backend ({@link ContextRolloverEngine}) it also answers the backend API.
 */
export class RolloverController {
  private effective: ResolvedRolloverConfig

  /** Row configuration, kept as the settings scope's composition layer. */
  private readonly rowConfig: RolloverConfig

  /**
   * Resolved and validated configuration. Re-resolved whenever the settings
   * scope attaches, detaches, or commits a change, so a card edit applies to
   * the next step without a restart.
   */
  get config(): ResolvedRolloverConfig {
    return this.effective
  }

  private readonly pendingRollovers = new Map<string, PendingRollover>()
  /** Turns (session + seq at crossing time) that already had a pressure rollover. */
  private readonly pressureRolledTurns = new Set<string>()
  private readonly overflowRetries = new WeakMap<Agent, number>()
  /** Other backends already reported as firing at or before this plugin. */
  private readonly warnedBackends = new Set<string>()
  /** Human-facing text in the deployment's current language. */
  private readonly t: (key: string, values?: Readonly<Record<string, string | number>>) => string
  /**
   * Backends resolved for a session, keyed by the resolved instance itself.
   * Two presets may both publish a backend called `compaction` at different
   * thresholds; keying by name would let the later, looser one erase the
   * stricter one and make the card report an unsafe bound.
   */
  private readonly observedBackends = new Map<CompactionEngine, BackendObservation>()
  /** Disposers for the optional tools the current configuration mounts. */
  private readonly optionalToolDisposers: Array<() => void> = []
  /** Tool collaborators, retained so a settings change can remount the optionals. */
  private toolDeps: RolloverToolDependencies | undefined

  /**
   * @param ctx - context owning every registration this controller makes.
   * @param config - raw plugin configuration.
   * @param self - the `ctx.compaction` service this controller backs, when it
   *   is mounted as a backend rather than as an interceptor.
   */
  constructor(
    private readonly ctx: Context,
    config: RolloverConfig = {},
    private readonly self?: CompactionEngine,
  ) {
    this.rowConfig = config
    this.effective = resolveConfig(config)
    this.t = hostTranslator(ctx)
    this.registerTools()
    this.registerGuidance()
    this.registerModeProjection()
    this.registerCommand()
    this.registerLifecycle()
    installSettings(ctx, this.rowConfig, (effective) => {
      this.effective = effective
      // The optional tool surface follows the same effective configuration the
      // thresholds do, so a card toggle reaches the model without a restart.
      this.syncOptionalTools()
    })
    registerBackendRoute(ctx, () => this.backendReport())
  }

  /**
   * Mount the model-facing tools.
   *
   * Registered in every session the plugin is mounted over — host plane or a
   * preset realm — because the plugin intercepts compaction in every mode
   * rather than behind an opted-in composition.
   */
  private registerTools(): void {
    const controller = this
    const deps: RolloverToolDependencies = {
      // A getter, not a snapshot. `registerTools` runs before
      // `installSettings`, so a captured value would freeze the row config and
      // a card edit would never reach the tools.
      get config() { return controller.effective },
      meter: this.ctx.tokenMeter,
      pendingRollovers: this.pendingRollovers,
      canRollOver: (session, handoff) => this.checkBoundary(session, handoff),
      modeOf: session => sessionMode(session),
      automaticArmed: agent => this.shouldPreemptAutomatic(agent),
    }
    for (const tool of createCoreRolloverTools(deps)) {
      this.ctx.tools.register(tool)
    }
    this.toolDeps = deps
    this.syncOptionalTools()
    // The optionals are mounted and unmounted over the plugin's lifetime, so
    // unloading has to release whichever ones are live at that moment.
    this.ctx.effect(() => () => {
      for (const dispose of this.optionalToolDisposers.splice(0)) dispose()
    }, 'context-rollover optional tools')
  }

  /**
   * Mount exactly the optional tools the effective configuration enables.
   *
   * A disabled tool is unmounted rather than left to refuse: the model's tool
   * surface has to match the policy in force. `tools.register` returns the
   * disposer that makes this reversible when the card toggles it back on.
   */
  private syncOptionalTools(): void {
    const deps = this.toolDeps
    if (deps === undefined) return
    for (const dispose of this.optionalToolDisposers.splice(0)) dispose()
    const config = this.effective
    const tools = createOptionalRolloverTools(deps, {
      notes: config.notesEnabled,
      history: config.historyEnabled,
    })
    for (const tool of tools) {
      this.optionalToolDisposers.push(this.ctx.tools.register(tool))
    }
  }

  /** Mount the stable context-management guidance section. */
  private registerGuidance(): void {
    this.ctx.systemPrompt.section({
      name: 'context:rollover',
      order: 2350,
      text: CONTEXT_MANAGEMENT_GUIDANCE,
    })
  }

  /**
   * Publish the per-session mode to clients. Absent without a projection
   * registry; the mode itself lives in the session log either way.
   */
  private registerModeProjection(): void {
    const registry = (this.ctx as unknown as { get(name: string): unknown }).get('sessionProjections') as
      | { register(definition: unknown): () => void }
      | undefined
    if (registry === undefined || typeof registry.register !== 'function') return
    this.ctx.effect(
      () => registry.register(modeProjectionDefinition) as unknown as () => void,
      'context-rollover mode projection',
    )
  }

  /**
   * Mount `/rollover now`: cross the boundary through this plugin's own
   * deterministic transaction, even where `/compact` belongs to another
   * backend and would summarize. Absent without a command registry.
   */
  private registerCommand(): void {
    const registry = (this.ctx as unknown as { get(name: string): unknown }).get('commands') as
      | CommandRegistry
      | undefined
    if (registry === undefined || typeof registry.register !== 'function') return
    this.ctx.effect(() => {
      const dispose = registry.register({
        name: 'rollover',
        description: this.t('command.description'),
        input: { hint: '[on|off|status|now]' },
        handler: invocation => this.handleRolloverCommand(invocation),
      })
      return () => { dispose() }
    }, 'context-rollover command')
  }

  /** Register the pending-rollover, pressure, and overflow lifecycle listeners. */
  private registerLifecycle(): void {
    const { ctx } = this

    // Prepend: this listener runs before every other `agent/pre-step`
    // participant — including the realm's ordinary compaction backend — so a
    // pressured window rolls over before a summarizer reaches its threshold.
    ctx.on('agent/pre-step', async (
      { agent, turn, signal },
      next,
    ): Promise<PreStepDecision> => {
      // Resolved once: it decides who may roll over *and* who may speak about
      // it. A host row or a superseded preset generation would otherwise
      // inject a reminder computed from its own thresholds into a session it
      // does not police — the live symptom was a second reminder reading
      // "automatic rollover in 1,169" right after a rollover had happened.
      const ownsAutomatic = this.shouldPreemptAutomatic(agent)
      if (!signal.aborted) {
        const pending = this.pendingRollovers.get(agent.session.id)
        let boundaryKept = false
        if (pending !== undefined) {
          // A model-requested boundary is this plugin's own promise and is
          // kept on every session, preempted or not.
          try {
            const result = await this.performRollover(agent, {
              reason: 'model-requested',
              handoff: pending.handoff,
            }, signal)
            if (result === null) {
              // Nothing worth replacing yet. Consuming the request here would
              // break the promise silently, so it stays queued for a later
              // boundary — and the pressure path below still gets its turn.
              ctx.logger.warn(
                'context rollover: the requested boundary found nothing to replace yet; '
                + 'keeping the request for the next boundary',
              )
            } else {
              this.pendingRollovers.delete(agent.session.id)
              boundaryKept = true
            }
          } catch (error: unknown) {
            // The commit refused (a checkpoint that would not shrink the
            // surface, or a surface that moved under it). Keep the request so
            // a later boundary can keep it.
            const message = error instanceof Error ? error.message : String(error)
            ctx.logger.warn(
              `context rollover failed: ${message}; falling back to the pressure path `
              + 'and retrying the request at the next boundary',
            )
          }
        }
        // The pressure path is an independent safety net: a pending request
        // that could not be kept must never stand it down.
        if (!boundaryKept && ownsAutomatic) {
          try {
            await this.rollOverOnPressure(agent, turn, signal)
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error)
            ctx.logger.warn(`context rollover failed: ${message}; continuing the turn`)
          }
        }
      }
      const decision = await next()
      if (decision.kind === 'reject') return decision
      if (!ownsAutomatic) return decision
      const reminder = this.pendingReminder(agent.session)
      if (reminder === undefined) return decision
      return { kind: 'enter', messages: [...decision.messages, reminder] }
    }, { prepend: true })

    // A rollover requested as the turn's last action still happens before the
    // next turn starts.
    ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
      const pending = this.pendingRollovers.get(agent.session.id)
      if (pending === undefined || signal.aborted) return
      try {
        const result = await this.performRollover(agent, { reason: 'model-requested', handoff: pending.handoff }, signal)
        // A no-op result leaves the request queued: the promise is kept only
        // by an actual commit.
        if (result !== null) this.pendingRollovers.delete(agent.session.id)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`context rollover at turn stop failed: ${message}; retrying at the next boundary`)
      }
    })

    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') this.overflowRetries.delete(agent)
    })

    // Provider-confirmed context overflow: roll over and let the loop resend
    // the request against the checkpoint and retained tail. Also prepended:
    // recovery through a deterministic checkpoint is this plugin's whole
    // point, so it gets the same first look as pressure.
    ctx.on('agent/request-error', async (
      { agent, failure, signal },
      next,
    ) => {
      if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next()
      if (!this.shouldPreemptAutomatic(agent)) return next()
      const generation = agent.session.surface.replaceGeneration
      const retries = this.overflowRetries.get(agent) ?? 0
      try {
        await this.performRollover(agent, { reason: 'overflow', handoff: null }, signal)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`context-overflow rollover failed: ${message}; preserving the original request error`)
        return next()
      }
      if (signal.aborted || agent.session.surface.replaceGeneration <= generation) return next()
      this.overflowRetries.set(agent, retries + 1)
      return { kind: 'retry' }
    }, { prepend: true })
  }

  /**
   * The one-per-window checkpoint reminder, when this step crosses the
   * reminder threshold for the first time in the current window.
   */
  private pendingReminder(session: Session): UserMessage | undefined {
    const contextWindow = session.requestContext()?.contextWindow
    if (contextWindow === undefined) return undefined
    const measurement = this.ctx.tokenMeter.measure(session)
    // The prompt the next request would submit — the quantity the window
    // actually constrains. Not a tally: a rollover lowers it.
    const promptTokens = measuredPromptTokens(measurement)
    if (promptTokens === null) return undefined
    const reminderTokens = Math.floor(contextWindow * this.config.reminderThresholdRatio)
    if (promptTokens < reminderTokens) return undefined
    // Claimed synchronously: on a preset deployment the host row and the
    // preset row both observe this pre-step, and neither delivery is in the
    // log yet when the second one decides.
    if (!claimReminder(session)) return undefined
    const rolloverTokens = Math.floor(contextWindow * this.config.thresholdRatio)
    const windowPercent = Math.min(100, Math.round((promptTokens / contextWindow) * 100))
    return createUserMessage({
      content: [{
        type: 'text',
        text: this.t('reminder', {
          percent: windowPercent,
          used: promptTokens.toLocaleString('en-US'),
          window: contextWindow.toLocaleString('en-US'),
          left: Math.max(0, contextWindow - promptTokens).toLocaleString('en-US'),
          until: Math.max(0, rolloverTokens - promptTokens).toLocaleString('en-US'),
        }),
      }],
      source: {
        kind: 'plugin',
        plugin: name,
        form: 'notice',
        summary: boundContextSummary(`${REMINDER_SUMMARY_PREFIX} (${windowPercent}% of window)`),
      },
    })
  }

  /**
   * Pressure evaluation: one reminder per window below the rollover point,
   * automatic rollover above it. Automatic pressure rollover happens at most
   * once per turn: crossing the threshold again within the same turn means
   * per-step re-injection plus tail exceed the threshold (a config/tail
   * mismatch), which no rollover fixes — rolling over again would burn the
   * prefix cache every step. Model-requested and overflow rollovers are exempt.
   */
  private async rollOverOnPressure(agent: Agent, turn: number, signal: AbortSignal): Promise<void> {
    const contextWindow = agent.session.requestContext()?.contextWindow
    if (contextWindow === undefined) return
    const measurement = this.ctx.tokenMeter.measure(agent.session)
    const promptTokens = measuredPromptTokens(measurement)
    if (promptTokens === null) return
    const rolloverTokens = Math.floor(contextWindow * this.config.thresholdRatio)
    if (promptTokens < rolloverTokens) return
    if (this.pressureRolledTurns.has(turnKey(agent.session.id, turn))) {
      this.ctx.logger.warn(
        `context rollover: usage is still above the automatic threshold after this turn's pressure `
        + `rollover (tail + per-step context likely exceed thresholdRatio * contextWindow); `
        + 'skipping further automatic rollovers this turn',
      )
      return
    }
    await this.performRollover(agent, { reason: 'pressure', handoff: null }, signal)
    this.pressureRolledTurns.add(turnKey(agent.session.id, turn))
  }

  /**
   * Whether the automatic paths (pressure and overflow) should run here.
   *
   * This is deliberately realm-blind: the plugin intercepts compaction in
   * every session, including one whose agent preset mounts its own backend in
   * its own realm. The listener is untagged at the host plane, so it sees
   * those sessions' events; what decides is the threshold order, resolved
   * through the preset roster for that agent. Two cases stand down:
   *
   * - another realm already runs *this* plugin (a user preset mounting it),
   *   which owns its own policy; and
   * - a backend whose threshold fires at or before this plugin's, where
   *   rolling over second would only discard a good tail. That one is
   *   reported loudly, once per backend, naming both numbers.
   * @param agent - agent whose session is being evaluated.
   * @returns whether this row runs automatic rollover for the session.
   */
  private shouldPreemptAutomatic(agent: Agent): boolean {
    // The per-session switch comes before every threshold question: a session
    // set to standard compaction keeps its own policy outright.
    if (sessionMode(agent.session) !== 'rollover') return false
    const other = this.otherBackend(agent)
    if (other === undefined) return true
    if (!this.config.preempt) return false
    if (isRolloverEngine(other)) return false
    return this.thresholdComesFirst(other)
  }

  /**
   * The automatic threshold ordering guard. Rolling over after another
   * backend has already compacted only discards a good tail, so a backend
   * that fires at or before this plugin stands this row's automatic paths
   * down — loudly, once per backend, naming both numbers.
   */
  private thresholdComesFirst(other: CompactionEngine): boolean {
    const otherRatio = readBackendThreshold(other)
    if (otherRatio === undefined) return true
    if (otherRatio > this.config.thresholdRatio) return true
    const key = `${other.name ?? 'compaction'}:${String(otherRatio)}`
    if (!this.warnedBackends.has(key)) {
      this.warnedBackends.add(key)
      this.ctx.logger.warn(
        `context rollover: automatic preemption is standing down for backend "${key}": its compaction `
        + `threshold (${otherRatio}) fires at or before this plugin's rollover threshold `
        + `(${this.config.thresholdRatio}), so a summary would win. Raise that backend's thresholdRatio or `
        + `lower this plugin's; model-requested new_context rollovers and /rollover now are unaffected.`,
      )
    }
    return false
  }

  /** Whether `engine` is the service this controller backs. */
  private isSelf(engine: CompactionEngine): boolean {
    return this.self !== undefined && concreteCompaction(engine) === concreteCompaction(this.self)
  }

  /** The compaction backend serving one agent's realm, roster first. */
  private owningBackend(agent: Agent): CompactionEngine | undefined {
    const roster = rosterOf(this.ctx)
    const fromRoster = roster?.serviceFor(agent, 'compaction')
    if (fromRoster !== undefined) return concreteCompaction(fromRoster)
    const current = (this.ctx as unknown as { get(name: string): unknown }).get('compaction') as
      | CompactionEngine
      | undefined
    return current === undefined ? undefined : concreteCompaction(current)
  }

  /** The backend serving this agent that is *not* this controller's own service. */
  private otherBackend(agent: Agent): CompactionEngine | undefined {
    const owning = this.owningBackend(agent)
    if (owning === undefined) return undefined
    if (this.isSelf(owning)) return undefined
    this.observeBackend(owning)
    return owning
  }

  /**
   * Remember one resolved backend for the settings card's guidance. Keyed by
   * the instance: two same-named backends at different thresholds are two
   * facts, and the stricter one must survive the looser one's observation.
   */
  private observeBackend(engine: CompactionEngine): void {
    const name = typeof engine.name === 'string' && engine.name !== '' ? engine.name : 'compaction'
    const thresholdRatio = readBackendThreshold(engine) ?? null
    const previous = this.observedBackends.get(engine)
    if (previous !== undefined && previous.thresholdRatio === thresholdRatio) return
    this.observedBackends.set(engine, { name, thresholdRatio })
  }

  /**
   * What the settings card shows about the backends around this plugin: the
   * thresholds it has actually resolved, the presets that mount one, and the
   * strictest threshold a rollover point must stay below.
   * @returns the report served at {@link BACKEND_ROUTE}.
   */
  async backendReport(): Promise<BackendReport> {
    return await collectBackendReport(this.ctx, [...this.observedBackends.values()], {
      thresholdRatio: this.config.thresholdRatio,
      reminderThresholdRatio: this.config.reminderThresholdRatio,
      preempt: this.config.preempt,
    })
  }

  /**
   * Perform one rollover: select the replacement range, resolve notes and the
   * checkpoint inputs for the reason, and commit the compaction transaction.
   * @param agent - agent whose session surface is rolled over.
   * @param request - rollover reason and the model's handoff, when any.
   * @param signal - live turn cancellation signal.
   * @returns the compaction result, or `null` when no useful range exists.
   */
  private async performRollover(
    agent: Agent,
    request: { reason: RolloverReason; handoff: string | null },
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    signal.throwIfAborted()
    const session = agent.session
    const retainTokens = this.resolveRetainTokens(session)
    const range = selectRolloverRange(session, this.ctx.tokenMeter.measure(session), retainTokens)
    if (range === null) {
      this.ctx.logger.info('context rollover skipped: no compactable surface span (context is already minimal)')
      return null
    }
    const notes = this.config.notesEnabled
      ? await this.notesStore(session).renderAll(this.config.handoffMaxChars)
      : null
    // The notes read is the one await between the entry check and the
    // irrevocable commit; honour a cancellation that arrived during it.
    signal.throwIfAborted()
    const windowNumber = countRollovers(session) + 1
    const result = await commitRollover(
      { meter: this.ctx.tokenMeter },
      session,
      range.start,
      range.end,
      {
        owner: 'current-turn',
        checkpoint: {
          reason: request.reason,
          windowNumber,
          notes,
          handoff: request.handoff,
        },
      },
    )
    this.ctx.logger.info(
      `context rollover (${request.reason}): window ${windowNumber} started; `
      + `shadowed ${result.shadowedSeqs.length} surface nodes (~${result.shadowedTokenCount} tokens)`,
    )
    return result
  }

  /**
   * The session's open turn number, or `-1` when none is open (the guard key
   * then falls back to one-shot-per-call semantics).
   */
  private openTurnNumber(session: Session): number {
    for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
      const event = sessionEventAt(session, seq)
      if (event === undefined) continue
      if (event.type === 'turn/start') return event.data.turn
      if (event.type === 'turn/end') return -1
    }
    return -1
  }

  /** Resolve the recent-tail token budget for one session. */
  private resolveRetainTokens(session: Session): number {
    if (this.config.retainTokens !== null) return this.config.retainTokens
    const contextWindow = session.requestContext()?.contextWindow
    return contextWindow === undefined
      ? 4096
      : Math.floor(contextWindow * this.config.retainRatio)
  }

  /** Resolve the notes store for one session. */
  private notesStore(session: Session): NotesStore {
    return new NotesStore(
      NotesStore.directoryFor(session.id, this.config.notesDir),
      // A note the store could not read is surfaced in the checkpoint itself;
      // the operator log gets the same fact with its error code.
      message => this.ctx.logger.warn(message),
    )
  }

  /**
   * Whether a requested boundary would actually commit, judged on the commit's
   * own budget.
   *
   * The range check alone is not enough: the commit refuses a checkpoint whose
   * notes and handoff are not smaller than the span they would replace, so
   * answering "accepted" on the range check alone promises a boundary that
   * never starts. The check runs the same `priceCheckpoint` arithmetic the
   * commit's shrink guard does, which is what keeps the promise and the
   * refusal from disagreeing.
   *
   * An unmeasurable surface still accepts: the commit validates whatever span
   * it selects, and a genuine refusal is reported honestly at the next
   * boundary rather than hidden behind a pre-check that gave up.
   * @param session - session the boundary was requested for.
   * @param handoff - the model's handoff text, when it supplied one.
   * @returns `'ok'` when the boundary can commit, otherwise why it cannot.
   */
  private async checkBoundary(session: Session, handoff: string | null): Promise<BoundaryCheck> {
    try {
      const measurement = this.ctx.tokenMeter.measure(session)
      const range = selectRolloverRange(session, measurement, this.resolveRetainTokens(session))
      if (range === null) return 'minimal'
      const notes = this.config.notesEnabled
        ? await this.notesStore(session).renderAll(this.config.handoffMaxChars)
        : null
      const checkpointText = buildCheckpointText({
        reason: 'model-requested',
        windowNumber: countRollovers(session) + 1,
        notes,
        handoff,
      })
      const shadowedNodes = spanSurfaceNodes(session, measurement, range)
      if (shadowedNodes === null) return 'ok'
      const { framedTokenCount, shadowedRouteTokenCount } = priceCheckpoint(
        this.ctx.tokenMeter,
        shadowedNodes,
        checkpointText,
      )
      return framedTokenCount < shadowedRouteTokenCount ? 'ok' : 'checkpoint-too-large'
    } catch {
      // An unmeasurable surface is no reason to refuse a boundary the model
      // asked for; the commit still validates the span it selects.
      return 'ok'
    }
  }

  /**
   * Compact when the model failed to manage context: pressure rolls over
   * above the threshold, while context overflow forces the same deterministic
   * reduction before retry. Backend-role entry point.
   * @param agent - agent whose latest routed request is measured.
   * @param trigger - step-boundary pressure or provider-confirmed overflow.
   * @param signal - live turn cancellation signal.
   * @returns the rollover result, or `null` when no rollover was warranted.
   */
  async compactIfNeeded(
    agent: Agent,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    if (this.otherBackend(agent) !== undefined) return null
    if (trigger === 'context-overflow') {
      return this.performRollover(agent, { reason: 'overflow', handoff: null }, signal)
    }
    await this.rollOverOnPressure(agent, this.openTurnNumber(agent.session), signal)
    return null
  }

  /**
   * Manual rollover behind an explicit request: the same deterministic
   * checkpoint and recent tail, run exclusively on an idle agent.
   * @param agent - idle agent whose next-turn admission this call reserves.
   * @param signal - cancellation scoped to this rollover request.
   * @param sourceCommandId - initiating command identity for presentation.
   * @returns the committed result, or `null` when no safe useful range exists.
   */
  compactNow(
    agent: Agent,
    signal: AbortSignal,
    sourceCommandId?: CommandId,
  ): Promise<CompactionResult | null> {
    signal.throwIfAborted()
    if (this.otherBackend(agent) !== undefined) {
      this.ctx.logger.info('context rollover skipped: session compaction is owned by another backend')
      return Promise.resolve(null)
    }
    return this.runManualRollover(agent, signal, sourceCommandId)
  }

  /**
   * Unconditional manual rollover: `/rollover now`, which an explicit human
   * request owns even where another backend serves the realm. The durable
   * `compaction/start` lock still serializes it against that backend.
   * @param agent - idle agent whose history should start a new window.
   * @param signal - cancellation scoped to this rollover request.
   * @param sourceCommandId - initiating command identity for presentation.
   * @returns the committed result, or `null` when no safe useful range exists.
   */
  private runManualRollover(
    agent: Agent,
    signal: AbortSignal,
    sourceCommandId?: CommandId,
  ): Promise<CompactionResult | null> {
    const run = async (operationSignal: AbortSignal): Promise<CompactionResult | null> => {
      const session = agent.session
      const range = selectRolloverRange(
        session,
        this.ctx.tokenMeter.measure(session),
        this.resolveRetainTokens(session),
      )
      if (range === null) return null
      const notes = this.config.notesEnabled
        ? await this.notesStore(session).renderAll(this.config.handoffMaxChars)
        : null
      // Re-checked after the notes IO: reading notes can take long enough for
      // the command to be cancelled, and committing then would report success
      // for work the caller already abandoned. Everything past this point is
      // the irrevocable transaction.
      operationSignal.throwIfAborted()
      const windowNumber = countRollovers(session) + 1
      return commitRollover(
        { meter: this.ctx.tokenMeter },
        session,
        range.start,
        range.end,
        {
          owner: null,
          ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
          checkpoint: {
            reason: 'manual',
            windowNumber,
            notes,
            handoff: null,
          },
          flush: async () => {
            await this.ctx.sessions.flush(session)
          },
        },
      )
    }
    return this.runMaintained(agent, run, signal)
  }

  /**
   * Replace one inclusive surface-position span with a rollover checkpoint.
   * @param start - inclusive first surface-node seq.
   * @param end - inclusive last surface-node seq.
   * @param agent - owner of the target session.
   * @param signal - optional cancellation signal.
   * @returns the durable rollover result.
   */
  async compactRegion(
    start: Seq,
    end: Seq,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    signal?.throwIfAborted()
    if (this.otherBackend(agent) !== undefined) {
      throw new Error('context rollover refused: session compaction is owned by another backend')
    }
    const session = agent.session
    const notes = this.config.notesEnabled
      ? await this.notesStore(session).renderAll(this.config.handoffMaxChars)
      : null
    // Everything past this point is the irrevocable transaction.
    signal?.throwIfAborted()
    const windowNumber = countRollovers(session) + 1
    return commitRollover(
      { meter: this.ctx.tokenMeter },
      session,
      start,
      end,
      {
        owner: 'current-turn',
        checkpoint: {
          reason: 'manual',
          windowNumber,
          notes,
          handoff: null,
        },
      },
    )
  }

  /**
   * Execute `/rollover` against the invoking session.
   *
   * `on`/`rollover` and `off`/`compact` select the session's context-management
   * mode; the command's own durable `command/run` record is the selection, so
   * no extra event is written. `status` reports the effective policy, and
   * `now` (or a bare invocation, which is what a menu pick submits) crosses a
   * boundary immediately.
   */
  private async handleRolloverCommand(invocation: CommandInvocation): Promise<CommandResult> {
    const argument = invocation.rawInput.trim()
    const selected = modeFromArgument(argument)
    if (selected !== undefined) return this.modeResult(invocation, selected)
    if (argument === 'status') return this.modeStatus(invocation)
    if (argument !== '' && argument !== 'now') {
      return { kind: 'error', text: this.t('command.usage') }
    }
    if (sessionMode(invocation.agent.session) !== 'rollover') {
      return {
        kind: 'error',
        text: this.t('manual.compactRefusal'),
      }
    }
    try {
      const result = await this.runManualRollover(invocation.agent, invocation.signal, invocation.commandId)
      if (result === null) return { kind: 'success', text: this.t('manual.noHistory') }
      return {
        kind: 'success',
        text: this.t('manual.success', {
          window: countRollovers(invocation.agent.session),
          items: result.shadowedSeqs.length,
          tokens: result.shadowedTokenCount,
        }),
        sourceEventSeq: result.summarySeq,
      }
    } catch (error: unknown) {
      if (invocation.signal.aborted) return { kind: 'error', text: this.t('manual.cancelled') }
      if (error instanceof ManualCompactionError) return this.manualFailure(error)
      // A refusal is a stable fact about the requested checkpoint, not a
      // transient host condition: say what to change rather than implying a
      // retry would help.
      if (error instanceof RolloverRefusedError) {
        return { kind: 'error', text: this.t('manual.tooLarge') }
      }
      const message = error instanceof Error ? error.message : String(error)
      return { kind: 'error', text: this.t('manual.failed', { message }) }
    }
  }

  /** Report one mode selection as a human result. */
  private modeResult(invocation: CommandInvocation, mode: RolloverMode): CommandResult {
    const percent = Math.round(this.config.thresholdRatio * 100)
    const modeNow = sessionMode(invocation.agent.session)
    const applied = modeNow === mode
    const text = this.t(mode === 'rollover' ? 'mode.rollover' : 'mode.compact', { percent })
    return applied
      ? { kind: 'success', text }
      : {
          kind: 'error',
          text: text + this.t('mode.notApplied', { mode: this.t(`mode.name.${modeNow}`) }),
        }
  }

  /** Report the session's effective context-management policy. */
  private modeStatus(invocation: CommandInvocation): CommandResult {
    const session = invocation.agent.session
    const mode = sessionMode(session)
    const other = this.otherBackend(invocation.agent)
    const backendRatio = other === undefined ? undefined : readBackendThreshold(other)
    const backend = other === undefined
      ? this.t('status.self')
      : `${other.name ?? 'compaction'}${backendRatio === undefined ? '' : ` @ ${backendRatio}`}`
    const intercepting = this.shouldPreemptAutomatic(invocation.agent)
    return {
      kind: 'success',
      text: [
        `${this.t('status.mode')}: ${this.t(`mode.name.${mode}`)}`,
        `${this.t('status.rolloverAt')}: ${Math.round(this.config.thresholdRatio * 100)}%`,
        `${this.t('status.reminderAt')}: ${Math.round(this.config.reminderThresholdRatio * 100)}%`,
        `${this.t('status.backend')}: ${backend}`,
        `${this.t('status.intercepting')}: ${this.t(intercepting ? 'status.yes' : 'status.no')}`,
      ].join('\n'),
    }
  }

  /** Present one classified manual-rollover failure as a human result. */
  private manualFailure(error: ManualCompactionError): CommandResult {
    switch (error.code) {
      case 'busy':
        return {
          kind: 'error',
          text: this.t('manual.busy'),
        }
      case 'cancelled':
        return { kind: 'error', text: this.t('manual.cancelled') }
      default:
        return { kind: 'error', text: this.t('manual.failed', { message: error.message }) }
    }
  }

  /**
   * Run one idle-agent task under `runMaintenance`, mapping cancellation to
   * the manual-failure code a command presents.
   *
   * The task receives the operation signal so it can honour cancellation
   * *inside* its own awaits — a `notes` read can be slow, and checking only
   * before the task starts would let an aborted command commit afterwards.
   * Cancellation is honoured up to the irrevocable commit: once
   * `commitRollover` opens its bracket the transaction finishes and reports
   * its real outcome.
   * @param agent - idle agent whose maintenance admission this reserves.
   * @param task - the operation, given the fused cancellation signal.
   * @param signal - caller-scoped cancellation.
   * @returns the task's result.
   */
  private async runMaintained<T>(
    agent: Agent,
    task: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    let entered = false
    try {
      return await agent.runMaintenance(async (agentSignal) => {
        entered = true
        const operationSignal = AbortSignal.any([agentSignal, signal])
        try {
          operationSignal.throwIfAborted()
          return await task(operationSignal)
        } catch (error: unknown) {
          // A real failure keeps its own class; only a cancellation this
          // wrapper introduced is relabelled.
          if (error instanceof ManualCompactionError) throw error
          if (operationSignal.aborted) {
            throw new ManualCompactionError('cancelled', 'manual rollover was cancelled', { cause: error })
          }
          throw error
        }
      })
    } catch (error: unknown) {
      if (error instanceof ManualCompactionError) throw error
      // Only a refusal to *admit* the maintenance counts as busy. The task's
      // own failures (budget, persistence, commit) keep their real identity so
      // the command can tell the user what actually went wrong.
      if (entered) throw error
      throw new ManualCompactionError(
        'busy',
        'manual rollover requires an idle agent with no waking queued work',
        { cause: error },
      )
    }
  }
}

/**
 * Summarization-free compaction backend: durable notes + handoff/recovery
 * checkpoint + token-budgeted recent verbatim tail, with model-requested
 * rollover via the `new_context` tool and runtime-driven rollover as the
 * pressure/overflow safety net.
 *
 * Mount this only where no other row provides `ctx.compaction` (a deployment
 * that disables `compaction-basic`), or through `backend: true`. The default
 * plugin role does not mount it at all: that role is the interceptor, which
 * leaves the mounted backend's service and identity untouched.
 */
export class ContextRolloverEngine extends CompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions', 'tools', 'systemPrompt']

  static Config: z<RolloverConfig> = rolloverConfigSchema

  /** Policy and listeners this service backs. */
  readonly controller: RolloverController

  constructor(ctx: Context, config: RolloverConfig = {}) {
    super(ctx)
    this.controller = new RolloverController(ctx, config, this)
  }

  /** Resolved and validated configuration, following the settings scope. */
  get config(): ResolvedRolloverConfig {
    return this.controller.config
  }

  /** {@inheritDoc RolloverController.compactIfNeeded} */
  override async compactIfNeeded(
    agent: Agent,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    return this.controller.compactIfNeeded(agent, trigger, signal)
  }

  /** {@inheritDoc RolloverController.compactNow} */
  override compactNow(
    agent: Agent,
    signal: AbortSignal,
    sourceCommandId?: CommandId,
  ): Promise<CompactionResult | null> {
    return this.controller.compactNow(agent, signal, sourceCommandId)
  }

  /** {@inheritDoc RolloverController.compactRegion} */
  override async compactRegion(
    start: Seq,
    end: Seq,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    return this.controller.compactRegion(start, end, agent, signal)
  }
}

// Brand this copy's prototype. The Web profile loads this module through two
// different paths behind separate realms, so each copy has to be able to
// recognize the others' engines; see ENGINE_BRAND.
Object.defineProperty(ContextRolloverEngine.prototype, ENGINE_BRAND, {
  value: true,
  enumerable: false,
  configurable: true,
  writable: false,
})

/**
 * Mount the plugin.
 *
 * The default role is the interceptor: listeners and tools only, no service.
 * `backend: true` mounts {@link ContextRolloverEngine} instead, for a
 * deployment that deliberately leaves the `ctx.compaction` slot empty.
 * @param ctx - context owning every registration.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: RolloverConfig = {}): void {
  if (config.backend === true) {
    ctx.plugin(ContextRolloverEngine, config)
    return
  }
  // The controller owns its listeners, tools, and guidance through `ctx`, so
  // unloading this plugin removes every trace of the preemption.
  new RolloverController(ctx, config)
}
