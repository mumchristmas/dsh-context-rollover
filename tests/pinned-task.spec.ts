/**
 * The active request survives a rollover.
 *
 * A token-budgeted tail answers "how much recent conversation is worth
 * keeping", and that is the wrong question for the one message the human is
 * waiting on. A single long turn puts the request that started it at the far
 * end of the turn's work, and a tail sized for the work drops the request
 * itself: the fresh window would then hold notes about a task whose
 * instructions are gone.
 *
 * So the rule is not a budget but a floor: while a turn is open, the newest
 * direct human message on the surface is never inside the replaced span. The
 * pin also retains everything the turn has done since, which is exactly the
 * working context a fresh window needs — and it can only ever *shrink* a
 * rollover, never enlarge the span being replaced.
 *
 * The rule is deliberately bounded to the open turn. A human message from a
 * turn that already closed is history, notes are its carrier, and pinning it
 * would retain every turn since.
 *
 * @module tests/pinned-task
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  createAssistantMessage,
  createUserMessage,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import { countRollovers, selectRolloverRange } from '../src/rollover.ts'
import type { Seq } from '../src/compat.ts'
import {
  appendExchange,
  closedConversation,
  derivedTexts,
  engineHarness,
  followup,
  ScriptedAdapter,
  usageResponseWith,
} from './harness.ts'

/** A meter mounted on a bare context, for direct range tests. */
async function bareMeter(): Promise<TokenMeter> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TokenMeter)
  return ctx.tokenMeter
}

const REQUEST = 'the request that must survive'

/** The surface seq of one direct human message, or `undefined`. */
function humanSeq(session: Session, text: string): Seq | undefined {
  for (const seq of session.surface.nodes) {
    const event = session.snapshotEvents().find(candidate => candidate.seq === seq)
    if (event?.type !== 'user/message') continue
    if (event.data.source.kind !== 'user') continue
    const carried = event.data.content.map(block => block.type === 'text' ? block.text : '').join('')
    if (carried.includes(text)) return seq
  }
  return undefined
}

/**
 * Two closed turns of ordinary history, then an open turn whose request is
 * followed by `steps` worth of work — the shape that puts a request out of
 * reach of its own turn's tail.
 */
function longTurnWithRequest(steps: number): Session {
  const session = closedConversation(2)
  session.append('turn/start', { turn: 3 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `user: ${REQUEST}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  for (let step = 1; step <= steps; step += 1) {
    session.append('step/start', { turn: 3, step })
    session.append('assistant/message', {
      stream: [],
      turn: 3,
      step,
      message: createAssistantMessage({
        content: [{ type: 'text', text: `work ${step} ${'detail '.repeat(200)}` }],
        source: { provider: 'mock', model: 'mock' },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 3, step })
  }
  return session
}

describe('pinned active request', () => {
  it('keeps the open turn\'s request out of the replaced span', async () => {
    const meter = await bareMeter()
    const session = longTurnWithRequest(3)
    const measurement = meter.measure(session)
    const request = humanSeq(session, REQUEST)
    expect(request).toBeDefined()
    // A tail budget that covers only the last step of work: the budgeted cut
    // lands well after the request.
    const range = selectRolloverRange(session, measurement, 400)
    expect(range).not.toBeNull()
    if (range === null || request === undefined) return
    expect(range.shadowedSeqs).not.toContain(request)
    expect(range.end).toBeLessThan(request)
  })

  it('is doing work: the same budget takes the request with the pin switched off', async () => {
    const meter = await bareMeter()
    const session = longTurnWithRequest(3)
    const measurement = meter.measure(session)
    const request = humanSeq(session, REQUEST)
    const range = selectRolloverRange(session, measurement, 400, false)
    expect(range).not.toBeNull()
    if (range === null || request === undefined) return
    // The contrast is the whole point of the case: without the pin, the request
    // is inside the span the rollover discards.
    expect(range.shadowedSeqs).toContain(request)
  })

  it('leaves both cuts of the pinned span tool-pairing balanced', async () => {
    const meter = await bareMeter()
    const session = longTurnWithRequest(3)
    const measurement = meter.measure(session)
    const range = selectRolloverRange(session, measurement, 400)
    if (range === null) throw new Error('expected a pinned range')
    // Pinning moves the cut; the balance loop still runs afterwards, and this
    // is the assertion that says so on a real surface.
    expect(toolPairingBalancedBefore(session, range.start)).toBe(true)
    expect(toolPairingBalancedAfter(session, range.end)).toBe(true)
  })

  it('does not pin a request from a turn that already closed', async () => {
    const meter = await bareMeter()
    const session = closedConversation(3)
    const measurement = meter.measure(session)
    const request = humanSeq(session, 'exchange 3')
    expect(request).toBeDefined()
    // Zero tail budget: the cut lands on the last node, so every earlier
    // message — including the newest human one — is in the replaced span.
    const range = selectRolloverRange(session, measurement, 0)
    expect(range).not.toBeNull()
    if (range === null || request === undefined) return
    // Closed history belongs to notes: pinning it would retain every turn since
    // and the rollover would free nothing.
    expect(range.shadowedSeqs).toContain(request)
  })

  it('yields to the budget when the open turn is the whole surface', async () => {
    const meter = await bareMeter()
    const session = Session.create(SessionId(`only-open-${Math.random().toString(36).slice(2, 8)}`))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `user: ${REQUEST}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    for (let step = 1; step <= 3; step += 1) {
      session.append('step/start', { turn: 1, step })
      session.append('assistant/message', {
        stream: [],
        turn: 1,
        step,
        message: createAssistantMessage({
          content: [{ type: 'text', text: `work ${step} ${'detail '.repeat(200)}` }],
          source: { provider: 'mock', model: 'mock' },
        }),
      }, { surfaceOp: 'append' })
      session.append('step/end', { turn: 1, step })
    }
    const request = humanSeq(session, REQUEST)
    const range = selectRolloverRange(session, meter.measure(session), 400)
    // There is nothing before the request to replace, so the pin has nothing to
    // protect with: honouring it would leave no span, and a session that can
    // never roll over is worse than one that rolled over and said so.
    expect(range).not.toBeNull()
    if (range === null || request === undefined) return
    expect(range.shadowedSeqs).toContain(request)
  })
})

