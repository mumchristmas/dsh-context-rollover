/**
 * The plugin's model-facing tools: `new_context`, `get_context_remaining`,
 * `notes`, and `history`. The tools only request or report; the rollover
 * boundary itself is crossed by the engine at a safe lifecycle point.
 *
 * @module dsh-context-rollover/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { ResolvedRolloverConfig } from './config.ts'
import type { RolloverMode } from './mode.ts'
import { readHistoryItem, searchHistory } from './history.ts'
import type { HistoryProvenance } from './history.ts'
import { NotesStore } from './notes.ts'
import { countRollovers, measuredPromptTokens, rolloverSummarySeqs } from './rollover.ts'
import type { PendingRollover } from './state.ts'

/** Why a model-requested boundary would not be kept. */
export type BoundaryRefusal = 'compact-mode' | 'minimal' | 'checkpoint-too-large'

/** The outcome of checking whether a requested boundary can actually commit. */
export type BoundaryCheck = 'ok' | Exclude<BoundaryRefusal, 'compact-mode'>

/** Runtime collaborators the tool bodies need. */
export interface RolloverToolDependencies {
  /**
   * Live effective configuration. Read it on every use rather than capturing
   * it: a settings-card edit must reach the next tool call without a restart,
   * and a snapshot taken at registration time would keep serving the values
   * the plugin row was mounted with.
   */
  readonly config: ResolvedRolloverConfig
  readonly meter: TokenMeter
  /** Pending rollover requests keyed by session id, owned by the engine. */
  readonly pendingRollovers: Map<string, PendingRollover>
  /**
   * Whether a rollover with this handoff would commit right now, judged on the
   * same notes/handoff budget the commit itself uses. Answering "accepted" on a
   * weaker check would promise a boundary the commit then refuses.
   */
  readonly canRollOver: (session: Session, handoff: string | null) => Promise<BoundaryCheck>
  /**
   * The session's context-management mode. A session switched to standard
   * compaction gets no boundary from this tool, and is told why.
   */
  readonly modeOf: (session: Session) => RolloverMode
  /**
   * Whether automatic rollover is actually armed for this agent. A session in
   * standard-compaction mode, or one whose own backend fires first, gets no
   * automatic boundary — reporting a countdown toward one would be a fiction.
   */
  readonly automaticArmed: (agent: Agent) => boolean
}

/** Require the agent an execution is running for. */
function requireAgent(exec: ToolRunContext): Agent {
  const agent = exec.agent
  if (agent === undefined) {
    throw new Error('this tool requires an owning agent session')
  }
  return agent
}

/** Inclusive bounds for one numeric tool argument. */
interface IntegerRange {
  readonly min: number
  readonly max: number
}

/** Bounds for the two search tools' match limits. */
const MATCH_LIMIT: IntegerRange = { min: 0, max: 200 }

/** Bounds for a history read's character limit. */
const CHAR_LIMIT: IntegerRange = { min: 0, max: 200_000 }

/** Bounds for a logged event seq. */
const SEQ_LIMIT: IntegerRange = { min: 0, max: Number.MAX_SAFE_INTEGER }

/**
 * Validate one numeric tool argument at the boundary.
 *
 * The host has already established that the value is a finite number, so this
 * is about the *meaning* of the bound. A negative, fractional, or absurd limit
 * is not a smaller limit — it is a request the tool cannot honour — and
 * coercing it silently would answer a different question than the one asked.
 * @param value - the raw argument, or undefined when it was omitted.
 * @param name - argument name, for the error text.
 * @param range - inclusive bounds the value must fall inside.
 * @returns the validated value, or undefined when the argument was omitted.
 * @throws when the value is not an integer inside the range.
 */
function boundedInteger(value: unknown, name: string, range: IntegerRange): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(
      `${name} must be an integer between ${range.min} and ${range.max}, got ${String(value)}`,
    )
  }
  if (value < range.min || value > range.max) {
    throw new Error(`${name} must be between ${range.min} and ${range.max}, got ${value}`)
  }
  return value
}

/** Require the session an execution is running for. */
function requireSession(exec: ToolRunContext): Session {
  return requireAgent(exec).session
}

/** Resolve the notes store for one session. */
function notesStoreFor(config: ResolvedRolloverConfig, session: Session): NotesStore {
  return new NotesStore(NotesStore.directoryFor(session.id, config.notesDir))
}

/**
 * The availability output of `get_context_remaining`.
 *
 * `prompt_tokens` is what the next request will submit, not a running total of
 * what has been spent: the active surface is rebuilt from notes and the recent
 * tail at a rollover, so this number can fall without any provider traffic.
 * `surface_tokens` is the part of that prompt the conversation itself
 * accounts for — the rest is the system prompt, the tool schemas, and the
 * per-step context DSH injects. `rollover_tokens_left` is null whenever no
 * automatic rollover is armed for the session, so a countdown is never shown
 * toward a boundary that will not come.
 */
