/**
 * Window-pressure accounting: what the plugin compares against the context
 * window.
 *
 * The meter anchors a completed call with `usageTokens(usage)`, which sums that
 * call's prompt **and its output**. That output is not discarded: the assistant
 * message stays on the active surface and the next request replays the
 * conversation in full, so the whole total is the honest projection of what the
 * window has to hold. Subtracting the output would report every window one
 * assistant response too small and fire the reminder and the automatic rollover
 * late — the defect these tests exist to prevent from returning.
 *
 * They pin both halves: the arithmetic, and the threshold decisions that depend
 * on it.
 *
 * @module tests/pressure-accounting
 */

import { describe, expect, it } from 'vitest'
import { countRollovers, requestPressureTokens } from '../src/rollover.ts'
import {
  engineHarness,
  followup,
  reminderTexts,
  ScriptedAdapter,
  usageResponseWith,
} from './harness.ts'

describe('pressure accounting', () => {
  it('reports the full reading the next request will carry', async () => {
    const { ctx, agent, session } = await engineHarness('prompt-only', {
      thresholdRatio: 0.9,
      reminderThresholdRatio: 0.75,
      retainTokens: 40,
    })
    // An honest provider reading of 30,000 prompt tokens plus a 5-token answer.
    const adapter = new ScriptedAdapter([usageResponseWith('answer one', 30000, 5)])
    ctx.llm.registerAdapter(['mock'], adapter)

    await followup(agent, 'turn one')
    const measurement = ctx.tokenMeter.measure(session)

    expect(measurement.baseline.kind).toBe('usage')
    expect(measurement.totalTokens).toBe(30005)
    // The previous answer is still on the surface and is replayed in full, so
    // the window pressure is the whole reading, not the prompt alone.
    expect(requestPressureTokens(measurement)).toBe(30005)
  })

  it('rolls over once the last response leaves the next request past the threshold', async () => {
    const { ctx, agent, session } = await engineHarness('prompt-vs-total', {
      thresholdRatio: 0.9,
      reminderThresholdRatio: 0.75,
      retainTokens: 0,
      // The case pins where the *forced* rollover fires, so the last-chance
      // band is out of scope: with it on, the same reading would hold the
      // window open for the band's width.
      // Collapsed onto the rollover point: the tier is off, as in every release
      // before the ladder existed. The threshold here is 0.9.
      lastChanceRatio: 0.9,
    })
    // A first request large enough that the boundary has real content to
    // shadow, answered with 8,000 tokens on top of an 85,000-token prompt.
    const adapter = new ScriptedAdapter([
      usageResponseWith(`answer one ${'detail '.repeat(400)}`, 85000, 8000),
      usageResponseWith(`answer two ${'detail '.repeat(400)}`, 86000, 8000),
      usageResponseWith(`answer three ${'detail '.repeat(400)}`, 87000, 8000),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)

    await followup(agent, `turn one ${'context '.repeat(400)}`)
    const measurement = ctx.tokenMeter.measure(session)
    expect(measurement.baseline.kind).toBe('usage')
    expect(measurement.totalTokens).toBe(93_000)
    // 93,000 is past the 90,000 rollover point, and the next request genuinely
    // carries both halves. A reader that subtracted the answer would see
    // 85,000 and let another unrolled request through.
    expect(requestPressureTokens(measurement)).toBe(93_000)

    // The boundary is crossed before the next request, not one response later.
    await followup(agent, 'turn two')
    expect(countRollovers(session)).toBe(1)
  })

  it('reports the reminder against that same reading', async () => {
    const { ctx, agent, session } = await engineHarness('reminder-accounting', {
      // Reminder point 22,500 of the 100k window. The reading after turn one is
      // a 25,000-token prompt plus its 4,000-token answer: 29,000, i.e. 29% of
      // the window once the answer the next request replays is counted.
      thresholdRatio: 0.9,
      reminderThresholdRatio: 0.225,
      retainTokens: 40,
    })
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
      usageResponseWith('answer one', 25000, 4000),
      usageResponseWith('answer two', 26000, 4000),
    ]))

    await followup(agent, 'turn one')
    await followup(agent, 'turn two')

    const reminders = reminderTexts(session)
    expect(reminders).toHaveLength(1)
    // The reminder leads with the numbers and labels them the same way the
    // tool does: the prompt the next request would submit, out of the window.
    expect(reminders[0]).toContain('prompt used 29,000 / 100,000')
    expect(reminders[0]).toContain('window left 71,000')
    expect(reminders[0]).toContain('automatic rollover in 61,000')
  })
})
