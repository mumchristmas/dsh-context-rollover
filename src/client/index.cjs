/**
 * Browser half of the plugin: the session-page mode button.
 *
 * One icon button that sits tight after the session's native stat pills, in
 * their row under the composer. The icon *is* the state: the Lucide recycle
 * mark means this session rolls over, the Lucide square-split-vertical mark
 * means it uses its own compaction backend. Clicking toggles the mode, so
 * there is no separate switch chrome to explain.
 *
 * The button reads the mode from the session projection the host half
 * registers and writes it by running the existing `/rollover on|off` command
 * through the client's command remote. That command's own durable
 * `command/run` record *is* the selection, so the UI adds no second source of
 * truth — a reload, fork, or resume sees the same value.
 *
 * Geometry is deliberately the native pill's: the same 22px box (a 20px text
 * line plus a 1px pill padding), the same 8px side padding, corner radius and
 * hover affordance, and a 16px glyph so a 24-unit Lucide mark carries the same
 * visual weight as the platform's 16-unit icons. The slot renders into the
 * composer column (`InputBar .root`), whose stats row is a centered box of
 * `--dsh-chat-content-width`: this entry mirrors that box exactly, pulls
 * itself onto the row's line, and measures the last stat pill so the button
 * lands one pill-gap after it instead of at the box edge.
 *
 * Authored as CommonJS because the artifact runs inside the shell's loader
 * factory, which hands the bundle a `require` bound to the browser module
 * table: `react` is the only external this file uses. That makes the "build" a
 * wrapper, not a bundler — see `scripts/build-client.mjs`.
 *
 * @module dsh-context-rollover/client
 */

const { createElement, useEffect, useLayoutEffect, useRef, useState } = require('react')

/** Projection key the host half publishes the per-session mode under. */
const MODE_PROJECTION_KEY = 'contextRolloverMode'

/** Slot the button occupies: the row under the composer, with the stats. */
const SLOT = 'conversation.composer.dock'

/** Settings namespace the host half registers; the card's join key. */
const SETTINGS_NS = 'context-rollover'

/** Slot the settings card occupies (`settings.plugin.item`, keyed by namespace). */
const SETTINGS_SLOT = 'settings.plugin.item'

/** Host route carrying what is known about the surrounding compaction backends. */
const BACKEND_ROUTE = '/context-rollover/backends'

/** Stylesheet tag id; also the class prefix below. */
const STYLE_ID = 'dsh-context-rollover-mode'

/** Locale namespace this half registers its dictionaries under. */
const LOCALE_NS = 'context-rollover'

/**
 * Browser-side vocabulary, registered through the client locale service so the
 * shell hands every contribution a `t` bound to this namespace and re-renders
 * it on a language switch. Both languages ship here; a deployment with a
 * different active language falls back to English per key.
 */
