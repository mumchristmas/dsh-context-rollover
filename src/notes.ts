/**
 * Durable model-managed notes: plain markdown files under one per-session
 * directory, surviving context rollovers within the session. Notes are the
 * model's own selected state — nothing is written automatically.
 *
 * A file store (not session events) keeps every log readable by any DSH
 * build: `Session.append` cannot mark a plugin's custom event types
 * `ignorable`, so unknown plugin events on a session log would make that log
 * refused at restore.
 *
 * The store is a boundary, not just a directory: note paths are validated
 * lexically *and* physically, so a symlink placed inside it cannot turn a
 * legitimate `path=linked.md` into a read or an overwrite of a file outside
 * it, nor pull outside content into a checkpoint. Writes replace a file
 * atomically, and a read that fails is never mistaken for an empty file.
 *
 * @module dsh-context-rollover/notes
 */

import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Reject path traversal and unsafe note path components. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._ -]*$/

/**
 * `O_NOFOLLOW` where the platform provides it. It is absent on Windows, where
 * the containment resolution below is the whole guard.
 */
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0

/** The POSIX error code on a filesystem failure, when it carries one. */
function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | undefined)?.code
  return typeof code === 'string' ? code : undefined
}

/** `lstat` that reports absence instead of throwing. */
async function lstatOrUndefined(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path)
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return undefined
    throw error
  }
}

/** Whether `candidate` is the store root itself or lies inside it. */
function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

/** The error one escaping note path is refused with. */
export class NotePathEscapeError extends Error {
  /** Stable label for logs and checkpoint placeholders. Not an errno. */
  readonly code = 'EOUTSIDE'

  constructor(path: string) {
    super(`note path "${path}" escapes the notes store`)
    this.name = 'NotePathEscapeError'
  }
}

/**
 * Read one file without following a symlink that appeared after resolution.
 * @param absolute - a resolved path from {@link resolveContainedNotePath}.
 * @returns the file's text.
 */
async function readContainedFile(absolute: string): Promise<string> {
  const handle = await open(absolute, constants.O_RDONLY | NO_FOLLOW)
  try {
    return await handle.readFile('utf8')
  } finally {
    await handle.close()
  }
}

/**
 * Replace one file's contents atomically.
 *
 * The text is written to a sibling temporary file and renamed over the target,
 * so a failure part-way through leaves the previous contents intact rather
 * than truncating them. The rename also replaces a symlink planted at the
 * target instead of writing through it.
 * @param absolute - a resolved path from {@link resolveContainedNotePath}.
 * @param text - complete replacement text.
 */
async function writeContainedFile(absolute: string, text: string): Promise<void> {
  const parent = dirname(absolute)
  await mkdir(parent, { recursive: true })
  const temporary = join(parent, `.${basename(absolute)}.${randomUUID()}.tmp`)
  try {
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o666,
    )
    try {
      await handle.writeFile(text, 'utf8')
    } finally {
      await handle.close()
    }
    await rename(temporary, absolute)
  } catch (error: unknown) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * Validate a model-supplied note path and map it into the store directory.
 * @param dir - the store's root directory.
 * @param path - relative note path (`foo.md`, `plans/rollout.md`).
 * @returns the absolute file path.
 * @throws when the path escapes the store (traversal, absolute, empty segments).
 */
export function resolveNotePath(dir: string, path: string): string {
  if (path.length === 0) throw new Error('note path must not be empty')
  const segments = path.split('/')
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..' || !SAFE_SEGMENT.test(segment)) {
      throw new Error(
        `note path "${path}" is invalid: segments must be relative and match ${SAFE_SEGMENT.source}`,
      )
    }
  }
  return join(dir, ...segments)
}

/**
 * Resolve one note path for I/O, refusing any route that leaves the store.
 *
 * `resolveNotePath` rejects traversal lexically; this rejects it physically. A
 * symlink placed inside the store — by the user or by another local process —
 * would otherwise let a legitimate `path=linked.md` read, overwrite, or append
 * a file outside it, and let `search`/`renderAll` pull outside content into a
 * checkpoint. Every existing component is resolved and required to stay inside
 * the root, and a link on the final component is followed only when its target
 * stays inside too. The returned path never ends in a symlink, so callers can
 * open it with `O_NOFOLLOW` as a race guard.
 *
 * Two limits are worth stating plainly: Node has no `openat`, so a race
 * between resolution and open cannot be eliminated outright, and a link that
 * genuinely points inside the store is allowed — refusing every link would
 * break legitimate linked layouts without adding safety.
 * @param dir - the store's root directory.
 * @param path - a store-relative note path.
 * @param create - create the root (and nothing else) when it does not exist.
 * @returns the absolute path to operate on.
 * @throws when any component escapes the store, or is not a directory.
 */
