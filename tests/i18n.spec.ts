/**
 * Localization coverage: the shipped tables stay parallel, the active language
 * comes from the same durable preference the browser UI uses, and the
 * human-facing host text (command results, the pressure reminder) follows it —
 * while the model-facing text stays English by design.
 *
 * @module tests/i18n
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { CommandId } from '@deepseek-ai/dsh-commands'
import { SessionId } from '@deepseek-ai/dsh-session'
import { HOST_DICTIONARIES, hostTranslator, pluginLocale } from '../src/i18n.ts'
import { RolloverController } from '../src/index.ts'
import { MODEL, mountTestContext, tempNotesDir } from './harness.ts'

/**
 * A child context whose `settings` service answers the given durable locale
 * preference. The harness composes a real settings service, so the preference
 * is shadowed through an isolated realm rather than replaced.
 */
function withLocale(ctx: Context, preference: unknown): Context {
  const scoped = ctx.isolate('settings')
  ;(scoped as unknown as { provide(name: string, value: unknown): void }).provide('settings', {
    get: () => ({ preference }),
  })
  return scoped
}

describe('plugin localization', () => {
  it('ships the same key set in both languages', () => {
    expect(Object.keys(HOST_DICTIONARIES.zh).sort()).toEqual(Object.keys(HOST_DICTIONARIES.en).sort())
    expect(Object.keys(HOST_DICTIONARIES.en).length).toBeGreaterThan(10)
  })

  it('reads the durable locale preference and defaults to English', async () => {
    const english = await mountTestContext()
    // A bare settings service carries no locale section: English.
    ;(english as unknown as { provide(name: string, value: unknown): void }).provide('settings', {
      get: () => undefined,
    })
    expect(pluginLocale(withLocale(english, undefined))).toBe('en')
    expect(pluginLocale(withLocale(english, 'zh-CN'))).toBe('zh')
    expect(pluginLocale(withLocale(english, 'en'))).toBe('en')
    expect(pluginLocale(withLocale(english, 42))).toBe('en')
  })

  it('fills placeholders in the active language and falls back per key', async () => {
    const english = await mountTestContext()
    const ctx = withLocale(english, 'zh')
    const t = hostTranslator(ctx)
    expect(t('manual.success', { window: 2, items: 5, tokens: 120 })).toContain('第 2 个上下文窗口')
    expect(t('manual.success', { window: 2, items: 5, tokens: 120 })).toContain('5 条历史')
    expect(t('reminder', { percent: 61, used: 1, window: 2, left: 3, until: 4 })).toContain('上下文窗口 61%')
    expect(t('no.such.key')).toBe('no.such.key')
    expect(hostTranslator(withLocale(english, 'en'))('status.mode')).toBe('mode')
  })

  it('answers /rollover status in the active language', async () => {
    const ctx = withLocale(await mountTestContext(), 'zh')
    const registered = new Map<string, CommandDefinition>()
    ;(ctx as unknown as { provide(name: string, value: unknown): void }).provide('commands', {
      register: (definition: CommandDefinition) => {
        registered.set(definition.name, definition)
        return () => { registered.delete(definition.name) }
      },
    })
    new RolloverController(ctx, { notesDir: await tempNotesDir() })
    const definition = registered.get('rollover')
    if (definition === undefined) throw new Error('no /rollover registration')

    // The description is localized at registration time...
    expect(definition.description).toContain('滚动归档')
    // ...and results are localized per call.
    const agent = await ctx.agentLoop.create(SessionId('i18n-status'), { provider: MODEL, model: MODEL })
    const status = await definition.handler({
      commandId: CommandId('i18n-1'),
      agent,
      rawInput: ' status',
      attachments: [],
      signal: new AbortController().signal,
    })
    expect(status.kind).toBe('success')
    expect(String(status.text)).toContain('模式: 滚动归档')
    expect(String(status.text)).toContain('是否拦截: 是')
  })
})
