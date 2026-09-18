/**
 * Browser half of the plugin: the session-page mode button and the settings
 * form.
 *
 * The button is one icon that sits tight after the session's native stat pills,
 * in their row under the composer. The icon *is* the state: the Lucide recycle
 * mark means this session rolls over, the Lucide square-split-vertical mark
 * means it uses its own compaction backend. Clicking toggles the mode, so
 * there is no separate switch chrome to explain.
 *
 * The form is the same tree on two surfaces, because the host moved it. It
 * registers under `settings.plugin.item` for hosts up to 0.1.6-alpha.1, which
 * draw it as a card in Settings > Plugins, and under `plugins.bundle.config`
 * keyed by this bundle's package name from 0.1.6-alpha.2 on, which draws it on
 * the bundle's own page in the sidebar's Plugins tab. Each registration waits
 * for its slot to be declared, so a host lights up exactly the one it has.
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
 * visual weight as the platform's 16-unit icons.
 *
 * Placement follows the dock the host draws, and two shapes have shipped. Up to
 * 0.1.6-alpha.1 the dock slot renders into the composer column (`InputBar
 * .root`) and the native stats row marks itself with `data-composer-stats`:
 * this entry mirrors that row's centered box, pulls itself onto the row's line,
 * and measures the last stat pill so the button lands one pill-gap after it
 * instead of at the box edge. From 0.1.6-alpha.2 the dock slot renders into the
 * stats row itself — a centered flex row shared with the context-usage donut —
 * so this entry is one of its items and the row's own `gap` *is* that pill gap;
 * there the entry only has to shrink to the button and keep its margins out of
 * the row's free space. Which shape it is comes from the container's own
 * computed flex direction rather than from a host version, so a host that
 * re-draws the row needs no change here.
 *
 * Authored as CommonJS because the artifact runs inside the shell's loader
 * factory, which hands the bundle a `require` bound to the browser module
 * table: `react` is the only external this file uses. That makes the "build" a
 * wrapper, not a bundler — see `scripts/build-client.mjs`.
 *
 * @module dsh-context-rollover/client
 */

const { createElement, useEffect, useLayoutEffect, useRef, useState } = require('react')

/**
 * `createPortal`, when the shell's module table carries React's DOM renderer.
 *
 * It is a platform seed word rather than a package row, so every host that can
 * render this control has it; the guard is here because a bundle that throws
 * while loading takes the whole browser half down with it, and an overlay drawn
 * in place is a far better failure than no control at all.
 */
const createPortal = (() => {
  try {
    return require('react-dom').createPortal
  } catch {
    return undefined
  }
})()

/** Projection key the host half publishes the per-session mode under. */
const MODE_PROJECTION_KEY = 'contextRolloverMode'

/** Slot the button occupies: the row under the composer, with the stats. */
const SLOT = 'conversation.composer.dock'

/** Settings namespace the host half registers; the card's join key. */
const SETTINGS_NS = 'context-rollover'

/** Bundle package name: the key `plugins.bundle.config` dispatches. */
const BUNDLE_NAME = 'dsh-context-rollover'

/**
 * Legacy slot for the card: the Settings > Plugins section, keyed by namespace.
 * Hosts up to 0.1.6-alpha.1 declare it. 0.1.6-alpha.2 dropped the declaration —
 * Settings keeps only the read-only plugin inventory now — so a registration
 * here simply waits, forever, on a host that never declares it.
 */
const LEGACY_SETTINGS_SLOT = 'settings.plugin.item'

/**
 * Current slot for the card: a bundle's own configuration, keyed by the
 * bundle's package name and rendered on the bundle's page in the sidebar's
 * Plugins tab. Declared by `@deepseek-ai/dsh-client-ui-plugin-manager` from
 * 0.1.6-alpha.2 on.
 */
const BUNDLE_CONFIG_SLOT = 'plugins.bundle.config'

/** Host route carrying what is known about the surrounding compaction backends. */
const BACKEND_ROUTE = '/context-rollover/backends'

/** Host route carrying one session's rollover reading. */
const STATUS_ROUTE = '/context-rollover/status'

/**
 * How often the control re-reads the host while it is on screen.
 *
 * The reading is not pushable: it is built from the live measurement behind the
 * next request, which is host state no session event carries, and it moves
 * between steps as the conversation grows. Five seconds is short enough that a
 * countdown looks live and long enough that the measurement it costs — the same
 * one every step already takes — stays negligible.
 */
const STATUS_POLL_MS = 5000

/** Delay before the hover bubble appears, the platform's own hover patience. */
const TOOLTIP_DELAY_MS = 300

/** Gap between the trigger and the overlay above it. */
const OVERLAY_GAP = 10

/** Panel width, matching the platform's usage panel. */
const PANEL_WIDTH = 264

/** Leave room below the panel when there is not enough above the trigger. */
const PANEL_FLIP_BELOW_UNDER = 260