export async function resolveContainedNotePath(
  dir: string,
  path: string,
  create = false,
): Promise<string> {
  resolveNotePath(dir, path)
  if (create) await mkdir(dir, { recursive: true })
  const realRoot = await realpath(dir)
  const segments = path.split('/')
  let realDir = realRoot
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index] as string
    const candidate = join(realDir, segment)
    const info = await lstatOrUndefined(candidate)
    if (info === undefined) {
      // The rest of the path does not exist yet. Every existing ancestor has
      // been verified, so the remainder is inside by construction.
      return join(realDir, ...segments.slice(index))
    }
    if (info.isSymbolicLink()) {
      const resolved = await realpath(candidate)
      if (!isInside(realRoot, resolved)) throw new NotePathEscapeError(path)
      realDir = resolved
      continue
    }
    if (!info.isDirectory()) {
      throw new Error(`note path "${path}" has a non-directory component "${segment}"`)
    }
    realDir = candidate
  }
  const finalPath = join(realDir, segments[segments.length - 1] as string)
  const info = await lstatOrUndefined(finalPath)
  if (info === undefined || !info.isSymbolicLink()) return finalPath
  const resolved = await realpath(finalPath)
  if (!isInside(realRoot, resolved)) throw new NotePathEscapeError(path)
  return resolved
}

/** One listed note file. */
export interface NoteListing {
  /** Store-relative path. */
  readonly path: string
  readonly size: number
  readonly updatedAt: number
}

/** One literal note search hit. */
export interface NoteMatch {
  readonly path: string
  /** 1-based line number. */
  readonly line: number
  /** The matched line text. */
  readonly text: string
}

/** Per-session durable notes store over plain markdown files. */
export class NotesStore {
  /**
   * @param dir - the store's root directory.
   * @param warn - optional sink for conditions the caller should see but that
   *   must not fail the operation (a note that could not be read).
   */
  constructor(
    private readonly dir: string,
    private readonly warn?: (message: string) => void,
  ) {}

  /** The store's root directory. */
  get root(): string {
    return this.dir
  }

  /**
   * Resolve the default store directory for one session: `<notesDir>/<id>`
   * under the configured base, defaulting to `<dsh home>/notes/<id>`.
   * @param sessionId - the owning session's id.
   * @param baseDir - configured base directory override, when any.
   * @returns the store directory.
   */
  static directoryFor(sessionId: string, baseDir?: string): string {
    return join(baseDir ?? dshHomePath('notes'), sessionId)
  }

  /** The store root when it exists, or `undefined` when it does not. */
  private async existingRoot(): Promise<string | undefined> {
    try {
      return await realpath(this.dir)
    } catch (error: unknown) {
      if (errorCode(error) === 'ENOENT') return undefined
      throw error
    }
  }