const DICTS = {
  en: {
    'switch.label': 'Context Rollover',
    'aria.rollover': 'Context management: rollover',
    'aria.compact': 'Context management: standard compaction',
    'tip.rollover': 'Rollover: this session starts a new window with a deterministic checkpoint before its '
      + 'compaction backend reaches its threshold. Click for standard compaction.',
    'tip.compact': 'Standard compaction: this session keeps its own compaction backend and summarises. '
      + 'Click to intercept it with a rollover.',
    'mode.failed': 'Mode not changed:',
    'card.title': 'Context Rollover',
    'card.expand': 'Expand',
    'card.collapse': 'Collapse',
    'card.intro': 'Automatic rollover happens at the threshold below. It must stay strictly under the threshold of '
      + "the session's own compaction backend, or that backend summarises first.",
    'card.thresholdRatio': 'Rollover threshold (%)',
    'card.thresholdRatio.hint': 'At this share of the window the session rolls over: a new window, a checkpoint, and '
      + 'the recent tail, with no summary. Keep it strictly below the compaction backend\'s threshold, or that backend '
      + 'summarises first.',
    'card.reminderThresholdRatio': 'Reminder threshold (%)',
    'card.reminderThresholdRatio.hint': 'At this share the model is reminded, once per window, that the window is '
      + 'filling up. How the span between this point and the rollover threshold is used is the model\'s own call: '
      + 'notes, a handoff through new_context, or simply carrying on.',
    'card.retainTokens': 'Retained tail (tokens)',
    'card.retainTokens.hint': 'Recent conversation kept verbatim across a rollover, counted in tokens. Empty keeps '
      + "the deployment's default, which is a share of the window.",
    'card.retainTokens.unset': 'share of window',
    'card.lastChanceRatio': 'Last chance from (%)',
    'card.lastChanceRatio.hint': 'The final stretch before the rollover, measured as a share of the window. On '
      + 'entering it the model is told once that this is its last chance and how much growth is left, so it stops '
      + 'and writes notes instead of being cut off mid-task. The rollover still fires at the threshold above. '
      + '0 switches the notice off, which is how every release before this one behaved.',
    'card.pinActiveRequest': 'Keep the active request',
    'card.pinActiveRequest.hint': 'On, a rollover never drops the human message that started the open turn, even '
      + 'when a long turn has pushed it past the retained-tail budget. It costs rollover room in exchange.',
    'card.invalid.lastChance': 'The last chance cannot start before the window does: its width {lastChance}% must '
      + 'not exceed the rollover threshold {threshold}%.',
    'card.handoffMaxChars': 'Handoff limit (characters)',
    'card.handoffMaxChars.hint': 'Largest handoff a model may attach to new_context. Counted in characters, not '
      + 'tokens.',
    'card.preempt': 'Intercept compaction',
    'card.preempt.hint': 'Off hands every automatic path back to the session\'s own backend.',
    'card.notesEnabled': 'Notes tool',
    'card.notesEnabled.hint': 'Off removes notes from the model\'s surface: no working memory to carry across '
      + 'a rollover.',
    'card.historyEnabled': 'History tool',
    'card.historyEnabled.hint': 'Off removes history, so a window that has already rolled over can no longer be '
      + 'searched or read back.',
    'card.reset': 'Reset',
    'card.resetAll': 'Reset all to deployment values',
    'card.info': 'About this setting',
    'card.on': 'On',
    'card.off': 'Off',
    'card.unset': 'unset',
    'card.advanced': 'Advanced',
    'card.advanced.hint': 'Guardrails and tool toggles; the defaults suit most sessions.',
    'card.invalid.reminder': 'The reminder threshold must stay below the rollover threshold: {reminder} is not below '
      + '{threshold}.',
    'card.overridden': 'set here',
    'card.writeFailed': 'The change was not saved.',
    'card.system': 'Compaction backend',
    'card.system.loading': 'reading…',
    'card.system.none': 'none observed yet — the value below is the stock default',
    'card.system.presets': 'Presets mounting one',
    'card.system.safeBelow': 'Strictest threshold seen among the backends above: keep the rollover threshold below {safe}',
    'card.system.stock': 'stock default {stock}',
    'card.warn.threshold': 'Rollover threshold {current} is not below {safe}, the strictest threshold observed among '
      + 'the surrounding backends: one of them will summarise first. Lower this value or raise that backend\'s.',
    'card.warn.preemptOff': 'Interception is off: every session keeps its own compaction backend.',
    'card.unavailable': 'Settings are not writable in this deployment.',
  },
  zh: {
    'switch.label': 'Context Rollover',
    'aria.rollover': '上下文管理模式：滚动归档',
    'aria.compact': '上下文管理模式：标准压缩',
    'tip.rollover': '滚动归档：到阈值时开新窗口，用检查点 + 最近原文替代摘要。点击切换为标准压缩。',
    'tip.compact': '标准压缩（Compact）：由本会话自己的压缩器在它的阈值处摘要。点击切换为滚动归档。',
    'mode.failed': '模式未切换：',
    'card.title': 'Context Rollover',
    'card.expand': '展开',
    'card.collapse': '收起',
    'card.intro': '到下面的阈值就自动换窗口。它必须严格小于本会话压缩后端的阈值，否则后端会先做摘要。',
    'card.thresholdRatio': '滚动归档阈值（%）',
    'card.thresholdRatio.hint': '窗口用到该比例时自动换窗：开新窗口、写检查点、保留最近原文，不做摘要。'
      + '该值须严格低于本会话压缩后端的阈值（实测值见下方「压缩后端」）。',
    'card.reminderThresholdRatio': '提醒阈值（%）',
    'card.reminderThresholdRatio.hint': '窗口用到该比例时向模型提醒一次（每个窗口一次）：提示它窗口接近上限。'
      + '从该比例到滚动归档阈值之间的区间由模型自行判断如何使用，例如写笔记、用 new_context 交接，或继续当前工作。',
    'card.retainTokens': '保留最近对话（Token）',
    'card.retainTokens.hint': '换窗后原样保留的最近对话，按 Token 计。留空表示沿用部署默认值（窗口的 10%）。',
    'card.retainTokens.unset': '按窗口比例',
    'card.lastChanceRatio': '最后机会起始（%）',
    'card.lastChanceRatio.hint': '换窗之前的最后一段，按窗口比例计。进入这一段时模型会收到一次提醒：这是最后机会、还能增长多少，'
      + '于是它可以停下来写笔记，而不是在干活的中途被切断。换窗仍然发生在上面的阈值处。填 0 表示不发这条提醒，'
      + '也就是此前所有版本的行为。',
    'card.pinActiveRequest': '保底保留当前请求',
    'card.pinActiveRequest.hint': '开启后，换窗永远不会丢掉开启当前回合的那条人类消息，即使长回合已经把它挤出'
      + '保留区。代价是单次换窗腾出的空间更少。',
    'card.invalid.lastChance': '最后机会不能从窗口开始处就生效：它的宽度 {lastChance}% 不能超过滚动归档阈值 {threshold}%。',
    'card.handoffMaxChars': '交接文本上限（字符数）',
    'card.handoffMaxChars.hint': '模型调用 new_context 时允许附带的交接文本上限，按字符数计（不是 Token）。',
    'card.preempt': '拦截压缩',
    'card.preempt.hint': '关闭后，自动压缩全部交还本会话自己的后端。',
    'card.notesEnabled': '笔记工具',
    'card.notesEnabled.hint': '关闭后 notes 会从模型的工具面移除：换窗时不再有可携带的工作记忆。',
    'card.historyEnabled': '历史工具',
    'card.historyEnabled.hint': '关闭后 history 会从模型的工具面移除：已换出的窗口将无法再搜索或读回。',
    'card.reset': '重置',
    'card.resetAll': '全部恢复部署默认值',
    'card.info': '关于此项设置',
    'card.on': '开',
    'card.off': '关',
    'card.unset': '未设置',
    'card.advanced': '高级',
    'card.advanced.hint': '护栏与工具开关；默认值适合多数会话。',
    'card.invalid.reminder': '提醒阈值必须低于滚动归档阈值：{reminder} 不低于 {threshold}。',
    'card.overridden': '已自定义',
    'card.writeFailed': '改动没有保存成功。',
    'card.system': '压缩后端',
    'card.system.loading': '读取中…',
    'card.system.none': '尚未观测到 —— 下面的数值是出厂默认',
    'card.system.presets': '挂载了压缩器的预设',
    'card.system.safeBelow': '上方后端中已观测到的最严格阈值：滚动归档阈值需低于 {safe}',
    'card.system.stock': '出厂默认 {stock}',
    'card.warn.threshold': '滚动归档阈值 {current} 不低于已观测到的后端最严格阈值 {safe}：其中之一会先做摘要。请调低本值或调高该后端阈值。',
    'card.warn.preemptOff': '拦截已关闭：每个会话都用自己后端的压缩策略。',
    'card.unavailable': '该部署下设置不可写。',
  },
}

/** Fill `{name}` placeholders from a values map. */
function fill(template, values) {
  if (values === undefined) return template
  return template.replace(/\{([a-z]+)\}/gu, (whole, name) => {
    const value = values[name]
    return value === undefined ? whole : String(value)
  })
}

/**
 * Translator for a shell that did not hand one to the contribution (no locale
 * service, or a host without the namespace): the document language decides,
 * then English per key.
 * @returns a `t(key, values?)` bound to the browser's current language.
 */
function fallbackTranslate() {
  const lang = (typeof document !== 'undefined' && document.documentElement !== undefined
    ? document.documentElement.lang
    : undefined)
    ?? (typeof navigator !== 'undefined' ? navigator.language : undefined)
    ?? 'en'
  const table = String(lang).toLowerCase().startsWith('zh') ? DICTS.zh : DICTS.en
  const translate = (key, values) => {
    const template = table[key] ?? DICTS.en[key] ?? key
    return typeof template === 'string' ? fill(template, values) : template
  }
  return translate
}

