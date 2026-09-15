/**
 * Tool rendering tests: every `notes` and `history` branch returns the stable
 * `{ action, text }` shape the renderer reads, verified through the actual DSH
 * tool runtime (execute + render), not only the underlying stores — so the
 * assertions cover the final model-visible content.
 *
 * @module tests/tools.spec
 */

import { describe, expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { CommandId } from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { countRollovers } from '../src/rollover.ts'
import {
  engineHarness,
  followup,
  ScriptedAdapter,
  seedExchanges,
  textResponse,
  usageResponseWith,
} from './harness.ts'

/** Execute one tool through the registry and require success. */
async function executeTool(
  ctx: Context,
  agent: Agent,
  name: string,
  args: Record<string, unknown>,
  callId: string,
) {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(callId),
    name,
    arguments: args,
    agent,
  })
  if (result.isError) throw new Error(`tool ${name} failed: ${JSON.stringify(result.content)}`)
  return result
}

/** The final model-visible text of a successful tool result. */
function renderedText(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content
    .map(block => block.type === 'text' ? block.text ?? '' : `[${block.type}]`)
    .join('\n')
}

describe('notes tool rendering', () => {
  it('renders write, append, read, and a non-empty list', async () => {
    const { ctx, agent } = await engineHarness('tools-notes-list')
    await executeTool(ctx, agent, 'notes', { action: 'write', path: 'state.md', text: 'goal: prove rendering' }, 'n1')
    await executeTool(ctx, agent, 'notes', { action: 'append', path: 'state.md', text: 'next: tests' }, 'n2')
    await executeTool(ctx, agent, 'notes', { action: 'write', path: 'plans/rollout.md', text: 'step 1' }, 'n3')

    const read = await executeTool(ctx, agent, 'notes', { action: 'read', path: 'state.md' }, 'n4')
    expect(renderedText(read)).toContain('goal: prove rendering')
    expect(renderedText(read)).toContain('next: tests')

    const list = await executeTool(ctx, agent, 'notes', { action: 'list' }, 'n5')
    const listText = renderedText(list)
    expect(listText).toContain('state.md')
    expect(listText).toContain('plans/rollout.md')
    expect(listText).not.toContain('undefined')
    expect(list.value).toMatchObject({ action: 'list' })
    expect((list.value as { text?: unknown }).text).toContain('state.md')
  })

  it('renders search hits', async () => {
    const { ctx, agent } = await engineHarness('tools-notes-search')
    await executeTool(ctx, agent, 'notes', { action: 'write', path: 'state.md', text: 'decided: no summary' }, 's1')

    const search = await executeTool(ctx, agent, 'notes', { action: 'search', query: 'SUMMARY' }, 's2')
    const searchText = renderedText(search)
    expect(searchText).toContain('state.md')
    expect(searchText).toContain('decided: no summary')
    expect(searchText).not.toContain('undefined')
  })
})

describe('history tool rendering', () => {
  it('renders search hits from earlier windows', async () => {
    const { ctx, engine, agent, session } = await engineHarness('tools-history-search')
    const adapter = new ScriptedAdapter(
      Array.from({ length: 30 }, (_unused, index) => textResponse(`background detail ${index}`)),
    )
    ctx.llm.registerAdapter(['mock'], adapter)

    await seedExchanges(agent, 20)
    await followup(agent, 'orchard harvest plan')
    const compacted = await engine.compactNow(agent, new AbortController().signal)
    expect(compacted).not.toBeNull()
    expect(countRollovers(session)).toBe(1)

    const search = await executeTool(ctx, agent, 'history', { action: 'search', query: 'research question 0' }, 'h1')
    const searchText = renderedText(search)
    expect(searchText).toContain('research question 0')
    expect(searchText).toContain('[seq ')
    expect(searchText).not.toContain('undefined')
  })

  it('renders a full read of a shadowed item', async () => {
    const { ctx, engine, agent } = await engineHarness('tools-history-read')
    const adapter = new ScriptedAdapter(
      Array.from({ length: 30 }, (_unused, index) => textResponse(`background detail ${index}`)),
    )
    ctx.llm.registerAdapter(['mock'], adapter)

    await seedExchanges(agent, 20)
    await followup(agent, 'orchard harvest plan')
    const compacted = await engine.compactNow(agent, new AbortController().signal)
    expect(compacted).not.toBeNull()

    const search = await executeTool(ctx, agent, 'history', { action: 'search', query: 'research question 1' }, 'h1')
    const seqMatch = /\[seq (\d+)\]/.exec(renderedText(search))
    if (seqMatch?.[1] === undefined) throw new Error('expected a history search hit with a seq')
    const read = await executeTool(ctx, agent, 'history', { action: 'read', seq: Number(seqMatch[1]) }, 'h2')
    const readText = renderedText(read)
    expect(readText).toContain('research question 1')
    expect(readText).toContain('[seq ')
    expect(readText).not.toContain('undefined')
    expect(read.value).toMatchObject({ action: 'read' })
  })
})

