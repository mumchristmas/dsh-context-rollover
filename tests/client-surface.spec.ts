/**
 * Browser-half coverage: the built client artifact is loaded exactly the way
 * the shell loads it — `window.__ModuleLoader__.load({ id, factory })`, with
 * `factory(require)` answering `react` from the module table — and the mode
 * button it registers is driven against a fake command remote and a fake
 * document.
 *
 * The artifact is produced by the real build script first, so this covers the
 * wrapper (`scripts/build-client.mjs`) and the source together, not a
 * hand-simulated copy.
 *
 * @module tests/client-surface
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const buildScript = join(repoRoot, 'scripts', 'build-client.mjs')

/** One contribution captured from a fake slots service. */
interface Contribution {
  readonly options: {
    name?: string
    id?: string
    key?: string
    order?: number
    label?: string
    inject?: (sessionId: string) => unknown
  }
  readonly component: (props: Record<string, unknown>) => unknown
}

/** One recorded settings-scope write. */
type ScopeCall = [op: 'set' | 'unset', field: string, value?: unknown]

/** Minimal settings scope the card binds to. */
interface FakeScope {
  getSnapshot(): Record<string, unknown>
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
  unset(field: string): Promise<void>
  mutate(ops: ReadonlyArray<{ op: string, path: string[] }>): Promise<void>
  calls: ScopeCall[]
  mutations: Array<ReadonlyArray<{ op: string, path: string[] }>>
}

