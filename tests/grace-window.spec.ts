/**
 * The last-chance band: the final stretch before the automatic rollover, in
 * which the model is told once, in as many words, that this is its last
 * opportunity to write notes before the window is replaced.
 *
 * The band reserves room *below* the rollover point rather than delaying the
 * rollover past it. That placement is the load-bearing decision, and three
 * consequences of it are what these cases pin:
 *
 * 1. **The rollover still fires exactly where it always did.** A band that
 *    pushed the firing point later would let any other compaction backend's
 *    threshold win the session, which is a summary instead of a rollover.
 * 2. **Inside the band the model is told, once.** A notice that repeats every
 *    step spends the room it exists to protect.
 * 3. **The band is a tier of its own.** One shared claim would let either
 *    notice suppress the other, and the failure is invisible: the session
 *    simply stops being warned.
 *
 * The band is a guarantee of *room*, not a guarantee of delivery: a single step
 * can jump from below the band to past the threshold, and then no notice is
 * owed. That case is pinned too, because it is the edge of the promise.
 *
 * Every case anchors pressure with a provider usage reading, so the numbers
 * under test are the ones a real request would carry rather than heuristic
 * estimates. The first request also carries a large prompt, which is what gives
 * a rollover a span worth replacing — a surface of two tiny messages is
 * correctly refused by the shrink guard before any of this is reached.
 *
 * @module tests/grace-window
 */

import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { countRollovers } from '../src/rollover.ts'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  engineHarness,
  followup,
  lastChanceTexts,
  reminderTexts,
  ScriptedAdapter,
  toolCall,
  usageResponseWith,
} from './harness.ts'

/**
 * The rollover fires at 60% of the mock's 100,000-token window, and the last
 * chance opens at 50%: a 10% band, with the ordinary reminder at 40% below it.
 */
const BANDED = {
  thresholdRatio: 0.6,
  reminderThresholdRatio: 0.4,
  lastChanceRatio: 0.1,
  retainTokens: 0,
} as const

/** A first request with enough content that a rollover has a span to replace. */
const BIG_TURN = `turn one ${'context '.repeat(400)}`
/** An answer big enough to be worth pricing, but not big enough to matter. */
const BIG_ANSWER = `answer ${'detail '.repeat(400)}`

/** Every notice this engine delivered, in log order, as `[tier, text]`. */
function notices(session: Session): Array<[string, string]> {
  return session.snapshotEvents()
    .flatMap((event) => {
      if (event.type !== 'user/message') return []
      const { source } = event.data
      // Narrowed the way the engine's own predicates do it: the summary rides
      // on the `notice` form, not on every plugin source.
      if (source.kind !== 'plugin' || !('plugin' in source) || source.form !== 'notice') return []
      const { summary } = source
      if (!summary.startsWith('context pressure')) return []
      const text = event.data.content
        .map(block => block.type === 'text' ? block.text : '')
        .join('')
      const tier = summary.startsWith('context pressure last-chance') ? 'last-chance' : 'reminder'
      return [[tier, text] as [string, string]]
    })
}

