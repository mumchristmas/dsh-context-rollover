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
import { afterEach, describe, expect, it, vi } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const buildScript = join(repoRoot, 'scripts', 'build-client.mjs')

/**
 * Whatever `getComputedStyle` the host running these tests has — nothing, in
 * Node — so a dock fixture installed for one test cannot outlive it.
 */
const nativeComputedStyle = (globalThis as { getComputedStyle?: unknown }).getComputedStyle

afterEach(() => {
  ;(globalThis as { getComputedStyle?: unknown }).getComputedStyle = nativeComputedStyle
})

/** One contribution captured from a fake slots service. */
interface Contribution {
  readonly options: {
    name?: string
    id?: string
    key?: string
    order?: number
    label?: string
    locale?: string
    inject?: (sessionId: string) => unknown
  }
  readonly component: (props: Record<string, unknown>) => unknown
}

/** The mode component's rendered tree, in the shape its state lives in. */
interface ModeTree {
  children: Array<{ props: Record<string, unknown>, children?: Array<{ props?: { d?: string } }> }>
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
  /**
   * Whether the Host refuses the next mutation. The refusal shows up as an
   * unchanged snapshot, not as a resolved value: `SettingsScope` declares
   * `set`/`unset` as `Promise<void>` and absorbs the `{ ok: false }` envelope
   * internally, so a caller cannot read the outcome off the promise.
   */
  refuse: { value: boolean }
  /** Whether the next mutation rejects instead (an offline carrier). */
  reject: { value: boolean }
}

/** One fake element carrying the computed style and geometry the walk reads. */
interface DockElement {
  style: { display: string, flexDirection?: string }
  parentElement: DockElement | null
  firstElementChild: DockElement | null
  lastElementChild: DockElement | null
  children: DockElement[]
  getBoundingClientRect(): { right: number, width: number }
}

/** A fake element with the given computed display and box, empty to start. */
function dockElement(
  style: { display: string, flexDirection?: string },
  box: { right: number, width: number } = { right: 0, width: 0 },
): DockElement {
  return {
    style,
    parentElement: null,
    firstElementChild: null,
    lastElementChild: null,
    children: [],
    getBoundingClientRect: () => ({ right: box.right, width: box.width }),
  }
}

/**
 * What the mode button's refs hold when no dock fixture is in play.
 *
 * `firstElementChild` being null is the point: the alignment effect reads the
 * button from it and gives up, so a test that is not about the dock never has
 * to describe one — while the overlay placement still has a rect to measure.
 */
function inertRefTarget(): {
  firstElementChild: null
  getBoundingClientRect(): { left: number, top: number, right: number, bottom: number, width: number, height: number }
} {
  return {
    firstElementChild: null,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  }
}

/**
 * The composer as one host line lays it out.
 *
 * Both lines put a `display: contents` slot outlet between this entry and the
 * element that actually places it, so the walk has to step over one. What
 * differs is that element: the composer root, a column flex box, up to
 * 0.1.6-alpha.1 — which marks its stats row with `data-composer-stats` and needs
 * the measured overlay — and the stats row itself, a centered row flex box,
 * from 0.1.6-alpha.2, where the entry is simply one of its items.
 * @param container - the computed style of the element that places the entry.
 * @param geometry - the right edges the overlay measurement reads.
 * @param statsRow - whether the older line's `[data-composer-stats]` row exists.
 * @returns the entry element plus the row the document lookup must answer with.
 */
function fakeComposer(
  container: { display: string, flexDirection?: string },
  geometry: { entryRight: number, buttonWidth: number, anchorRight: number },
  statsRow: boolean,
): { entry: DockElement, row: DockElement | null } {
  const button = dockElement({ display: 'inline-flex' }, { right: geometry.entryRight, width: geometry.buttonWidth })
  const entry = dockElement({ display: 'flex' }, { right: geometry.entryRight, width: 0 })
  entry.firstElementChild = button
  const outlet = dockElement({ display: 'contents' })
  entry.parentElement = outlet
  outlet.parentElement = dockElement(container)
  const row = statsRow
    ? dockElement({ display: 'flex', flexDirection: 'row' }, { right: geometry.anchorRight, width: 0 })
    : null
  return { entry, row }
}

/** Load the built artifact through the shell's loader contract. */
function loadClient(dock?: { entry: DockElement, row: DockElement | null }): {
  id: string
  exports: { apply?: (ctx: unknown) => void, inject?: readonly string[], name?: string }
  contributions: Contribution[]
  commands: Array<{ sessionId: string, line: string }>
  commandResult: { value: unknown }
  effects: number
  dictionaries: Array<{ ns: string, dicts: Record<string, Record<string, string>> }>
  scope: FakeScope
  boundNamespaces: string[]
  backendRequests: string[]
  statusRequests: string[]
  statusPayload: { value: unknown }
  /** The fake document, so a test can press a key or a pointer at it. */
  document: { dispatch(type: string, event: Record<string, unknown>): void }
  render: (component: (props: Record<string, unknown>) => unknown, props: Record<string, unknown>) => unknown
} {
  execFileSync(process.execPath, [buildScript], { cwd: repoRoot })
  const artifact = readFileSync(join(repoRoot, 'lib', 'client.js'), 'utf8')

  const contributions: Contribution[] = []
  const commands: Array<{ sessionId: string, line: string }> = []
  /** What `remote.commands.execute` resolves with. */
  const commandResult: { value: unknown } = { value: {} }
  const backendRequests: string[] = []
  /** Every status poll, in order, so a test can read the session it named. */
  const statusRequests: string[] = []
  /**
   * What the status route answers. The default reading is one already inside
   * the rollover band, which is the state the control has the most to say
   * about; a test can replace it with `null` for a host that has no such
   * session, or with any other stage.
   */
  const statusPayload: { value: unknown } = {
    value: {
      mode: 'rollover',
      stage: 'rollover',
      promptTokens: 770000,
      contextWindow: 1000000,
      tokensToNext: 20000,
      points: { notify: 0.72, warn: 0.76, rollover: 0.79, compact: 0.8 },
    },
  }
  let effects = 0

  const modules: Record<string, unknown> = {
    react: {
      createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props: props ?? {}, children }),
      // The button measures itself in a layout effect and anchors its overlays
      // to itself through a second ref. A dock fixture supplies a composer to
      // walk; without one the refs attach to an element that has no button
      // inside it, so the alignment effect returns before it measures anything.
      useRef: (initial: unknown) => ({
        current: initial === null ? (dock === undefined ? inertRefTarget() : dock.entry) : null,
      }),
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
            return Promise.resolve(commandResult.value)
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
    const href = String(url)
    // One stub, two routes: the card reads the backend report and the composer
    // control polls the session reading, and both go through `fetch`.
    if (href.includes('/context-rollover/status')) {
      statusRequests.push(href)
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(statusPayload.value),
      })
    }
    backendRequests.push(href)
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        observed: [{ name: 'compaction-basic', thresholdRatio: 0.8 }],
        presets: ['standard'],
        stockThresholdRatio: 0.8,
        self: {
          thresholdRatio: 0.79,
          reminderThresholdRatio: 0.72,
          lastChanceRatio: 0.76,
          preempt: true,
        },
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
  // The alignment walk asks the browser for a computed style; outside a browser
  // the answer has to come from the fake composer's own elements. Only a fixture
  // installs this, and the suite's `afterEach` takes it back off.
  if (dock !== undefined) {
    ;(globalThis as { getComputedStyle?: unknown }).getComputedStyle =
      (element: DockElement) => element.style
  }
  // The alignment effect re-measures on resize, so the fake window carries the
  // listener pair a browser window has. Nothing fires them; the tests drive the
  // measurement by rendering, which is when a layout effect runs.
  const resizeListeners: Array<() => void> = []
  const fakeWindow = {
    __ModuleLoader__: loader,
    addEventListener: (type: string, listener: () => void) => {
      if (type === 'resize') resizeListeners.push(listener)
    },
    removeEventListener: (_type: string, listener: () => void) => {
      const index = resizeListeners.indexOf(listener)
      if (index !== -1) resizeListeners.splice(index, 1)
    },
  }
  // The artifact is a classic script: `window`, `require`, and (for its own
  // stylesheet) `document` are the only ambient names it may use.
  const document = fakeDocument(dock === undefined ? true : dock.row)
  new Function('window', 'require', 'document', artifact)(
    fakeWindow,
    requireModule,
    document,
  )
  if (loaded === undefined) throw new Error('client artifact never called __ModuleLoader__.load')
  loaded.exports.apply?.(ctx)
  return {
    id: loaded.id,
    exports: loaded.exports,
    contributions,
    commands,
    commandResult,
    effects,
    dictionaries,
    scope,
    boundNamespaces,
    backendRequests,
    statusRequests,
    statusPayload,
    document: document as { dispatch(type: string, event: Record<string, unknown>): void },
    render,
  }
}