/** Load the built artifact through the shell's loader contract. */
function loadClient(): {
  id: string
  exports: { apply?: (ctx: unknown) => void, inject?: readonly string[], name?: string }
  contributions: Contribution[]
  commands: Array<{ sessionId: string, line: string }>
  effects: number
  dictionaries: Array<{ ns: string, dicts: Record<string, Record<string, string>> }>
  scope: FakeScope
  boundNamespaces: string[]
  backendRequests: string[]
  render: (component: (props: Record<string, unknown>) => unknown, props: Record<string, unknown>) => unknown
} {
  execFileSync(process.execPath, [buildScript], { cwd: repoRoot })
  const artifact = readFileSync(join(repoRoot, 'lib', 'client.js'), 'utf8')

  const contributions: Contribution[] = []
  const commands: Array<{ sessionId: string, line: string }> = []
  const backendRequests: string[] = []
  let effects = 0

  const modules: Record<string, unknown> = {
    react: {
      createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props: props ?? {}, children }),
      // The button measures itself in a layout effect; with no ref attached in
      // this JSX-free stub the effect returns early, which is what the render
      // assertions below rely on.
      useRef: () => ({ current: null }),
      useState: (initial: unknown) => {
        const index = hookCursor++
        if (hookSlots.length <= index) {
          hookSlots[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial
        }
        const set = (value: unknown): void => {
          hookSlots[index] = typeof value === 'function'
            ? (value as (current: unknown) => unknown)(hookSlots[index])
            : value
        }
        return [hookSlots[index], set]
      },
      useLayoutEffect: (callback: () => unknown) => { callback() },
      useEffect: (callback: () => unknown) => { callback() },
    },
  }
  const requireModule = (specifier: string): unknown => {
    const value = modules[specifier]
    if (value === undefined) throw new Error(`client bundle required an unknown module: ${specifier}`)
    return value
  }

  const dictionaries: Array<{ ns: string, dicts: Record<string, Record<string, string>> }> = []
  const locale = {
    register: (ns: string, dicts: Record<string, Record<string, string>>) => {
      dictionaries.push({ ns, dicts })
      return () => undefined
    },
  }
  const scope = fakeScope()
  const boundNamespaces: string[] = []
  const settingsScope = {
    bind: (spec: { namespace: string }) => {
      boundNamespaces.push(spec.namespace)
      return scope
    },
  }
  const slots = {
    inject: (_name: string, callback: () => () => void) => {
      callback()
      return () => undefined
    },
    register: (options: Contribution['options'], component: Contribution['component']) => {
      contributions.push({ options, component })
      return () => undefined
    },
  }
  /** Context the deferred `settingsScope` injection hands its callback. */
  const localeCtx = {
    get: (name: string): unknown => {
      if (name === 'locale') return locale
      if (name === 'slots') return slots
      return undefined
    },
    effect: (callback: () => unknown) => {
      effects += 1
      return callback()
    },
  }
  const scopeCtx = {
    get: (name: string): unknown => {
      if (name === 'settingsScope') return settingsScope
      if (name === 'slots') return slots
      return undefined
    },
    effect: (callback: () => unknown) => {
      effects += 1
      return callback()
    },
  }
  const ctx = {
    inject: (deps: readonly string[], callback: (ctx: unknown) => void) => {
      // The shell activates plugins in an unspecified order, so these domains
      // may become available only after this half applies.
      if (deps.includes('locale')) callback(localeCtx)
      if (deps.includes('settingsScope')) callback(scopeCtx)
    },
    get: (name: string): unknown => {
      if (name === 'slots') return slots
      if (name === 'locale') return undefined
      if (name === 'settingsScope') return undefined
      if (name === 'remote.commands') {
        return {
          execute: (sessionId: string, line: string) => {
            commands.push({ sessionId, line })
            return Promise.resolve({})
          },
        }
      }
      return undefined
    },
    effect: (callback: () => () => void) => {
      effects += 1
      callback()
    },
  }

  // A tiny hook store: hooks keep their value across re-invocations, which is
  // what lets a test click the card header and render the expanded card.
  const hookSlots: unknown[] = []
  let hookCursor = 0
  const render = (
    component: (props: Record<string, unknown>) => unknown,
    props: Record<string, unknown>,
  ): unknown => {
    hookCursor = 0
    return component(props)
  }

  const previousFetch = (globalThis as { fetch?: unknown }).fetch
  ;(globalThis as { fetch?: unknown }).fetch = (url: string) => {
    backendRequests.push(String(url))
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        observed: [{ name: 'compaction-basic', thresholdRatio: 0.8 }],
        presets: ['standard'],
        stockThresholdRatio: 0.8,
        self: { thresholdRatio: 0.75, reminderThresholdRatio: 0.6, preempt: true },
        safeBelow: 0.8,
      }),
    })
  }
  void previousFetch

  let loaded: { id: string, exports: ReturnType<typeof assertExports> } | undefined
  const loader = {
    load: ({ id, factory }: { id: string, factory: (require: unknown) => unknown }) => {
      loaded = { id, exports: assertExports(factory(requireModule)) }
    },
  }
  // The artifact is a classic script: `window`, `require`, and (for its own
  // stylesheet) `document` are the only ambient names it may use.
  new Function('window', 'require', 'document', artifact)(
    { __ModuleLoader__: loader },
    requireModule,
    fakeDocument(true),
  )
  if (loaded === undefined) throw new Error('client artifact never called __ModuleLoader__.load')
  loaded.exports.apply?.(ctx)
  return {
    id: loaded.id,
    exports: loaded.exports,
    contributions,
    commands,
    effects,
    dictionaries,
    scope,
    boundNamespaces,
    backendRequests,
    render,
  }
}

/** A settings scope stub: one overridden field, one inherited from the base. */
function fakeScope(): FakeScope {
  const calls: ScopeCall[] = []
  const mutations: FakeScope['mutations'] = []
  return {
    calls,
    mutations,
    getSnapshot: () => ({
      status: 'ready',
      writable: true,
      mode: 'host',
      revision: 3,
      value: { thresholdRatio: 0.9, preempt: true },
      base: { thresholdRatio: 0.75, reminderThresholdRatio: 0.6, retainRatio: 0.1, preempt: true },
      user: { thresholdRatio: 0.9 },
    }),
    subscribe: () => () => undefined,
    set: (field: string, value: unknown) => {
      calls.push(['set', field, value])
      return Promise.resolve()
    },
    unset: (field: string) => {
      calls.push(['unset', field])
      return Promise.resolve()
    },
    mutate: (ops: ReadonlyArray<{ op: string, path: string[] }>) => {
      mutations.push(ops)
      return Promise.resolve()
    },
  }
}

/**
 * A minimal document: enough for the injected stylesheet and for the stats-row
 * lookup the alignment depends on, with a JSX-free DOM.
 * @param statsRow - whether a `[data-composer-stats]` row is present.
 */
