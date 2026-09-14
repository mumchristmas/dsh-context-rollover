/**
 * Tool discoverability: what the model is told about invoking
 * `get_context_remaining`.
 *
 * A live session showed the failure this guards against. Asked for
 * `get_context_remaining()`, the model searched the repository for the
 * function, then reported a fabricated reading — "initial context window has
 * full capacity available" — in a plan that claimed the tool had been
 * executed, while the session log showed no call at all.
 *
 * The plugin cannot force a model to invoke a tool, but it owns the two texts
 * that make the invocation unambiguous: the tool's own description, and the
 * guidance section. Both now say the tool takes no arguments, that a reading
 * comes from calling it, and that the state is not derivable from source.
 *
 * @module tests/tool-discovery
 */

import { describe, expect, it } from 'vitest'
import { CONTEXT_MANAGEMENT_GUIDANCE } from '../src/guidance.ts'
import { engineHarness } from './harness.ts'

/** The registered definition of one tool, as the model receives it. */
function toolDefinition(ctx: { tools: unknown }, name: string): { description?: string } {
  const registry = ctx.tools as {
    get?: (name: string) => { description?: string } | undefined
    list?: () => { name: string; description?: string }[]
  }
  const direct = registry.get?.(name)
  if (direct !== undefined) return direct
  return registry.list?.().find(tool => tool.name === name) ?? {}
}

describe('get_context_remaining discoverability', () => {
  it('describes the tool as a no-argument call whose reading must be fetched', async () => {
    const { ctx } = await engineHarness('tool-discovery', {})
    const definition = toolDefinition(ctx, 'get_context_remaining')
    const description = definition.description ?? ''

    expect(description).not.toBe('')
    expect(description).toMatch(/no arguments/i)
    // The failure mode was reasoning from the repository instead of calling.
    expect(description).toMatch(/call it/i)
    expect(description).toMatch(/not derivable/i)
  })

  it('tells the model in the guidance that the state is not readable from source', () => {
    expect(CONTEXT_MANAGEMENT_GUIDANCE).toMatch(/get_context_remaining is a tool you invoke/i)
    expect(CONTEXT_MANAGEMENT_GUIDANCE).toMatch(/no arguments/i)
    expect(CONTEXT_MANAGEMENT_GUIDANCE).toMatch(/not readable from repository files/i)
    // Fabricating a reading is called out explicitly, because a plausible
    // guess is exactly what the live session produced.
    expect(CONTEXT_MANAGEMENT_GUIDANCE).toMatch(/fabrication/i)
  })

  it('names the measured quantity for what it is, in the tool output', async () => {
    const { ctx } = await engineHarness('tool-wording', {})
    const definition = toolDefinition(ctx, 'get_context_remaining') as {
      description?: string
      output?: { render?: (args: unknown, value: unknown) => { text: string }[] }
    }
    const description = definition.description ?? ''
    // The description must not promise a "remaining" number without saying
    // remaining of what, and must not call the reading "used".
    expect(description).toMatch(/prompt tokens the next request will submit/i)
    expect(description).not.toMatch(/context used/i)

    const render = definition.output?.render
    expect(typeof render).toBe('function')
    const lines = render?.({}, {
      prompt_tokens: 15255,
      surface_tokens: 3100,
      context_window: 32000,
      prompt_tokens_left: 16745,
      rollover_tokens_left: 13545,
    }) ?? []
    const text = lines.map(line => line.text).join('\n')

    // A projection, said plainly, and never "used".
    expect(text).toMatch(/will submit about 15,255 prompt tokens/)
    expect(text).toMatch(/48% of the window/)
    expect(text).toMatch(/the active conversation accounts for about 3,100 tokens/)
    expect(text).toMatch(/Room left in the window: about 16,745 tokens/)
    expect(text).toMatch(/Automatic rollover in about 13,545 tokens/)
    expect(text).toMatch(/projection that moves with every turn, not a tally/)
    expect(text).not.toMatch(/Context used/i)
    expect(text).not.toMatch(/used_tokens/)

    // Unmeasured is stated as unmeasured, never as a number.
    const empty = (render?.({}, {
      prompt_tokens: null,
      surface_tokens: null,
      context_window: 32000,
      prompt_tokens_left: null,
      rollover_tokens_left: null,
    }) ?? []).map(line => line.text).join('\n')
    expect(empty).toMatch(/Not measured yet/)
    expect(empty).not.toMatch(/0 tokens/)
  })
})