/**
 * Translate one key through the shell, falling back to this half's own table.
 *
 * The shell binds `t` to the entry's locale namespace, but a dictionary that
 * registered after the entry was created can leave that reader without a
 * single key — a card of raw keys is worse than a card in the fallback
 * language, so a shell answer equal to the key is treated as a miss.
 * @param t - the shell's reader, when one was handed to the contribution.
 * @param key - dictionary key.
 * @param values - optional placeholder values.
 * @returns the localized text.
 */
function translate(t, key, values) {
  const viaShell = typeof t === 'function' ? t(key, values) : undefined
  if (typeof viaShell === 'string' && viaShell !== '' && viaShell !== key) return viaShell
  return fallbackTranslate()(key, values)
}

/** Gap between the native stat pills, reused so this one joins their group. */
const PILL_GAP = 12

/** Services the client half needs before it applies. */
const inject = ['slots']

/** Cordis plugin name for the browser half. */
const name = 'context-rollover/client'

/**
 * The button's styles. Everything expressible without measurement is CSS; the
 * tight adjacency and the row-line alignment are measured inline.
 */
const CSS = `
/* Mirror the stats row's own box (ui-chat StatsPills .root): the same content
   width, centered the same way — that is what makes the measured offset land
   in the stats row instead of at the viewport edge. */
.dsh-context-rollover-mode {
  display: flex;
  justify-content: flex-end;
  width: 100%;
  max-width: var(--dsh-chat-content-width);
  margin: 0 auto;
  box-sizing: border-box;
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
}
/* This entry spans the whole stats band to position one pill at its right end,
   so the empty part of it must stay click-through: the native stat pills sit
   underneath and own their own clicks. Only the button opts back in. */
.dsh-context-rollover-mode { pointer-events: none; }
.dsh-context-rollover-mode > button { pointer-events: auto; }
/* The native stat pill's box: 1px padding + a 20px (+ text-tier delta) line. */
.dsh-context-rollover-mode > button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  box-sizing: border-box;
  height: calc(22px + var(--dsh-content-font-delta-secondary, 0px));
  padding: 1px 8px;
  border: none;
  border-radius: 24px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  line-height: inherit;
  white-space: nowrap;
  cursor: pointer;
}
.dsh-context-rollover-mode > button:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
.dsh-context-rollover-mode svg { width: 16px; height: 16px; flex: none; }
/* The failure line sits beside the pill: this dock is icon-only, so a refused
   mode change has nowhere else to show up. */
.dsh-context-rollover-mode > .dsh-mode-error {
  pointer-events: auto;
  align-self: center;
  margin-right: 8px;
  font-size: 12px;
  color: var(--dsw-alias-label-error, #d33);
}
.dsh-context-rollover-mode > button[disabled] { opacity: 0.5; cursor: default; }
.dsh-context-rollover-mode > button[disabled]:hover { background: transparent; }
/* Settings card. The section renders a registered card bare, so this half owns
   its chrome — reproduced from the section's own PluginCard look, whose CSS a
   plugin may not import. */
.dsh-context-rollover-card {
  list-style: none;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: 16px;
  background: var(--dsw-alias-bg-layer-3);
  transition: border-color .16s, background .16s;
}
.dsh-context-rollover-card:hover { border-color: var(--dsw-alias-label-dimmed); }
.dsh-context-rollover-card.dsh-open {
  background: var(--dsw-alias-bg-layer-2);
  border-color: var(--dsw-alias-label-dimmed);
}
.dsh-context-rollover-card > button.dsh-head {
  width: 100%; appearance: none; border: 0; background: none; font: inherit; color: inherit;
  text-align: left; cursor: pointer; display: flex; align-items: center; gap: 12px;
  padding: 14px 16px; border-radius: 12px;
}
.dsh-context-rollover-card > button.dsh-head:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px;
}
.dsh-context-rollover-card .dsh-head-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.dsh-context-rollover-card .dsh-name {
  font-size: 15px; font-weight: 600; line-height: 1.4; color: var(--dsw-alias-label-primary);
}
.dsh-context-rollover-card .dsh-description {
  font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-tertiary);
}
.dsh-context-rollover-card .dsh-chevron { flex: none; color: var(--dsw-alias-label-tertiary); transition: transform .16s; }
.dsh-context-rollover-card.dsh-open .dsh-chevron { transform: rotate(180deg); }
.dsh-context-rollover-card .dsh-body {
  border-top: 0.5px solid var(--dsw-alias-border-l2); margin: 0 16px; padding-bottom: 8px;
}
.dsh-context-rollover-card .dsh-grid {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 4px 24px; padding: 4px 0 8px;
}
.dsh-context-rollover-card .dsh-field { display: flex; flex-direction: column; gap: 6px; padding: 10px 0; min-width: 0; }
.dsh-context-rollover-card .dsh-field-head { display: flex; align-items: center; gap: 6px; }
.dsh-context-rollover-card .dsh-label {
  min-width: 0; font-size: 13px; font-weight: 500; line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.dsh-context-rollover-card .dsh-info {
  flex: none; width: 15px; height: 15px; padding: 0; border-radius: 50%;
  border: 1px solid var(--dsw-alias-border-l4); background: none; cursor: help;
  font-size: 10px; font-style: italic; font-family: Georgia, serif; line-height: 13px;
  color: var(--dsw-alias-label-tertiary); text-align: center;
}
.dsh-context-rollover-card .dsh-info:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-label-dimmed); }
.dsh-context-rollover-card .dsh-info-wrap { position: relative; display: inline-flex; flex: none; }
.dsh-context-rollover-card .dsh-tip {
  position: absolute; left: -4px; bottom: calc(100% + 8px); z-index: 30;
  width: max-content; max-width: 280px; box-sizing: border-box;
  padding: 8px 10px; border-radius: 8px; border: 0.5px solid var(--dsw-alias-border-l4);
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary);
  font-size: 12px; font-weight: 400; line-height: 1.5; text-align: left;
  box-shadow: 0 6px 20px rgb(0 0 0 / 14%);
  opacity: 0; visibility: hidden; transition: opacity .12s ease; pointer-events: none;
}
.dsh-context-rollover-card .dsh-info-wrap:hover .dsh-tip,
.dsh-context-rollover-card .dsh-info-wrap:focus-within .dsh-tip { opacity: 1; visibility: visible; }
.dsh-context-rollover-card .dsh-over { margin-left: auto; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.dsh-context-rollover-card .dsh-toggle { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--dsw-alias-label-secondary); }
.dsh-context-rollover-card .dsh-reset-all-row { display: flex; justify-content: flex-end; padding-top: 8px; }
.dsh-context-rollover-card .dsh-advanced {
  display: block; width: 100%; margin: 4px 0 0; padding: 8px 0 0; text-align: left;
  border: 0; border-top: 0.5px solid var(--dsw-alias-border-l2); background: none;
  font: inherit; font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-secondary); cursor: pointer;
}
.dsh-context-rollover-card .dsh-advanced:hover { color: var(--dsw-alias-label-primary); }
.dsh-context-rollover-card button.dsh-reset {
  border: 0; background: none; padding: 0; font: inherit; font-size: 12px; line-height: 1.5;
  color: var(--dsw-alias-label-secondary); cursor: pointer;
}
.dsh-context-rollover-card button.dsh-reset:hover { color: var(--dsw-alias-label-primary); }
.dsh-context-rollover-card input[type='number'] {
  width: 120px; height: 34px; box-sizing: border-box; padding: 0 12px;
  border: 0.5px solid var(--dsw-alias-border-l4); border-radius: 8px;
  background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary); font: inherit;
}
.dsh-context-rollover-card input[type='checkbox'] { width: 16px; height: 16px; accent-color: var(--dsw-alias-brand-primary); }
.dsh-context-rollover-card .dsh-hint { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.dsh-context-rollover-card .dsh-system {
  display: flex; flex-direction: column; gap: 4px; padding: 12px 0;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}
.dsh-context-rollover-card .dsh-system > strong { font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.dsh-context-rollover-card .dsh-warn { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-error, #d33); }
`