function fakeDocument(statsRow: boolean): unknown {
  const appended: Array<{ dataset: Record<string, unknown>, textContent: string }> = []
  const document = {
    documentElement: { lang: 'zh-CN' },
    head: { appendChild: (tag: { dataset: Record<string, unknown>, textContent: string }) => appended.push(tag) },
    createElement: () => ({ dataset: {} as Record<string, unknown>, textContent: '' }),
    querySelector: (selector: string) => {
      if (selector === '[data-composer-stats]') return statsRow ? {} : null
      return appended.some(tag => selector.includes(String(tag.dataset['pluginCss']))) ? appended[0] : null
    },
  }
  Object.defineProperty(document, 'appended', { value: appended })
  return document
}

/** The composer-dock contribution (the mode button). */
function dockContribution(loaded: { contributions: Contribution[] }): Contribution {
  const contribution = loaded.contributions
    .find(candidate => candidate.options.name === 'conversation.composer.dock')
  if (contribution === undefined) throw new Error('the button did not register into the composer dock')
  return contribution
}

/** Every element in a JSX-free element tree, depth first. */
function elementsOf(tree: unknown): Array<{ type: unknown, props: Record<string, unknown>, children?: unknown[] }> {
  const found: Array<{ type: unknown, props: Record<string, unknown>, children?: unknown[] }> = []
  const visit = (node: unknown): void => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const child of node) visit(child); return }
    const element = node as { type?: unknown, props?: Record<string, unknown>, children?: unknown[] }
    if (element.props !== undefined) {
      found.push({
        type: element.type,
        props: element.props,
        ...(element.children === undefined ? {} : { children: element.children }),
      })
    }
    for (const child of element.children ?? []) visit(child)
  }
  visit(tree)
  return found
}

/** Narrow a loaded module namespace to the plugin shape this suite asserts. */
function assertExports(value: unknown): { apply?: (ctx: unknown) => void, inject?: readonly string[], name?: string } {
  return value as { apply?: (ctx: unknown) => void, inject?: readonly string[], name?: string }
}

