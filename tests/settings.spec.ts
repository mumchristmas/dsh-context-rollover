/**
 * Settings-surface coverage: the namespace a card edits, the live re-resolve
 * that makes an edit apply to the next step, and the backend report the card
 * renders its threshold guidance from.
 *
 * @module tests/settings
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import {
  BACKEND_ROUTE,
  STOCK_BACKEND_THRESHOLD,
  collectBackendReport,
  registerBackendRoute,
  type BackendReport,
} from '../src/backends.ts'
import { ContextRolloverEngine, RolloverController } from '../src/index.ts'
import { SETTINGS_NAMESPACE, resolveSettings } from '../src/settings.ts'
import {
  ScriptedAdapter,
  followup,
  mountTestContext,
  tempNotesDir,
  usageResponseWith,
} from './harness.ts'

/** Let deferred service-injection callbacks run. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

/** Execute one tool through the registry, returning the raw result. */
async function invokeTool(
  ctx: Context,
  agent: Agent,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean, content: readonly { type: string, text?: string }[], value?: unknown }> {
  return await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`settings-${name}`),
    name,
    arguments: args,
    agent,
  }) as { isError: boolean, content: readonly { type: string, text?: string }[], value?: unknown }
}

/**
 * A harness context with a real settings provider, the way a deployment that
 * serves a Plugin configuration tab has one.
 * @returns the context and its cleanup.
 */