/** Inject the button's stylesheet once per document. */
function ensureStyles() {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-context-rollover'
  tag.dataset.pluginCss = STYLE_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
}

/**
 * How far to pull this entry up so its pill shares the stats row's line: the
 * row owns a 4px top padding above a 22px pill box, so one pill box height of
 * pull-back lands the two boxes on each other.
 */
const ROW_LINE_PULL = 'calc(-1 * (22px + var(--dsh-content-font-delta-secondary, 0px)))'

/** Shared SVG attributes for both icons (24-unit Lucide geometry, 16px box). */
const ICON = {
  viewBox: '0 0 24 24',
  width: 16,
  height: 16,
  'aria-hidden': true,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2.25,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
}

/**
 * Rollover: the recycling mark (Lucide `recycle`) — the same material, a new
 * cycle. This session crosses into a fresh window instead of being summarised.
 */
function RolloverIcon() {
  return createElement('svg', ICON,
    createElement('path', { d: 'M7 19H4.815a1.83 1.83 0 0 1-1.57-.881 1.785 1.785 0 0 1-.004-1.784L7.196 9.5' }),
    createElement('path', { d: 'M11 19h8.203a1.83 1.83 0 0 0 1.556-.89 1.784 1.784 0 0 0 0-1.775l-1.226-2.12' }),
    createElement('path', { d: 'm14 16-3 3 3 3' }),
    createElement('path', { d: 'M8.293 13.596 7.196 9.5 3.1 10.598' }),
    createElement('path', { d: 'm9.344 5.811 1.093-1.892A1.83 1.83 0 0 1 11.985 3a1.784 1.784 0 0 1 1.546.888l3.943 6.843' }),
    createElement('path', { d: 'm13.378 9.633 4.096 1.098 1.097-4.096' }),
  )
}

/**
 * Standard compaction: Lucide `square-split-vertical` — a box held apart, the
 * session's own backend summarising history in place.
 */
function CompactIcon() {
  return createElement('svg', ICON,
    createElement('path', { d: 'M5 8V5c0-1 1-2 2-2h10c1 0 2 1 2 2v3' }),
    createElement('path', { d: 'M19 16v3c0 1-1 2-2 2H7c-1 0-2-1-2-2v-3' }),
    createElement('line', { x1: 4, x2: 20, y1: 12, y2: 12 }),
  )
}

/**
 * Measure the right padding that puts the button one pill-gap after the last
 * native stat pill: this entry and the stats row share the same centered box,
 * so their right edges coincide and the offset is entirely padding.
 * @param ref - ref to this entry's root element.
 * @returns the padding in px, or undefined while it cannot be measured.
 */
function useAdjacentPadding(ref) {
  const [paddingRight, setPaddingRight] = useState(undefined)
  useLayoutEffect(() => {
    const entry = ref.current
    const row = typeof document === 'undefined' ? null : document.querySelector('[data-composer-stats]')
    if (entry === null || entry === undefined || row === null) return undefined
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => { measure() })
    // Re-measured on resize and on any stat pill geometry change, because the
    // numbers in those pills grow and shift the row's centre.
    function measure() {
      const button = entry.firstElementChild
      if (button === null) return
      const last = row.lastElementChild
      const anchorRight = (last === null ? row : last).getBoundingClientRect().right
      const buttonWidth = button.getBoundingClientRect().width
      const boxRight = entry.getBoundingClientRect().right
      setPaddingRight(Math.max(0, Math.round(boxRight - anchorRight - PILL_GAP - buttonWidth)))
      if (observer !== null) {
        observer.observe(row)
        for (const child of row.children) observer.observe(child)
      }
    }
    measure()
    if (typeof window !== 'undefined') window.addEventListener('resize', measure)
    return () => {
      if (observer !== null) observer.disconnect()
      if (typeof window !== 'undefined') window.removeEventListener('resize', measure)
    }
  }, [])
  return paddingRight
}

/**
 * The mode button. Renders nothing until the projection answers, so a host
 * half without the projection (or a session the host has not seen) shows no
 * control instead of a lying one.
 * @param props - session-slot props plus this registration's inject face.
 * @returns the icon button, or null while the mode is unknown.
 */