describe('settings card', () => {
  it('registers under its settings namespace and offers every field', () => {
    const loaded = loadClient()
    const card = loaded.contributions.find(candidate => candidate.options.name === 'settings.plugin.item')
    if (card === undefined) throw new Error('the card did not register into the plugin settings slot')
    expect(card.options.key).toBe('context-rollover')
    expect(loaded.boundNamespaces).toContain('context-rollover')

    // A shell reader that answers from this plugin's namespace.
    const props = { t: (key: string) => `T:${key}`, scope: loaded.scope }
    // Collapsed by default, exactly like the section's own plugin cards: the
    // header names the plugin, the body holds the controls.
    const collapsed = loaded.render(card.component, props)
    const header = elementsOf(collapsed).find(element => element.props['className'] === 'dsh-head')
    expect(header?.type).toBe('button')
    expect(header?.props['aria-expanded']).toBe(false)
    expect(elementsOf(collapsed).some(element => element.props['className'] === 'dsh-chevron')).toBe(true)
    expect(elementsOf(collapsed).filter(element => element.type === 'input')).toHaveLength(0)

    ;(header?.props['onClick'] as () => void)()
    const expanded = loaded.render(card.component, props)
    expect(elementsOf(expanded).some(element =>
      String(element.props['className'] ?? '').includes('dsh-open'))).toBe(true)
    const inputs = elementsOf(expanded).filter(element => element.type === 'input')
    // Four policy fields on the surface: three percentages plus the switch.
    expect(inputs).toHaveLength(4)
    const labels = inputs.map(input => input.props['aria-label'])
    expect(labels).toEqual([
      'T:card.thresholdRatio',
      'T:card.reminderThresholdRatio',
      'T:card.retainTokens',
      'T:card.preempt',
    ])
    // Values come from the resolved settings layer, so a field the user never
    // touched still shows the effective number rather than an empty box.
    const threshold = inputs[0]
    expect(threshold?.props['value']).toBe('90')
    const reminder = inputs[1]
    expect(reminder?.props['value']).toBe('60')
    // Retention is the one control whose empty state is meaningful: empty means
    // "keep the deployment's share of the window".
    const retention = inputs[2]
    expect(retention?.props['value']).toBe('')
    expect(retention?.props['placeholder']).toBe('T:card.retainTokens.unset')
    // Explanations live on the info button, not on the surface.
    // The explanation rides in a rendered tooltip, not a native title: this
    // shell shows no title tooltip.
    const info = elementsOf(expanded).find(element => element.props['className'] === 'dsh-info')
    expect(info?.props['title']).toBeUndefined()
    expect(String(info?.props['aria-describedby'])).toContain('dsh-tip-thresholdRatio')
    const tip = elementsOf(expanded).find(element => element.props['className'] === 'dsh-tip')
    expect(tip?.props['role']).toBe('tooltip')
    expect((tip?.children ?? []).join('')).toContain('T:card.thresholdRatio.hint')
    // Explanations are collected on those buttons: no field carries its own
    // hint line, so a card of fields stays scannable.
    const fieldHints = elementsOf(expanded)
      .filter(element => element.props['className'] === 'dsh-field')
      .flatMap(field => elementsOf(field.children ?? []))
      .filter(element => String(element.props['className'] ?? '').includes('dsh-hint'))
    expect(fieldHints).toHaveLength(0)
    expect(loaded.scope.calls).toHaveLength(0)

    // Guardrails and tool mounts wait behind the Advanced disclosure.
    const advanced = elementsOf(expanded).find(element => element.props['className'] === 'dsh-advanced')
    ;(advanced?.props['onClick'] as () => void)()
    const withAdvanced = elementsOf(loaded.render(card.component, props)).filter(element => element.type === 'input')
    expect(withAdvanced.map(input => input.props['aria-label'])).toEqual([
      'T:card.thresholdRatio',
      'T:card.reminderThresholdRatio',
      'T:card.retainTokens',
      'T:card.preempt',
      'T:card.handoffMaxChars',
    ])
  })

  it('warns with the threshold the host reports for the system compactor', async () => {
    const loaded = loadClient()
    const card = loaded.contributions.find(candidate => candidate.options.name === 'settings.plugin.item')
    if (card === undefined) throw new Error('no card')
    // First render starts the fetch; the report is cached, so the next render
    // (a tab switch in the real shell) shows it without another request.
    const props = { t: (key: string) => `T:${key}`, scope: loaded.scope }
    const collapsed = loaded.render(card.component, props)
    const header = elementsOf(collapsed).find(element => element.props['className'] === 'dsh-head')
    ;(header?.props['onClick'] as () => void)()
    await new Promise(resolve => setTimeout(resolve, 0))
    const text = JSON.stringify(loaded.render(card.component, props))
    expect(loaded.backendRequests).toContain('/context-rollover/backends')
    // The stubbed report says the backend fires at 0.8 while the scope's
    // effective rollover threshold is 0.9: exactly the misconfiguration the
    // guidance exists to catch.
    expect(text).toContain('T:card.warn.threshold')
    expect(text).toContain('compaction-basic')
    expect(text).toContain('standard')
    expect(text).toContain('T:card.overridden')
  })

  it('refuses a write that would invert the two thresholds before it is sent', () => {
    const loaded = loadClient()
    const card = loaded.contributions.find(candidate => candidate.options.name === 'settings.plugin.item')
    if (card === undefined) throw new Error('no card')
    const props = { t: (key: string) => `T:${key}`, scope: loaded.scope }
    const collapsed = loaded.render(card.component, props)
    const header = elementsOf(collapsed).find(element => element.props['className'] === 'dsh-head')
    ;(header?.props['onClick'] as () => void)()
    const elements = elementsOf(loaded.render(card.component, props))

    // The scope's threshold is 0.9, so a reminder of 0.95 is incoherent.
    const reminder = elements.find(element => element.props['aria-label'] === 'T:card.reminderThresholdRatio')
    ;(reminder?.props['onChange'] as (event: unknown) => void)({ target: { value: '95' } })
    expect(loaded.scope.calls).toHaveLength(0)
    const warned = JSON.stringify(loaded.render(card.component, props))
    expect(warned).toContain('T:card.invalid.reminder')

    // A coherent reminder still writes.
    ;(reminder?.props['onChange'] as (event: unknown) => void)({ target: { value: '60' } })
    expect(loaded.scope.calls.at(-1)).toEqual(['set', 'reminderThresholdRatio', 0.6])
  })

  it('clears every override in one mutation', () => {
    const loaded = loadClient()
    const card = loaded.contributions.find(candidate => candidate.options.name === 'settings.plugin.item')
    if (card === undefined) throw new Error('no card')
    const props = { t: (key: string) => `T:${key}`, scope: loaded.scope }
    const collapsed = loaded.render(card.component, props)
    const header = elementsOf(collapsed).find(element => element.props['className'] === 'dsh-head')
    ;(header?.props['onClick'] as () => void)()
    const elements = elementsOf(loaded.render(card.component, props))
    // The stub reports one overridden field (thresholdRatio), so the card
    // offers the whole-card reset next to it.
    const resetAll = elements.find(element =>
      element.type === 'button' && String(element.props['className'] ?? '').includes('dsh-reset-deployment'))
    ;(resetAll?.props['onClick'] as () => void)()
    expect(loaded.scope.mutations).toHaveLength(1)
    expect(loaded.scope.mutations[0]).toEqual([
      { op: 'unset', path: ['thresholdRatio'] },
      { op: 'unset', path: ['reminderThresholdRatio'] },
      { op: 'unset', path: ['retainTokens'] },
      { op: 'unset', path: ['preempt'] },
      { op: 'unset', path: ['handoffMaxChars'] },
    ])
  })

  it('shows real copy even when the shell reader lacks its dictionary', async () => {
    const loaded = loadClient()
    const card = loaded.contributions.find(candidate => candidate.options.name === 'settings.plugin.item')
    if (card === undefined) throw new Error('no card')
    // A shell that answers with the key itself means the namespace arrived too
    // late: the card falls back to its own table (document language) instead of
    // rendering a wall of keys.
    const props = { t: (key: string) => key, scope: loaded.scope }
    const collapsed = loaded.render(card.component, props)
    const header = elementsOf(collapsed).find(element => element.props['className'] === 'dsh-head')
    ;(header?.props['onClick'] as () => void)()
    const opened = loaded.render(card.component, props)
    const advanced = elementsOf(opened).find(element => element.props['className'] === 'dsh-advanced')
    ;(advanced?.props['onClick'] as () => void)()
    await new Promise(resolve => setTimeout(resolve, 0))
    const text = JSON.stringify(loaded.render(card.component, props))
    expect(text).toContain('Context Rollover')
    expect(text).not.toContain('card.title')
    // Ratios are quoted the way the controls express them, and the one
    // character-counted field says so.
    expect(text).toContain('80%')
    expect(text).not.toContain('@ 0.8')
    expect(text).toContain('交接文本上限（字符数）')
    // The two threshold hints describe their own field only: the card shows the
    // rollover threshold first, so no hint may point at the other one by
    // position.
    expect(text).not.toContain('上面那声哨')
    expect(text).not.toContain('缓冲带')
    expect(text).toContain('由模型自行判断如何使用')
    expect(text).toContain('保留最近对话（Token）')
    expect(text).not.toContain('tokens）')
  })

  it('writes one field and clears an override through the scope', () => {
    const loaded = loadClient()
    const card = loaded.contributions.find(candidate => candidate.options.name === 'settings.plugin.item')
    if (card === undefined) throw new Error('no card')
    const props = { t: (key: string) => `T:${key}`, scope: loaded.scope }
    const collapsed = loaded.render(card.component, props)
    const header = elementsOf(collapsed).find(element => element.props['className'] === 'dsh-head')
    ;(header?.props['onClick'] as () => void)()
    const elements = elementsOf(loaded.render(card.component, props))

    const threshold = elements.find(element => element.props['aria-label'] === 'T:card.thresholdRatio')
    ;(threshold?.props['onChange'] as (event: unknown) => void)({ target: { value: '60' } })
    expect(loaded.scope.calls.at(-1)).toEqual(['set', 'thresholdRatio', 0.6])

    const inputs = elements.filter(element => element.type === 'input')
    const preempt = inputs.find(element => element.props['aria-label'] === 'T:card.preempt')
    ;(preempt?.props['onChange'] as (event: unknown) => void)({ target: { checked: false } })
    expect(loaded.scope.calls.at(-1)).toEqual(['set', 'preempt', false])

    const reset = elements.find(element =>
      element.type === 'button'
      && String(element.props['className'] ?? '').includes('dsh-reset')
      && !String(element.props['className'] ?? '').includes('dsh-reset-deployment'))
    ;(reset?.props['onClick'] as () => void)()
    expect(loaded.scope.calls.at(-1)).toEqual(['unset', 'thresholdRatio'])
  })
})

