/**
 * Host-version compatibility helpers. Public dsh releases lag the internal
 * line: the newer line exposes the session log through `snapshotEvents()`,
 * while the published line exposes it as the `events` array. The replace
 * `surfaceOp` moved the same way: newer hosts take `{ op: 'replace', startSeq,
 * endSeq }`, older ones `{ op: 'replace', start, end }`, and both reject the
 * other shape.
 *
 * That second one is a *released* fact rather than something to discover, so
 * {@link declareHostVersion} lets a deployment that can name its session
 * package settle it outright; {@link replaceSurfaceOp} keeps probing for the
 * deployments that cannot. Both roads reach the same cached answer.
 *
 * ## Why the synchronous log readers stay
 *
 * DSH 0.1.6 deprecates `snapshotEvents`, `eventAt`, and `ownEvents` — with no
 * removal date, and with DSH itself still calling them behind lint waivers. The
 * documented replacements are session projections for *state* and asynchronous
 * paged reads (`ctx.sessionQuery`) for *history*. Neither replaces what this
 * module does, and the plugin should not pretend otherwise:
 *
 * - `ctx.sessionQuery` reads through storage, which is a different and
 *   potentially lagging source than the live session this plugin is deciding
 *   about. Filtering a live surface against a stored log is how a rollover
 *   would come to disagree with itself, so history is read from the live log.
 * - Derived state is a genuinely better fit for projections, and the one state
 *   read this plugin makes — the per-session mode — goes through the registry
 *   when the host has one (see `mode.ts`).
 *
 * So these readers remain the correct API for the live-log question being
 * asked. They are deliberately funnelled through this module: it is the single
 * place to change if a host ever stops offering them.
 *
 * @module dsh-context-rollover/compat
 */

import { randomUUID } from 'node:crypto'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/**
 * One host-typed surface/log position: a branded seq on newer hosts, a plain
 * number on the published rc line. Values of this type always originate from
 * host APIs, so both shapes flow in without casts.
 */
export type Seq = Session['surface']['nodes'][number]

/**
 * Read one session's full event log across host versions.
 * @param session - the session whose log to read.
 * @returns the logged events in order.
 */
export function sessionEvents(session: Session): readonly SessionEvent[] {
  const reader = session as {
    snapshotEvents?: () => readonly SessionEvent[]
    events?: readonly SessionEvent[]
  }
  return reader.snapshotEvents !== undefined
    ? reader.snapshotEvents()
    : (reader.events ?? [])
}

/**
 * Read one logged event by seq across host versions: newer hosts expose
 * `session.eventAt(seq)`, older ones expose the `events` array directly.
 * @param session - the session to read.
 * @param seq - the event's log position.
 * @returns the event, or `undefined` when the log has no event at that seq.
 */
export function sessionEventAt(session: Session, seq: number): SessionEvent | undefined {
  const withEventAt = session as unknown as { eventAt?: (seq: number) => SessionEvent | undefined }
  if (withEventAt.eventAt !== undefined) return withEventAt.eventAt(seq)
  return sessionEvents(session)[seq]
}

/** One priced surface node, as shaped by either host line. */
interface SurfaceNode {
  readonly seq: number
  readonly tokens: number
  readonly heuristicTokens?: number
}

/**
 * Read a surface node's heuristic price across host versions: newer hosts
 * carry a separate `heuristicTokens` field, older ones price nodes with the
 * fixed heuristic in `tokens` directly.
 * @param node - one priced surface node from a meter measurement.
 * @returns the node's fixed-heuristic token price.
 */
export function nodeHeuristicTokens(node: SurfaceNode): number {
  return node.heuristicTokens ?? node.tokens
}

/** One parsed host version: numeric release fields plus the prerelease tail. */
interface HostVersion {
  readonly release: readonly [number, number, number]
  readonly prerelease: readonly string[]
}

/**
 * Parse one `@deepseek-ai/dsh-*` version string.
 *
 * Only the shape those packages actually publish is accepted (`0.1.5-rc.2`,
 * `0.1.6-alpha.1`, `0.0.1-rc.1`, or a bare `1.2.3`). Anything else — a git
 * specifier, a workspace link, a dist-tag that leaked through — parses to
 * `undefined`, which callers must read as "unknown", never as "old".
 * @param version - the raw version string, when the caller resolved one.
 * @returns the parsed version, or `undefined` when it is not recognizable.
 */
