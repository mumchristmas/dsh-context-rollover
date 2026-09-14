/**
 * Host/preset ownership under a preset-free design: the plugin's model surface
 * is registered everywhere, the backend API still defers to whoever provides
 * `ctx.compaction`, and model-requested `new_context` rollovers stay this
 * plugin's own promise on every session. The *automatic* cross-realm
 * interception itself is covered by the realm cases in `preempt.spec.ts`.
 *
 * @module tests/preset-deferral
 */

import { describe, expect, it } from 'vitest'
import { getTraceable, type Context } from '@deepseek-ai/cordis'
import type { CompactionEngine } from '@deepseek-ai/dsh-compaction'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import { countRollovers } from '../src/rollover.ts'
import { ContextRolloverEngine } from '../src/index.ts'
import { resolveConfig } from '../src/config.ts'
import {
  derivedTexts,
  engineHarness,
  followup,
  mountTestContext,
  newContextCall,
  ScriptedAdapter,
  seedExchanges,
  tempNotesDir,
  textResponse,
} from './harness.ts'

/** Install a fake preset roster whose composition owns `compaction`. */
function provideRoster(ctx: Context, owner: CompactionEngine | undefined): void {
  (ctx as unknown as { provide(name: string, value: unknown): void })
    .provide('agentPresets', { serviceFor: () => owner })
}

describe('preset ownership', () => {
  it('stands down manual and automatic compaction for a preset-owned session', async () => {
    const { ctx, engine, agent, session } = await engineHarness('defer-other')
    const adapter = new ScriptedAdapter(
      Array.from({ length: 20 }, (_unused, index) => textResponse(`background ${index}`)),
    )
    ctx.llm.registerAdapter(['mock'], adapter)

    await seedExchanges(agent, 20)
    await followup(agent, 'background work')
    provideRoster(ctx, {} as CompactionEngine)

    const compacted = await engine.compactNow(agent, new AbortController().signal)
    expect(compacted).toBeNull()
    const pressured = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal)
    expect(pressured).toBeNull()
    expect(countRollovers(session)).toBe(0)
    expect(session.snapshotEvents().some(event => event.type === 'compaction/start')).toBe(false)
  })

  it('refuses host-region commits for a preset-owned session, but not otherwise', async () => {
    // compactRegion never reaches the commit path here (empty surface), so
    // this exercises only the ownership gate in both directions.
    const start = 0 as unknown as SessionSeq
    const end = 1 as unknown as SessionSeq
    const noRoster = await engineHarness('defer-none')
    await expect(noRoster.engine.compactRegion(start, end, noRoster.agent)).rejects.toThrow(/not found in surface/)

    const owned = await engineHarness('defer-region')
    provideRoster(owned.ctx, {} as CompactionEngine)
    await expect(owned.engine.compactRegion(start, end, owned.agent)).rejects.toThrow(/owned by another backend/)

    const selfOwned = await engineHarness('defer-region-self')
    // Real agent-presets addressing returns the Cordis-traced service, not the
    // raw constructor instance captured by lifecycle listeners.
    provideRoster(selfOwned.ctx, getTraceable(selfOwned.ctx, selfOwned.engine))
    await expect(selfOwned.engine.compactRegion(start, end, selfOwned.agent)).rejects.toThrow(/not found in surface/)
  })

  it('keeps a model-requested new_context promise even where a preset owns compaction', async () => {
    const { ctx, agent, session } = await engineHarness('defer-honest')
    provideRoster(ctx, {} as CompactionEngine)
    const adapter = new ScriptedAdapter([
      ...Array.from({ length: 6 }, (_unused, index) => textResponse(`background ${index}`)),
      newContextCall('{"handoff":"Continue the work."}'),
      textResponse('noted'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    await seedExchanges(agent, 6)

    await followup(agent, 'Roll over, please.')

    // A model-requested boundary is this plugin's own promise: another
    // backend owning automatic compaction never turns it down, and the
    // checkpoint carries the handoff.
    expect(countRollovers(session)).toBe(1)
    const tailResultSeq = session.surface.nodes
      .map(seq => session.eventAt(seq))
      .filter(event => event?.type === 'tool/result')
      .map(event => event?.seq)
      .pop()
    const tailResult = tailResultSeq === undefined ? undefined : session.eventAt(tailResultSeq)
    expect(JSON.stringify(tailResult?.data)).toContain('without summarizing')
    expect(derivedTexts(session).join('\n')).toContain('Continue the work.')
  })

  it('registers its model surface on rosterless deployments', async () => {
    const { ctx } = await engineHarness('defer-tools-present')
    for (const name of ['new_context', 'get_context_remaining', 'notes', 'history']) {
      expect(ctx.tools.get(name)).toBeDefined()
    }
  })

  it('registers the same model surface where a preset roster exists', async () => {
    const ctx = await mountTestContext()
    provideRoster(ctx, undefined)
    // Preset-free design: the plugin is not an opt-in composition any more, so
    // a roster must not suppress its tools or guidance.
    const engine = new ContextRolloverEngine(ctx, { notesDir: await tempNotesDir() })
    expect(engine).toBeDefined()
    for (const name of ['new_context', 'get_context_remaining', 'notes', 'history']) {
      expect(ctx.tools.get(name)).toBeDefined()
    }
    const prompt = await ctx.systemPrompt.assemble({})
    expect(prompt.sections.some(section => section.text.includes('temporary working memory'))).toBe(true)
  })

  it('defaults below the stock backend threshold and validates the ratios', () => {
    // The plugin must reach the window before the stock `compaction-basic`
    // default (0.8), or a preset session would summarize first.
    const defaults = resolveConfig({})
    expect(defaults.thresholdRatio).toBeLessThan(0.8)
    expect(defaults.reminderThresholdRatio).toBeLessThanOrEqual(defaults.thresholdRatio)
    expect(() => resolveConfig({ thresholdRatio: 0.5, reminderThresholdRatio: 0.9 }))
      .toThrow(/must not exceed/)
  })
})