/**
 * A settings scope stub modelled on the real contract.
 *
 * The real `SettingsScope.set`/`unset`/`mutate` resolve `Promise<void>` and
 * absorb an ordinary Host refusal inside their own `mutate`, so a refusal is
 * visible only as a snapshot that did not move. The stub therefore keeps a live
 * document that accepted writes update, and `refuse` makes the Host decline
 * without touching it — which is the situation the card has to report.
 */
function fakeScope(): FakeScope {
  const calls: ScopeCall[] = []
  const mutations: FakeScope['mutations'] = []
  const refuse: { value: boolean } = { value: false }
  const reject: { value: boolean } = { value: false }
  const base: Record<string, unknown> = {
    thresholdRatio: 0.79,
    reminderThresholdRatio: 0.72,
    lastChanceRatio: 0.76,
    retainRatio: 0.1,
    preempt: true,
  }
  let value: Record<string, unknown> = { thresholdRatio: 0.9, preempt: true }
  let user: Record<string, unknown> = { thresholdRatio: 0.9 }
  const settle = (ops: ReadonlyArray<{ op: string, path: string[], value?: unknown }>): Promise<void> => {
    if (!refuse.value && !reject.value) {
      for (const op of ops) {
        const field = op.path[0]
        if (field === undefined) continue
        if (op.op === 'unset') {
          delete user[field]
          if (field in base) value[field] = base[field]
          else delete value[field]
        } else {
          user[field] = op.value
          value[field] = op.value
        }
      }
    }
    return reject.value ? Promise.reject(new Error('carrier offline')) : Promise.resolve()
  }
  return {
    calls,
    mutations,
    refuse,
    reject,
    getSnapshot: () => ({
      status: 'ready',
      writable: true,
      mode: 'host',
      revision: 3,
      value: { ...value },
      base: { ...base },
      user: { ...user },
    }),
    subscribe: () => () => undefined,
    set: (field: string, next: unknown) => {
      calls.push(['set', field, next])
      return settle([{ op: 'set', path: [field], value: next }])
    },
    unset: (field: string) => {
      calls.push(['unset', field])
      return settle([{ op: 'unset', path: [field] }])
    },
    mutate: (ops: ReadonlyArray<{ op: string, path: string[] }>) => {
      mutations.push(ops)
      return settle(ops)
    },
  }
}

/**
 * A minimal document: enough for the injected stylesheet and for the stats-row
 * lookup the alignment depends on, with a JSX-free DOM.
 * @param statsRow - what the `[data-composer-stats]` lookup answers. `true` is
 *   the placeholder for a test that only needs the row to exist and never
 *   measures it; an alignment fixture hands over its fake row element instead,
 *   and `null` is a host that draws no stats row at all.
 */
