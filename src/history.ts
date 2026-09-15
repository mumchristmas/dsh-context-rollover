/**
 * History: targeted read-only recovery of conversation that left the active
 * surface. The DSH session log is the only transcript store — history items
 * are the log's shadowed surface events, recovered by literal search and
 * bounded reads, never reloaded wholesale.
 *
 * Recovery is deliberately inclusive and provenance-preserving. Anything that
 * reached the model's context and cannot be reproduced belongs here, whatever
 * produced it: direct human messages, the model's own turns, tool traffic
 * (bodies, names, and arguments — a tool result is nested content, not an
 * opaque marker), and the messages collaborating agents sent this session.
 * Only regenerable plugin state is excluded, and non-human items keep the
 * attribution that says so, so a collaborator's report is never read as
 * something the human wrote.
 *
 * @module dsh-context-rollover/history
 */

import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { Seq } from './compat.ts'
import { sessionEventAt, sessionEvents } from './compat.ts'
import { isPressureReminder } from './rollover.ts'

/** Which kind of surface event one history item came from. */
export type HistoryItemKind = 'user' | 'assistant' | 'tool-result' | 'agent'

/**
 * Where one recovered item came from, when it is not direct human
 * conversation. Kept so a collaborator's message is never presented as the
 * human's own words.
 */
export interface HistoryProvenance {
  /** The logged message source kind (`agent-message`, `subagent-settled`, …). */
  readonly source: string
  /** The producer-declared context form, when it declared one. */
  readonly form?: string
  /** The producer's one-line account, when it declared one. */
  readonly summary?: string
  /** The session that sent the message, when the source names one. */
  readonly senderSessionId?: string
}

/** One recoverable history item. */
export interface HistoryItem {
  readonly seq: number
  readonly kind: HistoryItemKind
  /** 1-based number of the rollover that shadowed this item (1 = the first window). */
  readonly window: number
  /** The item's text content, with tool traffic expanded. */
  readonly text: string
  /** Present when the item is model-visible context rather than direct user text. */
  readonly provenance?: HistoryProvenance
}

/** One literal search hit over history. */
export interface HistoryMatch {
  readonly seq: number
  readonly kind: HistoryItemKind
  readonly window: number
  /** 1-based character offset of the match in the item text. */
  readonly offset: number
  /** The item text around the match, bounded for model consumption. */
  readonly snippet: string
  /** Present when the matched item carries non-human attribution. */
  readonly provenance?: HistoryProvenance
}

/**
 * Structural view of one content block, widened for merge-extensible types:
 * the plugin reads the blocks a host actually logged rather than a closed
 * union it would have to keep in step with.
 */
interface BlockShape {
  readonly type: string
  readonly text?: unknown
  readonly id?: unknown
  readonly name?: unknown
  readonly arguments?: unknown
  readonly toolCallId?: unknown
  readonly isError?: unknown
  readonly content?: readonly BlockShape[]
  readonly attachment?: { readonly id?: unknown }
}

/** Structural view of one logged message source, widened for merge-extensible kinds. */
interface SourceShape {
  readonly kind?: unknown
  readonly form?: unknown
  readonly summary?: unknown
  readonly senderSessionId?: unknown
}

/** Render one scalar inside a marker line, tolerating a field the host omitted. */
function scalar(value: unknown): string {
  if (value === undefined || value === null) return '?'
  return typeof value === 'string' ? value : String(value)
}

/** Indent every line of a text block so nested tool content stays readable. */
function indentLines(text: string, indent: string): string {
  if (indent.length === 0 || text.length === 0) return text
  return text.split('\n').map(line => `${indent}${line}`).join('\n')
}

/** An addressable placeholder for media history does not carry. */
function imagePlaceholder(block: BlockShape, indent: string): string {
  const id = block.attachment?.id
  const reference = typeof id === 'string' || typeof id === 'number' ? ` attachment=${String(id)}` : ''
  return `${indent}[image${reference}]`
}

/**
 * Render one content block as recoverable text.
 *
 * The renderer is recursive and lossless about tool traffic on purpose: a tool
 * result's blocks are the content the model actually read, so collapsing them
 * to `[tool-result]` would drop exactly what history exists to recover.
 * Reasoning and media are the documented exceptions — a marker states plainly
 * that history does not carry them rather than pretending it does.
 */
