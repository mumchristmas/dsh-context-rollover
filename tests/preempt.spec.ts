/**
 * Preemption over an ordinary compaction backend, verified against the real
 * `compaction-basic` engine mounted beside this plugin:
 *
 * 1. the prepended pre-step listener crosses the boundary before that engine's
 *    own listener runs, on the very same dispatch;
 * 2. with the thresholds ordered in this plugin's favour, the engine never
 *    compacts at all;
 * 3. with preemption off — or with the thresholds the wrong way round — the
 *    engine keeps its own automatic policy and this plugin stays out of it.
 *
 * `/rollover now` is the explicit human path and is checked against the same
 * mounted engine.
 *
 * @module tests/preempt
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import { CommandId } from '@deepseek-ai/dsh-commands'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { RolloverController, ContextRolloverEngine } from '../src/index.ts'
import * as rolloverPlugin from '../src/index.ts'
import { MODE_PROJECTION_KEY, sessionMode } from '../src/mode.ts'
import { NotesStore } from '../src/notes.ts'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { RolloverConfig } from '../src/config.ts'
import { ROLLOVER_PROVIDER, countRollovers } from '../src/rollover.ts'
import {
  MODEL,
  TextAdapter,
  derivedTexts,
  followup,
  mountTestContext,
  reminderTexts,
  tempNotesDir,
  textResponse,
  usageResponse,
} from './harness.ts'

/**
 * The window every case works in. A small one keeps the mounted engine's
 * arithmetic honest at test scale: the pressure this plugin relieves is real
 * surface content, not an artificial usage number, so the backend genuinely
 * sees a smaller prompt after the rollover.
 */
const WINDOW = 8_000

/** A prompt worth roughly the whole window, so a rollover has real work to do. */
const BIG_PROMPT = `turn one ${'detail '.repeat(4000)}`

/** The harness's scripted adapter, advertising a small context window. */
class SmallWindowAdapter extends LlmAdapter {
  readonly requests: Message[][] = []

  constructor(private readonly script: readonly (readonly StreamChunk[])[], private readonly window: number) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: this.window } })
  }

  override async *stream(options: { messages: readonly Message[] }): AsyncIterable<StreamChunk> {
    this.requests.push([...options.messages])
    const entry = this.script[Math.min(this.requests.length - 1, this.script.length - 1)]
    if (entry === undefined) throw new Error('scripted adapter ran out of entries')
    for (const chunk of entry) yield chunk
  }
}

/** Compactions committed by a backend other than this plugin. */
function backendSummaries(session: Session): number {
  return session.snapshotEvents()
    .filter(event => event.type === 'compaction/summary' && event.data.provider !== ROLLOVER_PROVIDER)
    .length
}

/** One mounted preempter over one mounted ordinary compaction backend. */
interface PreemptHarness {
  readonly ctx: Context
  readonly controller: RolloverController
  readonly backend: BasicCompactionEngine
  readonly agent: Agent
  readonly session: Session
}

/**
 * Mount `compaction-basic` first (its listener is registered first) and this
 * plugin's controller second, with the inherited threshold below the
 * backend's unless a case says otherwise.
 */
async function preemptHarness(
  id: string,
  options: { backend?: BasicCompactionConfig; controller?: RolloverConfig } = {},
): Promise<PreemptHarness> {
  const ctx = await mountTestContext()
  const backend = new BasicCompactionEngine(ctx, {
    thresholdRatio: 0.8,
    retainTokens: 0,
    ...options.backend,
  })
  const controller = new RolloverController(ctx, {
    notesDir: await tempNotesDir(),
    thresholdRatio: 0.5,
    reminderThresholdRatio: 0.4,
    retainTokens: 0,
    ...options.controller,
  })
  const agent = await ctx.agentLoop.create(SessionId(id), { provider: MODEL, model: MODEL })
  return { ctx, controller, backend, agent, session: agent.session }
}

/** Capture the engine's own warnings. */
function captureWarnings(ctx: Context): string[] {
  const warnings: string[] = []
  const original = ctx.logger.warn.bind(ctx.logger)
  ctx.logger.warn = (message: string): void => {
    warnings.push(message)
    original(message)
  }
  return warnings
}