interface ContextRemainingResult {
  prompt_tokens: number | null
  surface_tokens: number | null
  context_window: number | null
  prompt_tokens_left: number | null
  rollover_tokens_left: number | null
}

/** The model-facing answer for one `new_context` outcome. */
function newContextAnswer(value: { accepted?: boolean; reason?: BoundaryRefusal }): string {
  if (value.accepted !== false) {
    return 'A new context window will start without summarizing conversation history.'
  }
  switch (value.reason) {
    case 'compact-mode':
      return 'No new context window will start: this session is set to standard compaction, so its own '
        + 'backend will compact when it reaches that backend\'s threshold. Ask the human to run '
        + '/rollover on (or switch the session control) to use rollover instead.'
    case 'checkpoint-too-large':
      return 'No new context window will start: the checkpoint (durable notes plus this handoff) would be '
        + 'no smaller than the conversation it would replace, so starting a window now would free no room. '
        + 'Trim the handoff, shorten or consolidate the notes, or keep working until more conversation has '
        + 'accumulated, then ask again.'
    default:
      return 'No new context window will start: the active context is already minimal, so there is '
        + 'nothing to roll over yet. Keep working, and request the boundary again once real '
        + 'conversation has accumulated.'
  }
}

/** The `new_context` tool: request a context boundary at the next safe point. */
function newContextTool(deps: RolloverToolDependencies) {
  return defineTool({
    name: 'new_context',
    description:
      'Start a new context window at the next safe boundary. Does not clear, reset, or otherwise affect '
      + 'environment state. Earlier conversation leaves the active context; durable notes, your handoff, '
      + 'and a recent verbatim conversation tail carry over, and full history stays recoverable via history. '
      + 'The boundary always starts before the next model request, whether or not another compaction backend '
      + 'is mounted for this session.',
    parameters: {
      handoff: {
        type: 'string',
        description:
          'Short handoff for the next window: current state, immediate next steps, and anything the '
          + 'recent conversation tail cannot show. Keep it concise; save larger material to notes first.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accepted: { type: 'boolean', required: true },
          reason: { type: 'string' },
        },
      },
      render: (_args, rawValue) => [{
        type: 'text',
        text: newContextAnswer(rawValue as unknown as { accepted?: boolean; reason?: BoundaryRefusal }),
      }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const session = requireSession(exec)
      const handoff = args.handoff ?? null
      if (handoff !== null && handoff.length > deps.config.handoffMaxChars) {
        throw new Error(
          `handoff is ${handoff.length} characters; the maximum is ${deps.config.handoffMaxChars}. `
          + 'Save larger material to notes and shorten the handoff.',
        )
      }
      // The session's own switch decides first: standard-compaction sessions
      // never get a rollover boundary from this tool.
      if (deps.modeOf(session) !== 'rollover') return { accepted: false, reason: 'compact-mode' }
      // Then refuse honestly when the boundary could not actually commit. The
      // check runs the commit's own notes/handoff budget, so "accepted" is a
      // promise this tool can keep rather than one the commit later breaks.
      const check = await deps.canRollOver(session, handoff)
      if (check !== 'ok') return { accepted: false, reason: check }
      // The interceptor's own pre-step listener crosses this boundary before the
      // next request, so the request is a promise this plugin can always keep —
      // including on a session whose realm mounts an ordinary compaction
      // backend, which this plugin only preempts rather than replaces.
      deps.pendingRollovers.set(session.id, { handoff })
      return { accepted: true }
    },
  })
}

