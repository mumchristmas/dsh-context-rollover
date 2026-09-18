/**
 * The composer control's reading: which countdown a session is on, and how much
 * prompt growth is left before the action it names.
 *
 * The stage is decided on the host because every input is host state — the live
 * measurement behind the next request, the once-per-window claim in the session
 * log, and whether automatic rollover is armed for the session's realm. These
 * cases pin that decision: the ladder's four stages, the two ways a window ends
 * in a summary, and the collapsed band that has no middle stage to be in.
 *
 * @module tests/status.spec
 */

import { describe, expect, it } from 'vitest'
import { readStage, sessionIdFromUrl, statusOf } from '../src/status.ts'
import type { RolloverStatus, StageInput } from '../src/status.ts'

/** The shipped defaults: 72% notify, 76% warn, 79% take the window. */
const POINTS: RolloverStatus['points'] = { notify: 0.72, warn: 0.76, rollover: 0.79, compact: 0.8 }

/** One reading with everything but the case's own facts filled in. */
function reading(overrides: Partial<StageInput> = {}): StageInput {
  return {
    mode: 'rollover',
    armed: true,
    promptTokens: 0,
    contextWindow: 1000000,
    notified: false,
    points: POINTS,
    ...overrides,
  }
}

describe('readStage', () => {
  it('counts down to the notice before the first point', () => {
    // 700K of a 1M window: 20K short of the 720K notify point.
    expect(readStage(reading({ promptTokens: 700000, notified: false })))
      .toEqual({ stage: 'notify', tokensToNext: 20000 })
  })

  it('counts down to the warning once the window has been reported on', () => {
    // The claim in the log is what makes this "notified"; the position alone
    // does not, because a step may not have run since the point was crossed.
    expect(readStage(reading({ promptTokens: 700000, notified: true })))
      .toEqual({ stage: 'warn', tokensToNext: 60000 })
  })

  it('treats a crossed point as reported even before the notice lands', () => {
    // Past 720K with no claim recorded: the notice is due at the next step, so
    // counting down to it would promise a boundary that has already arrived.
    expect(readStage(reading({ promptTokens: 730000, notified: false })))
      .toEqual({ stage: 'warn', tokensToNext: 30000 })
  })

  it('counts down to the new window from inside the last-chance band', () => {
    expect(readStage(reading({ promptTokens: 770000, notified: true })))
      .toEqual({ stage: 'rollover', tokensToNext: 20000 })
  })

  it('drops the countdown at the rollover point, where the next boundary takes it', () => {
    expect(readStage(reading({ promptTokens: 790000, notified: true })))
      .toEqual({ stage: 'imminent', tokensToNext: 0 })
    expect(readStage(reading({ promptTokens: 900000, notified: true })))
      .toEqual({ stage: 'imminent', tokensToNext: 0 })
  })

  it('counts down to the backend that will summarise a compact-mode session', () => {
    expect(readStage(reading({ mode: 'compact', promptTokens: 500000 })))
      .toEqual({ stage: 'compacting', tokensToNext: 300000 })
  })

  it('counts down to the same backend when rollover stands down for one', () => {
    // Rollover mode, but a backend fires at or before this plugin's point: the
    // window ends in a summary either way, and a rollover countdown here would
    // name a boundary that never comes.
    expect(readStage(reading({ armed: false, promptTokens: 500000 })))
      .toEqual({ stage: 'compacting', tokensToNext: 300000 })
  })

  it('skips the middle stage when the band is collapsed onto the rollover point', () => {
    // A two-tier ladder by choice: the warn point raised onto the execute point
    // leaves no band to be in, so the ladder goes straight from notice to
    // new window.
    const points = { ...POINTS, warn: 0.79 }
    expect(readStage(reading({ promptTokens: 770000, notified: true, points })))
      .toEqual({ stage: 'rollover', tokensToNext: 20000 })
    expect(readStage(reading({ promptTokens: 700000, notified: false, points })))
      .toEqual({ stage: 'notify', tokensToNext: 20000 })
  })

  it('names the stage without a countdown while nothing is measured', () => {
    expect(readStage(reading({ promptTokens: null })))
      .toEqual({ stage: 'notify', tokensToNext: null })
    expect(readStage(reading({ contextWindow: null })))
      .toEqual({ stage: 'notify', tokensToNext: null })
    expect(readStage(reading({ mode: 'compact', contextWindow: null })))
      .toEqual({ stage: 'compacting', tokensToNext: null })
  })

  it('never counts below zero', () => {
    // The point is behind the reading but the stage has not advanced: a
    // negative countdown would read as room that is not there.
    expect(readStage(reading({ promptTokens: 730000, notified: false })).tokensToNext).toBe(30000)
    expect(readStage(reading({ mode: 'compact', promptTokens: 900000 })).tokensToNext).toBe(0)
  })
})

describe('statusOf', () => {
  it('carries the reading, the stage, and the points the bar draws', () => {
    expect(statusOf(reading({ promptTokens: 770000, notified: true }))).toEqual({
      mode: 'rollover',
      stage: 'rollover',
      promptTokens: 770000,
      contextWindow: 1000000,
      tokensToNext: 20000,
      points: POINTS,
    })
  })
})

describe('sessionIdFromUrl', () => {
  it('reads the session a status request names', () => {
    expect(sessionIdFromUrl('/context-rollover/status?session=session-7')).toBe('session-7')
    expect(sessionIdFromUrl('/context-rollover/status?x=1&session=a%2Fb')).toBe('a/b')
  })

  it('answers nothing for a request that names none', () => {
    expect(sessionIdFromUrl('/context-rollover/status')).toBeUndefined()
    expect(sessionIdFromUrl('/context-rollover/status?other=1')).toBeUndefined()
    expect(sessionIdFromUrl(undefined)).toBeUndefined()
  })
})
