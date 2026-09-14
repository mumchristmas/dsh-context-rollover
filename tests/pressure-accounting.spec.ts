/**
 * Window-pressure accounting: what the plugin compares against the context
 * window, and why it is not `TokenMeasurement.totalTokens`.
 *
 * The meter anchors a completed call with `usageTokens(usage)`, which sums the
 * call's prompt **and its output**. The next request carries the prompt only,
 * so the raw total over-reports every window by one assistant response —
 * measured live at 2,000–5,100 tokens on a 32k test window (6–16%), enough to
 * fire the reminder and the automatic rollover a whole response early.
 *
 * `requestPressureTokens` subtracts exactly that output. These tests pin both
 * halves: the arithmetic, and a threshold decision that would flip without it.
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
  toolCall,
  usageResponse,
  usageResponseWith,
} from './harness.ts'

describe('pressure accounting', () => {
  it('reports the next request prompt, not the prompt plus the last response', async () => {
    const { ctx, agent, session } = await engineHarness('prompt-only', {
      thresholdRatio: 0.9,
      reminderThresholdRatio: 0.75,
      retainTokens: 40,
    })
    // An honest provider reading of 30,000 prompt tokens plus a 5-token answer.
    const adapter = new ScriptedAdapter([usageResponse('answer one', 30000)])
    ctx.llm.registerAdapter(['mock'], adapter)

    await followup(agent, 'turn one')
    const measurement = ctx.tokenMeter.measure(session)

    expect(measurement.baseline.kind).toBe('usage')
    expect(measurement.totalTokens).toBe(30005)
    // The next request rebuilds the prompt from the surface: no 5 output
    // tokens, so the window pressure is the prompt alone.
    expect(requestPressureTokens(measurement)).toBe(30000)
  })

  it('decides the automatic rollover on the prompt, not on the raw total', async () => {
    // Control: prompt 85,000 with an 8,000-token answer. The raw total
    // (93,000) is past the 90,000 rollover point, the prompt is not. Counting
    // the previous response's output — what `totalTokens` reports — would roll
    // over here; the corrected reading must not.
    const naive = await engineHarness('prompt-vs-total-naive', {
      thresholdRatio: 0.9,
      reminderThresholdRatio: 0.75,
      retainTokens: 0,
    })
    naive.ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
      usageResponseWith(`answer one ${'detail '.repeat(400)}`, 85000, 8000),
      toolCall('get_context_remaining', '{}', 'c1'),
      usageResponseWith(`answer two ${'detail '.repeat(400)}`, 86000, 8000),
      usageResponseWith(`answer three ${'detail '.repeat(400)}`, 87000, 8000),
    ]))
    await followup(naive.agent, 'turn one')
    const naiveReading = naive.ctx.tokenMeter.measure(naive.session)
    expect(naiveReading.totalTokens).toBeGreaterThanOrEqual(90000)
    expect(requestPressureTokens(naiveReading)).toBeLessThan(90000)

    await followup(naive.agent, 'turn two')
    expect(countRollovers(naive.session)).toBe(0)

    // Genuine case: a prompt past the rollover point still rolls over, exactly
    // once, so the correction cannot silently disable the safety net.
    const real = await engineHarness('prompt-vs-total-real', {
      thresholdRatio: 0.9,
      reminderThresholdRatio: 0.75,
      retainTokens: 0,
    })
    real.ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
      usageResponse(`answer one ${'detail '.repeat(400)}`, 85000),
      toolCall('get_context_remaining', '{}', 'c1'),
      usageResponse(`answer two ${'detail '.repeat(400)}`, 95000),
      usageResponse(`answer three ${'detail '.repeat(400)}`, 96000),
    ]))
    await followup(real.agent, 'turn one')
    await followup(real.agent, 'turn two')
    // Turn two's reading was still the pre-rollover prompt; the rollover lands
    // on the next turn's pre-step, where 95,000 is visible.
    expect(countRollovers(real.session)).toBe(0)
    await followup(real.agent, 'turn three')
    expect(countRollovers(real.session)).toBe(1)
  })

  it('reports the reminder against the prompt, not the raw total', async () => {
    const { ctx, agent, session } = await engineHarness('reminder-accounting', {
      // Reminder point 22,500 of the 100k window. The honest reading is a
      // 25,000-token prompt plus a 4,000-token answer: counting the output
      // would report 29% used, the prompt is 25%.
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
    // The reminder names the quantity it reports: what the next request would
    // submit, out of the window — not a tally of what was spent.
    expect(reminders[0]).toContain('Context window at 25%')
    expect(reminders[0]).toContain('about 25,000 of 100,000 prompt tokens')
    expect(reminders[0]).not.toContain('29000')
    expect(reminders[0]).toMatch(/projection that moves with every turn, not a tally/)
  })
})