describe('preemption over a mounted compaction backend', () => {
  it('crosses the boundary before the backend listener on the same dispatch', async () => {
    const { ctx, session, agent } = await preemptHarness('preempt-first')
    // Registered after the backend, so each entry observes what the backend
    // already saw. An entry with a committed rollover and no backend summary
    // proves the rollover ran first on that very dispatch.
    const probe: Array<{ rollovers: number; summaries: number }> = []
    ctx.on('agent/pre-step', async (_payload, next): Promise<PreStepDecision> => {
      probe.push({ rollovers: countRollovers(session), summaries: backendSummaries(session) })
      return next()
    })
    ctx.llm.registerAdapter(['mock'], new SmallWindowAdapter([
      usageResponse('acknowledged', 7_000),
      textResponse('turn two answer'),
    ], WINDOW))

    await followup(agent, BIG_PROMPT)
    expect(countRollovers(session)).toBe(0)

    await followup(agent, 'turn two')

    expect(countRollovers(session)).toBe(1)
    expect(backendSummaries(session)).toBe(0)
    expect(probe.some(entry => entry.rollovers === 1 && entry.summaries === 0)).toBe(true)
    expect(derivedTexts(session).join('\n')).toContain('reason: pressure')
  })

  it('hands every automatic path to the backend when preemption is off', async () => {
    const { ctx, session, agent } = await preemptHarness('preempt-off', {
      controller: { preempt: false },
    })
    ctx.llm.registerAdapter(['mock'], new SmallWindowAdapter([
      usageResponse('acknowledged', 7_000),
      textResponse('compacted summary of the work so far'),
      textResponse('turn two answer'),
    ], WINDOW))

    await followup(agent, BIG_PROMPT)
    await followup(agent, 'turn two')

    expect(countRollovers(session)).toBe(0)
    expect(backendSummaries(session)).toBeGreaterThan(0)
  })

  it('stands down and names the numbers when the backend fires first', async () => {
    const { ctx, session, agent } = await preemptHarness('preempt-guard', {
      backend: { thresholdRatio: 0.4 },
    })
    const warnings = captureWarnings(ctx)
    ctx.llm.registerAdapter(['mock'], new SmallWindowAdapter([
      usageResponse('acknowledged', 7_000),
      textResponse('compacted summary of the work so far'),
      textResponse('turn two answer'),
    ], WINDOW))

    await followup(agent, BIG_PROMPT)
    await followup(agent, 'turn two')

    // The backend's 0.4 threshold beats this plugin's 0.5, so preemption is
    // refused rather than run second, and the refusal is reported.
    expect(countRollovers(session)).toBe(0)
    expect(backendSummaries(session)).toBeGreaterThan(0)
    expect(warnings.some(message => message.includes('standing down'))).toBe(true)
    expect(warnings.some(message => message.includes('0.4'))).toBe(true)
  })
})

describe('plugin mounting roles', () => {
  it('mounts the preempter without taking the compaction service', async () => {
    const ctx = await mountTestContext()
    await ctx.plugin(rolloverPlugin, { notesDir: await tempNotesDir() })
    // The whole point of the default role: no service changes hands, so
    // removing the plugin can never strand a session.
    expect(ctx.get('compaction')).toBeUndefined()
    expect(ctx.tools.get('new_context')).toBeDefined()
  })

  it('provides ctx.compaction only in the explicit backend role', async () => {
    const ctx = await mountTestContext()
    await ctx.plugin(rolloverPlugin, { backend: true, notesDir: await tempNotesDir() })
    expect(ctx.get('compaction')).toBeInstanceOf(ContextRolloverEngine)
  })
})

describe('preset realms', () => {
  /**
   * A context whose `compaction` realm mounts a backend, plus a roster naming
   * it — the shape a Web session has, where the preset owns compaction and the
   * plugin runs at the host plane.
   */
  async function realmHarness(
    id: string,
    backendThreshold = 0.8,
  ): Promise<{
    ctx: Context
    realm: Context
    agent: Agent
    session: Session
  }> {
    const ctx = await mountTestContext()
    const realm = ctx.isolate('compaction')
    const backend = new BasicCompactionEngine(realm, { thresholdRatio: backendThreshold, retainTokens: 0 })
    ;(ctx as unknown as { provide(name: string, value: unknown): void }).provide('agentPresets', {
      serviceFor: () => backend,
    })
    ctx.llm.registerAdapter(['mock'], new SmallWindowAdapter([
      usageResponse('acknowledged', 7_000),
      textResponse('compacted summary of the work so far'),
      textResponse('turn two answer'),
    ], WINDOW))
    const agent = await ctx.agentLoop.create(SessionId(id), { provider: MODEL, model: MODEL })
    return { ctx, realm, agent, session: agent.session }
  }

  /** Drive one session past the preempter's threshold. */
  async function pressure(agent: Agent): Promise<void> {
    await followup(agent, BIG_PROMPT)
    await followup(agent, 'turn two')
  }

  it('preempts the backend its own realm mounts', async () => {
    const { realm, agent, session } = await realmHarness('realm-row')
    new RolloverController(realm, {
      notesDir: await tempNotesDir(),
      thresholdRatio: 0.5,
      reminderThresholdRatio: 0.4,
      retainTokens: 0,
    })

    await pressure(agent)

    expect(countRollovers(session)).toBe(1)
    expect(backendSummaries(session)).toBe(0)
  })

  it('preempts a backend owned by an enclosing realm', async () => {
    const { ctx, agent, session } = await realmHarness('realm-host')
    // Realm-blind by design: the host row intercepts the preset's backend too,
    // because the preset-free deployment has no opted-in composition to reach.
    new RolloverController(ctx, {
      notesDir: await tempNotesDir(),
      thresholdRatio: 0.5,
      reminderThresholdRatio: 0.4,
      retainTokens: 0,
    })

    await pressure(agent)

    expect(countRollovers(session)).toBe(1)
    expect(backendSummaries(session)).toBe(0)
  })

  it('stands down, and stays silent, when the enclosing backend fires first', async () => {
    const { ctx, agent, session } = await realmHarness('realm-host-early', 0.4)
    const warnings = captureWarnings(ctx)
    new RolloverController(ctx, {
      notesDir: await tempNotesDir(),
      thresholdRatio: 0.5,
      // Any measurable prompt crosses this, so a reminder here could only come
      // from a row that does not own the session's policy.
      reminderThresholdRatio: 0.001,
      retainTokens: 0,
    })

    await pressure(agent)

    expect(countRollovers(session)).toBe(0)
    expect(backendSummaries(session)).toBeGreaterThan(0)
    expect(reminderTexts(session)).toHaveLength(0)
    expect(warnings.some(message => message.includes('standing down'))).toBe(true)
  })

})