/** Minimum inset an overlay keeps from the viewport's sides. */
const OVERLAY_MARGIN = 12

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
    // The control's hover bubble: one sentence saying what happens next and how
    // much prompt growth is left before it does. `{tokens}` is already
    // abbreviated, so the unit is the translator's to place.
    'stage.notify': '{tokens} tokens to the context notice',
    'stage.warn': 'Notice sent · {tokens} tokens to the last-chance warning',
    'stage.rollover': 'Rollover armed · new window in {tokens} tokens',
    'stage.imminent': 'Rollover armed · the next safe boundary starts a new window',
    'stage.compacting': 'Compaction in {tokens} tokens',
    'stage.unknown': 'Context window not measured yet',
    // The panel. `usedBefore`/`usedAfter` split the native phrasing so both
    // languages can put the number where their grammar wants it.
    'panel.usedBefore': '',
    'panel.usedAfter': 'of context used',
    'panel.unknown': 'Context window',
    'panel.point.notify': 'Notify',
    'panel.point.warn': 'Warn',
    'panel.point.rollover': 'Roll over',
    'panel.point.compact': 'Compaction',
    'panel.switch': 'Roll over this session',
    'panel.switchHint': 'Off hands the window back to the session\'s own compaction backend.',
    'panel.writeFailed': 'Mode not changed:',
    'panel.pending': 'Applying…',
    'card.title': 'Context Rollover',
    'card.expand': 'Expand',
    'card.collapse': 'Collapse',
    'card.intro': 'Three points on one scale, in the order they fire: 1 notify, 2 warn, 3 execute. Each is a '
      + 'share of the window, and the whole ladder has to stay below the session\'s own compaction backend.',
    'card.thresholdRatio': '3. Execute — roll over at (%)',
    'card.thresholdRatio.hint': 'The execute point. At this share of the window the plugin rolls over: a new '
      + "window, a checkpoint, and the recent tail, with no summary. Keep it strictly below the compaction "
      + 'backend\'s threshold, or that backend summarises first.',
    'card.reminderThresholdRatio': '1. Notify (%)',
    'card.reminderThresholdRatio.hint': 'The notify point, and the first tier to fire. The model is reminded once '
      + 'per window that the window is filling up. It has to land before the warn point, so that "filling up" '
      + 'arrives before "this is the end"; the harness lowers it automatically when a lower execute point leaves '
      + 'no room.',
    'card.retainTokens': 'Retained tail (tokens)',
    'card.retainTokens.hint': 'Recent conversation kept verbatim across a rollover, counted in tokens. Empty '
      + "keeps the deployment's default, a share of the window. Worth setting explicitly on a large window: a "
      + 'share of 1M is a very large tail to carry into every fresh window.',
    'card.retainTokens.unset': 'share of window',
    'card.lastChanceRatio': '2. Warn (%)',
    'card.lastChanceRatio.hint': 'Where the final stretch opens. Past this share of the window the model is told '
      + 'once that this is its last chance and how much growth is left, so it stops and writes notes instead of '
      + 'being cut off mid-task. The stretch runs from here up to tier 3, and its width is that difference (see '
      + 'the line below). Setting this equal to tier 3 switches the tier off.',
    'card.ladder': 'Where the tiers land',
    'card.ladder.reminder': '1 notify',
    'card.ladder.band': '2 warn',
    'card.ladder.threshold': '3 execute',
    'card.ladder.bandValue': 'opens at {start}% (then {width}% wide)',
    'card.ladder.note': 'Shares of the window, not token counts: the token distances scale with it, and on a '
      + 'much smaller window they are far tighter. Re-tune against those distances, not the ratios.',
    'card.ladder.degenerate': 'No room left between tiers: the notify point cannot land before the warn point. '
      + 'Raise the execute point or lower the warn point.',
    'card.pinActiveRequest': 'Keep the active request',
    'card.pinActiveRequest.hint': 'On, a rollover never drops the human message that started the open turn, even '
      + 'when a long turn has pushed it past the retained-tail budget. It costs rollover room in exchange.',
    'card.invalid.lastChance': 'The last chance cannot open at or after the window is replaced: its point '
      + '{lastChance}% must stay below the execute point {threshold}%.',
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
    'card.invalid.reminderOrder': 'The reminder has to fire before the last chance opens: {reminder} is not below '
      + 'the last-chance point {start}. Lower the reminder, lower the last chance, or raise the execute point.',
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
    'stage.notify': '{tokens} Token后提示',
    'stage.warn': '已提示 · {tokens} Token后预警',
    'stage.rollover': '自动滚动就位 · {tokens} Token后强制换窗',
    'stage.imminent': '自动滚动就位 · 下一个安全边界即开新窗口',
    'stage.compacting': '{tokens} Token后强制压缩',
    'stage.unknown': '尚未测量上下文窗口',
    'panel.usedBefore': '上下文已用',
    'panel.usedAfter': '',
    'panel.unknown': '上下文窗口',
    'panel.point.notify': '提示',
    'panel.point.warn': '预警',
    'panel.point.rollover': '换窗',
    'panel.point.compact': '压缩',
    'panel.switch': '本会话滚动归档',
    'panel.switchHint': '关闭后交还给本会话自己的压缩后端。',
    'panel.writeFailed': '模式未切换：',
    'panel.pending': '正在应用…',
    'card.title': 'Context Rollover',
    'card.expand': '展开',
    'card.collapse': '收起',
    'card.intro': '同一条刻度上的三个点，按触发顺序：1 提示 → 2 预警 → 3 执行。'
      + '每个都是窗口占比，整条阶梯须低于本会话自己的压缩后端。',
    'card.thresholdRatio': '3. 执行 —— 到此处换窗（%）',
    'card.thresholdRatio.hint': '执行点。窗口用到该比例时自动换窗：开新窗口、写检查点、保留最近原文，不做摘要。'
      + '该值须严格低于本会话压缩后端的阈值，否则后端会先做摘要。',
    'card.reminderThresholdRatio': '1. 提示（%）',
    'card.reminderThresholdRatio.hint': '提示点，三档中最早触发的一档。窗口用到该比例时向模型提醒一次（每个窗口一次）：'
      + '窗口正在变满。它必须落在预警点之前，这样「正在变满」才会先于「这是最后一段」到达；'
      + '当执行点被调低、前面没余量时，本插件会自动把它往下压来维持这个顺序。',
    'card.retainTokens': '保留最近对话（Token）',
    'card.retainTokens.hint': '换窗后原样保留的最近对话，按 Token 计。留空表示沿用部署默认值（窗口的 10%）。'
      + '大窗口上建议显式设置：1M 的 10% 是十万级 Token，会被每一个新窗口一直背着。',
    'card.retainTokens.unset': '按窗口比例',
    'card.lastChanceRatio': '2. 预警（%）',
    'card.lastChanceRatio.hint': '最后一段的起点。窗口用到这里之后，模型会收到一次提醒：这是最后机会、还能增长多少，'
      + '于是它可以停下来写笔记，而不是在干活的中途被切断。这一段从这里一直延伸到第 3 档，宽度就是两者之差（见下方那行）。'
      + '把它填成与第 3 档相同，即关闭这一档。',
    'card.ladder': '三档落在哪里',
    'card.ladder.reminder': '1 提示',
    'card.ladder.band': '2 预警',
    'card.ladder.threshold': '3 执行',
    'card.ladder.bandValue': '起于 {start}%（其后宽 {width}%）',
    'card.ladder.note': '这些是窗口占比，不是 Token 数：对应距离随窗口放大，窗口小得多时会紧很多。'
      + '请按绝对距离重新调参，而不是按比例。',
    'card.ladder.degenerate': '三档之间已经挤不出间距：提示点无法落在预警点之前。请调高执行点，或调低预警点。',
    'card.pinActiveRequest': '保底保留当前请求',
    'card.pinActiveRequest.hint': '开启后，换窗永远不会丢掉开启当前回合的那条人类消息，即使长回合已经把它挤出'
      + '保留区。代价是单次换窗腾出的空间更少。',
    'card.invalid.lastChance': '最后机会不能落在换窗之后：它的点 {lastChance}% 必须低于执行点 {threshold}%。',
    'card.invalid.reminderOrder': '提醒必须早于最后机会触发：{reminder}% 不低于最后机会点 {start}%。'
      + '请调低提醒、调低最后机会点，或调高执行点。',
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
/* From 0.1.6-alpha.2 the dock is a centered flex *row* and this entry is one of
   its items, beside the native pills and the context-usage donut. The row's own
   12px gap is the pill gap, so the entry shrinks to the button and takes no side
   margin: width 100% would eat the row and push the button into the middle of
   the band, ahead of the donut, and an auto side margin would swallow the free
   space justify-content: center needs, stranding the pills at the left edge.
   The measured overlay below belongs to the older column dock only. */