  /**
   * List note files newest-modified first.
   * @returns the listings, or `[]` when the store directory does not exist.
   */
  async list(): Promise<NoteListing[]> {
    const root = await this.existingRoot()
    if (root === undefined) return []
    // A directory that cannot be read is not an empty directory: letting this
    // throw keeps "no notes" and "notes unavailable" distinguishable.
    const entries = await readdir(root, { recursive: true })
    const listings = await Promise.all(entries.map(async (entry) => {
      const path = entry.replaceAll('\\', '/')
      const info = await stat(join(root, entry)).catch((error: unknown) => {
        // A file that vanished between listing and stat is simply gone; any
        // other failure is real and must not read as an empty store.
        const code = errorCode(error)
        if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
        throw error
      })
      if (info === undefined || !info.isFile()) return undefined
      return { path, size: info.size, updatedAt: info.mtimeMs }
    }))
    return listings
      .filter((listing): listing is NoteListing => listing !== undefined)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /**
   * Read one note file's full text.
   * @param path - store-relative note path.
   * @returns the file text.
   */
  async read(path: string): Promise<string> {
    return await readContainedFile(await resolveContainedNotePath(this.dir, path))
  }

  /**
   * Create or replace one note file, creating parent directories. The
   * replacement is atomic: a failure leaves the previous contents in place.
   * @param path - store-relative note path.
   * @param text - complete replacement text.
   */
  async write(path: string, text: string): Promise<void> {
    await writeContainedFile(await resolveContainedNotePath(this.dir, path, true), text)
  }

  /**
   * Append text to one note file, creating it when missing. Appends always
   * end with a newline so successive appends stay line-oriented.
   *
   * Only a genuinely absent file counts as empty: any other read failure is
   * reported instead of being overwritten, because the read-modify-write below
   * would otherwise replace contents the store could not read.
   * @param path - store-relative note path.
   * @param text - text to append exactly as provided.
   */
  async append(path: string, text: string): Promise<void> {
    const absolute = await resolveContainedNotePath(this.dir, path, true)
    let current = ''
    try {
      current = await readContainedFile(absolute)
    } catch (error: unknown) {
      if (errorCode(error) !== 'ENOENT') throw error
    }
    const separator = current.length > 0 && !current.endsWith('\n') ? '\n' : ''
    await writeContainedFile(absolute, `${current}${separator}${text}\n`)
  }

  /**
   * Literal case-insensitive search over note lines.
   * @param query - literal substring to find.
   * @param maxMatches - upper bound on returned matches.
   * @returns the matches in file order.
   */
  async search(query: string, maxMatches = 20): Promise<NoteMatch[]> {
    const lowerQuery = query.toLowerCase()
    if (lowerQuery.length === 0 || maxMatches <= 0) return []
    const matches: NoteMatch[] = []
    for (const listing of await this.list()) {
      if (matches.length >= maxMatches) break
      let text: string
      try {
        text = await this.read(listing.path)
      } catch (error: unknown) {
        // Reported rather than silently skipped: a search over a store it
        // could not fully read must not look like a complete one.
        this.warn?.(
          `context rollover: could not search note ${listing.path} `
          + `(${errorCode(error) ?? String(error)})`,
        )
        continue
      }
      const lines = text.split('\n')
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]
        if (line === undefined || !line.toLowerCase().includes(lowerQuery)) continue
        matches.push({ path: listing.path, line: index + 1, text: line })
        if (matches.length >= maxMatches) break
      }
    }
    return matches
  }

  /**
   * Render every note file into one bounded text snapshot for a rollover
   * checkpoint. `maxChars` bounds the whole snapshot — headers and the
   * separators between sections included; note bodies are filled
   * newest-modified first.
   * @param maxChars - hard character bound for the snapshot.
   * @returns the snapshot, or `null` when the store is empty.
   */
  async renderAll(maxChars: number): Promise<string | null> {
    const listings = await this.list()
    if (listings.length === 0) return null
    const sections: string[] = []
    let length = 0
    for (const listing of listings) {
      const header = `### ${listing.path}\n`
      // The separator `join` will insert is part of the snapshot, so it is
      // charged to the budget too; ignoring it lets the output exceed the
      // hard bound it advertises. One separator per section after the first.
      const separator = sections.length > 0 ? 2 : 0
      const remaining = maxChars - length - separator - header.length
      if (remaining <= 0) break
      let body: string
      try {
        const text = await this.read(listing.path)
        body = text.length > remaining ? text.slice(0, remaining) : text
      } catch (error: unknown) {
        // A checkpoint must never quietly omit a note it could not read: the
        // model would lose its own state without knowing. Record the fact in
        // the snapshot and keep the rest of the store usable.
        if (errorCode(error) === 'ENOENT') continue
        const code = errorCode(error) ?? 'unreadable'
        this.warn?.(
          `context rollover: could not read note ${listing.path} (${code}); `
          + 'the checkpoint records it as unreadable',
        )
        body = `> (unreadable: ${code})`
        if (body.length > remaining) continue
      }
      length += separator + header.length + body.length
      sections.push(`${header}${body}`)
    }
    if (sections.length === 0) return null
    const snapshot = sections.join('\n\n')
    if (snapshot.length > maxChars) {
      // Defensive: the arithmetic above is what guarantees the bound.
      throw new Error(`context-rollover: notes snapshot exceeded its ${maxChars}-character budget`)
    }
    return snapshot
  }
}
