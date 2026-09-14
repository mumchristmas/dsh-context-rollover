/**
 * The plugin's model-facing tools: `new_context`, `get_context_remaining`,
 * `notes`, and `history`. The tools only request or report; the rollover
 * boundary itself is crossed by the engine at a safe lifecycle point.
 *
 * @module dsh-context-rollover/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { ResolvedRolloverConfig } from './config.ts'
import { readHistoryItem, searchHistory } from './history.ts'
import { NotesStore } from './notes.ts'
import { countRollovers, measuredPromptTokens, rolloverSummarySeqs } from './rollover.ts'
import type { PendingRollover } from './state.ts'

/** Runtime collaborators the tool bodies need. */
export interface RolloverToolDependencies {
  readonly config: ResolvedRolloverConfig
  readonly meter: TokenMeter
  /** Pending rollover requests keyed by session id, owned by the engine. */
  readonly pendingRollovers: Map<string, PendingRollover>
  /**
   * Whether another backend owns compaction for an agent's session (a preset
   * session reaching this host-registered tool). The engine wires its own
   * ownership check here so `new_context` stays honest everywhere.
   */
  readonly compactionOwnedElsewhere: (agent: { ctx: Context }) => boolean
}

/** Require the session an execution is running for. */
function requireSession(exec: ToolRunContext): Session {
  const session = exec.agent?.session
  if (session === undefined) {
    throw new Error('this tool requires an owning agent session')
  }
  return session
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
 * per-step context DSH injects.
 */
interface ContextRemainingResult {
  prompt_tokens: number | null
  surface_tokens: number | null
  context_window: number | null
  prompt_tokens_left: number | null
  rollover_tokens_left: number | null
}

/** The `new_context` tool: request a context boundary at the next safe point. */
function newContextTool(deps: RolloverToolDependencies) {
  return defineTool({
    name: 'new_context',
    description:
      'Start a new context window at the next safe boundary. Does not clear, reset, or otherwise affect '
      + 'environment state. Earlier conversation leaves the active context; durable notes, your handoff, '
      + 'and a recent verbatim conversation tail carry over, and full history stays recoverable via history.',
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
        },
      },
      render: (_args, rawValue) => {
        const value = rawValue as unknown as { accepted?: boolean }
        return [{
          type: 'text',
          text: value.accepted === false
            ? 'No new context window will start: this session compacts through its agent preset, '
            + 'not through context rollover. Open a new session on the standard-rollover preset to roll over; '
            + 'notes and history keep working here.'
            : 'A new context window will start without summarizing conversation history.',
        }]
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const session = requireSession(exec)
      // A preset-owned session reaches this host-registered tool only when
      // the preset does not shadow it. Recording the request would promise a
      // boundary the deferring engine never crosses, so answer honestly.
      if (exec.agent !== undefined && deps.compactionOwnedElsewhere(exec.agent)) {
        return { accepted: false }
      }
      const handoff = args.handoff ?? null
      if (handoff !== null && handoff.length > deps.config.handoffMaxChars) {
        throw new Error(
          `handoff is ${handoff.length} characters; the maximum is ${deps.config.handoffMaxChars}. `
          + 'Save larger material to notes and shorten the handoff.',
        )
      }
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
      'Report how full the context window is: the prompt tokens the next request will submit, the room '
      + 'left in the window, and the growth left before the automatic rollover. Takes no arguments; call '
      + 'it to read the measured numbers — the current context state is not derivable from repository '
      + 'files or from the plugin source.',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, rawValue) => {
        const value = rawValue as unknown as ContextRemainingResult
        if (value.prompt_tokens === null || value.context_window === null) {
          return [{
            type: 'text',
            text: 'Not measured yet: no request has reported usage in this window. '
              + 'There is no honest reading to give — call again after the next model response.',
          }]
        }
        const lines: string[] = [
          `Context window: ${value.context_window.toLocaleString('en-US')} tokens.`,
          `The next request will submit about ${value.prompt_tokens.toLocaleString('en-US')} prompt tokens `
          + `(${Math.round((value.prompt_tokens / value.context_window) * 100)}% of the window).`,
        ]
        if (value.surface_tokens !== null) {
          lines.push(
            `Of those, the active conversation accounts for about `
            + `${value.surface_tokens.toLocaleString('en-US')} tokens; the rest is the system prompt, `
            + 'tool schemas, and per-step context.',
          )
        }
        if (value.prompt_tokens_left !== null) {
          lines.push(
            `Room left in the window: about ${value.prompt_tokens_left.toLocaleString('en-US')} tokens.`,
          )
        }
        if (value.rollover_tokens_left !== null) {
          lines.push(
            `Automatic rollover in about ${value.rollover_tokens_left.toLocaleString('en-US')} tokens `
            + 'of further growth.',
          )
        }
        lines.push(
          'This is a projection that moves with every turn, not a tally of what has been spent; '
          + 'it drops when a rollover rebuilds the active context.',
        )
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(_args, exec) {
      const session = requireSession(exec)
      const contextWindow = session.requestContext()?.contextWindow ?? null
      const thresholdTokens = contextWindow === null
        ? null
        : Math.floor(contextWindow * deps.config.thresholdRatio)
      const measurement = deps.meter.measure(session)
      const promptTokens = measuredPromptTokens(measurement)
      return {
        prompt_tokens: promptTokens,
        surface_tokens: measurement.baseline.kind === 'none' ? null : measurement.surfaceTokens,
        context_window: contextWindow,
        prompt_tokens_left: contextWindow === null || promptTokens === null
          ? null
          : Math.max(0, contextWindow - promptTokens),
        rollover_tokens_left: thresholdTokens === null || promptTokens === null
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
        description: 'Maximum matches returned by search (default 20).',
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
          const matches = await store.search(args.query, args.max_matches ?? 20)
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
        description: 'Maximum matches returned by search (default 10).',
      },
      max_chars: {
        type: 'number',
        description: 'Maximum characters returned by read (default 4000).',
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
            args.max_matches ?? 10,
          )
          if (matches.length === 0) return { action: 'search', text: 'No matches in history.' }
          return {
            action: 'search',
            text: matches
              .map(match => `[seq ${match.seq}] (window ${match.window}, ${match.kind}) ${match.snippet}`)
              .join('\n---\n'),
          }
        }
        case 'read': {
          if (args.seq === undefined) throw new Error('read requires "seq"')
          const item = readHistoryItem(
            session,
            args.seq,
            windowCount,
            rolloverSeqs,
            args.max_chars ?? 4000,
          )
          if (item === null) {
            throw new Error(`no history item at seq ${args.seq} (it may still be on the active surface)`)
          }
          return { action: 'read', text: `[seq ${item.seq}] (window ${item.window}, ${item.kind})\n${item.text}` }
        }
        default:
          throw new Error(`unknown history action "${String(args.action)}"; expected search or read`)
      }
    },
  })
}

/**
 * Build the plugin's tools for one engine instance.
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
  const tools = [
    newContextTool(deps),
    getContextRemainingTool(deps),
    ...(notesEnabled ? [notesTool(deps)] : []),
    ...(historyEnabled ? [historyTool()] : []),
  ]
  return tools
}
