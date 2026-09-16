/**
 * Lifecycle policy coverage: what a requested boundary promises, whether a
 * queued request can mask the independent pressure safety net, and how a
 * rollover backend from another module copy is recognized.
 *
 * These are the behaviours the audit's lifecycle evidence described as broken;
 * each case here asserts the contract a fix has to keep.
 *
 * @module tests/lifecycle.spec
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ContextRolloverEngine, RolloverController } from '../src/index.ts'
import { NotesStore } from '../src/notes.ts'
import { RolloverRefusedError, countRollovers } from '../src/rollover.ts'
import {
  engineHarness,
  followup,
  mountTestContext,
  newContextCall,
  ScriptedAdapter,
  seedExchanges,
  textResponse,
} from './harness.ts'

/** A harness with enough conversation that a boundary has real content to shadow. */
async function seeded(id: string) {
  const result = await engineHarness(id, { retainTokens: 0 })
  result.ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
    textResponse('prior investigation '.repeat(35)),
  ]))
  await seedExchanges(result.agent, 10)
  return result
}

/** A promise plus the resolver its test drives the timing with. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

afterEach(() => { vi.restoreAllMocks() })

describe('requested boundary honesty', () => {
  it('refuses a handoff the commit could not shrink, instead of promising a window', async () => {
    const { ctx, agent, session, engine } = await engineHarness('lifecycle-handoff-refusal', {
      notesEnabled: false,
      retainTokens: 0,
    })
    // Legal by size (under the 20,000-character limit) but larger than the
    // span it would replace: the commit refuses this, so the tool must not
    // answer "accepted" and leave the model waiting for a window.
    const handoff = 'handoff material '.repeat(1100)
    expect(handoff.length).toBeLessThan(20_000)
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
      ...Array.from({ length: 10 }, (_unused, index) => textResponse(`finding ${index} details`)),
      newContextCall(JSON.stringify({ handoff })),
      textResponse('continued in the old window'),
    ]))
    await seedExchanges(agent, 10)
    await followup(agent, 'Create a new context now.')

    const toolResult = session.snapshotEvents().find(event => event.type === 'tool/result')
    const resultText = JSON.stringify(toolResult?.data)
    expect(resultText).toContain('No new context window will start')
    expect(resultText).toContain('no smaller than')

    // No promise was made, so nothing may stay queued as if one had been.
    const controller = engine.controller as unknown as {
      pendingRollovers: Map<string, { handoff: string | null }>
    }
    expect(controller.pendingRollovers.has(session.id)).toBe(false)
  })

  it('keeps the pressure safety net when a queued request cannot be kept', async () => {
    const { agent, session, engine } = await seeded('lifecycle-pending-not-masking')
    const controller = engine.controller as unknown as {
      effective: typeof engine.controller.config
      pendingRollovers: Map<string, { handoff: string | null }>
      rollOverOnPressure: (...args: unknown[]) => Promise<void>
    }
    // A threshold this low makes the pressure path eligible on its own, and the
    // queued handoff is far too large for the commit to shrink. The band is
    // switched off so the reading lands past the forced point immediately —
    // this case is about the safety net, not about the wait before it.
    controller.effective = {
      ...engine.controller.config,
      thresholdRatio: 0.001,
      reminderThresholdRatio: 0.001,
      // Collapsed onto the rollover point: the tier is off, as in every release
      // before the ladder existed. The threshold here is 0.001.
      lastChanceRatio: 0.001,
    }
    controller.pendingRollovers.set(session.id, { handoff: 'handoff '.repeat(2490) })

    const pressure = vi.spyOn(controller, 'rollOverOnPressure')
    await followup(agent, 'Continue while already above the rollover threshold.')

    // The refuse-to-shrink guard is a protection, but a queued request that hit
    // it must not stand down the independent safety net.
    expect(pressure).toHaveBeenCalled()
    expect(countRollovers(session)).toBeGreaterThan(0)
    // The request itself is still queued for a later boundary rather than
    // silently consumed.
    expect(controller.pendingRollovers.has(session.id)).toBe(true)
  })
})

describe('cancellation during notes IO', () => {
  it('does not commit the manual rollover its command already cancelled', async () => {
    const { agent, session, engine } = await seeded('lifecycle-cancel-during-notes')
    const entered = deferred<void>()
    const release = deferred<string | null>()
    vi.spyOn(NotesStore.prototype, 'renderAll').mockImplementationOnce(async () => {
      entered.resolve()
      return await release.promise
    })
    const abort = new AbortController()
    const pending = engine.compactNow(agent, abort.signal)
    await entered.promise
    // Cancelled while the notes read is in flight and before anything was
    // written: the operation has to honour it, not commit and report success.
    abort.abort(new Error('command cancelled'))
    release.resolve(null)

    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    expect(countRollovers(session)).toBe(0)
    // No half-open compaction bracket was left behind either.
    expect(session.snapshotEvents().some(event => event.type === 'compaction/start')).toBe(false)
  })
})

describe('manual failure classification', () => {
  it('keeps a shrink refusal its own kind, not a busy agent', async () => {
    const { agent, session, engine } = await seeded('lifecycle-refusal-classification')
    // Notes larger than the span they would replace: a legal request the
    // commit's own budget must refuse, after maintenance was already admitted.
    vi.spyOn(NotesStore.prototype, 'renderAll').mockResolvedValueOnce('notes '.repeat(3300))
    let failure: unknown
    try {
      await engine.compactNow(agent, new AbortController().signal)
    } catch (error: unknown) {
      failure = error
    }
    expect(failure).toBeInstanceOf(RolloverRefusedError)
    expect(failure).toMatchObject({ code: 'checkpoint-too-large' })
    expect(countRollovers(session)).toBe(0)
  })
})

describe('cross-module backend ownership', () => {
  it('recognizes a rollover engine loaded from another module instance', async () => {
    const host = await mountTestContext()
    const controller = new RolloverController(host, {
      notesEnabled: false,
      thresholdRatio: 0.5,
      reminderThresholdRatio: 0.4,
    })
    // A cache-busted import models the host row and the agent-preset row
    // loading this module through different paths, which is why constructor
    // identity cannot be the test.
    // @ts-expect-error query specifier intentionally creates another module instance
    const fresh = await import('../src/index.ts?distinct-preset-row') as typeof import('../src/index.ts')
    const presetContext = await mountTestContext()
    const presetEngine = new fresh.ContextRolloverEngine(presetContext, {
      notesEnabled: false,
      thresholdRatio: 0.8,
      reminderThresholdRatio: 0.7,
    })
    ;(host as unknown as { provide(name: string, value: unknown): void }).provide('agentPresets', {
      serviceFor: () => presetEngine,
    })
    const agent = await host.agentLoop.create(
      SessionId('lifecycle-cross-module-owner'),
      { provider: 'mock', model: 'mock' },
    )

    // The premise: this really is a different constructor, so `instanceof`
    // alone cannot see it.
    expect(presetEngine).not.toBeInstanceOf(ContextRolloverEngine)
    // ...and the host row still stands down, because the preset's own rollover
    // engine owns that session's policy.
    const preempts = (controller as unknown as {
      shouldPreemptAutomatic(candidate: typeof agent): boolean
    }).shouldPreemptAutomatic(agent)
    expect(preempts).toBe(false)
  })
})