describe('browser half', () => {
  it('declares the client entry the shell scans for', () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>
      files: string[]
      dsh: { client?: { platform?: string, inject?: string[] } }
    }
    // The client edge the shell keys the card's slot package on, per the
    // settings-card cookbook.
    expect(manifest.dsh.client).toEqual({
      platform: 'web',
      inject: ['@deepseek-ai/dsh-client-ui-settings-plugins'],
    })
    expect(manifest.exports['./client']).toEqual({ default: './lib/client.js' })
    expect(manifest.files).toContain('lib')
  })

  it('loads through the module loader and registers one composer-dock switch', () => {
    const loaded = loadClient()
    expect(loaded.id).toBe('dsh-context-rollover')
    expect(loaded.exports.name).toBe('context-rollover/client')
    expect(loaded.exports.inject).toContain('slots')
    expect(loaded.contributions.filter(c => c.options.name === 'conversation.composer.dock')).toHaveLength(1)
    const contribution = dockContribution(loaded)
    expect(contribution.options).toMatchObject({
      id: 'context-rollover',
      label: 'Context Rollover',
    })
    expect(typeof contribution?.component).toBe('function')
  })

  /** The button element the component renders for one mode. */
  function buttonFor(
    contribution: Contribution,
    mode: 'rollover' | 'compact',
    sessionId = 'session-1',
    extra: Record<string, unknown> = {},
  ): {
    button: { props: Record<string, unknown> }
    icon: { type: string, children?: Array<{ props?: { d?: string } }> }
  } {
    const setMode = contribution.options.inject?.(sessionId) as { setMode: (value: boolean) => void }
    const tree = contribution.component({ useProjection: () => mode, ...setMode, ...extra }) as {
      children?: Array<{ type: string, props: Record<string, unknown>, children?: unknown[] }>
    }
    const button = tree.children?.[0]
    if (button === undefined) throw new Error('the mode component rendered no button')
    return { button: { props: button.props }, icon: button.children?.[0] as never }
  }

  it('keeps the native pill geometry, aligned onto the stats row line', () => {
    execFileSync(process.execPath, [buildScript], { cwd: repoRoot })
    const artifact = readFileSync(join(repoRoot, 'lib', 'client.js'), 'utf8')
    // Same box as the native stat pill: 1px padding on a 20px (+ text-tier
    // delta) line, the platform's 24px corner radius and 8px side padding.
    expect(artifact).toContain('height: calc(22px + var(--dsh-content-font-delta-secondary, 0px))')
    expect(artifact).toContain('padding: 1px 8px')
    expect(artifact).toContain('border-radius: 24px')
    expect(artifact).toContain('svg { width: 16px; height: 16px; flex: none; }')
    // Mirrors the stats row's centered box, then measures the last native pill
    // so this one joins the group one pill-gap later.
    expect(artifact).toContain('max-width: var(--dsh-chat-content-width)')
    expect(artifact).toContain('margin: 0 auto')
    expect(artifact).toContain('justify-content: flex-end')
    expect(artifact).toContain("querySelector('[data-composer-stats]')")
    expect(artifact).toContain('ResizeObserver')
    expect(artifact).toContain('lastElementChild')
    expect(artifact).toContain('calc(-1 * (22px + var(--dsh-content-font-delta-secondary, 0px)))')
    // The entry spans the stats band to position one pill: its empty area must
    // not swallow the native pills' clicks, so it stays click-through.
    expect(artifact).toContain('.dsh-context-rollover-mode { pointer-events: none; }')
    expect(artifact).toContain('.dsh-context-rollover-mode > button { pointer-events: auto; }')
  })

  it('uses the two Lucide marks at the requested stroke weight', () => {
    execFileSync(process.execPath, [buildScript], { cwd: repoRoot })
    const artifact = readFileSync(join(repoRoot, 'lib', 'client.js'), 'utf8')
    expect(artifact).toContain('strokeWidth: 2.25')
    // Lucide `recycle` (headless triangles + bent arrows).
    expect(artifact).toContain('M7 19H4.815a1.83 1.83 0 0 1-1.57-.881')
    // Lucide `square-split-vertical`.
    expect(artifact).toContain('M5 8V5c0-1 1-2 2-2h10c1 0 2 1 2 2v3')
    expect(artifact).toContain('M19 16v3c0 1-1 2-2 2H7c-1 0-2-1-2-2v-3')
  })

  it('renders one icon button whose icon carries the mode', () => {
    const loaded = loadClient()
    const contribution = dockContribution(loaded)

    // Unknown mode: no control at all, rather than a lying one.
    expect(contribution.component({ useProjection: () => undefined })).toBeNull()

    const rollover = buttonFor(contribution, 'rollover')
    expect(rollover.button.props['data-context-rollover-mode']).toBe('rollover')
    expect(rollover.button.props['aria-pressed']).toBe(true)
    expect(String(rollover.button.props['title'])).toContain('滚动归档')

    const compact = buttonFor(contribution, 'compact')
    expect(compact.button.props['data-context-rollover-mode']).toBe('compact')
    expect(compact.button.props['aria-pressed']).toBe(false)
    expect(String(compact.button.props['title'])).toContain('标准压缩')

    // The two modes must not look identical: different icon paths.
    const paths = (icon: { children?: Array<{ props?: { d?: string } }> }): string =>
      (icon.children ?? []).map(child => child.props?.d ?? '').join('|')
    expect(paths(rollover.icon)).not.toBe(paths(compact.icon))
  })

  it('registers both languages under one namespace and renders through t', () => {
    const loaded = loadClient()
    expect(loaded.dictionaries).toHaveLength(1)
    const [registration] = loaded.dictionaries
    expect(registration?.ns).toBe('context-rollover')
    expect(Object.keys(registration?.dicts ?? {}).sort()).toEqual(['en', 'zh'])
    expect(Object.keys(registration?.dicts.zh ?? {}).sort())
      .toEqual(Object.keys(registration?.dicts.en ?? {}).sort())

    const contribution = dockContribution(loaded)
    // The shell hands `t` bound to the entry's namespace; the component must
    // use it rather than its own copy of the strings.
    const zhTable = registration?.dicts.zh ?? {}
    const t = (key: string): string => zhTable[key] ?? `MISSING:${key}`
    const zh = buttonFor(contribution, 'rollover', 'session-1', { t })
    expect(zh.button.props['title']).toContain('滚动归档')
    expect(zh.button.props['aria-label']).toBe('上下文管理模式：滚动归档')
    const zhCompact = buttonFor(contribution, 'compact', 'session-1', { t })
    expect(zhCompact.button.props['aria-label']).toBe('上下文管理模式：标准压缩')

    // Without a `t` the built-in fallback still answers (document language).
    const fallback = buttonFor(contribution, 'rollover')
    expect(String(fallback.button.props['title'])).not.toContain('MISSING')
  })

  it('writes the other mode through /rollover when clicked', () => {
    const loaded = loadClient()
    const contribution = dockContribution(loaded)

    const fromRollover = buttonFor(contribution, 'rollover')
    ;(fromRollover.button.props['onClick'] as () => void)()
    expect(loaded.commands.at(-1)).toEqual({ sessionId: 'session-1', line: '/rollover off' })

    const fromCompact = buttonFor(contribution, 'compact')
    ;(fromCompact.button.props['onClick'] as () => void)()
    expect(loaded.commands.at(-1)).toEqual({ sessionId: 'session-1', line: '/rollover on' })
  })

})
