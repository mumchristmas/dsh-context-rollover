/**
 * Notes store tests: write/read/append/search/list semantics, path safety,
 * and the bounded checkpoint snapshot.
 *
 * @module tests/notes.spec
 */

import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NotesStore, NotePathEscapeError, resolveNotePath } from '../src/notes.ts'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanup.length > 0) {
    const dispose = cleanup.pop()
    if (dispose !== undefined) await dispose()
  }
})

/** A store rooted at a fresh temp directory. */
async function tempStore(): Promise<NotesStore> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-rollover-notes-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  return new NotesStore(dir)
}

describe('NotesStore', () => {
  it('writes, reads, lists, appends, and searches notes', async () => {
    const store = await tempStore()
    await store.write('state.md', '# goal\nprove rollover')
    await store.write('plans/rollout.md', 'step 1\nstep 2')
    await store.append('state.md', 'decided: no summary')
    await store.append('state.md', 'next: tests')

    expect(await store.read('state.md')).toBe('# goal\nprove rollover\ndecided: no summary\nnext: tests\n')

    const listings = await store.list()
    expect(listings.map(listing => listing.path).sort()).toEqual(['plans/rollout.md', 'state.md'])

    const matches = await store.search('SUMMARY')
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({ path: 'state.md', line: 3 })
  })

  it('rejects path traversal and unsafe segments', async () => {
    const store = await tempStore()
    await expect(store.read('../escape.md')).rejects.toThrow(/invalid/)
    await expect(store.write('/absolute.md', 'x')).rejects.toThrow(/invalid/)
    await expect(store.write('a/../b.md', 'x')).rejects.toThrow(/invalid/)
    expect(resolveNotePath(store.root, 'ok.md')).toContain('ok.md')
  })

  it('lists empty when the store directory does not exist', async () => {
    const store = new NotesStore(join(tmpdir(), `dsh-rollover-missing-${Date.now()}`))
    await expect(store.list()).resolves.toEqual([])
  })

  it('renders a bounded snapshot across files', async () => {
    const store = await tempStore()
    await store.write('a.md', 'alpha note')
    await store.write('b.md', 'beta note')
    const snapshot = await store.renderAll(1000)
    expect(snapshot).toContain('### a.md')
    expect(snapshot).toContain('alpha note')
    expect(snapshot).toContain('beta note')

    const bounded = await store.renderAll(10)
    expect(bounded).not.toBeNull()
    expect(bounded?.length).toBeLessThanOrEqual(10 + '### a.md\n'.length)
  })

  it('returns null when there is nothing to render', async () => {
    const store = await tempStore()
    await expect(store.renderAll(1000)).resolves.toBeNull()
  })

  it('keeps the whole snapshot inside its hard character bound', async () => {
    const store = await tempStore()
    await store.write('a.md', 'A')
    await store.write('b.md', 'B')
    // The two-byte separator `join` inserts is part of the snapshot, so a
    // budget that ignores it emits more characters than it promised.
    const snapshot = await store.renderAll(20)
    expect(snapshot).not.toBeNull()
    expect(snapshot?.length ?? 0).toBeLessThanOrEqual(20)
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'never replaces a note it could not read',
    async () => {
      const store = await tempStore()
      await store.write('state.md', 'valuable-existing-state\n')
      const path = join(store.root, 'state.md')
      await chmod(path, 0o200)
      try {
        // The read genuinely fails while the owner may still open the file for
        // writing. Treating that failure as "empty file" is exactly how an
        // append destroys the note it was asked to extend.
        await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'EACCES' })
        await expect(store.append('state.md', 'new-entry')).rejects.toMatchObject({ code: 'EACCES' })
      } finally {
        await chmod(path, 0o600)
      }
      expect(await store.read('state.md')).toBe('valuable-existing-state\n')
    },
  )

  it.skipIf(process.platform === 'win32')('refuses a note whose symlink leaves the store', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-rollover-notes-link-'))
    cleanup.push(() => rm(dir, { recursive: true, force: true }))
    const root = join(dir, 'notes')
    await mkdir(root)
    const outside = join(dir, 'outside.md')
    await writeFile(outside, 'outside-before', 'utf8')
    // A link the store itself never creates, but the user or another local
    // process may have placed there: it must not turn a legitimate note path
    // into a read or overwrite outside the store.
    await symlink(outside, join(root, 'linked.md'))
    const store = new NotesStore(root)

    await expect(store.read('linked.md')).rejects.toBeInstanceOf(NotePathEscapeError)
    await expect(store.write('linked.md', 'overwritten')).rejects.toBeInstanceOf(NotePathEscapeError)
    await expect(store.append('linked.md', 'appended')).rejects.toBeInstanceOf(NotePathEscapeError)
    expect(await readFile(outside, 'utf8')).toBe('outside-before')

    // The snapshot reports the exclusion instead of pulling outside content in.
    const snapshot = await store.renderAll(1000)
    expect(snapshot).not.toContain('outside-before')
    expect(snapshot).toContain('EOUTSIDE')
  })

  it.skipIf(process.platform === 'win32')('refuses a directory symlink that leaves the store', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-rollover-notes-dirlink-'))
    cleanup.push(() => rm(dir, { recursive: true, force: true }))
    const root = join(dir, 'notes')
    await mkdir(root)
    const outsideDir = join(dir, 'outside-directory')
    await mkdir(outsideDir)
    await symlink(outsideDir, join(root, 'linked-directory'))
    const store = new NotesStore(root)

    await expect(store.write('linked-directory/new.md', 'created')).rejects
      .toBeInstanceOf(NotePathEscapeError)
    await expect(readFile(join(outsideDir, 'new.md'), 'utf8')).rejects
      .toMatchObject({ code: 'ENOENT' })
  })

  it.skipIf(process.platform === 'win32')('still follows a link that stays inside the store', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-rollover-notes-insidelink-'))
    cleanup.push(() => rm(dir, { recursive: true, force: true }))
    const root = join(dir, 'notes')
    await mkdir(root)
    await writeFile(join(root, 'real.md'), 'real-content', 'utf8')
    await symlink(join(root, 'real.md'), join(root, 'alias.md'))
    const store = new NotesStore(root)

    // Containment is the boundary, not "no links ever": refusing every link
    // would break legitimate layouts without adding safety.
    expect(await store.read('alias.md')).toBe('real-content')
  })
})