function RolloverModeButton(props) {
  const mode = typeof props.useProjection === 'function'
    ? props.useProjection(MODE_PROJECTION_KEY)
    : undefined
  const ref = useRef(null)
  const paddingRight = useAdjacentPadding(ref)
  /** Synchronous latch: `pending` state alone is batched and can read stale. */
  const inFlight = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(undefined)
  const t = typeof props.t === 'function' ? props.t : fallbackTranslate()
  if (mode !== 'rollover' && mode !== 'compact') return null
  const rollover = mode === 'rollover'
  ensureStyles()
  const hasStatsRow = typeof document !== 'undefined'
    && document.querySelector('[data-composer-stats]') !== null
  const style = {
    ...(paddingRight === undefined ? {} : { paddingRight: `${paddingRight}px` }),
    ...(hasStatsRow ? { marginTop: ROW_LINE_PULL } : {}),
  }
  /**
   * Ask for the other mode and report what came back.
   *
   * The command executor resolves with `{ ok: false }` for an ordinary Host
   * refusal and for an offline carrier, so a resolved promise is not a changed
   * mode: ignoring the result would leave the button silently unchanged with
   * no hint that nothing happened. The projection stays the source of truth —
   * no optimistic flip — and the button is held while the request is in
   * flight so one impatient double-click cannot queue two opposite changes.
   */
  const request = next => {
    // The ref is the authoritative latch: React may batch the state update, so
    // two clicks in one tick would both read a stale `pending`.
    if (inFlight.current || typeof props.setMode !== 'function') return
    inFlight.current = true
    setPending(true)
    setError(undefined)
    const finish = () => {
      inFlight.current = false
      setPending(false)
    }
    Promise.resolve(props.setMode(next)).then(
      outcome => {
        finish()
        if (outcome === undefined || outcome === null || outcome.ok !== false) return
        setError(outcome.detail === undefined
          ? t('mode.failed')
          : `${t('mode.failed')} ${outcome.detail}`)
      },
      failure => {
        finish()
        setError(`${t('mode.failed')} ${failure instanceof Error ? failure.message : String(failure)}`)
      },
    )
  }
  const children = []
  if (error !== undefined) {
    children.push(createElement('span', {
      key: 'error',
      className: 'dsh-mode-error',
      role: 'status',
    }, error))
  }
  children.push(createElement('button', {
    key: 'mode',
    type: 'button',
    'data-context-rollover-mode': mode,
    'data-context-rollover-pending': pending ? '' : undefined,
    disabled: pending,
    'aria-pressed': rollover,
    'aria-label': t(rollover ? 'aria.rollover' : 'aria.compact'),
    title: error ?? t(rollover ? 'tip.rollover' : 'tip.compact'),
    onClick: () => request(!rollover),
  }, rollover ? RolloverIcon() : CompactIcon()))
  return createElement('div', { className: 'dsh-context-rollover-mode', ref, style }, ...children)
}


/**
 * The settings a session's owner actually tunes: where the window rolls over,
 * when they are warned, how much recent conversation survives it, and whether
 * the plugin takes over compaction at all. Everything else is a guardrail or a
 * tool mount, and lives under {@link ADVANCED_FIELDS}.
 */
const CARD_FIELDS = [
  { key: 'thresholdRatio', kind: 'percent', step: 1 },
  { key: 'lastChanceRatio', kind: 'percent', step: 1 },
  { key: 'reminderThresholdRatio', kind: 'percent', step: 1 },
  { key: 'retainTokens', kind: 'number', min: 0, placeholderKey: 'card.retainTokens.unset' },
  { key: 'preempt', kind: 'boolean' },
]

/**
 * Guardrails and policy knobs a session's owner rarely touches. The retention
 * *percentage* stays out of the card on purpose: two retention controls that
 * override each other read as a trap, and the percentage is what the
 * deployment keeps as its default.
 */
const ADVANCED_FIELDS = [
  // The two tool switches live here rather than out of reach: the engine mounts
  // and unmounts these tools as the values change, so a user who turns one off
  // must be able to turn it back on from the same card.
  { key: 'notesEnabled', kind: 'boolean' },
  { key: 'historyEnabled', kind: 'boolean' },
  { key: 'pinActiveRequest', kind: 'boolean' },
  { key: 'handoffMaxChars', kind: 'number', min: 1 },
]

/** Read one field's effective value from a scope snapshot. */
function fieldValue(snapshot, key) {
  const value = (snapshot.value ?? {})[key]
  return value === undefined ? (snapshot.base ?? {})[key] : value
}

/** Whether the user layer owns this field (presence, not value, marks it). */
function fieldOverridden(snapshot, key) {
  return Object.prototype.hasOwnProperty.call(snapshot.user ?? {}, key)
}

/** The stock backend threshold the card assumes until it hears otherwise. */
const STOCK_THRESHOLD = 0.8

/**
 * Render a ratio the way the controls above it do — the cards edit percentages,
 * so a guidance line quoting `0.8` next to an input reading `80` is the kind of
 * unit mix-up the guidance exists to prevent.
 * @param ratio - fraction in `(0, 1]`.
 * @returns the percentage as text.
 */
function asPercent(ratio) {
  return `${Math.round(ratio * 100)}%`
}

/**
 * Subscribe to settings-scope snapshots.
 * @param scope - the bound settings scope.
 * @returns the current snapshot, refreshed on every change.
 */
function useScopeSnapshot(scope) {
  const [snapshot, setSnapshot] = useState(() => scope.getSnapshot())
  useEffect(() => {
    setSnapshot(scope.getSnapshot())
    return scope.subscribe(() => setSnapshot(scope.getSnapshot()))
  }, [])
  return snapshot
}

/**
 * Last report this page received. Cached so a remount (switching settings
 * tabs) shows the known thresholds immediately instead of flashing the
 * loading line again.
 */
let cachedBackendReport

/**
 * Read what the host knows about the surrounding compaction backends.
 * @returns the report once it arrives, or undefined while loading/failed.
 */
function useBackendReport() {
  const [report, setReport] = useState(() => cachedBackendReport)
  useEffect(() => {
    let alive = true
    if (typeof fetch !== 'function') return undefined
    fetch(BACKEND_ROUTE, { headers: { accept: 'application/json' } })
      .then(response => response.ok ? response.json() : undefined)
      .then(value => {
        if (value === undefined) return
        cachedBackendReport = value
        if (alive) setReport(value)
      })
      .catch(() => undefined)
    return () => { alive = false }
  }, [])
  return report
}

/**
 * Report the outcome of one settings-scope write.
 *
 * `SettingsScope` declares `set()` and `unset()` as `Promise<void>`, and it
 * keeps that promise even when the Host refuses: its own `mutate` sees the
 * `{ ok: false }` envelope, runs the recovery read, and returns normally. A
 * refusal therefore never reaches this card as a value, and a fulfilled
 * promise is not evidence that anything was stored — reading a result object
 * here would be dead code.
 *
 * The settled snapshot is the only evidence the card has, so `confirm` decides.
 * `report` receives `undefined` when the write landed: a failure line that only
 * ever gets written is a line that outlives the failure it describes, which is
 * what a later successful write has to clear.
 * @param pending - whatever the scope mutation returned.
 * @param report - receives the message to show, or undefined to clear the line.
 * @param message - the already-localized failure text.
 * @param confirm - reads the settled snapshot; returns true when the write took effect.
 */
function settleWrite(pending, report, message, confirm) {
  if (pending === undefined || pending === null || typeof pending.then !== 'function') return
  pending.then(
    () => { report(confirm() === true ? undefined : message) },
    () => { report(message) },
  )
}