.dsh-context-rollover-mode.dsh-in-dock {
  width: auto;
  margin: 0;
  justify-content: flex-start;
}
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

/* The control's two overlays. Both are chrome copied from the platform's own
   components — the hover bubble is the Tooltip primitive's box and the panel is
   the context-usage panel's — because a plugin may not import those components,
   and both are built from the theme's tokens so they follow it anyway. They are
   fixed-position and rendered at the end of this entry, which its own ancestors
   leave viewport-positioned: none of them carries a transform, filter, or
   containment. */
.dsh-context-rollover-bubble {
  position: fixed;
  z-index: 100;
  box-sizing: border-box;
  width: max-content;
  max-width: 50vw;
  padding: 3px 7px;
  border-radius: 8px;
  background: var(--dsw-alias-tooltip-bg);
  color: var(--dsw-static-neutral-bluish-00, #fff);
  font-size: 13px;
  line-height: 20px;
  white-space: pre-line;
  overflow-wrap: break-word;
  pointer-events: none;
  transform: translateX(-50%);
}
.dsh-context-rollover-panel {
  position: fixed;
  z-index: 100;
  box-sizing: border-box;
  padding: 12px;
  border: 0;
  border-radius: 12px;
  background: var(--dsw-specific-menu);
  box-shadow: var(--dsw-elevation-prominent);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 20px;
  cursor: default;
  /* The entry it hangs from is click-through so the native pills keep their own
     clicks; the panel is not, or its switch would not be. */
  pointer-events: auto;
  transform: translateX(-50%);
}
.dsh-context-rollover-panel .dsh-panel-head { display: flex; align-items: center; gap: 6px; }
.dsh-context-rollover-panel .dsh-panel-headline { color: var(--dsw-alias-label-tertiary); }
.dsh-context-rollover-panel .dsh-panel-percent { color: var(--dsw-alias-label-primary); font-weight: 500; }
.dsh-context-rollover-panel .dsh-panel-figures {
  margin-left: auto; font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-primary); font-weight: 500;
}
.dsh-context-rollover-panel .dsh-bar {
  position: relative; height: 6px; margin: 10px 0 6px;
  border-radius: 999px; background: var(--dsw-alias-interactive-bg-hover); overflow: hidden;
}
/* The window as four rungs, read like a signal: quiet up to the notify point,
   green up to the warn point, amber up to the execute point, red past it. The
   band tints say which stretch the window is standing in; the ticks are the
   same three colours in the same order, so the bar reads at a glance without
   the key under it. */