describe('countdown authority', () => {
  it('reports no automatic countdown where automatic rollover is not armed', async () => {
    const { ctx, agent, session } = await engineHarness('tools-countdown-off')
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([usageResponseWith('answer', 1000, 5)]))
    await followup(agent, 'a real measurement')

    // Standard compaction hands automation to the session's own backend, so
    // there is no boundary for this plugin's countdown to point at. Reporting
    // one would promise a rollover that never comes.
    const commandId = CommandId('tools-countdown-off')
    session.append('command/run', { commandId, name: 'rollover', args: 'off', source: { kind: 'user' } })
    session.append('command/done', { commandId, kind: 'success' })

    const result = await executeTool(ctx, agent, 'get_context_remaining', {}, 'cr-off')
    expect(result.value).toMatchObject({ rollover_tokens_left: null })
    const text = renderedText(result)
    expect(text).toContain('automatic rollover does not run')
    expect(text).not.toContain('rollover in')
    // The honest window reading is still reported.
    expect((result.value as { prompt_tokens: number }).prompt_tokens).toBeGreaterThan(0)
  })
})

describe('history argument bounds', () => {
  it('refuses impossible limits and counts the ellipsis against the bound', async () => {
    const { ctx, agent, session, engine } = await engineHarness('tools-argument-bounds', { retainTokens: 0 })
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([textResponse('answer')]))
    const marker = 'argument-bound-marker'
    await followup(agent, `${marker} ${'x'.repeat(8000)}`)
    await followup(agent, 'recent tail')
    const event = session.snapshotEvents()
      .find(item => item.type === 'user/message' && JSON.stringify(item.data).includes(marker))
    if (event === undefined) throw new Error('expected the seeded user message in the log')
    await engine.compactNow(agent, new AbortController().signal)

    const raw = (arguments_: Record<string, unknown>, callId: string) => ctx.tools.execute({
      agent,
      signal: new AbortController().signal,
      name: 'history',
      arguments: arguments_,
      callId: ToolCallId(callId),
    })

    // A negative bound is not a smaller bound: it is a request the tool cannot
    // honour, and answering it with a near-full read answered a different
    // question than the caller asked.
    const negative = await raw({ action: 'read', seq: event.seq, max_chars: -1 }, 'bounds-read')
    expect(negative.isError).toBe(true)
    expect(JSON.stringify(negative.content)).toContain('max_chars must be between')

    const fractional = await raw({ action: 'read', seq: event.seq, max_chars: 1.5 }, 'bounds-fraction')
    expect(fractional.isError).toBe(true)

    // A bound of zero means zero matches — not the one match the old
    // push-then-check order returned.
    const zero = await executeTool(
      ctx, agent, 'history', { action: 'search', query: marker, max_matches: 0 }, 'bounds-search',
    )
    expect(renderedText(zero)).toBe('No matches in history.')

    // The bound covers the whole returned text, the ellipsis included.
    const bounded = await executeTool(
      ctx, agent, 'history', { action: 'read', seq: event.seq, max_chars: 100 }, 'bounds-bounded',
    )
    const text = (bounded.value as { text: string }).text
    const body = text.slice(text.indexOf('\n') + 1)
    expect(body.length).toBeLessThanOrEqual(100)
    expect(body.endsWith('…')).toBe(true)
  })
})

describe('new_context honesty', () => {
  it('refuses a boundary when the active context has nothing to shadow', async () => {
    // A fresh session is all system head and one exchange: the retained tail
    // already covers every surface node, so no rollover could commit. Saying
    // "accepted" here would promise a window that never starts.
    const { ctx, agent } = await engineHarness('tools-new-context-minimal')
    const result = await executeTool(ctx, agent, 'new_context', {}, 'nc1')
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ accepted: false })
    expect(renderedText(result)).toContain('already minimal')
  })

  it('accepts a boundary once real conversation has accumulated', async () => {
    const { ctx, agent } = await engineHarness('tools-new-context-ready')
    const adapter = new ScriptedAdapter(
      Array.from({ length: 12 }, (_unused, index) => textResponse(`background detail ${index}`)),
    )
    ctx.llm.registerAdapter(['mock'], adapter)
    await seedExchanges(agent, 8)

    const result = await executeTool(ctx, agent, 'new_context', { handoff: 'carry on' }, 'nc2')
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ accepted: true })
    expect(renderedText(result)).toContain('without summarizing')
  })
})