/**
 * Read a human-readable detail out of whatever failure shape a seam reported.
 *
 * The Remote envelope carries `{ code, message }`, a settled command carries a
 * plain string, and a transport error carries an `Error`. All three end up on
 * the same line beside the control, so they are normalized here rather than at
 * each call site.
 * @param error - the reported failure.
 * @returns the detail text, or undefined when there is nothing worth showing.
 */
function refusalDetail(error) {
  if (error === undefined || error === null) return undefined
  if (typeof error === 'string') return error.length > 0 ? error : undefined
  if (typeof error === 'object') {
    const message = error.message
    if (typeof message === 'string' && message.length > 0) return message
    const code = error.code
    if (typeof code === 'string' && code.length > 0) return code
  }
  return String(error)
}

/**
 * One labelled control row: the label, an info button carrying the explanation
 * (kept off the surface so a card of eight fields stays scannable), the
 * override badge and reset, then the control itself.
 * @param write - the card's write guard: `busy` while a write is in flight,
 *   `track`, which reports one mutation's outcome and releases the guard,
 *   `confirm`, which reads the settled snapshot for the field it names, and the
 *   `draft`/`edit`/`clear` trio that keeps keystrokes local until confirmation.
 */
function fieldRow(t, snapshot, scope, field, guardError, write) {
  const { key, kind } = field
  const tipId = `dsh-tip-${key}`
  const label = t(`card.${key}`)
  const hint = t(`card.${key}.hint`)
  const value = fieldValue(snapshot, key)
  const overridden = fieldOverridden(snapshot, key)
  const writable = snapshot.writable !== false
  const blocked = !writable || write.busy
  /** Write one field back through the revision-fenced scope. */
  const commit = next => {
    if (blocked) return
    if (next === undefined || next === null) {
      // Empty means "use the composition layer", which is `unset`, not a null.
      write.track(
        typeof scope.unset === 'function' ? scope.unset(key) : undefined,
        write.confirm(key, undefined),
      )
      return
    }
    const refusal = guardError(key, next)
    if (refusal !== undefined) return
    write.track(
      typeof scope.set === 'function' ? scope.set(key, next) : undefined,
      write.confirm(key, next),
    )
  }
  let control
  if (kind === 'boolean') {
    control = createElement('label', { className: 'dsh-toggle' },
      createElement('input', {
        type: 'checkbox',
        checked: value === true,
        disabled: blocked,
        'aria-label': label,
        onChange: event => { commit(event.target.checked) },
      }),
      createElement('span', null, value === true ? t('card.on') : t('card.off')),
    )
  } else {
    const percent = kind === 'percent'
    const stored = percent && typeof value === 'number' ? Math.round(value * 100) : value
    const shown = stored === undefined || stored === null ? '' : String(stored)
    const raw = write.draft(key)
    /**
     * Confirm the draft. An empty box means "inherit the composition layer",
     * which is `unset` rather than a zero; anything else is parsed and handed to
     * `commit`, whose guard runs before the scope sees it. The draft is released
     * either way, so the box always shows what is actually stored: a refusal
     * belongs on the card's failure line, not in text that still looks accepted.
     */
    const confirm = () => {
      if (raw === undefined) return
      write.clear(key)
      const text = String(raw).trim()
      if (text === '') { commit(undefined); return }
      const parsed = Number(text)
      if (!Number.isFinite(parsed)) return
      commit(percent ? Math.round(parsed) / 100 : Math.round(parsed))
    }
    control = createElement('input', {
      type: 'number',
      step: percent ? field.step ?? 1 : 1,
      min: percent ? 0 : field.min,
      max: percent ? 100 : undefined,
      disabled: blocked,
      value: raw === undefined ? shown : raw,
      placeholder: percent ? '' : t(field.placeholderKey ?? 'card.unset'),
      'aria-label': label,
      // Every keystroke stays local; only blur or Enter confirms it.
      onChange: event => { write.edit(key, event.target.value) },
      onBlur: confirm,
      onKeyDown: event => {
        // With no draft there is nothing to confirm or revert, so the control
        // leaves the key alone: swallowing Escape unconditionally would turn a
        // focused field into a keyboard trap for the shell's close gesture.
        if (raw === undefined) return
        const consume = () => {
          if (typeof event.preventDefault === 'function') event.preventDefault()
          if (typeof event.stopPropagation === 'function') event.stopPropagation()
        }
        if (event.key === 'Enter') {
          consume()
          confirm()
        } else if (event.key === 'Escape') {
          // Reverting is this control's own use of Escape. Without consuming it
          // the key also reaches the shell, which closes the settings surface,
          // so a single Escape reverted the box and dismissed the page.
          consume()
          write.clear(key)
        }
      },
    })
  }
  return createElement('div', { className: 'dsh-field', key },
    createElement('div', { className: 'dsh-field-head' },
      createElement('label', { className: 'dsh-label' }, label),
      createElement('span', { className: 'dsh-info-wrap' },
        createElement('button', {
          type: 'button',
          className: 'dsh-info',
          'aria-label': `${t('card.info')}: ${label}`,
          'aria-describedby': `${tipId}-tip`,
        }, 'i'),
        // Rendered here rather than left to the native `title`: this shell's
        // webview shows no title tooltip, and a card may not import the
        // section's tooltip primitive.
        createElement('span', { className: 'dsh-tip', role: 'tooltip', id: `${tipId}-tip` }, hint),
      ),
      overridden
        ? createElement('span', { className: 'dsh-over' }, `· ${t('card.overridden')}`)
        : null,
      overridden && !blocked
        ? createElement('button', {
            type: 'button',
            className: 'dsh-reset',
            onClick: () => { commit(undefined) },
          }, t('card.reset'))
        : null,
    ),
    control,
  )
}