function fakeDocument(statsRow: unknown): unknown {
  const appended: Array<{ dataset: Record<string, unknown>, textContent: string }> = []
  const listeners = new Map<string, Array<(event: Record<string, unknown>) => void>>()
  const document = {
    documentElement: { lang: 'zh-CN' },
    head: { appendChild: (tag: { dataset: Record<string, unknown>, textContent: string }) => appended.push(tag) },
    createElement: () => ({ dataset: {} as Record<string, unknown>, textContent: '' }),
    querySelector: (selector: string) => {
      if (selector === '[data-composer-stats]') return statsRow === true ? {} : statsRow
      return appended.some(tag => selector.includes(String(tag.dataset['pluginCss']))) ? appended[0] : null
    },
    // The control closes its panel on a document-level press and on Escape, so
    // the fake document carries the listener pair a real one has, and a test
    // can press either key.
    addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) => {
      const bucket = listeners.get(type)
      if (bucket === undefined) listeners.set(type, [listener])
      else bucket.push(listener)
    },
    removeEventListener: (type: string, listener: (event: Record<string, unknown>) => void) => {
      const bucket = listeners.get(type)
      if (bucket === undefined) return
      const index = bucket.indexOf(listener)
      if (index !== -1) bucket.splice(index, 1)
    },
  }
  Object.defineProperty(document, 'appended', { value: appended })
  Object.defineProperty(document, 'dispatch', {
    value: (type: string, event: Record<string, unknown>) => {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event)
    },
  })
  Object.defineProperty(document, 'listenerCount', {
    value: (type: string) => (listeners.get(type) ?? []).length,
  })
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
  /**
   * Render the card expanded through the hook store, so a state update made by
   * one interaction is visible to the next render.
   */
  function expandedCard(loaded: ReturnType<typeof loadClient>) {
    const card = loaded.contributions.find(candidate => candidate.options.name === 'settings.plugin.item')
    if (card === undefined) throw new Error('the card did not register into the plugin settings slot')
    const props = { t: (key: string) => `T:${key}`, scope: loaded.scope }
    const header = elementsOf(loaded.render(card.component, props))
      .find(element => element.props['className'] === 'dsh-head')
    ;(header?.props['onClick'] as () => void)()
    return {
      elements: () => elementsOf(loaded.render(card.component, props)),
      rerender: () => loaded.render(card.component, props),
    }
  }

  /** The card's displayed warnings, in render order. */
  function warnings(elements: ReturnType<typeof elementsOf>): string[] {
    return elements
      .filter(element => String(element.props['className'] ?? '').includes('dsh-warn'))
      .map(element => String(element.children?.[0] ?? ''))
  }

  /**
   * Type into one field and confirm it the way a user does.
   *
   * A keystroke and the confirming blur are separate events on separate
   * renders, so the blur handler closes over the draft that keystroke produced
   * instead of the value the box held before it. Collapsing them onto one
   * render would test a component that does not exist.
   */
  function typeAndConfirm(
    loaded: ReturnType<typeof loadClient>,
    card: Contribution,
    props: Record<string, unknown>,
    label: string,
    value: string,
  ): void {
    const field = (): ReturnType<typeof elementsOf>[number] | undefined =>
      elementsOf(loaded.render(card.component, props))
        .find(element => element.props['aria-label'] === label)
    ;(field()?.props['onChange'] as (event: unknown) => void)({ target: { value } })
    ;(field()?.props['onBlur'] as () => void)()
  }

  it('registers under its settings namespace and offers every field', () => {
    const loaded = loadClient()
    const card = loaded.contributions.find(candidate => candidate.options.name === 'settings.plugin.item')
    if (card === undefined) throw new Error('the card did not register into the plugin settings slot')
    expect(card.options.key).toBe('context-rollover')
    expect(loaded.boundNamespaces).toContain('context-rollover')

    // A shell reader that answers from this plugin's namespace. Values are
    // echoed into the answer so a placeholder's arguments are assertable.
    const props = {
      t: (key: string, values?: unknown) => `T:${key}${values === undefined ? '' : JSON.stringify(values)}`,
      scope: loaded.scope,
    }
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
    // Five policy fields on the surface: four percentages plus the switch.
    expect(inputs).toHaveLength(5)
    const labels = inputs.map(input => input.props['aria-label'])
    expect(labels).toEqual([
      'T:card.reminderThresholdRatio',
      'T:card.lastChanceRatio',
      'T:card.thresholdRatio',
      'T:card.retainTokens',
      'T:card.preempt',
    ])
    // Values come from the resolved settings layer, so a field the user never
    // touched still shows the effective number rather than an empty box.
    // Ladder order: the reminder fires first, then the band, then the rollover.
    const reminder = inputs[0]
    expect(reminder?.props['value']).toBe('72')
    const lastChance = inputs[1]
    expect(lastChance?.props['value']).toBe('76')
    const threshold = inputs[2]
    expect(threshold?.props['value']).toBe('90')
    // The firing order is stated on the controls themselves, not only in the
    // summary below them: the three boxes read as a sequence of numbers, and
    // 72/3/79 means nothing without the numbers 1, 2 and 3 attached.
    const tierLabels = elementsOf(expanded)
      .filter(element => String(element.props['className'] ?? '').includes('dsh-label'))
      .map(element => String(element.children?.[0] ?? ''))
    expect(tierLabels[0]?.startsWith('T:card.reminderThresholdRatio')).toBe(true)
    expect(tierLabels[1]?.startsWith('T:card.lastChanceRatio')).toBe(true)
    expect(tierLabels[2]?.startsWith('T:card.thresholdRatio')).toBe(true)
    // Retention is the one control whose empty state is meaningful: empty means
    // "keep the deployment's share of the window".
    const retention = inputs[3]
    expect(retention?.props['value']).toBe('')
    expect(retention?.props['placeholder']).toBe('T:card.retainTokens.unset')
    // Explanations live on the info button, not on the surface.
    // The explanation rides in a rendered tooltip, not a native title: this
    // shell shows no title tooltip.
    const info = elementsOf(expanded).find(element => element.props['className'] === 'dsh-info')
    expect(info?.props['title']).toBeUndefined()
    expect(String(info?.props['aria-describedby'])).toContain('dsh-tip-reminderThresholdRatio')
    const tip = elementsOf(expanded).find(element => element.props['className'] === 'dsh-tip')
    expect(tip?.props['role']).toBe('tooltip')
    expect((tip?.children ?? []).join('')).toContain('T:card.reminderThresholdRatio.hint')
    // Explanations are collected on those buttons: no field carries its own
    // hint line, so a card of fields stays scannable.
    const fieldHints = elementsOf(expanded)
      .filter(element => element.props['className'] === 'dsh-field')
      .flatMap(field => elementsOf(field.children ?? []))
      .filter(element => String(element.props['className'] ?? '').includes('dsh-hint'))
    expect(fieldHints).toHaveLength(0)
    expect(loaded.scope.calls).toHaveLength(0)

    // The ladder states the order it fires in, and each tier is reported by the
    // *point* it opens at. The width of the last stretch is derived arithmetic,
    // so the two must not be swapped: with tier 2 at 76 and tier 3 at 79 the
    // summary has to read "opens at 76 (3 wide)", never the reverse.
    const track = elementsOf(expanded).find(element => element.props['className'] === 'dsh-ladder-track')
    const tiers = (track?.children ?? []).map(child => String((child as { children?: unknown[] }).children?.[0] ?? ''))
    expect(tiers).toHaveLength(3)
    expect(tiers[0]).toContain('T:card.ladder.reminder')
    expect(tiers[0]).toContain('72')
    expect(tiers[1]).toContain('"start":76')
    expect(tiers[1]).toContain('"width":14')
    // The fixture's user layer raises the execute point to 90, so this reads 90
    // rather than the composition default: the summary follows the effective
    // values, not the shipped ones.
    expect(tiers[2]).toContain('90')
    // 72 < 76, so nothing is collapsed and the complaint must stay off. This is
    // the assertion the earlier round lacked: the check used to reconstruct the
    // warn point by subtracting a width, which made it fire on every healthy
    // ladder.
    const note = elementsOf(expanded)
      .filter(element => String(element.props['className'] ?? '').includes('dsh-ladder-hint'))
      .concat(elementsOf(expanded))
      .map(element => String(element.children?.[0] ?? ''))
      .find(text => text.includes('T:card.ladder.note'))
    expect(note).toContain('"collapsed":"no"')
    const ladderNote = elementsOf(expanded)
      .filter(element => String(element.props['className'] ?? '').includes('dsh-ladder-foot'))
      .flatMap(foot => elementsOf(foot.children ?? []))
      .find(element => String(element.props['className'] ?? '').includes('dsh-hint'))
    expect((ladderNote?.children ?? []).join('')).toContain('T:card.ladder.note')

    // Guardrails and tool mounts wait behind the Advanced disclosure.
    const advanced = elementsOf(expanded).find(element => element.props['className'] === 'dsh-advanced')
    ;(advanced?.props['onClick'] as () => void)()
    const withAdvanced = elementsOf(loaded.render(card.component, props)).filter(element => element.type === 'input')
    expect(withAdvanced.map(input => input.props['aria-label'])).toEqual([
      'T:card.reminderThresholdRatio',
      'T:card.lastChanceRatio',
      'T:card.thresholdRatio',
      'T:card.retainTokens',
      'T:card.preempt',
      'T:card.notesEnabled',
      'T:card.historyEnabled',
      'T:card.pinActiveRequest',
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

  it('refuses a reminder that would land at or after the last-chance point', () => {
    const loaded = loadClient()
    const card = loaded.contributions.find(candidate => candidate.options.name === 'settings.plugin.item')
    if (card === undefined) throw new Error('no card')
    const props = { t: (key: string) => `T:${key}`, scope: loaded.scope }
    const collapsed = loaded.render(card.component, props)
    const header = elementsOf(collapsed).find(element => element.props['className'] === 'dsh-head')
    ;(header?.props['onClick'] as () => void)()

    // The fixture's last-chance point is 0.76 and the rollover is 0.9. The
    // boundary is the point itself: 76 is already too late (the engine hands
    // that step to the last-chance tier), while anything below it is fine. That
    // comparison is against the *point*, so a card that reconstructed it by
    // subtracting a width would reject a legal value here.
    typeAndConfirm(loaded, card, props, 'T:card.reminderThresholdRatio', '76')
    expect(loaded.scope.calls).toHaveLength(0)
    const warned = JSON.stringify(loaded.render(card.component, props))
    expect(warned).toContain('T:card.invalid.reminderOrder')

    // A reminder below the point is legal even when it sits close to it: the
    // engine's one-point clearance applies to values it derives itself, so a
    // stated value must not be held to it.
    typeAndConfirm(loaded, card, props, 'T:card.reminderThresholdRatio', '73')
    expect(loaded.scope.calls.at(-1)).toEqual(['set', 'reminderThresholdRatio', 0.73])
  })

  it('offers no reset at all while every field still holds the deployment value', () => {
    // The report this answers: a fresh profile shows no reset control, which
    // reads like a lost button. It is the designed condition — presence in the
    // user layer marks a field, not a value that differs from the base — so a
    // card with nothing overridden has nothing to reset, and the control appears
    // the moment a value is stored.
    const loaded = loadClient()
    const card = loaded.contributions.find(candidate => candidate.options.name === 'settings.plugin.item')
    if (card === undefined) throw new Error('no card')
    const props = { t: (key: string) => `T:${key}`, scope: loaded.scope }
    const header = elementsOf(loaded.render(card.component, props))
      .find(element => element.props['className'] === 'dsh-head')
    ;(header?.props['onClick'] as () => void)()

    const buttons = (): string[] => elementsOf(loaded.render(card.component, props))
      .filter(element => element.type === 'button')
      .map(element => String(element.props['className'] ?? ''))
    // The fixture starts with one override, so exactly one per-field reset and
    // the whole-card reset are offered — never a control with nothing to undo.
    expect(buttons().filter(name => name === 'dsh-reset')).toHaveLength(1)
    expect(buttons()).toContain('dsh-reset dsh-reset-deployment')
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
      { op: 'unset', path: ['reminderThresholdRatio'] },
      { op: 'unset', path: ['lastChanceRatio'] },
      { op: 'unset', path: ['thresholdRatio'] },
      { op: 'unset', path: ['retainTokens'] },
      { op: 'unset', path: ['preempt'] },
      { op: 'unset', path: ['notesEnabled'] },
      { op: 'unset', path: ['historyEnabled'] },
      { op: 'unset', path: ['pinActiveRequest'] },
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
    expect(text).toContain('窗口正在变满')
    expect(text).toContain('保留最近对话（Token）')
    expect(text).not.toContain('tokens）')
  })

  it('writes one field and clears an override through the scope', async () => {
    const loaded = loadClient()
    const card = loaded.contributions.find(candidate => candidate.options.name === 'settings.plugin.item')
    if (card === undefined) throw new Error('no card')
    const props = { t: (key: string) => `T:${key}`, scope: loaded.scope }
    const collapsed = loaded.render(card.component, props)
    const header = elementsOf(collapsed).find(element => element.props['className'] === 'dsh-head')
    ;(header?.props['onClick'] as () => void)()

    typeAndConfirm(loaded, card, props, 'T:card.thresholdRatio', '60')
    expect(loaded.scope.calls.at(-1)).toEqual(['set', 'thresholdRatio', 0.6])
    // The card holds every control while one write is in flight, so the next
    // edit waits for the scope to settle — exactly as it does in the browser.
    await Promise.resolve()
    await Promise.resolve()

    const inputs = elementsOf(loaded.render(card.component, props)).filter(element => element.type === 'input')
    const preempt = inputs.find(element => element.props['aria-label'] === 'T:card.preempt')
    ;(preempt?.props['onChange'] as (event: unknown) => void)({ target: { checked: false } })
    expect(loaded.scope.calls.at(-1)).toEqual(['set', 'preempt', false])
    await Promise.resolve()
    await Promise.resolve()

    const reset = elementsOf(loaded.render(card.component, props)).find(element =>
      element.type === 'button'
      && String(element.props['className'] ?? '').includes('dsh-reset')
      && !String(element.props['className'] ?? '').includes('dsh-reset-deployment'))
    ;(reset?.props['onClick'] as () => void)()
    expect(loaded.scope.calls.at(-1)).toEqual(['unset', 'thresholdRatio'])
  })

  it('reports a refused write, which only the unchanged snapshot reveals', async () => {
    const loaded = loadClient()
    const card = loaded.contributions.find(candidate => candidate.options.name === 'settings.plugin.item')
    if (card === undefined) throw new Error('no card')
    const props = { t: (key: string) => `T:${key}`, scope: loaded.scope }
    const header = elementsOf(loaded.render(card.component, props))
      .find(element => element.props['className'] === 'dsh-head')
    ;(header?.props['onClick'] as () => void)()

    // A Host refusal neither rejects nor carries a result: `SettingsScope`
    // resolves `void` either way and absorbs the `{ ok: false }` envelope, so
    // the snapshot that did not move is the only evidence the card can act on.
    loaded.scope.refuse.value = true
    typeAndConfirm(loaded, card, props, 'T:card.thresholdRatio', '60')

    // While the write is in flight the card's controls are held.
    const held = elementsOf(loaded.render(card.component, props))
      .find(element => element.props['aria-label'] === 'T:card.thresholdRatio')
    expect(held?.props['disabled']).toBe(true)

    await Promise.resolve()
    await Promise.resolve()
    expect(warnings(elementsOf(loaded.render(card.component, props)))).toContain('T:card.writeFailed')
  })

  it('clears the failure line once a later write lands', async () => {
    const loaded = loadClient()
    const card = loaded.contributions.find(candidate => candidate.options.name === 'settings.plugin.item')
    if (card === undefined) throw new Error('no card')
    const props = { t: (key: string) => `T:${key}`, scope: loaded.scope }
    const header = elementsOf(loaded.render(card.component, props))
      .find(element => element.props['className'] === 'dsh-head')
    ;(header?.props['onClick'] as () => void)()

    loaded.scope.refuse.value = true
    typeAndConfirm(loaded, card, props, 'T:card.thresholdRatio', '60')
    await Promise.resolve()
    await Promise.resolve()
    expect(warnings(elementsOf(loaded.render(card.component, props)))).toContain('T:card.writeFailed')

    // The line describes one failure. If nothing retires it, the card goes on
    // accusing a setting that a later write did save.
    loaded.scope.refuse.value = false
    typeAndConfirm(loaded, card, props, 'T:card.thresholdRatio', '60')
    await Promise.resolve()
    await Promise.resolve()
    expect(warnings(elementsOf(loaded.render(card.component, props)))).not.toContain('T:card.writeFailed')
  })

  it('clears the failure line once a later reset lands', async () => {
    const loaded = loadClient()
    const card = expandedCard(loaded)
    const resetButton = (): ReturnType<typeof elementsOf>[number] | undefined =>
      card.elements().find(element =>
        element.type === 'button'
        && String(element.props['className'] ?? '').includes('dsh-reset-deployment'))

    loaded.scope.refuse.value = true
    ;(resetButton()?.props['onClick'] as () => void)()
    await Promise.resolve()
    await Promise.resolve()
    expect(warnings(card.elements())).toContain('T:card.writeFailed')

    loaded.scope.refuse.value = false
    ;(resetButton()?.props['onClick'] as () => void)()
    await Promise.resolve()
    await Promise.resolve()
    expect(warnings(card.elements())).not.toContain('T:card.writeFailed')
  })

  it('states the refusal in the units the fields show', () => {
    const loaded = loadClient()
    const card = loaded.contributions.find(candidate => candidate.options.name === 'settings.plugin.item')
    if (card === undefined) throw new Error('no card')
    // Values are captured so the assertion can see what the copy was handed.
    const props = {
      t: (key: string, values?: unknown) => `T:${key}${values === undefined ? '' : JSON.stringify(values)}`,
      scope: loaded.scope,
    }
    const header = elementsOf(loaded.render(card.component, props))
      .find(element => element.props['className'] === 'dsh-head')
    ;(header?.props['onClick'] as () => void)()

    // The refusal has to speak in the units the user is looking at, not in raw
    // ratios: 95 is refused against the 87 the last-chance band opens at, which
    // is the box pair the user can actually compare.
    typeAndConfirm(loaded, card, props, 'T:card.reminderThresholdRatio', '95')
    const shown = warnings(elementsOf(loaded.render(card.component, props))).join('\n')
    expect(shown).toContain('"reminder":95')
    expect(shown).toContain('"start":76')
  })

  it('says nothing when the settled snapshot holds what the write asked for', async () => {
    const loaded = loadClient()
    const card = loaded.contributions.find(candidate => candidate.options.name === 'settings.plugin.item')
    if (card === undefined) throw new Error('no card')
    const props = { t: (key: string) => `T:${key}`, scope: loaded.scope }
    const header = elementsOf(loaded.render(card.component, props))
      .find(element => element.props['className'] === 'dsh-head')
    ;(header?.props['onClick'] as () => void)()

    typeAndConfirm(loaded, card, props, 'T:card.thresholdRatio', '60')
    await Promise.resolve()
    await Promise.resolve()
    // The stub applies accepted writes to its document, so the field settles on
    // 0.6: the comparison must stay quiet rather than crying wolf every time.
    expect(warnings(elementsOf(loaded.render(card.component, props)))).not.toContain('T:card.writeFailed')
  })

  it('writes only the value that was confirmed, never an intermediate keystroke', () => {
    const loaded = loadClient()
    const card = loaded.contributions.find(candidate => candidate.options.name === 'settings.plugin.item')
    if (card === undefined) throw new Error('no card')
    const props = { t: (key: string) => `T:${key}`, scope: loaded.scope }
    const header = elementsOf(loaded.render(card.component, props))
      .find(element => element.props['className'] === 'dsh-head')
    ;(header?.props['onClick'] as () => void)()
    const field = (): ReturnType<typeof elementsOf>[number] | undefined =>
      elementsOf(loaded.render(card.component, props))
        .find(element => element.props['aria-label'] === 'T:card.thresholdRatio')

    // Typing 65 passes through 6. Neither is a value the user chose, and
    // because settings apply live, an intermediate write would change the
    // rollover policy for real before the number was finished.
    ;(field()?.props['onChange'] as (event: unknown) => void)({ target: { value: '6' } })
    ;(field()?.props['onChange'] as (event: unknown) => void)({ target: { value: '65' } })
    expect(loaded.scope.calls).toHaveLength(0)

    ;(field()?.props['onBlur'] as () => void)()
    expect(loaded.scope.calls).toEqual([['set', 'thresholdRatio', 0.65]])
  })

  it('confirms a draft on Enter as well as on blur', () => {
    const loaded = loadClient()
    const card = loaded.contributions.find(candidate => candidate.options.name === 'settings.plugin.item')
    if (card === undefined) throw new Error('no card')
    const props = { t: (key: string) => `T:${key}`, scope: loaded.scope }
    const header = elementsOf(loaded.render(card.component, props))
      .find(element => element.props['className'] === 'dsh-head')
    ;(header?.props['onClick'] as () => void)()
    const field = (): ReturnType<typeof elementsOf>[number] | undefined =>
      elementsOf(loaded.render(card.component, props))
        .find(element => element.props['aria-label'] === 'T:card.thresholdRatio')

    ;(field()?.props['onChange'] as (event: unknown) => void)({ target: { value: '65' } })
    ;(field()?.props['onKeyDown'] as (event: unknown) => void)({
      key: 'Enter',
      preventDefault: () => undefined,
    })
    expect(loaded.scope.calls).toEqual([['set', 'thresholdRatio', 0.65]])
  })

  it('restores the stored value on Escape without writing', () => {
    const loaded = loadClient()
    const card = loaded.contributions.find(candidate => candidate.options.name === 'settings.plugin.item')
    if (card === undefined) throw new Error('no card')
    const props = { t: (key: string) => `T:${key}`, scope: loaded.scope }
    const header = elementsOf(loaded.render(card.component, props))
      .find(element => element.props['className'] === 'dsh-head')
    ;(header?.props['onClick'] as () => void)()
    const field = (): ReturnType<typeof elementsOf>[number] | undefined =>
      elementsOf(loaded.render(card.component, props))
        .find(element => element.props['aria-label'] === 'T:card.thresholdRatio')

    ;(field()?.props['onChange'] as (event: unknown) => void)({ target: { value: '65' } })
    ;(field()?.props['onKeyDown'] as (event: unknown) => void)({ key: 'Escape' })
    // The abandoned draft is gone, so the later blur confirms nothing.
    expect(field()?.props['value']).toBe('90')
    ;(field()?.props['onBlur'] as () => void)()
    expect(loaded.scope.calls).toHaveLength(0)
  })

  it('consumes Escape while a draft is open and leaves it alone otherwise', () => {
    const loaded = loadClient()
    const card = loaded.contributions.find(candidate => candidate.options.name === 'settings.plugin.item')
    if (card === undefined) throw new Error('no card')
    const props = { t: (key: string) => `T:${key}`, scope: loaded.scope }
    const header = elementsOf(loaded.render(card.component, props))
      .find(element => element.props['className'] === 'dsh-head')
    ;(header?.props['onClick'] as () => void)()
    const field = (): ReturnType<typeof elementsOf>[number] | undefined =>
      elementsOf(loaded.render(card.component, props))
        .find(element => element.props['aria-label'] === 'T:card.thresholdRatio')

    // The shell closes the settings surface on Escape. Reverting a draft is
    // this control's own use of the key, so the event must not also reach the
    // shell — one Escape otherwise reverted the box and dismissed the page.
    const seen: string[] = []
    const escape = {
      key: 'Escape',
      preventDefault: () => seen.push('preventDefault'),
      stopPropagation: () => seen.push('stopPropagation'),
    }
    ;(field()?.props['onChange'] as (event: unknown) => void)({ target: { value: '65' } })
    ;(field()?.props['onKeyDown'] as (event: unknown) => void)(escape)
    expect(seen).toEqual(['preventDefault', 'stopPropagation'])
    expect(loaded.scope.calls).toHaveLength(0)

    // Nothing to revert, so the key belongs to the shell again: a focused field
    // must not become a keyboard trap for the close gesture.
    seen.length = 0
    ;(field()?.props['onKeyDown'] as (event: unknown) => void)(escape)
    expect(seen).toEqual([])
  })

  it('mounts the two tool switches and writes them', () => {
    const loaded = loadClient()
    const card = loaded.contributions.find(candidate => candidate.options.name === 'settings.plugin.item')
    if (card === undefined) throw new Error('no card')
    const props = { t: (key: string) => `T:${key}`, scope: loaded.scope }
    const header = elementsOf(loaded.render(card.component, props))
      .find(element => element.props['className'] === 'dsh-head')
    ;(header?.props['onClick'] as () => void)()
    const advanced = elementsOf(loaded.render(card.component, props))
      .find(element => element.props['className'] === 'dsh-advanced')
    ;(advanced?.props['onClick'] as () => void)()

    const toggle = (label: string): ReturnType<typeof elementsOf>[number] | undefined =>
      elementsOf(loaded.render(card.component, props))
        .find(element => element.props['aria-label'] === label)
    // The engine mounts and unmounts these tools as the values change, so the
    // card has to be able to turn them back on from here.
    expect(toggle('T:card.notesEnabled')).toBeDefined()
    expect(toggle('T:card.historyEnabled')).toBeDefined()

    ;(toggle('T:card.notesEnabled')?.props['onChange'] as (event: unknown) => void)({
      target: { checked: false },
    })
    expect(loaded.scope.calls.at(-1)).toEqual(['set', 'notesEnabled', false])
  })

  it('reports a rejected write when the carrier fails outright', async () => {
    const loaded = loadClient()
    const card = loaded.contributions.find(candidate => candidate.options.name === 'settings.plugin.item')
    if (card === undefined) throw new Error('no card')
    const props = { t: (key: string) => `T:${key}`, scope: loaded.scope }
    const header = elementsOf(loaded.render(card.component, props))
      .find(element => element.props['className'] === 'dsh-head')
    ;(header?.props['onClick'] as () => void)()

    loaded.scope.reject.value = true
    typeAndConfirm(loaded, card, props, 'T:card.thresholdRatio', '60')
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(warnings(elementsOf(loaded.render(card.component, props)))).toContain('T:card.writeFailed')
  })

  it('reports a refused reset-all instead of throwing over it', async () => {
    const loaded = loadClient()
    // The Host refusing the reset leaves the overrides in place; a rejection is
    // the transport-level shape of the same failure. Here the Host refuses.
    loaded.scope.refuse.value = true
    const card = expandedCard(loaded)
    const resetAll = card.elements().find(element =>
      element.type === 'button'
      && String(element.props['className'] ?? '').includes('dsh-reset-deployment'))
    expect(resetAll).toBeDefined()
    ;(resetAll?.props['onClick'] as () => void)()

    // The rejection path used to call an undefined name, so a failed reset
    // surfaced as a ReferenceError rather than as the failure itself.
    await Promise.resolve()
    await Promise.resolve()
    expect(loaded.scope.mutations).toHaveLength(1)
    expect(warnings(card.elements())).toContain('T:card.writeFailed')
  })

  it('reports a reset-all whose carrier rejected', async () => {
    const loaded = loadClient()
    loaded.scope.reject.value = true
    const card = expandedCard(loaded)
    const resetAll = card.elements().find(element =>
      element.type === 'button'
      && String(element.props['className'] ?? '').includes('dsh-reset-deployment'))
    ;(resetAll?.props['onClick'] as () => void)()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(warnings(card.elements())).toContain('T:card.writeFailed')
  })
})

describe('plugins page configuration', () => {
  /**
   * The bundle-configuration contribution the sidebar's Plugins tab dispatches.
   *
   * 0.1.6-alpha.2 removed the Settings surface and moved a plugin's
   * configuration onto its own page in the Plugins tab, keyed by the bundle's
   * package name. Without this registration the page lists the bundle and opens
   * it to an empty configuration section — the state this covers.
   */
  function bundleConfig(loaded: ReturnType<typeof loadClient>): Contribution {
    const contribution = loaded.contributions
      .find(candidate => candidate.options.name === 'plugins.bundle.config')
    if (contribution === undefined) throw new Error('the form did not register into the bundle configuration slot')
    return contribution
  }

  it('registers under the bundle package name the page dispatches', () => {
    const loaded = loadClient()
    const card = bundleConfig(loaded)
    expect(card.options.key).toBe('dsh-context-rollover')
    expect(card.options.locale).toBe('context-rollover')
    // One bound scope serves both surfaces, so a value written from either is
    // the same value: binding twice would give the two forms separate snapshots.
    expect(loaded.boundNamespaces).toEqual(['context-rollover'])
  })

  it('keeps the legacy Settings registration beside the new one', () => {
    const loaded = loadClient()
    const names = loaded.contributions.map(candidate => candidate.options.name)
    // Both are registered and each waits for its own declaration, so hosts
    // before 0.1.6-alpha.2 still draw the card while later hosts draw the page.
    expect(names).toContain('settings.plugin.item')
    expect(names).toContain('plugins.bundle.config')
    const legacy = loaded.contributions.find(candidate => candidate.options.name === 'settings.plugin.item')
    expect(legacy?.options.key).toBe('context-rollover')
  })

  it('answers summary with the one-liner and page with the disclosed form', () => {
    const loaded = loadClient()
    const card = bundleConfig(loaded)
    const props = { t: (key: string) => `T:${key}`, scope: loaded.scope, view: 'summary' }
    // `summary` is the one-liner the page prints under the title, never a form.
    expect(loaded.render(card.component, props)).toBe('T:card.intro')

    const tree = loaded.render(card.component, { ...props, view: 'page' })
    const elements = elementsOf(tree)
    // The page draws the title, the icon, and the crumb, so this entry draws the
    // form bare: a plain element rather than the Settings card's list item, and
    // no disclosure header, because an open page has nothing left to disclose.
    expect((tree as { type: unknown }).type).toBe('div')
    expect(elements.some(element => element.type === 'li')).toBe(false)
    expect(elements.some(element => element.props['className'] === 'dsh-head')).toBe(false)
    expect(elements.some(element =>
      String(element.props['className'] ?? '').includes('dsh-page'))).toBe(true)
    // The same five surface fields the Settings card shows, already on screen.
    const inputs = elements.filter(element => element.type === 'input')
    expect(inputs.map(input => input.props['aria-label'])).toEqual([
      'T:card.reminderThresholdRatio',
      'T:card.lastChanceRatio',
      'T:card.thresholdRatio',
      'T:card.retainTokens',
      'T:card.preempt',
    ])
    expect(inputs[2]?.props['value']).toBe('90')
  })

  it('writes through the same scope from the Plugins page', () => {
    const loaded = loadClient()
    const card = bundleConfig(loaded)
    const props = { t: (key: string) => `T:${key}`, scope: loaded.scope, view: 'page' }
    // The keystroke and the confirming blur are separate renders, exactly as in
    // the Settings card: the page changes the chrome, not the write path.
    const field = (): ReturnType<typeof elementsOf>[number] | undefined =>
      elementsOf(loaded.render(card.component, props))
        .find(element => element.props['aria-label'] === 'T:card.thresholdRatio')
    ;(field()?.props['onChange'] as (event: unknown) => void)({ target: { value: '65' } })
    ;(field()?.props['onBlur'] as () => void)()
    expect(loaded.scope.calls).toEqual([['set', 'thresholdRatio', 0.65]])
  })

  it('carries the Advanced fields behind the disclosure on the page too', () => {
    const loaded = loadClient()
    const card = bundleConfig(loaded)
    const props = { t: (key: string) => `T:${key}`, scope: loaded.scope, view: 'page' }
    const advanced = elementsOf(loaded.render(card.component, props))
      .find(element => element.props['className'] === 'dsh-advanced')
    expect(advanced?.type).toBe('button')
    ;(advanced?.props['onClick'] as () => void)()
    const labels = elementsOf(loaded.render(card.component, props))
      .filter(element => element.type === 'input')
      .map(input => input.props['aria-label'])
    expect(labels).toContain('T:card.notesEnabled')
    expect(labels).toContain('T:card.handoffMaxChars')
  })
})

describe('composer dock alignment', () => {
  /**
   * Render the button twice: the alignment effect runs inside the render it
   * belongs to, exactly as a layout effect does before paint, so the state it
   * sets is what the next render sees.
   */
  function aligned(loaded: ReturnType<typeof loadClient>): {
    className: string
    style: Record<string, unknown>
  } {
    const contribution = dockContribution(loaded)
    const setMode = contribution.options.inject?.('session-1') as Record<string, unknown>
    const props = { useProjection: () => 'rollover', ...setMode }
    loaded.render(contribution.component, props)
    const tree = loaded.render(contribution.component, props) as {
      props: { className: string, style: Record<string, unknown> }
    }
    return { className: tree.props.className, style: tree.props.style }
  }

  it('joins the row the 0.1.6-alpha.2 dock lays out, and measures nothing', () => {
    // The stats row is the entry's container, so the row's own gap places it.
    const loaded = loadClient(fakeComposer(
      { display: 'flex', flexDirection: 'row' },
      { entryRight: 975, buttonWidth: 32, anchorRight: 1051 },
      true,
    ))
    const { className, style } = aligned(loaded)
    expect(className).toBe('dsh-context-rollover-mode dsh-in-dock')
    // Nothing to add: a measured overlay offset here is what pushed the button
    // into the middle of the band, ahead of the usage donut that follows it.
    expect(style).toEqual({})
  })

  it('still overlays the column dock, one pill-gap past the last pill', () => {
    // The composer root is the container, and the stats row marks itself: the
    // entry spans the row's box (right edge 1035), the button is 32 wide, and
    // the last pill ends at 959. The padding therefore works out to
    // 1035 − 959 − 12 − 32 = 32, which lands the button at 971..1003 — one
    // 12px pill-gap after the pill, which is the whole point of the offset.
    const loaded = loadClient(fakeComposer(
      { display: 'flex', flexDirection: 'column' },
      { entryRight: 1035, buttonWidth: 32, anchorRight: 959 },
      true,
    ))
    const { className, style } = aligned(loaded)
    expect(className).toBe('dsh-context-rollover-mode')
    expect(style).toEqual({
      paddingRight: '32px',
      marginTop: 'calc(-1 * (22px + var(--dsh-content-font-delta-secondary, 0px)))',
    })
  })

  it('falls back to a plain entry when a column dock draws no stats row', () => {
    // Neither shape: no row to align to, so the entry keeps its own box rather
    // than being pulled up over content that is not there.
    const loaded = loadClient(fakeComposer(
      { display: 'flex', flexDirection: 'column' },
      { entryRight: 1035, buttonWidth: 32, anchorRight: 0 },
      false,
    ))
    const { className, style } = aligned(loaded)
    expect(className).toBe('dsh-context-rollover-mode')
    expect(style).toEqual({})
  })
})

describe('browser half', () => {
  it('declares the client entry the shell scans for', () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>
      files: string[]
      dsh: { client?: { platform?: string, inject?: string[] } }
    }
    // The client edges the shell composes the module graph from: the Settings
    // section that declares the legacy card's slot, and the Plugins page that
    // declares the one 0.1.6-alpha.2 moved configuration onto. A host missing
    // either simply has no row to arrive, which the boot graph tolerates.
    expect(manifest.dsh.client).toEqual({
      platform: 'web',
      inject: [
        '@deepseek-ai/dsh-client-ui-settings-plugins',
        '@deepseek-ai/dsh-client-ui-plugin-manager',
      ],
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
    // The older column dock: mirror the stats row's centered box, then measure
    // the last native pill so this one joins the group one pill-gap later.
    expect(artifact).toContain('max-width: var(--dsh-chat-content-width)')
    expect(artifact).toContain('margin: 0 auto')
    expect(artifact).toContain('justify-content: flex-end')
    expect(artifact).toContain("querySelector('[data-composer-stats]')")
    expect(artifact).toContain('ResizeObserver')
    expect(artifact).toContain('lastElementChild')
    expect(artifact).toContain('calc(-1 * (22px + var(--dsh-content-font-delta-secondary, 0px)))')
    // The 0.1.6-alpha.2 row dock: the entry is one flex item of the stats row,
    // so it shrinks to the button and takes no margin for the row to distribute.
    expect(artifact).toContain('.dsh-context-rollover-mode.dsh-in-dock {')
    expect(artifact).toContain('width: auto;')
    expect(artifact).toContain('margin: 0;')
    expect(artifact).toContain('justify-content: flex-start;')
    // The row/column decision reads the container past the `display: contents`
    // slot outlet, because that is the element whose flex rules place the entry.
    expect(artifact).toContain("display === 'contents'")
    expect(artifact).toContain("flexDirection === 'row' ? 'row' : 'column'")
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
    // The click belongs to the numbers now, not to the mode: the trigger opens
    // the panel, and nothing about it says "pressed".
    expect(rollover.button.props['aria-haspopup']).toBe('dialog')
    expect(rollover.button.props['aria-expanded']).toBe(false)
    expect(rollover.button.props['aria-pressed']).toBeUndefined()
    expect(rollover.button.props['title']).toBeUndefined()
    expect(String(rollover.button.props['aria-label'])).toContain('滚动归档')

    const compact = buttonFor(contribution, 'compact')
    expect(compact.button.props['data-context-rollover-mode']).toBe('compact')
    expect(String(compact.button.props['aria-label'])).toContain('标准压缩')

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
    expect(String(zh.button.props['aria-label'])).toContain('滚动归档')
    // Nothing on any surface may fall back to a raw key.
    expect(JSON.stringify(loaded.render(contribution.component, {
      useProjection: () => 'rollover',
      ...(contribution.options.inject?.('session-1') as Record<string, unknown>),
      t,
    }))).not.toContain('MISSING')

    // Without a `t` the built-in fallback still answers (document language).
    const fallback = buttonFor(contribution, 'rollover')
    expect(String(fallback.button.props['aria-label'])).not.toContain('MISSING')
  })

  /**
   * Open the panel the way a reader does — one click on the trigger — and hand
   * back its switch plus a re-render, so a test can drive the mode from the one
   * control that changes it.
   *
   * The extra render is the placement effect's: it runs inside the render that
   * asks for the overlay and sets the measured position, which the next render
   * reads — React's own ordering, before paint.
   */
  function openPanel(
    loaded: ReturnType<typeof loadClient>,
    contribution: Contribution,
    props: Record<string, unknown>,
  ): { switch: () => { props: Record<string, unknown> } | undefined, root: () => unknown } {
    const trigger = () => elementsOf(loaded.render(contribution.component, props))
      .find(element => element.props['data-context-rollover-mode'] !== undefined)
    ;(trigger()?.props['onClick'] as () => void)()
    loaded.render(contribution.component, props)
    const root = () => loaded.render(contribution.component, props)
    return {
      switch: () => elementsOf(root()).find(element => element.props['className'] === 'dsh-switch'),
      root,
    }
  }

  it('opens the panel on click and changes the mode from its switch', () => {
    const loaded = loadClient()
    const contribution = dockContribution(loaded)

    const fromRollover = openPanel(loaded, contribution, {
      useProjection: () => 'rollover',
      ...(contribution.options.inject?.('session-1') as Record<string, unknown>),
    })
    // Opening it wrote nothing: the trigger is not a toggle any more.
    expect(loaded.commands).toHaveLength(0)
    const rolloverSwitch = fromRollover.switch()
    expect(rolloverSwitch?.props['role']).toBe('switch')
    expect(rolloverSwitch?.props['aria-checked']).toBe(true)
    ;(rolloverSwitch?.props['onClick'] as () => void)()
    expect(loaded.commands.at(-1)).toEqual({ sessionId: 'session-1', line: '/rollover off' })
  })

  it('switches the other way from standard compaction', () => {
    const loaded = loadClient()
    const contribution = dockContribution(loaded)
    const panel = openPanel(loaded, contribution, {
      useProjection: () => 'compact',
      ...(contribution.options.inject?.('session-1') as Record<string, unknown>),
    })
    const control = panel.switch()
    expect(control?.props['aria-checked']).toBe(false)
    ;(control?.props['onClick'] as () => void)()
    expect(loaded.commands.at(-1)).toEqual({ sessionId: 'session-1', line: '/rollover on' })
  })

  it('reports a refused mode change instead of silently keeping the old mode', async () => {
    const loaded = loadClient()
    const contribution = dockContribution(loaded)
    // A handler that refuses settles as `CommandExecution { commandId, result }`
    // with `result.kind === 'error'`. The outcome lives in `result`, so reading
    // the top level — as this once did — finds no failure at all.
    loaded.commandResult.value = { commandId: 'c1', result: { kind: 'error', text: 'mode change rejected' } }
    const props = {
      useProjection: () => 'rollover',
      ...(contribution.options.inject?.('session-1') as Record<string, unknown>),
    }
    const panel = openPanel(loaded, contribution, props)
    ;(panel.switch()?.props['onClick'] as () => void)()
    await Promise.resolve()
    await Promise.resolve()

    expect(loaded.commands.at(-1)).toEqual({ sessionId: 'session-1', line: '/rollover off' })
    // Still the old mode — no optimistic flip — but the failure is visible,
    // both beside the trigger and inside the panel that asked for it.
    const after = panel.root() as ModeTree
    const afterButton = elementsOf(after).find(element => element.props['data-context-rollover-mode'] !== undefined)
    expect(afterButton?.props['data-context-rollover-mode']).toBe('rollover')
    const error = elementsOf(after).find(element => element.props['className'] === 'dsh-mode-error')
    expect(String(error?.children?.[0] ?? '')).toContain('mode change rejected')
    expect(JSON.stringify(after)).toContain('mode change rejected')
  })

  it('treats an admission miss as a failed mode change', async () => {
    const loaded = loadClient()
    const contribution = dockContribution(loaded)
    // `undefined` is the documented admission miss: the line never reached a
    // handler, so nothing changed and the switch must not claim otherwise.
    loaded.commandResult.value = undefined
    const props = {
      useProjection: () => 'rollover',
      ...(contribution.options.inject?.('session-1') as Record<string, unknown>),
    }
    const panel = openPanel(loaded, contribution, props)
    ;(panel.switch()?.props['onClick'] as () => void)()
    await Promise.resolve()
    await Promise.resolve()

    const error = elementsOf(panel.root())
      .find(element => element.props['className'] === 'dsh-mode-error')
    expect(error).toBeDefined()
    // No detail is available for an admission miss, but the control still has to
    // say that nothing happened rather than silently keeping the old mode.
    expect(String(error?.children?.[0] ?? '')).toMatch(/模式未切换|Mode not changed/)
  })

  it('reads a failure the Remote seam reports as an envelope', async () => {
    const loaded = loadClient()
    const contribution = dockContribution(loaded)
    // The sibling settings scope unwraps a `{ ok, error }` envelope, so the same
    // shape is handled here even though the typed contract does not name it.
    loaded.commandResult.value = { ok: false, error: { code: 'gateway/internal', message: 'carrier offline' } }
    const props = {
      useProjection: () => 'rollover',
      ...(contribution.options.inject?.('session-1') as Record<string, unknown>),
    }
    const panel = openPanel(loaded, contribution, props)
    ;(panel.switch()?.props['onClick'] as () => void)()
    await Promise.resolve()
    await Promise.resolve()

    const error = elementsOf(panel.root())
      .find(element => element.props['className'] === 'dsh-mode-error')
    expect(String(error?.children?.[0] ?? '')).toContain('carrier offline')
  })

  it('holds the switch while its change is in flight', async () => {
    const loaded = loadClient()
    const contribution = dockContribution(loaded)
    const props = {
      useProjection: () => 'rollover',
      ...(contribution.options.inject?.('session-1') as Record<string, unknown>),
    }
    const panel = openPanel(loaded, contribution, props)
    const click = panel.switch()?.props['onClick'] as () => void

    click()
    // A second click before the first settles would queue the opposite change.
    click()
    expect(loaded.commands).toHaveLength(1)
    expect(panel.switch()?.props['disabled']).toBe(true)

    await Promise.resolve()
    await Promise.resolve()
    expect(panel.switch()?.props['disabled']).toBe(false)
  })

  /** Open the panel and let the reading the poll fetched arrive. */
  async function panelWithReading(
    loaded: ReturnType<typeof loadClient>,
    props: Record<string, unknown>,
  ): Promise<ReturnType<typeof elementsOf>> {
    const contribution = dockContribution(loaded)
    loaded.render(contribution.component, props)
    // A macrotask, not a microtask: the poll's two-then chain has to finish
    // before the render that reads it, and `await Promise.resolve()` does not
    // order against it.
    await new Promise(resolve => setTimeout(resolve, 0))
    // The placement lands one render after the click, which `openPanel` covers.
    return elementsOf(openPanel(loaded, contribution, props).root())
  }

  it('polls the session reading and draws it: header, tier marks, and stage', async () => {
    const loaded = loadClient()
    const elements = await panelWithReading(loaded, {
      useProjection: () => 'rollover',
      ...(dockContribution(loaded).options.inject?.('session-1') as Record<string, unknown>),
    })
    // The reading is per session, and the control asks for its own.
    expect(loaded.statusRequests.at(-1)).toContain('/context-rollover/status?session=session-1')
    const figures = elements.find(element => element.props['className'] === 'dsh-panel-figures')
    expect(String(figures?.children?.[0] ?? '')).toBe('~770K / 1M')
    const used = elements.find(element => element.props['className'] === 'dsh-bar-used')
    expect((used?.props['style'] as Record<string, string>)['width']).toBe('77%')

    // The three rungs of the ladder, and not the compaction point while the
    // session is in rollover mode.
    const marks = elements.filter(element => element.props['className'] === 'dsh-bar-mark')
    expect(marks.map(element => element.props['data-mark'])).toEqual(['notify', 'warn', 'rollover'])
    expect(marks.map(element => (element.props['style'] as Record<string, string>)['left']))
      .toEqual(['72%', '76%', '79%'])
    // The band each rung opens, tinted in the same signal order as its tick:
    // green, amber, red.
    const zones = elements.filter(element => element.props['className'] === 'dsh-bar-zone')
    expect(zones.map(element => [
      element.props['data-zone'],
      (element.props['style'] as Record<string, string>)['left'],
      (element.props['style'] as Record<string, string>)['width'],
    ])).toEqual([['notified', '72%', '4%'], ['lastChance', '76%', '3%'], ['past', '79%', '21%']])
    // The key names each mark and its position, so neither has to be read off
    // the bar's own geometry.
    const keys = elements.filter(element => element.props['className'] === 'dsh-bar-key')
    expect(keys.map(element => `${String(element.children?.[1] ?? '')}`))
      .toEqual(['提示 72%', '预警 76%', '换窗 79%'])
    // At 77% the first two rungs are behind the window and the third is the one
    // it is heading for.
    expect(keys.map(element => element.props['data-next'] !== undefined))
      .toEqual([false, false, true])
    expect(keys.map(element => element.props['data-passed'] !== undefined))
      .toEqual([true, true, false])

    const stage = elements.find(element => element.props['className'] === 'dsh-stage')
    expect(stage?.props['data-stage']).toBe('rollover')
    const sentence = elements.find(element => element.props['className'] === 'dsh-stage-text')
    expect(String(sentence?.children?.[0] ?? '')).toContain('自动滚动就位')
    // 20,000 tokens, abbreviated the way the platform's own pills abbreviate.
    expect(String(sentence?.children?.[0] ?? '')).toContain('20K')
  })

  it('drops a stage whose band collapsed onto the next one', async () => {
    const loaded = loadClient()
    // The execute point lowered onto the warn point: the engine re-derives a
    // two-tier ladder rather than refusing the edit, so the bar has two rungs,
    // not three with two ticks in the same pixel.
    loaded.statusPayload.value = {
      mode: 'rollover',
      stage: 'rollover',
      promptTokens: 700000,
      contextWindow: 1000000,
      tokensToNext: 40000,
      points: { notify: 0.72, warn: 0.74, rollover: 0.74, compact: 0.8 },
    }
    const elements = await panelWithReading(loaded, {
      useProjection: () => 'rollover',
      ...(dockContribution(loaded).options.inject?.('session-1') as Record<string, unknown>),
    })
    expect(elements
      .filter(element => element.props['className'] === 'dsh-bar-mark')
      .map(element => element.props['data-mark'])).toEqual(['notify', 'rollover'])
    expect(elements
      .filter(element => element.props['className'] === 'dsh-bar-zone')
      .map(element => [
        element.props['data-zone'],
        (element.props['style'] as Record<string, string>)['width'],
      ])).toEqual([['notified', '2%'], ['past', '26%']])
    expect(elements
      .filter(element => element.props['className'] === 'dsh-bar-key')
      .map(element => String(element.children?.[1] ?? ''))).toEqual(['提示 72%', '换窗 74%'])
  })

  it('draws the compaction point when the window will be summarised', async () => {
    const loaded = loadClient()
    loaded.statusPayload.value = {
      mode: 'compact',
      stage: 'compacting',
      promptTokens: 500000,
      contextWindow: 1000000,
      tokensToNext: 300000,
      points: { notify: 0.72, warn: 0.76, rollover: 0.79, compact: 0.8 },
    }
    const elements = await panelWithReading(loaded, {
      useProjection: () => 'compact',
      ...(dockContribution(loaded).options.inject?.('session-1') as Record<string, unknown>),
    })
    // One boundary, not four: this session never crosses the plugin's three
    // points, so drawing them would mark rungs the window will never reach.
    expect(elements
      .filter(element => element.props['className'] === 'dsh-bar-mark')
      .map(element => element.props['data-mark'])).toEqual(['compact'])
    expect(elements
      .filter(element => element.props['className'] === 'dsh-bar-zone')
      .map(element => element.props['data-zone'])).toEqual(['past'])
    const keys = elements.filter(element => element.props['className'] === 'dsh-bar-key')
    expect(keys.map(element => String(element.children?.[1] ?? ''))).toEqual(['压缩 80%'])
    const sentence = elements.find(element => element.props['className'] === 'dsh-stage-text')
    expect(String(sentence?.children?.[0] ?? '')).toContain('300K')
  })

  it('re-reads the moment the panel opens, so its marks are never a poll behind', async () => {
    const loaded = loadClient()
    const contribution = dockContribution(loaded)
    const props = {
      useProjection: () => 'rollover',
      ...(contribution.options.inject?.('session-1') as Record<string, unknown>),
    }
    loaded.render(contribution.component, props)
    await new Promise(resolve => setTimeout(resolve, 0))
    const afterMount = loaded.statusRequests.length
    expect(afterMount).toBeGreaterThan(0)
    // The rungs are the configuration's, and the configuration can be edited on
    // another page between polls: opening the panel asks again rather than
    // showing marks that are up to an interval stale.
    openPanel(loaded, contribution, props)
    expect(loaded.statusRequests.length).toBeGreaterThan(afterMount)
  })

  it('shows the stage sentence in the hover bubble, after the hover delay', () => {
    vi.useFakeTimers()
    try {
      const loaded = loadClient()
      const contribution = dockContribution(loaded)
      const props = {
        useProjection: () => 'rollover',
        ...(contribution.options.inject?.('session-1') as Record<string, unknown>),
      }
      const bake = () => elementsOf(loaded.render(contribution.component, props))
      const trigger = () => bake().find(element => element.props['data-context-rollover-mode'] !== undefined)
      const bubble = () => bake().find(element => element.props['className'] === 'dsh-context-rollover-bubble')
      expect(bubble()).toBeUndefined()
      ;(trigger()?.props['onMouseEnter'] as () => void)()
      // Not yet: the platform's tooltips wait for the pointer to settle.
      loaded.render(contribution.component, props)
      expect(bubble()).toBeUndefined()
      vi.advanceTimersByTime(400)
      // One render for the flag, one for the position it is drawn at.
      loaded.render(contribution.component, props)
      const shown = bubble()
      expect(shown?.props['role']).toBe('tooltip')
      // No reading has arrived yet, so the sentence says so rather than lying.
      expect(String(shown?.children?.[0] ?? '')).toMatch(/尚未测量|not measured/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes the panel on Escape and on a press outside it', () => {
    const loaded = loadClient()
    const contribution = dockContribution(loaded)
    const props = {
      useProjection: () => 'rollover',
      ...(contribution.options.inject?.('session-1') as Record<string, unknown>),
    }
    const panel = openPanel(loaded, contribution, props)
    expect(panel.switch()).toBeDefined()
    loaded.document.dispatch('keydown', { key: 'Escape' })
    expect(panel.switch()).toBeUndefined()

    const reopened = openPanel(loaded, contribution, props)
    expect(reopened.switch()).toBeDefined()
    // A press whose target is neither the entry nor the panel.
    loaded.document.dispatch('pointerdown', { target: { closest: () => null } })
    expect(reopened.switch()).toBeUndefined()
  })
})