describe('last-chance band', () => {
  let caseId = 0
  const sessionId = (label: string): string => `grace-${label}-${(caseId += 1)}`

  it('announces the final stretch once the reading enters the band', async () => {
    const { ctx, agent, session } = await engineHarness(sessionId('opens'), BANDED)
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
      // 55,000: past the 50,000 band start, still below the 60,000 rollover.
      usageResponseWith(BIG_ANSWER, 50000, 5000),
      usageResponseWith(BIG_ANSWER, 55000, 5000),
    ]))

    await followup(agent, BIG_TURN)
    await followup(agent, 'turn two')

    expect(countRollovers(session)).toBe(0)
    const delivered = lastChanceTexts(session)
    expect(delivered).toHaveLength(1)
    // It opens with where the window stands, names the point the rollover
    // fires at in the units the setting uses, and states the growth left.
    expect(delivered[0]).toContain('55%')
    expect(delivered[0]).toContain('60%')
    expect(delivered[0]).toContain('5,000')
    // It names what the next window needs and what happens otherwise. A notice
    // that only reports a number is not a last chance.
    expect(delivered[0]).toMatch(/notes/iu)
    expect(delivered[0]).toMatch(/new_context/u)
    expect(delivered[0]).toMatch(/leaves your active context/iu)
  })

  it('leaves the rollover exactly where it was: the band reserves room, it does not delay', async () => {
    // The property the whole design rests on. If the band moved the firing
    // point, every deployment that preempts a compaction backend would hand
    // those sessions to the summarizer instead.
    const { ctx, agent, session } = await engineHarness(sessionId('fires'), BANDED)
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
      usageResponseWith(BIG_ANSWER, 56000, 5000),
      usageResponseWith(BIG_ANSWER, 60000, 5000),
    ]))

    await followup(agent, BIG_TURN)
    // 61,000 is past the threshold: the same pre-step that would have rolled
    // over before this feature existed still does.
    await followup(agent, 'turn two')

    expect(countRollovers(session)).toBe(1)
    expect(lastChanceTexts(session)).toHaveLength(0)
  })

  it('is a tier of its own: the reminder precedes it, in that order', async () => {
    const { ctx, agent, session } = await engineHarness(sessionId('tiers'), BANDED)
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
      // 45,000: past the 40,000 reminder point, below the 50,000 band start.
      usageResponseWith(BIG_ANSWER, 40000, 5000),
      // 55,000: inside the band.
      usageResponseWith(BIG_ANSWER, 50000, 5000),
      usageResponseWith(BIG_ANSWER, 55000, 5000),
    ]))

    await followup(agent, BIG_TURN)
    await followup(agent, 'turn two')
    await followup(agent, 'turn three')

    expect(reminderTexts(session)).toHaveLength(1)
    expect(lastChanceTexts(session)).toHaveLength(1)
    // Order matters: the escalation has to arrive after the notice it replaces.
    expect(notices(session).map(([tier]) => tier)).toEqual(['reminder', 'last-chance'])
    expect(countRollovers(session)).toBe(0)
  })

  it('delivers the notice once per window, not once per step', async () => {
    const { ctx, agent, session } = await engineHarness(sessionId('once'), BANDED)
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
      usageResponseWith(BIG_ANSWER, 50000, 5000),
      // Turn two makes two requests, so two pre-steps see the same band.
      toolCall('get_context_remaining', '{}', 'c1'),
      usageResponseWith(BIG_ANSWER, 55000, 5000),
    ]))

    await followup(agent, BIG_TURN)
    await followup(agent, 'turn two')

    expect(lastChanceTexts(session)).toHaveLength(1)
    expect(countRollovers(session)).toBe(0)
  })

  it('opens a fresh notice slot when the band is entered in a new window', async () => {
    const { ctx, agent, session } = await engineHarness(sessionId('window'), BANDED)
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
      usageResponseWith(BIG_ANSWER, 50000, 5000),
      // The model takes the notice and crosses the boundary itself.
      toolCall('new_context', '{"handoff":"carry on"}', 'c1'),
      usageResponseWith(BIG_ANSWER, 50000, 5000),
    ]))

    await followup(agent, BIG_TURN)
    // Turn two's pre-step finds 55,000: inside the band, so the notice lands
    // first and the model answers it with its own boundary.
    await followup(agent, 'turn two')
    expect(countRollovers(session)).toBe(1)
    expect(lastChanceTexts(session)).toHaveLength(1)

    // The new window starts under the same honest reading, so it is inside a
    // band again — and the claim is per window, not per session.
    await followup(agent, 'turn three')
    expect(lastChanceTexts(session)).toHaveLength(2)
  })

  it('reproduces the pre-band behavior exactly when the band is switched off', async () => {
    // The contrast case for the first one: the same reading, one config flag
    // apart. Without a band there is no final stretch, so 55,000 is simply
    // below the threshold and the ordinary reminder is the only notice.
    const read = async (label: string, lastChanceRatio: number): Promise<Session> => {
      const { ctx, agent, session } = await engineHarness(sessionId(label), { ...BANDED, lastChanceRatio })
      ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
        usageResponseWith(BIG_ANSWER, 50000, 5000),
        usageResponseWith(BIG_ANSWER, 55000, 5000),
      ]))
      await followup(agent, BIG_TURN)
      await followup(agent, 'turn two')
      return session
    }

    const banded = await read('contrast-on', BANDED.lastChanceRatio)
    expect(lastChanceTexts(banded)).toHaveLength(1)
    expect(reminderTexts(banded)).toHaveLength(0)

    const unbanded = await read('contrast-off', 0)
    expect(lastChanceTexts(unbanded)).toHaveLength(0)
    // The ordinary reminder is unaffected by the switch and is not suppressed
    // by a band that does not exist.
    expect(reminderTexts(unbanded)).toHaveLength(1)
    expect(countRollovers(unbanded)).toBe(0)
  })

  it('keeps the last-chance notice out of recoverable history', async () => {
    const { ctx, agent, session } = await engineHarness(sessionId('history'), BANDED)
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
      usageResponseWith(BIG_ANSWER, 50000, 5000),
      // The model takes the notice, and the boundary shadows it.
      toolCall('new_context', '{"handoff":"carry on"}', 'c1'),
      usageResponseWith(BIG_ANSWER, 50000, 5000),
    ]))
    await followup(agent, BIG_TURN)
    await followup(agent, 'turn two')
    expect(countRollovers(session)).toBe(1)
    expect(lastChanceTexts(session)).toHaveLength(1)

    const { searchHistory } = await import('../src/history.ts')
    const { rolloverSummarySeqs } = await import('../src/rollover.ts')
    const query = (text: string): number => searchHistory(
      session,
      countRollovers(session),
      rolloverSummarySeqs(session),
      text,
    ).length
    // A notice the plugin regenerates is not conversation: the recovery tool
    // must not surface it as something the human or the model said, even though
    // it is now shadowed and every real message still is recoverable.
    expect(query('final stretch')).toBe(0)
    expect(query('turn one')).toBeGreaterThan(0)
  })
})

