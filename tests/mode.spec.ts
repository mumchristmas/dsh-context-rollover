/**
 * Per-session mode resolution: which context-management policy a session runs.
 *
 * The mode is recorded durably as the `/rollover on|off` command's own
 * `command/run` record, so it survives reload, fork, and resume. Reading it has
 * two sources — the session projection the host maintains, and a fold of the
 * log — and these cases pin which one answers, and that a registry which cannot
 * answer never decides the policy.
 *
 * @module tests/mode.spec
 */

import { describe, expect, it } from 'vitest'
import { CommandId } from '@deepseek-ai/dsh-commands'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { sessionMode } from '../src/mode.ts'
import type { ModeProjectionReader } from '../src/mode.ts'

/**
 * One session carrying a durable `/rollover off` selection and nothing else —
 * the smallest log whose mode is not the default.
 */
function sessionSelecting(mode: 'on' | 'off'): Session {
  const session = Session.create(SessionId(`mode-${mode}-${Math.random().toString(36).slice(2, 8)}`))
  session.append('command/run', {
    commandId: CommandId('mode-1'),
    name: 'rollover',
    args: mode,
    source: { kind: 'user' },
  })
  return session
}

/** A registry stub answering every read with one fixed value. */
function reader(stateOf: ModeProjectionReader['stateOf']): ModeProjectionReader {
  return { stateOf }
}

describe('sessionMode', () => {
  it('folds the log when no registry is available', () => {
    expect(sessionMode(sessionSelecting('off'))).toBe('compact')
    expect(sessionMode(sessionSelecting('on'))).toBe('rollover')
    // A session that never selected one runs the default.
    expect(sessionMode(Session.create(SessionId('mode-unset')))).toBe('rollover')
  })

  it('prefers the projection when a registry answers', () => {
    const session = sessionSelecting('off')
    // Deliberately disagreeing with the log: the point is which source wins.
    expect(sessionMode(session, reader(() => 'rollover'))).toBe('rollover')
    expect(sessionMode(session, reader(() => 'compact'))).toBe('compact')
  })

  it('falls back to the log when the registry cannot answer', () => {
    const session = sessionSelecting('off')
    // Unregistered key: the registry's own "not mine" answer.
    expect(sessionMode(session, reader(() => undefined))).toBe('compact')
    // A value that is not a mode is not an answer either.
    expect(sessionMode(session, reader(() => 'sideways'))).toBe('compact')
    expect(sessionMode(session, reader(() => ({ mode: 'compact' })))).toBe('compact')
    // A registry that throws must not take a session's policy down with it:
    // refusing to answer is normal, and the durable log is authoritative.
    expect(sessionMode(session, reader(() => { throw new Error('not attached') }))).toBe('compact')
  })

  it('reads the log for the default when the projection agrees there is none', () => {
    const session = Session.create(SessionId('mode-unset-projection'))
    expect(sessionMode(session, reader(() => undefined))).toBe('rollover')
    expect(sessionMode(session, reader(() => 'compact'))).toBe('compact')
  })
})
