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
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import {
  BACKEND_ROUTE,
  STOCK_BACKEND_THRESHOLD,
  collectBackendReport,
  registerBackendRoute,
  type BackendReport,
} from '../src/backends.ts'
import { RolloverController } from '../src/index.ts'
import { SETTINGS_NAMESPACE, resolveSettings } from '../src/settings.ts'
import { mountTestContext, tempNotesDir } from './harness.ts'

/** Let deferred service-injection callbacks run. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
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

    // A reminder above the rollover point is incoherent: the write is refused
    // rather than stored for the next rollover to trip over.
    await expect(async () => await ctx.settings.update(SETTINGS_NAMESPACE, {
      thresholdRatio: 0.5,
      reminderThresholdRatio: 0.9,
    })).rejects.toThrow(/must not exceed/)
    expect(controller.config.thresholdRatio).toBe(0.75)

    // An accepted write re-resolves the effective configuration in place. It
    // must stay above the reminder point (0.6 from the composition layer).
    await ctx.settings.update(SETTINGS_NAMESPACE, { thresholdRatio: 0.65 })
    expect(controller.config.thresholdRatio).toBe(0.65)
    expect(controller.config.reminderThresholdRatio).toBe(0.6)

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
})
