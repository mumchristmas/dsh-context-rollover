/**
 * Host-version compatibility: the `replace` surface-op shape, which is the one
 * place this plugin writes a host-versioned value into the session log.
 *
 * The shape is classified from the loaded session package's version when the
 * deployment can name it, and probed against a detached session when it cannot.
 * These cases pin both halves, and pin the boundary itself against the
 * published declaration files it was derived from.
 *
 * @module tests/compat.spec
 */

import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  declareHostVersion,
  replaceSurfaceOp,
  surfaceOpTakesSeq,
} from '../src/compat.ts'
import type { Seq } from '../src/compat.ts'

/** One minimal direct-user message, for appending into a probe session. */
function message(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

describe('replace surface op', () => {
  // Deliberately first: the probed shape is cached per process, and every later
  // case in this file declares a version. Nothing has declared one yet here, so
  // this is the only point at which the probe itself decides.
  it('probes a shape the running host actually accepts', () => {
    const session = Session.create(SessionId('compat-probe'))
    const first = session.append('user/message', message('a'), { surfaceOp: 'append' })
    // Whatever `replaceSurfaceOp` builds has to survive this host's own
    // validation — that round trip is the classification, not a proxy for it.
    // A shape the host did not recognize would fail before `sourceEventSeqs`
    // is ever consulted.
    expect(() => session.append('user/message', message('b'), {
      surfaceOp: replaceSurfaceOp(first.seq, first.seq),
      sourceEventSeqs: [first.seq],
    } as never)).not.toThrow()
  })

  it('honours a declared host version over the probe', () => {
    expect(declareHostVersion('0.1.6-alpha.1')).toBe(true)
    expect(replaceSurfaceOp(3 as Seq, 7 as Seq)).toEqual({ op: 'replace', startSeq: 3, endSeq: 7 })

    expect(declareHostVersion('0.1.3-alpha.2')).toBe(true)
    expect(replaceSurfaceOp(3 as Seq, 7 as Seq)).toEqual({ op: 'replace', start: 3, end: 7 })
  })

  it('leaves the probe in charge for a version it cannot classify', () => {
    // A workspace link, a git specifier, or a dist-tag that leaked through is
    // "unknown", never "old": guessing here would append an op the host rejects.
    for (const unknown of [undefined, 'workspace:^', 'latest', '0.1', '', 'v0.1.6']) {
      expect(declareHostVersion(unknown), String(unknown)).toBe(false)
      expect(surfaceOpTakesSeq(unknown), String(unknown)).toBeUndefined()
    }
  })
})

describe('surface op version boundary', () => {
  it('takes startSeq/endSeq at or after 0.1.5-alpha.1', () => {
    for (const version of ['0.1.5-alpha.1', '0.1.5-rc.1', '0.1.5-rc.2', '0.1.6-alpha.1', '0.1.6', '0.2.0', '1.0.0']) {
      expect(surfaceOpTakesSeq(version), version).toBe(true)
    }
  })

  it('takes start/end before it', () => {
    for (const version of ['0.0.1-rc.1', '0.0.1-rc.5', '0.1.0-rc.6', '0.1.1-rc.2', '0.1.2-rc.1', '0.1.3-alpha.2']) {
      expect(surfaceOpTakesSeq(version), version).toBe(false)
    }
  })

  it('orders prereleases by semver precedence, not by string', () => {
    // `0.1.5-alpha.0` precedes the boundary; `alpha.10` follows `alpha.9`
    // numerically even though it sorts first as text.
    expect(surfaceOpTakesSeq('0.1.5-alpha.0')).toBe(false)
    expect(surfaceOpTakesSeq('0.1.5-alpha.1')).toBe(true)
    expect(surfaceOpTakesSeq('0.1.5-alpha.10')).toBe(true)
    expect(surfaceOpTakesSeq('0.1.5-alpha.2')).toBe(true)
    expect(surfaceOpTakesSeq('0.1.5-beta.1')).toBe(true)
    // A release outranks any prerelease of its own tuple.
    expect(surfaceOpTakesSeq('0.1.5')).toBe(true)
  })
})