/** The guidance block: what the system's own compactor would do. */
function systemPanel(t, report, currentThreshold, preempt) {
  if (report === undefined) {
    return createElement('div', { className: 'dsh-system' },
      createElement('strong', null, t('card.system')),
      createElement('span', { className: 'dsh-hint' }, t('card.system.loading')),
    )
  }
  const observed = Array.isArray(report.observed) ? report.observed : []
  const presets = Array.isArray(report.presets) ? report.presets : []
  const safe = typeof report.safeBelow === 'number' ? report.safeBelow : null
  const lines = []
  lines.push(createElement('strong', { key: 'title' }, t('card.system')))
  if (observed.length === 0) {
    lines.push(createElement('span', { key: 'none', className: 'dsh-hint' },
      `${t('card.system.none')} (${t('card.system.stock', { stock: report.stockThresholdRatio ?? STOCK_THRESHOLD })})`))
  } else {
    for (const entry of observed) {
      const ratio = entry.thresholdRatio === null ? '—' : asPercent(entry.thresholdRatio)
      lines.push(createElement('span', { key: entry.name, className: 'dsh-hint' }, `${entry.name} @ ${ratio}`))
    }
  }
  if (presets.length > 0) {
    lines.push(createElement('span', { key: 'presets', className: 'dsh-hint' },
      `${t('card.system.presets')}: ${presets.join(', ')}`))
  }
  if (safe !== null) {
    lines.push(createElement('span', { key: 'safe', className: 'dsh-hint' },
      t('card.system.safeBelow', { safe: asPercent(safe) })))
    if (typeof currentThreshold === 'number' && currentThreshold >= safe) {
      lines.push(createElement('span', { key: 'warn', className: 'dsh-warn' },
        t('card.warn.threshold', { current: asPercent(currentThreshold), safe: asPercent(safe) })))
    }
  }
  if (preempt === false) {
    lines.push(createElement('span', { key: 'off', className: 'dsh-warn' }, t('card.warn.preemptOff')))
  }
  return createElement('div', { className: 'dsh-system' }, ...lines)
}

/**
 * The Plugin configuration card for this namespace.
 *
 * Laid out like the section's own cards — a header that discloses the body —
 * with the four policy settings on the surface and the guardrails behind an
 * Advanced disclosure. Writes settle per field rather than through a staged
 * save, because every value here is a live threshold.
 * @param props - settings-scope binding plus the shell's locale seat.
 * @returns the card element tree.
 */
function RolloverSettingsCard(props) {
  const t = (key, values) => translate(props.t, key, values)
  const scope = props.scope
  ensureStyles()
  const [open, setOpen] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const snapshot = useScopeSnapshot(scope)
  const report = useBackendReport()
  const [error, setError] = useState(undefined)
  const [refusal, setRefusal] = useState(undefined)
  const currentThreshold = fieldValue(snapshot, 'thresholdRatio')
  const currentReminder = fieldValue(snapshot, 'reminderThresholdRatio')
  const currentLastChance = fieldValue(snapshot, 'lastChanceRatio')
  /**
   * Refuse a write locally when it would make a pair incoherent, instead of
   * letting the Host reject it after the input has already moved on.
   */
  const guardError = (key, next) => {
    if (typeof next !== 'number') return undefined
    const threshold = key === 'thresholdRatio' ? next : currentThreshold
    const reminder = key === 'reminderThresholdRatio' ? next : currentReminder
    const lastChance = key === 'lastChanceRatio' ? next : currentLastChance
    // The band is checked first: it is the pair the engine itself refuses, and
    // a card that reported the weaker complaint would send the user to fix the
    // wrong box.
    if (typeof threshold === 'number' && typeof lastChance === 'number' && lastChance > threshold) {
      // Both fields are percent controls, so the refusal has to be stated in
      // the units the boxes show. "0.6 is not below 0.55" printed beside inputs
      // reading 60 and 55 reads like a different pair of numbers.
      const message = t('card.invalid.lastChance', {
        threshold: Math.round(threshold * 100),
        lastChance: Math.round(lastChance * 100),
      })
      setRefusal(message)
      return message
    }
    if (typeof threshold !== 'number' || typeof reminder !== 'number' || reminder <= threshold) {
      setRefusal(undefined)
      return undefined
    }
    const message = t('card.invalid.reminder', {
      reminder: Math.round(reminder * 100),
      threshold: Math.round(threshold * 100),
    })
    setRefusal(message)
    return message
  }
  const title = t('card.title')
  /**
   * Hold the card while one write is in flight. The scope is revision-fenced,
   * so a second edit issued before the first settles races it — and the user
   * would see whichever landed last rather than what they asked for.
   */
  const [writing, setWriting] = useState(false)
  /** The snapshot as it stands now: the only evidence that a write took effect. */
  const settledSnapshot = () =>
    (typeof scope.getSnapshot === 'function' ? scope.getSnapshot() : snapshot)
  /**
   * Read the settled snapshot for one field and say whether it holds what the
   * write asked for. The scope resolves `void` whether or not the Host accepted
   * the change, so this read — not the promise — is what separates saved from
   * refused; a refusal leaves the previous value in place.
   * @param key - the field the write named.
   * @param expected - the value asked for, or `undefined` for an `unset`.
   * @returns a predicate over the snapshot at settlement time.
   */
  const storedAs = (key, expected) => () => {
    const settled = settledSnapshot()
    return expected === undefined
      ? fieldOverridden(settled, key) !== true
      : fieldValue(settled, key) === expected
  }
  /**
   * Watch one mutation to its end: display its failure and release the guard.
   * @param pending - whatever the scope mutation returned.
   * @param confirm - reads the settled snapshot; absent means "assume it landed".
   */
  const track = (pending, confirm) => {
    if (pending === undefined || pending === null || typeof pending.then !== 'function') return
    setWriting(true)
    settleWrite(pending, setError, t('card.writeFailed'), confirm ?? (() => true))
    const release = () => setWriting(false)
    pending.then(release, release)
  }
  /**
   * The text a user is still editing, per field key.
   *
   * Committing on every keystroke wrote each intermediate value to the scope, so
   * typing `74` first stored `7` — a value nobody chose, which the Host can
   * refuse and which, because settings apply live, changes the rollover policy
   * before the number is finished. A draft keeps intermediate text local and is
   * released on confirmation, so the box always shows what is actually stored.
   */
  const [drafts, setDrafts] = useState({})
  const write = {
    busy: writing,
    track,
    confirm: storedAs,
    /** The draft for one field, or undefined while the box follows the snapshot. */
    draft: key => drafts[key],
    /** Keep one keystroke local until the field is confirmed. */
    edit: (key, text) => { setDrafts(current => ({ ...current, [key]: text })) },
    /** Release one draft so the box shows the stored value again. */
    clear: key => {
      setDrafts(current => {
        if (current[key] === undefined) return current
        const next = { ...current }
        delete next[key]
        return next
      })
    },
  }
  const renderFields = fields => fields.map(field =>
    fieldRow(t, snapshot, scope, field, guardError, write))
  const overriddenCount = [...CARD_FIELDS, ...ADVANCED_FIELDS]
    .filter(field => fieldOverridden(snapshot, field.key)).length
  /** Clear every override in one atomic mutation: back to the deployment's values. */
  const resetAll = () => {
    if (typeof scope.mutate !== 'function' || writing) return
    const ops = [...CARD_FIELDS, ...ADVANCED_FIELDS].map(field => ({ op: 'unset', path: [field.key] }))
    // The rejection path used to call an undefined name, so a failed reset
    // threw a ReferenceError that hid the failure it was meant to report.
    const cleared = () => ![...CARD_FIELDS, ...ADVANCED_FIELDS]
      .some(field => fieldOverridden(settledSnapshot(), field.key))
    track(scope.mutate(ops), cleared)
  }
  return createElement('li', {
    className: open ? 'dsh-context-rollover-card dsh-open' : 'dsh-context-rollover-card',
  },
    createElement('button', {
      type: 'button',
      className: 'dsh-head',
      'aria-expanded': open,
      'aria-label': `${t(open ? 'card.collapse' : 'card.expand')}: ${title}`,
      onClick: () => { setOpen(!open) },
    },
    createElement('span', { className: 'dsh-head-text' },
      createElement('span', { className: 'dsh-name' }, title),
      createElement('span', { className: 'dsh-description' }, t('card.intro')),
    ),
    createElement('svg', {
      className: 'dsh-chevron',
      viewBox: '0 0 14 14',
      width: 14,
      height: 14,
      'aria-hidden': true,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.5,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }, createElement('path', { d: 'M3.5 5.25 7 8.75l3.5-3.5' }))),
    open
      ? createElement('div', { className: 'dsh-body' },
          overriddenCount > 0 && snapshot.writable !== false
            ? createElement('div', { className: 'dsh-reset-all-row' },
                createElement('button', {
                  type: 'button',
                  className: 'dsh-reset dsh-reset-deployment',
                  onClick: resetAll,
                }, t('card.resetAll')),
              )
            : null,
          createElement('div', { className: 'dsh-grid' }, ...renderFields(CARD_FIELDS)),
          systemPanel(t, report, currentThreshold, preemptOf(snapshot)),
          refusal === undefined ? null : createElement('p', { className: 'dsh-warn' }, refusal),
          createElement('button', {
            type: 'button',
            className: 'dsh-advanced',
            'aria-expanded': advanced,
            onClick: () => { setAdvanced(!advanced) },
          }, `${advanced ? '▾' : '▸'} ${t('card.advanced')}`),
          advanced
            ? createElement('div', null,
                createElement('p', { className: 'dsh-hint' }, t('card.advanced.hint')),
                createElement('div', { className: 'dsh-grid' }, ...renderFields(ADVANCED_FIELDS)),
              )
            : null,
          snapshot.writable === false
            ? createElement('p', { className: 'dsh-hint' }, t('card.unavailable'))
            : null,
          error === undefined ? null : createElement('p', { className: 'dsh-warn' }, error),
        )
      : null,
  )
}