describe('last-chance configuration', () => {
  it('defaults to a 10% band below the rollover threshold', () => {
    const resolved = resolveConfig({})
    expect(resolved.lastChanceRatio).toBe(0.1)
    // The placement is the point: the rollover point itself is untouched.
    expect(resolved.thresholdRatio).toBe(0.75)
    expect(resolved.thresholdRatio - resolved.lastChanceRatio).toBeGreaterThan(0)
  })

  it('accepts zero as the documented way to switch the band off', () => {
    expect(resolveConfig({ lastChanceRatio: 0 }).lastChanceRatio).toBe(0)
  })

  it('clamps a band wider than the rollover point instead of refusing the config', () => {
    // A deployment with a very low threshold was valid before the band existed,
    // so an inherited default must yield rather than fail the load. The card
    // refuses the pair outright, so this path is only ever reached by defaults.
    const narrow = { thresholdRatio: 0.4, reminderThresholdRatio: 0.2, lastChanceRatio: 0.5 }
    expect(resolveConfig(narrow).lastChanceRatio).toBe(0.4)
    // Zero stays zero: the switch-off value is never clamped up into a band.
    // A tiny threshold is exactly the shape `tests/pressure-range.spec.ts`
    // uses, and the inherited 10% default has to yield to it rather than fail.
    const tiny = { thresholdRatio: 0.001, reminderThresholdRatio: 0.001 }
    expect(resolveConfig({ ...tiny, lastChanceRatio: 0 }).lastChanceRatio).toBe(0)
    expect(resolveConfig(tiny).lastChanceRatio).toBe(0.001)
  })

  it('refuses a band outside [0, 1]', () => {
    expect(() => resolveConfig({ lastChanceRatio: -0.1 })).toThrow(/lastChanceRatio/u)
    expect(() => resolveConfig({ lastChanceRatio: 1.5 })).toThrow(/lastChanceRatio/u)
    expect(() => resolveConfig({ lastChanceRatio: Number.NaN })).toThrow(/lastChanceRatio/u)
  })
})