function renderBlock(block: BlockShape, indent: string): string {
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? indentLines(block.text, indent) : ''
    case 'tool-call':
      return `${indent}[tool-call id=${scalar(block.id)} name=${scalar(block.name)} `
        + `arguments=${scalar(block.arguments)}]`
    case 'tool-result': {
      const header = `${indent}[tool-result toolCallId=${scalar(block.toolCallId)} `
        + `isError=${String(block.isError === true)}]`
      const nested = block.content === undefined ? '' : renderBlocks(block.content, `${indent}  `)
      return nested.length === 0 ? header : `${header}\n${nested}`
    }
    case 'reasoning':
      return `${indent}[reasoning]`
    case 'image':
      return imagePlaceholder(block, indent)
    default:
      return `${indent}[${block.type}]`
  }
}

/** Render a block list as recoverable text, one block per line. */
function renderBlocks(blocks: readonly BlockShape[], indent: string): string {
  const parts: string[] = []
  for (const block of blocks) {
    const rendered = renderBlock(block, indent)
    if (rendered.length > 0) parts.push(rendered)
  }
  return parts.join('\n')
}

/** Extract one message's recoverable text from its blocks. */
function messageText(blocks: readonly BlockShape[]): string {
  return renderBlocks(blocks, '')
}

/** Read the attribution one non-human producer declared, omitting absent fields. */
function provenanceOf(source: SourceShape, kind: string): HistoryProvenance {
  const form = typeof source.form === 'string' ? source.form : undefined
  const summary = typeof source.summary === 'string' ? source.summary : undefined
  const senderSessionId = typeof source.senderSessionId === 'string' ? source.senderSessionId : undefined
  return {
    source: kind,
    ...form === undefined ? {} : { form },
    ...summary === undefined ? {} : { summary },
    ...senderSessionId === undefined ? {} : { senderSessionId },
  }
}

/** One recovered item's kind, text, and provenance, before window numbering. */
interface RecoveredItem {
  readonly kind: HistoryItemKind
  readonly text: string
  readonly provenance?: HistoryProvenance
}

/**
 * Recover one shadowed event's model-visible content, or `null` when the event
 * carries nothing recoverable.
 *
 * The `user/message` gate is an exclusion list, not an allow-list. Direct
 * human messages keep `kind: 'user'`; every other producer that reached the
 * context is recovered as `kind: 'agent'` with its provenance intact, because
 * the host's source vocabulary is merge-extensible (relays, settlement
 * reports, team messages, session references, and whatever a future plugin
 * adds) and an allow-list silently drops each new one. Only state this plugin
 * or the compaction transaction regenerates is left out: a rollover checkpoint
 * and a pressure reminder are reproducible notices, not conversation.
 * @param event - one logged session event.
 * @returns the recovered item, or `null` when there is nothing to recover.
 */
function recoverEvent(event: SessionEvent): RecoveredItem | null {
  switch (event.type) {
    case 'user/message': {
      // Bound before the reminder predicate runs: its negative branch narrows
      // `event` away from `user/message`, which would leave this case with
      // `never` for the payload it was already narrowed to.
      const { content, source: rawSource } = event.data
      if (isCompactCheckpointSource(rawSource)) return null
      if (isPressureReminder(event)) return null
      const source = rawSource as SourceShape
      const kind = typeof source.kind === 'string' ? source.kind : ''
      const text = messageText(content as unknown as readonly BlockShape[])
      return kind === 'user'
        ? { kind: 'user', text }
        : { kind: 'agent', text, provenance: provenanceOf(source, kind) }
    }
    case 'assistant/message':
      return {
        kind: 'assistant',
        text: messageText(event.data.message.content as unknown as readonly BlockShape[]),
      }
    case 'tool/result':
      return {
        kind: 'tool-result',
        text: messageText(event.data.message.content as unknown as readonly BlockShape[]),
      }
    default:
      return null
  }
}

/**
 * Attribute one shadowed event to its originating window: the number of
 * rollovers committed at or after the item's seq.
 * @param seq - the shadowed event's log position.
 * @param windowCount - number of rollovers committed so far.
 * @param rolloverSeqs - seqs of the rollover summary events, ascending.
 * @returns the 1-based window number the item belongs to.
 */
function windowForSeq(seq: number, windowCount: number, rolloverSeqs: readonly Seq[]): number {
  for (const rolloverSeq of rolloverSeqs) {
    if (rolloverSeq >= seq) {
      return rolloverSeqs.indexOf(rolloverSeq) + 1
    }
  }
  return windowCount + 1
}