/** Whether interception is on, from a scope snapshot. */
function preemptOf(snapshot) {
  return fieldValue(snapshot, 'preempt')
}

/**
 * Mount the button and the settings card.
 * @param ctx - browser-side plugin context.
 * @returns {void}
 */
function apply(ctx) {
  const slots = ctx.get('slots')
  if (slots === undefined || slots === null) return
  // Registered through a deferred inject for the same reason as the card: the
  // shell decides the order, and a dictionary that arrives late is a card full
  // of raw keys.
  ctx.inject(['locale'], (localeCtx) => {
    const locale = localeCtx.get('locale')
    if (locale === null || locale === undefined || typeof locale.register !== 'function') return
    localeCtx.effect(() => locale.register(LOCALE_NS, DICTS), 'context-rollover dictionaries')
  })
  // The card waits for the settings domain instead of testing for it once: the
  // shell activates plugins in an unspecified order, and `settingsScope` may
  // well arrive after this half. Waiting also keeps the button working in a
  // composition that never mounts settings at all.
  ctx.inject(['settingsScope'], (scopeCtx) => {
    const settingsScope = scopeCtx.get('settingsScope')
    if (settingsScope === null || settingsScope === undefined || typeof settingsScope.bind !== 'function') return
    const scope = settingsScope.bind({ namespace: SETTINGS_NS })
    const scopedSlots = scopeCtx.get('slots') ?? slots
    scopeCtx.effect(
      () => scopedSlots.inject(SETTINGS_SLOT, () => scopedSlots.register({
        name: SETTINGS_SLOT,
        key: SETTINGS_NS,
        locale: LOCALE_NS,
        inject: () => ({ scope }),
      }, RolloverSettingsCard)),
      'context-rollover settings card',
    )
  })
  ctx.effect(
    () => slots.inject(SLOT, () => slots.register({
      name: SLOT,
      id: 'context-rollover',
      order: 8,
      locale: LOCALE_NS,
      label: 'Context Rollover',
      // The session id is bound per session, so the button never looks it up;
      // `remote.commands` is the same executor the composer uses.
      inject: sessionId => ({
        // Resolves with the outcome rather than firing and forgetting: the
        // gateway reports ordinary refusals and an offline carrier as a
        // fulfilled `{ ok: false }`, so only the result says whether anything
        // changed.
        setMode: async rollover => {
          const commands = ctx.get('remote.commands')
          if (commands === undefined || commands === null) return { ok: false }
          try {
            const execution = await commands.execute(sessionId, `/rollover ${rollover ? 'on' : 'off'}`, [])
            // A resolved call proves nothing by itself. Three shapes reach this
            // untyped boundary: an admission miss — the line never reached a
            // handler — resolves `undefined`; a handler that refused resolves
            // `CommandExecution { commandId, result: { kind: 'error', text } }`;
            // and a refusal at the Remote seam resolves the `{ ok: false,
            // error }` envelope the settings scope also unwraps. Reading only
            // the last one, as this did, reported every refusal as a change.
            if (execution === undefined || execution === null) return { ok: false }
            if (execution.ok === false) {
              const detail = refusalDetail(execution.error)
              return detail === undefined ? { ok: false } : { ok: false, detail }
            }
            const result = execution.result
            if (result !== undefined && result !== null && result.kind === 'error') {
              const detail = refusalDetail(result.text)
              return detail === undefined ? { ok: false } : { ok: false, detail }
            }
            return { ok: true }
          } catch (failure) {
            return { ok: false, detail: refusalDetail(failure) }
          }
        },
      }),
    }, RolloverModeButton)),
    'context-rollover mode button',
  )
}

module.exports = { apply, inject, name }