describe('pinned active request, end to end', () => {
  /**
   * The same turn driven twice: a mid-turn pressure rollover whose surface
   * holds a request followed by more work than the tail budget covers.
   */
  async function run(label: string, pinActiveRequest: boolean): Promise<Session> {
    const { ctx, agent, session } = await engineHarness(label, {
      thresholdRatio: 0.5,
      reminderThresholdRatio: 0.4,
      // The band is not this case's subject; the forced rollover has to fire
      // the moment the reading crosses.
      lastChanceRatio: 0,
      retainTokens: 40,
      pinActiveRequest,
    })
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
      // Two seed turns, both well under the threshold.
      usageResponseWith(`answer seed one ${'detail '.repeat(400)}`, 30000, 5000),
      usageResponseWith(`answer seed two ${'detail '.repeat(400)}`, 30000, 5000),
      // The turn under test opens with a tool call that also anchors a reading
      // past the threshold, so the rollover happens at the *second* pre-step of
      // this same turn — after the request is on the surface and after work has
      // accumulated behind it.
      [
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        { type: 'tool-call-delta', index: 0, id: ToolCallId('c1'), name: 'get_context_remaining', argumentsDelta: '{}' },
        { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('c1'), name: 'get_context_remaining', arguments: '{}' } },
        { type: 'usage', usage: { inputTokens: 55000, outputTokens: 5000 } },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ],
      usageResponseWith(`answer final ${'detail '.repeat(400)}`, 60000, 5000),
    ]))

    await followup(agent, `seed one ${'context '.repeat(300)}`)
    await followup(agent, `seed two ${'context '.repeat(300)}`)
    await followup(agent, REQUEST)
    return session
  }

  it('keeps the human request in the fresh window', async () => {
    const session = await run('pin-on', true)
    expect(countRollovers(session)).toBe(1)
    expect(derivedTexts(session).join('\n')).toContain(REQUEST)
  })

  it('is the pin that keeps it: switching the pin off drops the same request', async () => {
    const session = await run('pin-off', false)
    expect(countRollovers(session)).toBe(1)
    // Same script, same thresholds, one config flag: the request leaves the
    // active context exactly as it did before the pin existed.
    expect(derivedTexts(session).join('\n')).not.toContain(REQUEST)
  })
})

/** A tool result whose call is retained while the result is not would corrupt the surface. */
function pairClosed(session: Session, span: readonly Seq[]): boolean {
  const shadowed = new Set(span)
  for (const seq of span) {
    const event = session.snapshotEvents().find(candidate => candidate.seq === seq)
    if (event?.type !== 'tool/result') continue
    const callId = event.data.message.source.kind === 'tool' ? event.data.message.source.callId : undefined
    if (callId === undefined) continue
    const call = session.surface.nodes.find((candidate) => {
      const owner = session.snapshotEvents().find(entry => entry.seq === candidate)
      return owner?.type === 'assistant/message'
        && owner.data.message.content.some(block => block.type === 'tool-call' && block.id === callId)
    })
    if (call !== undefined && !shadowed.has(call)) return false
  }
  return true
}

describe('pinned span integrity', () => {
  it('never separates a tool result from its call', async () => {
    const meter = await bareMeter()
    // The closed exchanges carry tool calls, so the pinned cut has to sit
    // outside a pair rather than through one.
    const session = closedConversation(2)
    appendExchange(session, 3, 'kept', true)
    session.append('turn/start', { turn: 4 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `user: ${REQUEST}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    for (let step = 1; step <= 2; step += 1) {
      session.append('step/start', { turn: 4, step })
      session.append('assistant/message', {
        stream: [],
        turn: 4,
        step,
        message: createAssistantMessage({
          content: [{ type: 'text', text: `work ${step} ${'detail '.repeat(200)}` }],
          source: { provider: 'mock', model: 'mock' },
        }),
      }, { surfaceOp: 'append' })
      session.append('step/end', { turn: 4, step })
    }
    const range = selectRolloverRange(session, meter.measure(session), 400)
    if (range === null) throw new Error('expected a pinned range')
    expect(pairClosed(session, range.shadowedSeqs)).toBe(true)
  })
})

describe('pinned active request, wiring', () => {
  it('defaults to on and can be switched off', async () => {
    const { resolveConfig } = await import('../src/config.ts')
    expect(resolveConfig({}).pinActiveRequest).toBe(true)
    expect(resolveConfig({ pinActiveRequest: false }).pinActiveRequest).toBe(false)
  })
})