/**
 * Collect every item that has left the active surface, in log order. Current
 * surface content is active context, not history.
 * @param session - session whose log supplies the history.
 * @param windowCount - number of rollovers committed so far (window numbering).
 * @param rolloverSeqs - seqs of the rollover summary events, ascending.
 * @returns the shadowed items, oldest first.
 */
export function collectHistory(
  session: Session,
  windowCount: number,
  rolloverSeqs: readonly Seq[],
): HistoryItem[] {
  const surface = new Set(session.surface.nodes)
  const items: HistoryItem[] = []
  for (const event of sessionEvents(session)) {
    if (surface.has(event.seq)) continue
    const recovered = recoverEvent(event)
    if (recovered === null || recovered.text.length === 0) continue
    items.push({
      seq: event.seq as Seq,
      kind: recovered.kind,
      window: windowForSeq(event.seq, windowCount, rolloverSeqs),
      text: recovered.text,
      ...recovered.provenance === undefined ? {} : { provenance: recovered.provenance },
    })
  }
  return items
}

/** Render a bounded snippet around one match. */
function snippetAround(text: string, offset: number, matchLength: number): string {
  const radius = 160
  const start = Math.max(0, offset - radius)
  const end = Math.min(text.length, offset + matchLength + radius)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  return `${prefix}${text.slice(start, end)}${suffix}`
}

/**
 * Literal case-insensitive search over history items.
 * @param session - session whose log supplies the history.
 * @param windowCount - number of rollovers committed so far.
 * @param rolloverSeqs - seqs of the rollover summary events, ascending.
 * @param query - literal substring to find.
 * @param maxMatches - upper bound on returned matches; 0 returns none.
 * @returns the matches in log order.
 */
export function searchHistory(
  session: Session,
  windowCount: number,
  rolloverSeqs: readonly Seq[],
  query: string,
  maxMatches = 10,
): HistoryMatch[] {
  const lowerQuery = query.toLowerCase()
  if (lowerQuery.length === 0 || maxMatches <= 0) return []
  const matches: HistoryMatch[] = []
  for (const item of collectHistory(session, windowCount, rolloverSeqs)) {
    const lowerText = item.text.toLowerCase()
    let offset = lowerText.indexOf(lowerQuery)
    while (offset !== -1) {
      // Checked before the push: checking after it would return one match for
      // a bound of zero, and one more than asked for at every other bound.
      if (matches.length >= maxMatches) return matches
      matches.push({
        seq: item.seq,
        kind: item.kind,
        window: item.window,
        offset,
        snippet: snippetAround(item.text, offset, lowerQuery.length),
        ...item.provenance === undefined ? {} : { provenance: item.provenance },
      })
      offset = lowerText.indexOf(lowerQuery, offset + lowerQuery.length)
    }
  }
  return matches
}

/**
 * Read one history item's text by its logged seq, without scanning the log.
 * @param session - session whose log supplies the history.
 * @param seq - the item's event seq (as returned by a search).
 * @param windowCount - number of rollovers committed so far.
 * @param rolloverSeqs - seqs of the rollover summary events, ascending.
 * @param maxChars - hard character bound for the returned text, ellipsis
 *   included; 0 returns the item with no body.
 * @returns the item, or `null` when the seq is unknown, still on the active
 *   surface, a rollover checkpoint, a pressure reminder, or carries no text.
 */
export function readHistoryItem(
  session: Session,
  seq: number,
  windowCount: number,
  rolloverSeqs: readonly Seq[],
  maxChars = 4000,
): HistoryItem | null {
  if (session.surface.nodes.includes(seq as Seq)) return null
  const event = sessionEventAt(session, seq)
  if (event === undefined) return null
  const recovered = recoverEvent(event)
  if (recovered === null || recovered.text.length === 0) return null
  const item: HistoryItem = {
    seq: event.seq as Seq,
    kind: recovered.kind,
    window: windowForSeq(event.seq, windowCount, rolloverSeqs),
    text: recovered.text,
    ...recovered.provenance === undefined ? {} : { provenance: recovered.provenance },
  }
  if (maxChars <= 0) return { ...item, text: '' }
  if (item.text.length > maxChars) {
    // The ellipsis is part of what the model receives, so it is charged to the
    // bound rather than appended past it.
    return { ...item, text: `${item.text.slice(0, maxChars - 1)}…` }
  }
  return item
}