function parseHostVersion(version: string | undefined): HostVersion | undefined {
  if (version === undefined) return undefined
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version.trim())
  if (match === null) return undefined
  return {
    release: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/**
 * Compare two prerelease identifier lists by semver precedence: a version with
 * no prerelease outranks one with any, numeric identifiers rank below
 * alphanumeric ones, and otherwise comparison is per identifier (numerically
 * for numbers, by code unit for strings).
 */
function comparePrerelease(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) {
    return left.length === right.length ? 0 : left.length === 0 ? 1 : -1
  }
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    if (a === b) continue
    const aNumeric = /^\d+$/.test(a)
    const bNumeric = /^\d+$/.test(b)
    if (aNumeric && bNumeric) return Number(a) < Number(b) ? -1 : 1
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
    return a < b ? -1 : 1
  }
  return 0
}

/**
 * The first host line whose `replace` surface op takes `startSeq`/`endSeq`.
 * Everything at or after it uses the seq shape; every earlier published line
 * (0.0.1-rc.*, 0.1.0-rc.*, 0.1.1-rc.*, 0.1.2-*, 0.1.3-alpha.*) takes
 * `{ start, end }`. Verified against the published declaration files.
 */
const SEQ_OP_SINCE: HostVersion = { release: [0, 1, 5], prerelease: ['alpha', '1'] }

/**
 * Classify one host version into the `replace` surface op it validates.
 *
 * The deterministic alternative to {@link hostTakesSeqOp}'s runtime probe: the
 * shape is a known fact about a released version, not something that has to be
 * discovered by appending a probe event and matching an error message.
 * @param version - the resolved host version, when one was resolved at all.
 * @returns true for `startSeq`/`endSeq`, false for `start`/`end`, and
 *   `undefined` when the version is unknown and the probe must decide.
 */
export function surfaceOpTakesSeq(version: string | undefined): boolean | undefined {
  const parsed = parseHostVersion(version)
  if (parsed === undefined) return undefined
  for (let index = 0; index < SEQ_OP_SINCE.release.length; index += 1) {
    const seen = parsed.release[index] ?? 0
    const boundary = SEQ_OP_SINCE.release[index] ?? 0
    if (seen !== boundary) return seen > boundary
  }
  return comparePrerelease(parsed.prerelease, SEQ_OP_SINCE.prerelease) >= 0
}

/**
 * Cached replace-op shape: true once the running host is known to accept
 * `startSeq`/`endSeq`. Resolved once per process; the host never changes under
 * a loaded engine.
 */
let hostAcceptsSeqOp: boolean | undefined

/**
 * Declare the running host's surface-op shape from its resolved version,
 * before any rollover needs it.
 *
 * A deployment that can name the loaded session package gets a deterministic
 * answer for free; one that cannot is unaffected, because the runtime probe
 * below still decides. An unrecognized version is ignored rather than guessed:
 * a wrong declaration would append a surface op the host rejects, which is
 * exactly the failure the probe exists to avoid.
 * @param version - resolved version of the host's session package, if any.
 * @returns whether the declaration settled the shape.
 */
export function declareHostVersion(version: string | undefined): boolean {
  const known = surfaceOpTakesSeq(version)
  if (known === undefined) return false
  hostAcceptsSeqOp = known
  return true
}

/**
 * Whether the running host takes the newer `{ op: 'replace', startSeq,
 * endSeq }` shape. Probed once against a detached session: the candidate op
 * passes shape validation on a matching host (failing later on surface
 * position, which is the observable answer) and fails shape validation with
 * `invalid replace surfaceOp` on the other line. Shape is always validated
 * before position, so the classification is exact on both lines.
 * @returns true for the newer shape, false for `{ op: 'replace', start, end }`.
 */
function hostTakesSeqOp(): boolean {
  if (hostAcceptsSeqOp !== undefined) return hostAcceptsSeqOp
  const probe = Session.create(SessionId(`probe-${randomUUID()}`))
  try {
    probe.append(
      'user/message',
      createUserMessage({
        content: [{ type: 'text', text: 'probe' }],
        source: { kind: 'user' },
      }),
      { surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 } } as never,
    )
    hostAcceptsSeqOp = true
  } catch (error: unknown) {
    hostAcceptsSeqOp = !(error instanceof Error && error.message.includes('invalid replace surfaceOp'))
  }
  return hostAcceptsSeqOp
}

/**
 * Build the surface-replacement op in the running host's shape. The return
 * stays opaque (`unknown`) because neither line's type accepts the other's
 * fields; callers cast at the single `append` site.
 * @param start - inclusive first surface-node seq of the replaced span.
 * @param end - inclusive last surface-node seq of the replaced span.
 * @returns the replace op the running host validates.
 */
export function replaceSurfaceOp(start: Seq, end: Seq): unknown {
  if (hostTakesSeqOp()) return { op: 'replace', startSeq: start, endSeq: end }
  return { op: 'replace', start, end }
}