async function withSettingsProvider(): Promise<{ ctx: Awaited<ReturnType<typeof mountTestContext>>, cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-rollover-settings-'))
  const ctx = await mountTestContext()
  await ctx.plugin(FileSettingsProvider, { path: join(dir, 'settings.yaml'), dshHome: dir })
  return { ctx, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

describe('settings section', () => {
  it('refuses a settings value the engine could not run with', async () => {
    const { ctx, cleanup } = await withSettingsProvider()
    const controller = new RolloverController(ctx, { thresholdRatio: 0.75, retainTokens: 0 })
    await settle()
    expect(controller.config.thresholdRatio).toBe(0.75)

    // A ratio the engine has no meaning for is refused before it is stored.
    await expect(async () => await ctx.settings.update(SETTINGS_NAMESPACE, { thresholdRatio: 1.5 }))
      .rejects.toThrow(/in \(0, 1\]/)
    expect(controller.config.thresholdRatio).toBe(0.75)

    // A reminder above the rollover point is *reconciled* rather than refused:
    // the scope hands the engine the whole effective configuration, so refusing
    // here would also refuse the single-field threshold edit below — the user
    // would be blocked by a reminder they never chose. What survives is the
    // ordering the reminder needs in order to be delivered at all.
    await ctx.settings.update(SETTINGS_NAMESPACE, {
      thresholdRatio: 0.5,
      reminderThresholdRatio: 0.9,
    })
    expect(controller.config.thresholdRatio).toBe(0.5)
    expect(controller.config.reminderThresholdRatio)
      .toBeLessThanOrEqual(controller.config.lastChanceRatio)

    // A single-field edit re-resolves in place, and the inherited reminder
    // yields to the room the lower threshold leaves instead of blocking it.
    await ctx.settings.update(SETTINGS_NAMESPACE, { thresholdRatio: 0.65 })
    expect(controller.config.thresholdRatio).toBe(0.65)
    expect(controller.config.reminderThresholdRatio)
      .toBeLessThanOrEqual(controller.config.lastChanceRatio)

    // Clearing the user section returns every field to the composition layer.
    await ctx.settings.replace(SETTINGS_NAMESPACE, {})
    expect(controller.config.thresholdRatio).toBe(0.75)
    await cleanup()
  })

  it('validates a resolved snapshot directly', () => {
    expect(resolveSettings({ thresholdRatio: 0.6 }).thresholdRatio).toBe(0.6)
    expect(() => resolveSettings({ thresholdRatio: 1.5 })).toThrow(/in \(0, 1\]/)
  })
})

describe('live configuration', () => {
  it('applies a card edit to the model-facing tools without a restart', async () => {
    const { ctx, cleanup } = await withSettingsProvider()
    new ContextRolloverEngine(ctx, {
      notesDir: await tempNotesDir(),
      thresholdRatio: 0.75,
      reminderThresholdRatio: 0.6,
      retainTokens: 40,
    })
    await settle()
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([usageResponseWith('answer', 10_000, 5)]))
    const agent = await ctx.agentLoop.create(
      SessionId('settings-live-tools'),
      { provider: 'mock', model: 'mock' },
    )
    await followup(agent, 'measure the window')

    // The 100k window and the 0.75 row value put the boundary at 75,000.
    const before = await invokeTool(ctx, agent, 'get_context_remaining', {})
    expect(before.value).toMatchObject({ rollover_tokens_left: 75_000 - 10_005 })

    // Eleven characters are well inside the row's 20,000-character limit.
    const short = await invokeTool(ctx, agent, 'new_context', { handoff: '12345678901' })
    expect(short.isError).toBe(false)

    await ctx.settings.update(SETTINGS_NAMESPACE, { thresholdRatio: 0.65, handoffMaxChars: 10 })

    // Both reads must follow the edit on the very next call: the threshold the
    // tool counts down to, and the limit it enforces.
    const after = await invokeTool(ctx, agent, 'get_context_remaining', {})
    expect(after.value).toMatchObject({ rollover_tokens_left: 65_000 - 10_005 })
    const rejected = await invokeTool(ctx, agent, 'new_context', { handoff: '12345678901' })
    expect(rejected.isError).toBe(true)
    expect(JSON.stringify(rejected.content)).toContain('maximum is 10')
    await cleanup()
  })

  it('mounts and unmounts the optional tools as the card toggles them', async () => {
    const { ctx, cleanup } = await withSettingsProvider()
    new ContextRolloverEngine(ctx, { notesDir: await tempNotesDir(), retainTokens: 0 })
    await settle()
    expect(ctx.tools.get('notes')).toBeDefined()
    expect(ctx.tools.get('history')).toBeDefined()

    // Disabling must remove the tool from the model's surface, not merely make
    // it refuse: the policy in force and the surface have to agree.
    await ctx.settings.update(SETTINGS_NAMESPACE, { notesEnabled: false, historyEnabled: false })
    expect(ctx.tools.get('notes')).toBeUndefined()
    expect(ctx.tools.get('history')).toBeUndefined()
    expect(ctx.tools.get('new_context')).toBeDefined()
    expect(ctx.tools.get('get_context_remaining')).toBeDefined()

    // ...and toggling one back on remounts exactly that one.
    await ctx.settings.update(SETTINGS_NAMESPACE, { notesEnabled: true })
    expect(ctx.tools.get('notes')).toBeDefined()
    expect(ctx.tools.get('history')).toBeUndefined()
    await cleanup()
  })
})

describe('backend report', () => {
  it('lists the presets that mount a compactor and falls back to the stock threshold', async () => {
    const ctx = await mountTestContext()
    ;(ctx as unknown as { provide(name: string, value: unknown): void }).provide('agentPresets', {
      compositionInventory: async () => [
        { id: 'standard', rows: [{ moduleName: '@deepseek-ai/dsh-compaction-basic' }] },
        { id: 'minimal', rows: [{ moduleName: '@deepseek-ai/dsh-persona' }] },
      ],
    })
    const report = await collectBackendReport(ctx, [], {
      thresholdRatio: 0.75,
      reminderThresholdRatio: 0.6,
      preempt: true,
    })
    expect(report.presets).toEqual(['standard'])
    // Nothing resolved live yet, but a preset mounts a compactor: the guidance
    // uses what that backend defaults to.
    expect(report.safeBelow).toBe(STOCK_BACKEND_THRESHOLD)
    expect(report.observed).toEqual([])
  })

  it('prefers the strictest threshold it has actually resolved', async () => {
    const ctx = await mountTestContext()
    const report = await collectBackendReport(ctx, [
      { name: 'compaction', thresholdRatio: 0.8 },
      { name: 'other-compactor', thresholdRatio: 0.6 },
      { name: 'silent', thresholdRatio: null },
    ], { thresholdRatio: 0.75, reminderThresholdRatio: 0.6, preempt: true })
    expect(report.safeBelow).toBe(0.6)
  })

  it('serves the report on its own route', async () => {
    const ctx = await mountTestContext()
    let registered: { path: string, handler: (req: unknown, res: unknown) => void } | undefined
    ;(ctx as unknown as { provide(name: string, value: unknown): void }).provide('webServer', {
      register: (route: { path: string, handler: (req: unknown, res: unknown) => void }) => {
        registered = route
        return () => undefined
      },
    })
    const report: BackendReport = {
      observed: [{ name: 'compaction', thresholdRatio: 0.8 }],
      presets: ['standard'],
      stockThresholdRatio: STOCK_BACKEND_THRESHOLD,
      self: { thresholdRatio: 0.75, reminderThresholdRatio: 0.6, preempt: true },
      safeBelow: 0.8,
    }
    registerBackendRoute(ctx, () => Promise.resolve(report))
    await settle()
    expect(registered?.path).toBe(BACKEND_ROUTE)

    const chunks: string[] = []
    let status = 0
    await registered?.handler({ method: 'GET' }, {
      writeHead: (code: number) => { status = code; return { end: () => undefined } },
      end: (body?: string) => { if (body !== undefined) chunks.push(body) },
    })
    await settle()
    expect(status).toBe(200)
    expect(JSON.parse(chunks.join(''))).toMatchObject({ safeBelow: 0.8, presets: ['standard'] })
  })

  it('observes the backend a session actually resolves', async () => {
    const ctx = await mountTestContext()
    const realm = ctx.isolate('compaction')
    const backend = new (await import('@deepseek-ai/dsh-compaction-basic')).default(
      realm,
      { thresholdRatio: 0.7, retainTokens: 0 },
    )
    ;(ctx as unknown as { provide(name: string, value: unknown): void }).provide('agentPresets', {
      serviceFor: () => backend,
    })
    const controller = new RolloverController(ctx, {
      notesDir: await tempNotesDir(),
      thresholdRatio: 0.5,
      reminderThresholdRatio: 0.4,
      retainTokens: 0,
    })
    const agent = await ctx.agentLoop.create(
      (await import('@deepseek-ai/dsh-session')).SessionId('settings-observe'),
      { provider: 'mock', model: 'mock' },
    )
    // A pressure evaluation resolves the owning backend, which is what the
    // card's guidance reports.
    await controller.compactIfNeeded(agent, 'pressure', new AbortController().signal)
    const report = await controller.backendReport()
    expect(report.observed).toEqual([{ name: 'compaction', thresholdRatio: 0.7 }])
    expect(report.safeBelow).toBe(0.7)
  })

  it('keeps same-named backends apart and reports the strictest one', async () => {
    const ctx = await mountTestContext()
    const CompactionBasic = (await import('@deepseek-ai/dsh-compaction-basic')).default
    // Each backend is a real engine on its own root: `compaction` may only be
    // provided once per context, and two presets are exactly two contexts.
    const strict = new CompactionBasic(
      (await mountTestContext()).isolate('compaction'),
      { thresholdRatio: 0.6, retainTokens: 0 },
    )
    const lenient = new CompactionBasic(
      (await mountTestContext()).isolate('compaction'),
      { thresholdRatio: 0.9, retainTokens: 0 },
    )
    // Both publish a backend called `compaction` at different thresholds.
    // Recording them by name would let the later, looser one erase the
    // stricter one, and the card would then bless a threshold that is not safe
    // for the stricter session.
    ;(ctx as unknown as { provide(name: string, value: unknown): void }).provide('agentPresets', {
      serviceFor: (agent: Agent) =>
        String(agent.session.id) === 'settings-strict-backend' ? strict : lenient,
    })
    const controller = new RolloverController(ctx, {
      notesDir: await tempNotesDir(),
      thresholdRatio: 0.5,
      reminderThresholdRatio: 0.4,
      retainTokens: 0,
    })
    const strictAgent = await ctx.agentLoop.create(
      SessionId('settings-strict-backend'),
      { provider: 'mock', model: 'mock' },
    )
    const lenientAgent = await ctx.agentLoop.create(
      SessionId('settings-lenient-backend'),
      { provider: 'mock', model: 'mock' },
    )
    await controller.compactIfNeeded(strictAgent, 'pressure', new AbortController().signal)
    await controller.compactIfNeeded(lenientAgent, 'pressure', new AbortController().signal)

    const report = await controller.backendReport()
    expect(report.observed).toEqual([
      { name: 'compaction', thresholdRatio: 0.6 },
      { name: 'compaction', thresholdRatio: 0.9 },
    ])
    // The bound the card warns against is the strictest observed, not the last.
    expect(report.safeBelow).toBe(0.6)
  })
})