/** The `get_context_remaining` tool: report honest context headroom. */
function getContextRemainingTool(deps: RolloverToolDependencies) {
  return defineTool({
    name: 'get_context_remaining',
    description:
      'Report context-window pressure as measured numbers: `prompt used` is what the next request '
      + 'would submit (a projection that moves with every turn and drops at a rollover, not a tally of '
      + 'what was spent), `window left` is the room before the hard limit, and `rollover at` is how much '
      + 'further prompt growth remains before an automatic rollover. Takes no arguments; call it to read '
      + 'the numbers — this state is not derivable from repository files or from the plugin source.',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, rawValue) => {
        const value = rawValue as unknown as ContextRemainingResult
        if (value.prompt_tokens === null || value.context_window === null) {
          return [{ type: 'text', text: 'not measured yet' }]
        }
        const num = (n: number): string => n.toLocaleString('en-US')
        const lines = [
          `prompt used   ${num(value.prompt_tokens)} / ${num(value.context_window)} `
          + `(${Math.round((value.prompt_tokens / value.context_window) * 100)}%)`,
        ]
        if (value.surface_tokens !== null) lines.push(`  of which conversation ${num(value.surface_tokens)}`)
        if (value.prompt_tokens_left !== null) lines.push(`window left   ${num(value.prompt_tokens_left)}`)
        if (value.rollover_tokens_left !== null) {
          lines.push(`rollover in   ${num(value.rollover_tokens_left)}`)
        } else {
          lines.push('rollover      off: automatic rollover does not run for this session')
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(_args, exec) {
      const agent = requireAgent(exec)
      const session = agent.session
      const contextWindow = session.requestContext()?.contextWindow ?? null
      const thresholdTokens = contextWindow === null
        ? null
        : Math.floor(contextWindow * deps.config.thresholdRatio)
      // A countdown only means something where automatic rollover is armed: a
      // session in standard-compaction mode, or one whose own backend fires at
      // or before this threshold, never crosses this plugin's boundary.
      const armed = deps.automaticArmed(agent)
      const measurement = deps.meter.measure(session)
      const promptTokens = measuredPromptTokens(measurement)
      return {
        prompt_tokens: promptTokens,
        surface_tokens: measurement.baseline.kind === 'none' ? null : measurement.surfaceTokens,
        context_window: contextWindow,
        prompt_tokens_left: contextWindow === null || promptTokens === null
          ? null
          : Math.max(0, contextWindow - promptTokens),
        rollover_tokens_left: !armed || thresholdTokens === null || promptTokens === null
          ? null
          : Math.max(0, thresholdTokens - promptTokens),
      }
    },
  })
}

/** The `notes` tool: read and maintain durable model-managed notes. */
function notesTool(deps: RolloverToolDependencies) {
  const noteActions = 'list | read | write | append | search'
  return defineTool({
    name: 'notes',
    description:
      'Read and maintain durable notes that survive context rollovers. Notes are your own working memory: '
      + `goal, verified progress, decisions, constraints, files involved, known failures, explicit hypotheses, next steps. Actions: ${noteActions}. `
      + 'Notes are never written automatically — persist what the next context actually needs before a rollover.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: `One of: ${noteActions}.`,
      },
      path: {
        type: 'string',
        description: 'Note file path (read/write/append), e.g. "state.md" or "plans/rollout.md".',
      },
      text: {
        type: 'string',
        description: 'Text to write (write) or append (append).',
      },
      query: {
        type: 'string',
        description: 'Literal case-insensitive substring to find (search).',
      },
      max_matches: {
        type: 'number',
        description: `Maximum matches returned by search (default 20, 0..${MATCH_LIMIT.max}; 0 returns none).`,
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, rawValue) => {
        const value = rawValue as unknown as { action: string; text: string }
        return [{ type: 'text', text: value.text }]
      },
    },
    isConcurrencySafe: args => args.action === 'list' || args.action === 'read' || args.action === 'search',
    async execute(args, exec) {
      const session = requireSession(exec)
      const store = notesStoreFor(deps.config, session)
      switch (args.action) {
        case 'list': {
          const listings = await store.list()
          if (listings.length === 0) return { action: 'list', text: 'No notes stored yet.' }
          return {
            action: 'list',
            text: listings.map(listing => `${listing.path} (${listing.size} bytes)`).join('\n'),
          }
        }
        case 'read': {
          if (args.path === undefined) throw new Error('read requires "path"')
          return { action: 'read', text: await store.read(args.path) }
        }
        case 'write': {
          if (args.path === undefined || args.text === undefined) {
            throw new Error('write requires "path" and "text"')
          }
          await store.write(args.path, args.text)
          return { action: 'write', text: `Wrote ${args.path} (${args.text.length} characters).` }
        }
        case 'append': {
          if (args.path === undefined || args.text === undefined) {
            throw new Error('append requires "path" and "text"')
          }
          await store.append(args.path, args.text)
          return { action: 'append', text: `Appended to ${args.path}.` }
        }
        case 'search': {
          if (args.query === undefined) throw new Error('search requires "query"')
          const maxMatches = boundedInteger(args.max_matches, 'max_matches', MATCH_LIMIT) ?? 20
          const matches = await store.search(args.query, maxMatches)
          if (matches.length === 0) return { action: 'search', text: 'No matches.' }
          return {
            action: 'search',
            text: matches
              .map(match => `${match.path}:${match.line}: ${match.text}`)
              .join('\n'),
          }
        }
        default:
          throw new Error(`unknown notes action "${String(args.action)}"; expected one of: ${noteActions}`)
      }
    },
  })
}