.dsh-context-rollover-panel .dsh-bar-used {
  position: absolute; top: 0; left: 0; height: 100%; border-radius: 999px;
  background: var(--dsw-static-blue-450, #2f6fed); transition: width .24s ease;
  /* Above the bands: what is already used overrides what each rung would be.
     The ticks stay above this, so a point already crossed keeps its colour. */
  z-index: 1;
}
.dsh-context-rollover-panel .dsh-bar-zone { position: absolute; top: 0; height: 100%; }
.dsh-context-rollover-panel .dsh-bar-zone[data-zone='notified'] {
  background: var(--dsw-static-green-100, #e6faed);
}
.dsh-context-rollover-panel .dsh-bar-zone[data-zone='lastChance'] {
  background: var(--dsw-static-amber-100, #fef5e7);
}
.dsh-context-rollover-panel .dsh-bar-zone[data-zone='past'] {
  background: var(--dsw-static-red-100, #fee2e2);
}
.dsh-context-rollover-panel .dsh-bar-mark {
  position: absolute; top: 0; width: 2px; height: 100%; z-index: 2;
  background: var(--dsw-alias-label-tertiary);
}
.dsh-context-rollover-panel .dsh-bar-mark[data-mark='notify'] {
  background: var(--dsw-alias-state-success-primary);
}
.dsh-context-rollover-panel .dsh-bar-mark[data-mark='warn'] {
  background: var(--dsw-alias-state-warn-primary);
}
.dsh-context-rollover-panel .dsh-bar-mark[data-mark='rollover'],
.dsh-context-rollover-panel .dsh-bar-mark[data-mark='compact'] {
  background: var(--dsw-alias-state-error-primary);
}
/* The key under the bar: which rung is which, and where each one sits. The
   percentages are the tick positions, so a mark never has to be read off the
   bar's own geometry. */
.dsh-context-rollover-panel .dsh-bar-keys {
  display: flex; align-items: center; gap: 10px; margin: 0 0 10px;
  color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px;
}
.dsh-context-rollover-panel .dsh-bar-key { display: inline-flex; align-items: center; gap: 4px; }
.dsh-context-rollover-panel .dsh-key-dot {
  flex: none; width: 6px; height: 6px; border-radius: 2px; background: var(--dsw-alias-label-tertiary);
}
.dsh-context-rollover-panel .dsh-bar-key[data-point='notify'] .dsh-key-dot {
  background: var(--dsw-alias-state-success-primary);
}
.dsh-context-rollover-panel .dsh-bar-key[data-point='warn'] .dsh-key-dot {
  background: var(--dsw-alias-state-warn-primary);
}
.dsh-context-rollover-panel .dsh-bar-key[data-point='rollover'] .dsh-key-dot,
.dsh-context-rollover-panel .dsh-bar-key[data-point='compact'] .dsh-key-dot {
  background: var(--dsw-alias-state-error-secondary);
}
/* The rung the window is heading for reads at full strength; the ones already
   behind it are context rather than a call to action. */
.dsh-context-rollover-panel .dsh-bar-key[data-next] { color: var(--dsw-alias-label-primary); }
.dsh-context-rollover-panel .dsh-bar-key[data-passed] { opacity: 0.55; }
.dsh-context-rollover-panel .dsh-stage { display: flex; align-items: flex-start; gap: 6px; padding: 2px 0; }
.dsh-context-rollover-panel .dsh-stage-dot {
  flex: none; width: 8px; height: 8px; margin-top: 6px; border-radius: 50%;
  background: var(--dsw-alias-label-tertiary);
}
.dsh-context-rollover-panel .dsh-stage-text { min-width: 0; }
.dsh-context-rollover-panel .dsh-stage[data-stage='warn'] .dsh-stage-dot {
  background: var(--dsw-alias-state-warn-primary);
}
.dsh-context-rollover-panel .dsh-stage[data-stage='rollover'] .dsh-stage-dot {
  background: var(--dsw-alias-state-business-primary);
}
.dsh-context-rollover-panel .dsh-stage[data-stage='imminent'] .dsh-stage-dot {
  background: var(--dsw-alias-state-error-primary);
}
.dsh-context-rollover-panel .dsh-switch-row {
  display: flex; align-items: center; gap: 8px; margin-top: 10px; padding-top: 10px;
  border-top: 0.5px solid var(--dsw-alias-border-l1);
}
.dsh-context-rollover-panel .dsh-switch-label { min-width: 0; color: var(--dsw-alias-label-primary); }
.dsh-context-rollover-panel button.dsh-switch {
  position: relative; flex: none; margin-left: auto; box-sizing: border-box;
  width: 36px; height: 20px; padding: 2px; border: 0; border-radius: 10px;
  corner-shape: round; background: var(--dsw-alias-border-l3); cursor: pointer;
}
.dsh-context-rollover-panel button.dsh-switch[aria-checked='true'] { background: var(--dsw-alias-brand-primary); }
.dsh-context-rollover-panel button.dsh-switch:disabled { opacity: 0.5; cursor: default; }
.dsh-context-rollover-panel button.dsh-switch:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px;
}
.dsh-context-rollover-panel .dsh-thumb {
  display: block; width: 16px; height: 16px; border-radius: 50%; corner-shape: round;
  background: var(--dsw-alias-label-primary-foreground); transition: transform .12s ease;
}
.dsh-context-rollover-panel button.dsh-switch[aria-checked='true'] .dsh-thumb { transform: translateX(16px); }
.dsh-context-rollover-panel .dsh-panel-hint {
  margin: 4px 0 0; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px;
}
.dsh-context-rollover-panel .dsh-warn { margin: 6px 0 0; color: var(--dsw-alias-label-error, #d33); }
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
/* On the Plugins page the bundle's own section is the frame: the page draws the
   title, the icon, and the crumb above it, so the card keeps the form's styles
   and gives up its chrome and its header. The body's own top border and side
   margins go with it — there is no header left for them to belong to. */
.dsh-context-rollover-card.dsh-page {
  border: 0;
  border-radius: 0;
  background: none;
  padding: 0;
}
.dsh-context-rollover-card.dsh-page .dsh-body {
  border-top: 0;
  margin: 0;
  padding-bottom: 0;
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
/* The ladder reads top to bottom in the order it fires, so it gets one column
   and a rail rather than the two-column auto-flow the other fields use. */
.dsh-context-rollover-card .dsh-ladder { display: flex; flex-direction: column; padding: 4px 0 0; }
.dsh-context-rollover-card .dsh-ladder .dsh-field {
  border-left: 2px solid var(--dsw-alias-border-l2); padding-left: 12px;
}
.dsh-context-rollover-card .dsh-ladder .dsh-field + .dsh-field { border-top: 0; }
.dsh-context-rollover-card .dsh-step {
  flex: none; display: inline-flex; align-items: center; gap: 6px;
  font-size: 11px; font-weight: 600; letter-spacing: .02em;
  color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums;
}
.dsh-context-rollover-card .dsh-ladder-foot {
  display: flex; flex-direction: column; gap: 4px; padding: 10px 0 12px; min-width: 0;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}
.dsh-context-rollover-card .dsh-ladder-group { min-width: 0; }
.dsh-context-rollover-card .dsh-ladder-track > span,
.dsh-context-rollover-card .dsh-ladder-foot > .dsh-hint { overflow-wrap: anywhere; }
.dsh-context-rollover-card .dsh-ladder-track { display: flex; flex-wrap: wrap; gap: 4px 16px; }
.dsh-context-rollover-card .dsh-ladder-track > span {
  font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
}
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
 * The element the host actually lays this entry out in.
 *
 * The slot outlet is `display: contents` — it generates no box of its own — so
 * the entry's real parent, the one whose flex rules place it, is the first
 * ancestor that does generate one.
 * @param entry - this entry's root element.
 * @returns that ancestor, or null when the walk leaves the document or the
 *   computed style cannot be read at all.
 */
function layoutContainer(entry) {
  if (typeof getComputedStyle !== 'function') return null
  let container = entry.parentElement
  while (container !== null && container !== undefined
    && getComputedStyle(container).display === 'contents') {
    container = container.parentElement
  }
  return container ?? null
}

/**
 * How the host's composer lays this entry out.
 *
 * Two layouts have shipped, and they place this entry differently enough that
 * the button cannot be positioned the same way in both. Up to 0.1.6-alpha.1 the
 * dock slot renders as a child of the composer root — a *column* flex box — and
 * the native stats row marks itself with `data-composer-stats`: this entry then
 * spans the row's centered box and has to be pulled onto its line and padded so
 * the button clears the last pill. From 0.1.6-alpha.2 the dock slot renders as a
 * child of the stats row itself — a centered *row* flex box — so this entry is
 * simply one of its items and the row's own gap already puts the button one
 * pill-gap after the pills.
 * @param entry - this entry's root element.
 * @returns `'row'` for the flex-row dock, `'column'` for the older dock, or
 *   undefined when the container cannot be read.
 */
function dockLayout(entry) {
  const container = layoutContainer(entry)
  if (container === null) return undefined
  const style = getComputedStyle(container)
  if (!style.display.includes('flex')) return 'column'
  return style.flexDirection === 'row' ? 'row' : 'column'
}

/**
 * How this entry is positioned, decided from the host's own layout.
 *
 * `dock` needs no measurement: the entry is a flex item, so the row places it
 * and the entry must only stay out of the way. `overlay` is the older shape —
 * mirror the stats row's centered box, then pad it so the button lands one
 * pill-gap after the last pill. `plain` is the fallback for a column dock with
 * no stats row to align to: the entry keeps its full width and no offset, which
 * is what a host that draws neither will look least wrong with.
 * @param ref - ref to this entry's root element.
 * @returns the alignment: its `layout`, and the `paddingRight` overlay needs.
 */
function useDockAlignment(ref) {
  const [alignment, setAlignment] = useState({ layout: undefined, paddingRight: undefined })
  useLayoutEffect(() => {
    const entry = ref.current
    if (entry === null || entry === undefined || typeof document === 'undefined') return undefined
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => { measure() })
    // Re-measured on resize and on any stat pill geometry change, because the
    // numbers in those pills grow and shift the row's centre.
    function measure() {
      const button = entry.firstElementChild
      if (button === null) return
      if (dockLayout(entry) === 'row') {
        // Nothing to measure here: the entry is as wide as the button and the
        // row's gap places it, so a pill that grows re-centres the row without
        // changing this offset. Stop watching the pills.
        if (observer !== null) observer.disconnect()
        setAlignment({ layout: 'dock', paddingRight: undefined })
        return
      }
      const row = document.querySelector('[data-composer-stats]')
      if (row === null) {
        if (observer !== null) observer.disconnect()
        setAlignment({ layout: 'plain', paddingRight: undefined })
        return
      }
      const last = row.lastElementChild
      const anchorRight = (last === null ? row : last).getBoundingClientRect().right
      const buttonWidth = button.getBoundingClientRect().width
      const boxRight = entry.getBoundingClientRect().right
      setAlignment({
        layout: 'overlay',
        paddingRight: Math.max(0, Math.round(boxRight - anchorRight - PILL_GAP - buttonWidth)),
      })
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
  return alignment
}

/**
 * A token count in the shape the composer's own pills use: one decimal, an SI
 * suffix from a thousand up, and no trailing `.0` — the platform prints `1M`,
 * not `1.0M`.
 * @param value - the count, or null while nothing is measured.
 * @returns the abbreviated count, or null.
 */
function formatTokens(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const rounded = Math.max(0, Math.round(value))
  if (rounded < 1000) return String(rounded)
  const suffix = rounded < 1000000 ? 'K' : 'M'
  const text = (rounded / (suffix === 'K' ? 1000 : 1000000)).toFixed(1)
  return `${text.endsWith('.0') ? text.slice(0, -2) : text}${suffix}`
}

/**
 * The control's one sentence: what happens next, and how much prompt growth is
 * left before it does.
 *
 * The stage names the action rather than the tier number, because the tier
 * numbers are the settings card's vocabulary and the countdown is the only
 * thing a reader wants here.
 * @param t - this namespace's translator.
 * @param status - the host's reading, or undefined before the first one lands.
 * @returns the sentence to show in the bubble and the panel.
 */
function stageText(t, status) {
  if (status === undefined || status === null) return t('stage.unknown')
  const tokens = formatTokens(status.tokensToNext)
  // A stage whose countdown cannot be measured yet still knows what it is
  // waiting for, and the sentence is the same one with the number left out.
  const values = { tokens: tokens === null ? '—' : tokens }
  switch (status.stage) {
    case 'warn':
      return t('stage.warn', values)
    case 'rollover':
      return t('stage.rollover', values)
    case 'imminent':
      return t('stage.imminent')
    case 'compacting':
      return t('stage.compacting', values)
    default:
      return t('stage.notify', values)
  }
}

/**
 * Poll one session's reading from the host.
 *
 * Polled rather than pushed because the number is not in the session log: it is
 * the token meter's live measurement of the prompt the next request would
 * submit, which moves as the conversation grows and not on any event. The poll
 * runs only while this control is mounted and the document is visible, so a
 * background tab costs nothing.
 *
 * `watch` restarts the loop, which is what makes the reading current at the
 * moment it is looked at: opening the panel reads once immediately instead of
 * waiting out the interval, so the marks a reader is about to compare against
 * the configuration are never a poll behind it.
 * @param sessionId - the session to read, when the slot bound one.
 * @param watch - a value whose change means "read again now".
 * @returns the newest reading, or undefined before one arrives.
 */
function useRolloverStatus(sessionId, watch) {
  const [status, setStatus] = useState(undefined)
  useEffect(() => {
    if (typeof sessionId !== 'string' || sessionId === '' || typeof fetch !== 'function') return undefined
    let alive = true
    let timer
    const read = () => {
      fetch(`${STATUS_ROUTE}?session=${encodeURIComponent(sessionId)}`, {
        headers: { accept: 'application/json' },
      }).then(response => (response.ok ? response.json() : null))
        .then(value => {
          // A 404 body is `null`: the host has no live session for this id, so
          // the control keeps the mode it already knows and drops the countdown.
          if (alive) setStatus(value === null || typeof value !== 'object' ? undefined : value)
        })
        .catch(() => undefined)
    }
    const schedule = () => {
      clearTimeout(timer)
      if (typeof document !== 'undefined' && document.hidden === true) return
      timer = setTimeout(() => {
        read()
        schedule()
      }, STATUS_POLL_MS)
    }
    read()
    schedule()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [sessionId, watch])
  return status
}

/**
 * Where an overlay anchored to the trigger goes, in viewport coordinates.
 *
 * Measured from the trigger's own rect on every open and on every resize or
 * scroll, because the composer moves with the conversation: a panel placed once
 * would hang in the wrong place the moment the transcript scrolls. It prefers
 * the space above the trigger — where the platform's own usage panel goes — and
 * flips below when there is not enough of it.
 * @param anchor - ref to the trigger button.
 * @param visible - whether an overlay is on screen at all.
 * @param width - the box width to reserve and clamp to, or 0 for an overlay
 *   that sizes itself (the hover bubble, which centres on the trigger and lets
 *   its own `max-content`/`max-width` decide how wide it is).
 * @returns the fixed-position style for the overlay, or undefined while hidden.
 */
function useOverlayPlacement(anchor, visible, width) {
  const [placement, setPlacement] = useState(undefined)
  useLayoutEffect(() => {
    if (!visible) {
      setPlacement(undefined)
      return undefined
    }
    const element = anchor.current
    if (element === null || element === undefined || typeof window === 'undefined') return undefined
    const place = () => {
      const box = element.getBoundingClientRect()
      const centre = box.left + box.width / 2
      const fitted = Math.min(width, window.innerWidth - 2 * OVERLAY_MARGIN)
      // A box that sizes itself only has to keep its centre on screen; one with
      // a width of its own is clamped so neither edge leaves the viewport.
      const left = width > 0
        ? Math.min(
            Math.max(OVERLAY_MARGIN + fitted / 2, centre),
            Math.max(OVERLAY_MARGIN + fitted / 2, window.innerWidth - OVERLAY_MARGIN - fitted / 2),
          )
        : centre
      setPlacement({
        left: `${Math.round(left)}px`,
        ...(box.top < PANEL_FLIP_BELOW_UNDER
          ? { top: `${Math.round(box.bottom + OVERLAY_GAP)}px` }
          : { bottom: `${Math.round(window.innerHeight - box.top + OVERLAY_GAP)}px` }),
        ...(width > 0 ? { width: `${Math.round(fitted)}px` } : {}),
      })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [visible, width])
  return placement
}

/**
 * Draw an overlay through the shell's portal when it has one.
 * @param node - the overlay element.
 * @returns the node, portalled to the document body when that is possible.
 */
function overlay(node) {
  if (createPortal === undefined || typeof document === 'undefined' || document.body === undefined) return node
  return createPortal(node, document.body)
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
  /** The trigger itself, which the overlays are anchored to. */
  const anchor = useRef(null)
  const alignment = useDockAlignment(ref)
  const [open, setOpen] = useState(false)
  const status = useRolloverStatus(props.sessionId, open)
  const [hovering, setHovering] = useState(false)
  const bubbleShown = useDelayedFlag(hovering && !open, TOOLTIP_DELAY_MS)
  // Only the panel claims a width; the bubble sizes itself and centres on the
  // trigger, the way the platform's own tooltips do.
  const placement = useOverlayPlacement(anchor, open || bubbleShown, open ? PANEL_WIDTH : 0)
  // Closing on an outside press and on Escape, the way every popover in the
  // shell does. Read from the document because the panel is portalled out of
  // this entry, so a press inside it is not inside the entry's subtree.
  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined
    const onDown = event => {
      const target = event.target
      if (contains(ref.current, target)) return
      const panel = target === null || target === undefined || typeof target.closest !== 'function'
        ? null
        : target.closest('.dsh-context-rollover-panel')
      if (panel !== null) return
      setOpen(false)
    }
    const onKey = event => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])
  /** Synchronous latch: `pending` state alone is batched and can read stale. */
  const inFlight = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(undefined)
  const t = typeof props.t === 'function' ? props.t : fallbackTranslate()
  if (mode !== 'rollover' && mode !== 'compact') return null
  const rollover = mode === 'rollover'
  ensureStyles()
  const inDock = alignment.layout === 'dock'
  const style = {
    ...(alignment.paddingRight === undefined ? {} : { paddingRight: `${alignment.paddingRight}px` }),
    // Only the column dock needs the entry pulled up onto the stats row's line;
    // the row dock already centres its items.
    ...(alignment.layout === 'overlay' ? { marginTop: ROW_LINE_PULL } : {}),
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
  const sentence = stageText(t, status)
  children.push(createElement('button', {
    key: 'mode',
    ref: anchor,
    type: 'button',
    'data-context-rollover-mode': mode,
    'data-context-rollover-pending': pending ? '' : undefined,
    disabled: pending,
    'aria-haspopup': 'dialog',
    'aria-expanded': open,
    'aria-label': `${t(rollover ? 'aria.rollover' : 'aria.compact')} — ${sentence}`,
    onClick: () => { setOpen(!open) },
    onMouseEnter: () => { setHovering(true) },
    onMouseLeave: () => { setHovering(false) },
  }, rollover ? RolloverIcon() : CompactIcon()))
  if (placement !== undefined && bubbleShown) {
    children.push(createElement('span', {
      key: 'bubble',
      className: 'dsh-context-rollover-bubble',
      role: 'tooltip',
      style: placement,
    }, sentence))
  }
  if (placement !== undefined && open) children.push(modePanel({
    key: 'panel',
    t,
    status,
    placement,
    rollover,
    pending,
    error,
    sentence,
    onToggle: () => request(!rollover),
  }))
  return createElement('div', {
    className: inDock ? 'dsh-context-rollover-mode dsh-in-dock' : 'dsh-context-rollover-mode',
    ref,
    style,
  }, ...children)
}

/**
 * A flag that follows its input after a delay, and drops the moment it does.
 *
 * The platform's tooltips wait for the pointer to settle before appearing but
 * leave at once, which is the difference between a hint and a flicker as the
 * pointer crosses the composer's pills on the way somewhere else.
 * @param active - whether the flag is being asked for.
 * @param delay - milliseconds to wait before raising it.
 * @returns whether the flag is raised yet.
 */
function useDelayedFlag(active, delay) {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!active) {
      setShown(false)
      return undefined
    }
    const timer = setTimeout(() => setShown(true), delay)
    return () => clearTimeout(timer)
  }, [active])
  return shown
}

/**
 * The panel a click opens: where the window stands, and the one control that
 * changes what happens when it fills.
 *
 * The mode is no longer toggled by the button itself — a click belongs to the
 * reader who wants the numbers — so the switch is the only way to change it,
 * and it shows which mode is on rather than which one a click would select.
 * @param props - the reading, the placement, and the control's callbacks.
 * @returns the panel element, portalled when the shell can portal.
 */
function modePanel(props) {
  const { t, status, placement, rollover, pending, error, sentence, onToggle } = props
  const used = status !== undefined && status !== null
    && typeof status.promptTokens === 'number' && typeof status.contextWindow === 'number'
    && status.contextWindow > 0
    ? status.promptTokens / status.contextWindow
    : null
  const head = used === null
    ? [createElement('span', { key: 'unknown', className: 'dsh-panel-headline' }, t('panel.unknown'))]
    : [
        createElement('span', { key: 'before', className: 'dsh-panel-headline' }, t('panel.usedBefore')),
        createElement('span', { key: 'percent', className: 'dsh-panel-percent' },
          `${Math.min(100, Math.round(used * 100))}%`),
        createElement('span', { key: 'after', className: 'dsh-panel-headline' }, t('panel.usedAfter')),
        createElement('span', { key: 'figures', className: 'dsh-panel-figures' },
          `~${formatTokens(status.promptTokens) ?? '—'} / ${formatTokens(status.contextWindow) ?? '—'}`),
      ]
  // The rungs this session actually has. A session set to standard compaction
  // never crosses this plugin's three points — its backend summarises first —
  // so its bar has one boundary, at that backend's own threshold, rather than
  // three the window will never reach.
  const compacting = status !== undefined && status !== null && status.stage === 'compacting'
  const ladder = status === undefined || status === null || status.points === undefined
    ? []
    : compacting
      ? [{ key: 'compact', at: status.points.compact, zone: 'past' }]
      : [
          { key: 'notify', at: status.points.notify, zone: 'notified' },
          { key: 'warn', at: status.points.warn, zone: 'lastChance' },
          { key: 'rollover', at: status.points.rollover, zone: 'past' },
        ]
  // A point that lands on the one after it opens no band of its own. The engine
  // reads that as a shorter ladder rather than a broken one, so the bar drops
  // the stage instead of drawing two ticks in the same pixel — and the band the
  // dropped point would have opened is absorbed by the one before it.
  const rungs = ladder.filter((rung, index) => index === ladder.length - 1 || rung.at < ladder[index + 1].at)
  /** One ratio as a percentage of the bar, clamped to it. */
  const at = ratio => Math.min(100, Math.max(0, ratio * 100))
  const zones = rungs.map((rung, index) => createElement('span', {
    key: `zone-${rung.key}`,
    className: 'dsh-bar-zone',
    'data-zone': rung.zone,
    style: { left: `${at(rung.at)}%`, width: `${at(index + 1 < rungs.length ? rungs[index + 1].at : 1) - at(rung.at)}%` },
  }))
  const marks = rungs.map(rung => createElement('span', {
    key: `mark-${rung.key}`,
    className: 'dsh-bar-mark',
    'data-mark': rung.key,
    style: { left: `${at(rung.at)}%` },
  }))
  // The key names each mark so a position never has to be read off the bar's
  // own geometry. The rung the window is heading for is the highlighted one;
  // the ones already behind it are context.
  const nextRung = rungs.find(rung => used === null || used < rung.at)
  const keys = rungs.map(rung => createElement('span', {
    key: `key-${rung.key}`,
    className: 'dsh-bar-key',
    'data-point': rung.key,
    ...(rung === nextRung ? { 'data-next': '' } : {}),
    ...(used !== null && used >= rung.at ? { 'data-passed': '' } : {}),
  },
  createElement('span', { className: 'dsh-key-dot', 'aria-hidden': true }),
  `${t(`panel.point.${rung.key}`)} ${Math.round(rung.at * 100)}%`,
  ))
  return overlay(createElement('div', {
    className: 'dsh-context-rollover-panel',
    role: 'dialog',
    'aria-label': t('panel.switch'),
    style: placement,
  },
  createElement('div', { className: 'dsh-panel-head' }, ...head),
  createElement('div', { className: 'dsh-bar' },
    ...zones,
    createElement('span', {
      className: 'dsh-bar-used',
      style: { width: `${used === null ? 0 : at(used)}%` },
    }),
    ...marks,
  ),
  keys.length === 0 ? null : createElement('p', { className: 'dsh-bar-keys' }, ...keys),
  createElement('div', {
    className: 'dsh-stage',
    'data-stage': status === undefined || status === null ? 'unknown' : status.stage,
  },
  createElement('span', { className: 'dsh-stage-dot', 'aria-hidden': true }),
  createElement('span', { className: 'dsh-stage-text' }, sentence),
  ),
  createElement('div', { className: 'dsh-switch-row' },
    createElement('span', { className: 'dsh-switch-label' }, t('panel.switch')),
    createElement('button', {
      type: 'button',
      className: 'dsh-switch',
      role: 'switch',
      'aria-checked': rollover,
      'aria-label': t('panel.switch'),
      disabled: pending,
      onClick: onToggle,
    }, createElement('span', { className: 'dsh-thumb' })),
  ),
  createElement('p', { className: 'dsh-panel-hint' }, pending ? t('panel.pending') : t('panel.switchHint')),
  error === undefined ? null : createElement('p', { className: 'dsh-warn' }, error),
  ))
}

/**
 * Whether one node contains another, without assuming a DOM is present.
 * @param node - the candidate container.
 * @param target - the event target.
 * @returns true when `target` is `node` or sits inside it.
 */
function contains(node, target) {
  if (node === null || node === undefined || target === null || target === undefined) return false
  if (node === target) return true
  if (typeof node.contains !== 'function') return false
  return node.contains(target)
}


/**
 * The ladder: the three points that fire, in the order they fire. They are
 * edited as one group and rendered in one column, because the relationship
 * between them (reminder, then the last-chance band, then the rollover) *is*
 * the setting. A two-column flow paired the band width with a retention budget
 * on the same row, which read as three unrelated numbers.
 */
const LADDER_FIELDS = [
  { key: 'reminderThresholdRatio', kind: 'percent', step: 1, labelKey: 'card.reminderThresholdRatio' },
  { key: 'lastChanceRatio', kind: 'percent', step: 1, labelKey: 'card.lastChanceRatio' },
  { key: 'thresholdRatio', kind: 'percent', step: 1, labelKey: 'card.thresholdRatio' },
]

/**
 * The rest of the surface: everything a session's owner tunes that is not part
 * of the ladder. Guardrails and tool mounts live under {@link ADVANCED_FIELDS}.
 */
const SURFACE_FIELDS = [
  { key: 'retainTokens', kind: 'number', min: 0, placeholderKey: 'card.retainTokens.unset' },
  { key: 'preempt', kind: 'boolean' },
]

/** Every field the card owns, for override counting and "reset all". */
const CARD_FIELDS = [...LADDER_FIELDS, ...SURFACE_FIELDS]

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
  const label = t(field.labelKey ?? `card.${key}`)
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
 * The ladder panel: the three ordered controls, plus a read-only line that
 * states the order they fire in.
 *
 * The three controls are points, so the summary is mostly a restatement of what
 * is already on screen. What it adds is the *width* of the last stretch, which
 * is derived from two of the boxes and belongs to neither of them, and one line
 * saying that shares scale with the window while the distances do not read the
 * same way on a small one.
 * @param t - the card's translator.
 * @param snapshot - current settings snapshot.
 * @param scope - the bound settings scope.
 * @param guardError - local coherence check shared with every field.
 * @param write - the card's write controller.
 * @returns the panel element.
 */
function ladderPanel(t, snapshot, scope, guardError, write) {
  const threshold = fieldValue(snapshot, 'thresholdRatio')
  const band = fieldValue(snapshot, 'lastChanceRatio')
  const reminder = fieldValue(snapshot, 'reminderThresholdRatio')
  const numbers = [threshold, band, reminder].every(value => typeof value === 'number')
  // Tier 2 is a point, so the only question is whether tier 1 lands before it.
  // A collapsed tier 2 (its point raised to the execute point) is a two-tier
  // ladder by choice rather than a broken one, and needs no complaint.
  const degenerate = numbers && reminder >= band
  const rows = numbers
    ? [
        t('card.ladder.reminder') + ' ' + asPercent(reminder),
        t('card.ladder.band') + ' ' + t('card.ladder.bandValue', {
          // Tier 2 is a point, so it *is* where the stretch opens; the width is
          // the derived difference up to tier 3.
          start: Math.round(band * 100),
          width: Math.round((threshold - band) * 100),
        }),
        t('card.ladder.threshold') + ' ' + asPercent(threshold),
      ]
    : [t('card.ladder.note')]
  const body = [
    createElement('div', { className: 'dsh-ladder' },
      ...LADDER_FIELDS.map(field => fieldRow(t, snapshot, scope, field, guardError, write))),
    createElement('div', { className: 'dsh-ladder-foot', key: 'ladder-foot' },
      createElement('strong', null, t('card.ladder')),
      createElement('div', { className: 'dsh-ladder-track' },
        ...rows.map((row, index) => createElement('span', { key: `row-${String(index)}` }, row))),
      createElement('span', { className: 'dsh-hint' },
        t('card.ladder.note', numbers ? { collapsed: degenerate ? 'yes' : 'no' } : {})),
    ),
  ]
  if (degenerate) {
    body.push(createElement('p', { className: 'dsh-warn', key: 'ladder-degenerate' },
      t('card.ladder.degenerate')))
  }
  return createElement('div', { className: 'dsh-ladder-group' }, ...body)
}

/**
 * Everything the configuration form does, independent of the shell it is drawn
 * in.
 *
 * The ladder and the remaining policy settings sit on the surface with the
 * guardrails behind an Advanced disclosure. Writes settle per field rather than
 * through a staged save, because every value here is a live threshold.
 *
 * A hook rather than a component because the form now has two shells — the
 * Settings card older hosts mount, and the bundle's page in the sidebar's
 * Plugins tab — and they must not drift apart. Both call this once and hand the
 * result to {@link rolloverPanel}; only the chrome around the panel differs.
 * @param props - settings-scope binding plus the shell's locale seat.
 * @returns the form's state, its translators, and its write controller.
 */
function useRolloverSettings(props) {
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
    /**
     * Refuse only a value that is itself out of order. An edit that a *later*
     * tier merely has to yield to is not the typed value's fault: the engine
     * re-derives the tiers after it, so refusing those would block lowering the
     * execute point, which is the edit a user is most likely to make. Stated
     * refusals therefore use the ordering the three points must satisfy:
     *
     *     reminder  <  last chance  <  execute
     */
    const refuse = (messageKey, values) => {
      const message = t(messageKey, values)
      setRefusal(message)
      return message
    }
    // In the units the boxes show: "0.6 is not below 0.55" printed beside
    // inputs reading 60 and 55 reads like a different pair of numbers.
    if (key === 'lastChanceRatio' && typeof threshold === 'number' && lastChance >= threshold) {
      return refuse('card.invalid.lastChance', {
        threshold: Math.round(threshold * 100),
        lastChance: Math.round(lastChance * 100),
      })
    }
    // A reminder at or after the last-chance point is dropped by the engine for
    // the rest of the window, so accepting it would save a notice that never
    // arrives. Scoped to the reminder being the edited field on purpose: the
    // same pair of numbers is *not* a refusal when the user is moving the warn
    // point down onto the notify point, because the engine re-derives a
    // round of that.
    if (key === 'reminderThresholdRatio' && typeof lastChance === 'number' && reminder >= lastChance) {
      return refuse('card.invalid.reminderOrder', {
        reminder: Math.round(reminder * 100),
        start: Math.round(lastChance * 100),
      })
    }
    // Nothing else is refused. An edit that leaves the *other* two points out of
    // order is legal: the engine re-derives them into place, and blocking it
    // would reject lowering the execute point or the warn point, which are the
    // edits a user is most likely to make. The two checks above are exactly the
    // engine's own ordering rule, applied to the value being typed.
    setRefusal(undefined)
    return undefined
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
  return {
    t,
    scope,
    snapshot,
    report,
    error,
    refusal,
    write,
    guardError,
    renderFields,
    overriddenCount,
    resetAll,
    title,
    open,
    setOpen,
    advanced,
    setAdvanced,
    preempt: preemptOf(snapshot),
    currentThreshold,
  }
}

/** Whether interception is on, from a scope snapshot. */
function preemptOf(snapshot) {
  return fieldValue(snapshot, 'preempt')
}

/**
 * The form itself, without the chrome: the reset-all row, the ladder, the
 * surface fields, the backend line, a refusal or a failure, the Advanced
 * disclosure, and the read-only notice.
 *
 * Both shells draw this exact tree, so a control added here reaches the
 * Settings card and the Plugins page together.
 * @param model - what {@link useRolloverSettings} returned.
 * @returns the body element.
 */
function rolloverPanel(model) {
  const {
    t, snapshot, scope, guardError, write, renderFields, overriddenCount, resetAll,
    advanced, setAdvanced, refusal, error, report, currentThreshold, preempt,
  } = model
  return createElement('div', { className: 'dsh-body' },
    overriddenCount > 0 && snapshot.writable !== false
      ? createElement('div', { className: 'dsh-reset-all-row' },
          createElement('button', {
            type: 'button',
            className: 'dsh-reset dsh-reset-deployment',
            onClick: resetAll,
          }, t('card.resetAll')),
        )
      : null,
    ladderPanel(t, snapshot, scope, guardError, write),
    createElement('div', { className: 'dsh-grid' }, ...renderFields(SURFACE_FIELDS)),
    systemPanel(t, report, currentThreshold, preempt),
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
}

/**
 * The Settings > Plugins card shell: a list item whose header discloses the
 * form, matching the section's own plugin cards.
 *
 * Mounted only on hosts that still declare `settings.plugin.item`; on
 * 0.1.6-alpha.2 and later nothing draws it and the Plugins page shell below is
 * the only configuration surface.
 * @param props - settings-scope binding plus the shell's locale seat.
 * @returns the card element tree.
 */
function RolloverSettingsCard(props) {
  const model = useRolloverSettings(props)
  const { t, title, open, setOpen } = model
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
    open ? rolloverPanel(model) : null,
  )
}

/**
 * The Plugins page shell: the bundle's own configuration, drawn bare.
 *
 * The page owns the title, the icon, the crumb, and the one-liner, and it asks
 * every entry for two views. `summary` is that one-liner and never the form;
 * `page` is the form, already disclosed and with no chrome of its own, because
 * the page's section is the frame. The page only ever asks for `page` here, but
 * the entry honors the contract it was registered under.
 * @param props - the view the page asks for, the scope binding, and the locale seat.
 * @returns the one-liner, or the form element.
 */
function RolloverBundleConfig(props) {
  const model = useRolloverSettings(props)
  if (props.view === 'summary') return model.t('card.intro')
  return createElement('div', { className: 'dsh-context-rollover-card dsh-page' }, rolloverPanel(model))
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
    // Both surfaces are registered, and each waits for its own declaration.
    // `inject` installs the effect when the slot is declared and cancels it when
    // the declaration collapses, so on any one host exactly the slot that host
    // declares lights up: the Settings card on hosts up to 0.1.6-alpha.1, the
    // bundle's page in the sidebar's Plugins tab from 0.1.6-alpha.2 on. The
    // other registration stays pending and costs nothing.
    scopeCtx.effect(
      () => scopedSlots.inject(LEGACY_SETTINGS_SLOT, () => scopedSlots.register({
        name: LEGACY_SETTINGS_SLOT,
        key: SETTINGS_NS,
        locale: LOCALE_NS,
        inject: () => ({ scope }),
      }, RolloverSettingsCard)),
      'context-rollover settings card',
    )
    // The key is the bundle's package name, which is what the Plugins page
    // dispatches when it opens this bundle: `dsh-context-rollover`, the name the
    // profile installs and the name `cordis.patch.yml` mounts.
    scopeCtx.effect(
      () => scopedSlots.inject(BUNDLE_CONFIG_SLOT, () => scopedSlots.register({
        name: BUNDLE_CONFIG_SLOT,
        key: BUNDLE_NAME,
        locale: LOCALE_NS,
        inject: () => ({ scope }),
      }, RolloverBundleConfig)),
      'context-rollover bundle configuration',
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
      // `remote.commands` is the same executor the composer uses, and the id is
      // what the control reads its own countdown with.
      inject: sessionId => ({
        sessionId,
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
