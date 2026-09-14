/**
 * Plugin localization.
 *
 * Two surfaces need language:
 *
 * - **Human-facing host text** — the `/rollover` command's description and its
 *   results, and the pressure reminder that lands in the transcript. These are
 *   read at call time from the same durable locale preference the browser UI
 *   uses (`settings` namespace `locale`, field `preference`), so switching the
 *   GUI language changes them without a restart.
 * - **Model-facing text** — tool descriptions, the `new_context` refusal, the
 *   guidance section, and the checkpoint body — deliberately stays English:
 *   it is prompt surface, and the guidance section in particular is part of
 *   the cached request prefix.
 *
 * The browser half carries its own copy of the vocabulary
 * (`src/client/index.cjs`), registered through the client locale service so
 * the shell re-renders it on a language switch.
 *
 * @module dsh-context-rollover/i18n
 */

import type { Context } from '@deepseek-ai/cordis'

/** Languages this plugin ships. Both are built into the browser client. */
export type PluginLocale = 'en' | 'zh'

/** Host-side language tables, keyed by the same strings in both languages. */
export const HOST_DICTIONARIES: Readonly<Record<PluginLocale, Readonly<Record<string, string>>>> = {
  en: {
    'command.description': 'Switch this session between rollover and standard compaction, or start a window now',
    'command.usage': 'Usage: /rollover [on|off|status|now]',
    'mode.name.rollover': 'rollover',
    'mode.name.compact': 'compact',
    'mode.rollover': 'Context management: rollover — this session starts a new window at {percent}% of its window '
      + '(deterministic checkpoint, no summary).',
    'mode.compact': 'Context management: compact — this session keeps its own compaction backend (a summary at that '
      + "backend's threshold); the rollover interceptor stands down. /rollover on switches it back.",
    'mode.notApplied': ' (Not applied: the session log already records {mode}.)',
    'manual.compactRefusal': 'This session is set to standard compaction; run /rollover on to use rollover first.',
    'manual.noHistory': 'No rollover-worthy history yet.',
    'manual.success': 'Started context window {window} with a checkpoint: {items} history items (~{tokens} tokens) '
      + 'left the active context. Nothing was summarized.',
    'manual.busy': 'Rollover is unavailable because a compaction is active, or the agent is not idle.',
    'manual.cancelled': 'Rollover cancelled.',
    'manual.failed': 'Rollover failed: {message}',
    'status.mode': 'mode',
    'status.rolloverAt': 'rollover at',
    'status.reminderAt': 'reminder at',
    'status.backend': 'backend',
    'status.intercepting': 'intercepting',
    'status.yes': 'yes',
    'status.no': 'no',
    'status.self': 'this plugin (no other backend mounted)',
    'reminder': 'Context window {percent}%: prompt used {used} / {window}, window left {left}, automatic rollover '
      + 'in {until}. At a task boundary, save notes and call new_context with a short handoff; otherwise '
      + 'checkpoint soon.',
  },
  zh: {
    'command.description': '在滚动归档与标准压缩之间切换本会话，或立即开一个新窗口',
    'command.usage': '用法：/rollover [on|off|status|now]',
    'mode.name.rollover': '滚动归档',
    'mode.name.compact': '标准压缩',
    'mode.rollover': '上下文管理：滚动归档 —— 本会话在窗口的 {percent}% 处开启新窗口（确定性检查点，不做摘要）。',
    'mode.compact': '上下文管理：标准压缩 —— 本会话交还自己的压缩后端（由后端在其阈值处摘要），滚动归档拦截器对它让位。'
      + '执行 /rollover on 可切回滚动归档。',
    'mode.notApplied': '（未生效：会话记录中已经是 {mode}。）',
    'manual.compactRefusal': '本会话当前是标准压缩；先执行 /rollover on 切回滚动归档。',
    'manual.noHistory': '还没有值得滚动归档的历史内容。',
    'manual.success': '已开启第 {window} 个上下文窗口并写入检查点：{items} 条历史（约 {tokens} Token）离开活动上下文，'
      + '未做任何摘要。',
    'manual.busy': '当前有压缩正在进行，或 agent 不处于空闲状态，暂时无法滚动归档。',
    'manual.cancelled': '滚动归档已取消。',
    'manual.failed': '滚动归档失败：{message}',
    'status.mode': '模式',
    'status.rolloverAt': '滚动归档阈值',
    'status.reminderAt': '提醒阈值',
    'status.backend': '后端',
    'status.intercepting': '是否拦截',
    'status.yes': '是',
    'status.no': '否',
    'status.self': '本插件（没有其它后端挂载）',
    'reminder': '上下文窗口 {percent}%：已用 {used} / {window}，剩余 {left}，距自动滚动归档 {until}。'
      + '到了阶段边界就保存笔记并用简短交接调用 new_context；否则尽快打检查点。',
  },
}

/** Fill `{name}` placeholders from a values map. */
function fill(template: string, values: Readonly<Record<string, string | number>> | undefined): string {
  if (values === undefined) return template
  return template.replace(/\{([a-z]+)\}/gu, (whole, name: string) => {
    const value = values[name]
    return value === undefined ? whole : String(value)
  })
}

/**
 * The language this deployment currently reads, from the durable locale the
 * browser UI uses. Unknown or absent preferences fall back to English, which
 * is also the plugin's source language.
 * @param ctx - host context; a composition without `settings` stays English.
 * @returns the language to render human-facing text in.
 */
export function pluginLocale(ctx: Context): PluginLocale {
  const settings = (ctx as unknown as { get(name: string): unknown }).get('settings') as
    | { get(ns: string): unknown }
    | undefined
  const preference = (settings?.get('locale') as { preference?: unknown } | undefined)?.preference
  return typeof preference === 'string' && preference.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/**
 * A translator for one host context.
 *
 * Resolved per call rather than captured, so a language change applies to the
 * next command or reminder without reloading the plugin.
 * @param ctx - host context that owns the locale preference lookup.
 * @returns `t(key, values?)`, falling back to English and then to the key.
 */
export function hostTranslator(ctx: Context): (
  key: string,
  values?: Readonly<Record<string, string | number>>,
) => string {
  return (key, values) => {
    const table = HOST_DICTIONARIES[pluginLocale(ctx)]
    const template = table[key] ?? HOST_DICTIONARIES.en[key] ?? key
    return fill(template, values)
  }
}