describe('per-session mode', () => {
  /** One mounted interceptor over one mounted backend, with a command registry. */
  async function modeHarness(id: string) {
    const ctx = await mountTestContext()
    const backend = new BasicCompactionEngine(ctx, { thresholdRatio: 0.8, retainTokens: 0 })
    const registered = new Map<string, CommandDefinition>()
    ;(ctx as unknown as { provide(name: string, value: unknown): void }).provide('commands', {
      // Mirrors the host executor: the durable `command/run` record the mode is
      // read from is written by the registry, not by the command handler.
      register: (definition: CommandDefinition) => {
        const wrapped: CommandDefinition = {
          ...definition,
          handler: async (invocation) => {
            invocation.agent.session.append('command/run', {
              commandId: invocation.commandId,
              name: definition.name,
              args: invocation.rawInput,
              source: { kind: 'user' },
            })
            const result = await definition.handler(invocation)
            invocation.agent.session.append('command/done', {
              commandId: invocation.commandId,
              kind: result.kind,
              ...result.text === undefined ? {} : { text: result.text },
            })
            return result
          },
        }
        registered.set(definition.name, wrapped)
        return () => { registered.delete(definition.name) }
      },
    })
    new RolloverController(ctx, {
      notesDir: await tempNotesDir(),
      thresholdRatio: 0.5,
      reminderThresholdRatio: 0.4,
      retainTokens: 0,
    })
    ctx.llm.registerAdapter(['mock'], new SmallWindowAdapter([
      usageResponse('acknowledged', 7_000),
      textResponse('compacted summary of the work so far'),
      textResponse('turn two answer'),
    ], WINDOW))
    const agent = await ctx.agentLoop.create(SessionId(id), { provider: MODEL, model: MODEL })
    const definition = registered.get('rollover')
    if (definition === undefined) throw new Error('the controller did not register /rollover')
    return { ctx, backend, agent, session: agent.session, definition }
  }

  /** Drive one session past the interceptor's threshold. */
  async function drive(agent: Agent): Promise<void> {
    await followup(agent, BIG_PROMPT)
    await followup(agent, 'turn two')
  }

  /** Invoke the registered command as a UI would. */
  function invoke(definition: CommandDefinition, agent: Agent, rawInput: string) {
    return definition.handler({
      commandId: CommandId('mode-1'),
      agent,
      rawInput,
      attachments: [],
      signal: new AbortController().signal,
    })
  }

  it('records the mode, reports it, and hands automation back on `off`', async () => {
    const { ctx, agent, session, definition } = await modeHarness('mode-off')

    const off = await invoke(definition, agent, ' off')
    expect(off?.kind).toBe('success')
    expect(sessionMode(session)).toBe('compact')
    // The projection the Web switch reads folds the same durable record.
    const projected = (ctx as unknown as {
      sessionProjections: { stateOf(session: unknown, key: string): unknown }
    }).sessionProjections.stateOf(session, MODE_PROJECTION_KEY)
    expect(projected).toBe('compact')

    const status = await invoke(definition, agent, ' status')
    expect(status.kind).toBe('success')
    expect(String(status.text)).toContain('mode: compact')
    expect(String(status.text)).toContain('intercepting: no')

    // Automatic pressure now belongs to the backend: no rollover, no reminder.
    await drive(agent)
    expect(countRollovers(session)).toBe(0)
    expect(backendSummaries(session)).toBeGreaterThan(0)
    expect(reminderTexts(session)).toHaveLength(0)

    // And the model is told the truth instead of being promised a boundary.
    const refused = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('nc-mode'),
      name: 'new_context',
      arguments: {},
      agent,
    })
    expect(refused.value).toMatchObject({ accepted: false, reason: 'compact-mode' })
  })

  it('restores interception on `on`', async () => {
    const { agent, session, definition } = await modeHarness('mode-on')
    expect(sessionMode(session)).toBe('rollover')

    await invoke(definition, agent, ' off')
    expect(sessionMode(session)).toBe('compact')
    const on = await invoke(definition, agent, ' on')
    expect(on?.kind).toBe('success')
    expect(sessionMode(session)).toBe('rollover')

    await drive(agent)
    expect(countRollovers(session)).toBe(1)
    expect(backendSummaries(session)).toBe(0)
  })
})