/**
 * Label one history item's origin, naming the producer when the item is not
 * direct human text, so a collaborator's report is never read as the human's
 * own words.
 */
function originLabel(item: { readonly kind: string; readonly provenance?: HistoryProvenance }): string {
  if (item.provenance === undefined) return item.kind
  const from = item.provenance.senderSessionId
  return `${item.kind}: ${item.provenance.source}${from === undefined ? '' : ` from ${from}`}`
}

/** The `history` tool: targeted recovery of conversation that left the active surface. */
function historyTool() {
  return defineTool({
    name: 'history',
    description:
      'Search and read older conversation that has left the active context (for example after a context '
      + 'rollover). Use it for a specific missing detail, never to reconstruct the previous context. '
      + 'Actions: search | read.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: 'One of: search | read.',
      },
      query: {
        type: 'string',
        description: 'Literal case-insensitive substring to find (search).',
      },
      seq: {
        type: 'number',
        description: 'The event seq of the item to read, as returned by search (read).',
      },
      max_matches: {
        type: 'number',
        description: `Maximum matches returned by search (default 10, 0..${MATCH_LIMIT.max}; 0 returns none).`,
      },
      max_chars: {
        type: 'number',
        description: `Maximum characters returned by read (default 4000, 0..${CHAR_LIMIT.max}; `
          + '0 returns the item header with no body).',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, rawValue) => {
        const value = rawValue as unknown as { action: string; text: string }
        return [{ type: 'text', text: value.text }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const session = requireSession(exec)
      const windowCount = countRollovers(session)
      const rolloverSeqs = rolloverSummarySeqs(session)
      switch (args.action) {
        case 'search': {
          if (args.query === undefined) throw new Error('search requires "query"')
          const matches = searchHistory(
            session,
            windowCount,
            rolloverSeqs,
            args.query,
            boundedInteger(args.max_matches, 'max_matches', MATCH_LIMIT) ?? 10,
          )
          if (matches.length === 0) return { action: 'search', text: 'No matches in history.' }
          return {
            action: 'search',
            text: matches
              .map(match => `[seq ${match.seq}] (window ${match.window}, ${originLabel(match)}) ${match.snippet}`)
              .join('\n---\n'),
          }
        }
        case 'read': {
          const seq = boundedInteger(args.seq, 'seq', SEQ_LIMIT)
          if (seq === undefined) throw new Error('read requires "seq"')
          const item = readHistoryItem(
            session,
            seq,
            windowCount,
            rolloverSeqs,
            boundedInteger(args.max_chars, 'max_chars', CHAR_LIMIT) ?? 4000,
          )
          if (item === null) {
            throw new Error(`no history item at seq ${seq} (it may still be on the active surface)`)
          }
          const header = `[seq ${item.seq}] (window ${item.window}, ${originLabel(item)})`
          return { action: 'read', text: item.text.length === 0 ? header : `${header}\n${item.text}` }
        }
        default:
          throw new Error(`unknown history action "${String(args.action)}"; expected search or read`)
      }
    },
  })
}

/**
 * Build the tools that are always mounted for one engine instance.
 * @param deps - runtime collaborators shared with the engine.
 * @returns the always-mounted tool definitions.
 */
export function createCoreRolloverTools(deps: RolloverToolDependencies): ToolDefinition[] {
  return [newContextTool(deps), getContextRemainingTool(deps)]
}

/**
 * Build the optional tools one effective configuration enables.
 *
 * These are mounted and unmounted as the settings change, so a disabled tool
 * is genuinely absent from the model's surface rather than merely refusing.
 * @param deps - runtime collaborators shared with the engine.
 * @param enabled - which optional tools the effective configuration enables.
 * @returns the optional tool definitions to register.
 */
export function createOptionalRolloverTools(
  deps: RolloverToolDependencies,
  enabled: { readonly notes: boolean; readonly history: boolean },
): ToolDefinition[] {
  return [
    ...(enabled.notes ? [notesTool(deps)] : []),
    ...(enabled.history ? [historyTool()] : []),
  ]
}

/**
 * Build the plugin's whole tool surface for one engine instance.
 * @param deps - runtime collaborators shared with the engine.
 * @param notesEnabled - whether the `notes` tool is mounted.
 * @param historyEnabled - whether the `history` tool is mounted.
 * @returns the tool definitions to register.
 */
export function createRolloverTools(
  deps: RolloverToolDependencies,
  notesEnabled: boolean,
  historyEnabled: boolean,
): ToolDefinition[] {
  return [
    ...createCoreRolloverTools(deps),
    ...createOptionalRolloverTools(deps, { notes: notesEnabled, history: historyEnabled }),
  ]
}