describe('/rollover now', () => {
  /** Mount the plugin over a fake command registry and return the registration. */
  async function commandHarness(): Promise<{
    registered: Map<string, CommandDefinition>
    agent: Agent
    session: Session
  }> {
    const ctx = await mountTestContext()
    const registered = new Map<string, CommandDefinition>()
    ;(ctx as unknown as { provide(name: string, value: unknown): void }).provide('commands', {
      register: (definition: CommandDefinition) => {
        registered.set(definition.name, definition)
        return () => { registered.delete(definition.name) }
      },
    })
    // The ordinary backend stays mounted and owns automatic compaction; the
    // explicit command must still start this plugin's own window.
    new BasicCompactionEngine(ctx, { thresholdRatio: 0.8, retainTokens: 0 })
    new RolloverController(ctx, {
      notesDir: await tempNotesDir(),
      thresholdRatio: 0.5,
      reminderThresholdRatio: 0.4,
      retainTokens: 0,
      preempt: false,
    })
    const agent = await ctx.agentLoop.create(SessionId('rollover-command'), {
      provider: MODEL,
      model: MODEL,
    })
    ctx.llm.registerAdapter(['mock'], new TextAdapter())
    for (let index = 0; index < 4; index += 1) await followup(agent, `question ${index} ${'detail '.repeat(400)}`)
    return { registered, agent, session: agent.session }
  }

  it('starts a window through this plugin even where the backend owns automation', async () => {
    const { registered, agent, session } = await commandHarness()
    const definition = registered.get('rollover')
    expect(definition).toBeDefined()
    const result = await definition?.handler({
      commandId: CommandId('cmd-1'),
      agent,
      rawInput: ' now',
      attachments: [],
      signal: new AbortController().signal,
    })
    expect(result?.kind).toBe('success')
    expect(countRollovers(session)).toBe(1)
    expect(derivedTexts(session).join('\n')).toContain('reason: manual')
    expect(backendSummaries(session)).toBe(0)
  })

  it('reports a refused checkpoint as such, instead of blaming a busy agent', async () => {
    const { registered, agent, session } = await commandHarness()
    // Notes far larger than the span they would replace: a legal request the
    // commit refuses on its own budget. The user must be told what to change,
    // not sent away to retry because the agent looked busy.
    vi.spyOn(NotesStore.prototype, 'renderAll').mockResolvedValueOnce('notes '.repeat(3300))
    const result = await registered.get('rollover')?.handler({
      commandId: CommandId('cmd-refused'),
      agent,
      rawInput: ' now',
      attachments: [],
      signal: new AbortController().signal,
    })
    expect(result?.kind).toBe('error')
    expect(result?.text).toContain('would not be smaller')
    expect(result?.text).not.toContain('not idle')
    expect(countRollovers(session)).toBe(0)
  })

  it('rejects any other grammar with usage', async () => {
    const { registered, agent } = await commandHarness()
    const result = await registered.get('rollover')?.handler({
      commandId: CommandId('cmd-2'),
      agent,
      rawInput: ' later',
      attachments: [],
      signal: new AbortController().signal,
    })
    expect(result).toEqual({ kind: 'error', text: 'Usage: /rollover [on|off|status|now]' })
  })

  it('declares an argument hint and accepts the bare token a menu pick sends', async () => {
    const { registered, agent, session } = await commandHarness()
    const definition = registered.get('rollover')
    // A composer only claims text after `/rollover ` when the descriptor
    // declares an input; without the hint the GUI silently dropped `now` and
    // ran the bare token instead.
    expect(definition?.input?.hint).toBe('[on|off|status|now]')
    const result = await definition?.handler({
      commandId: CommandId('cmd-3'),
      agent,
      rawInput: '',
      attachments: [],
      signal: new AbortController().signal,
    })
    expect(result?.kind).toBe('success')
    expect(countRollovers(session)).toBe(1)
  })
})
