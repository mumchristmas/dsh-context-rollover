#!/usr/bin/env node
/**
 * Regenerate the shipped `standard-rollover` preset from the harness's shipped
 * `standard` composition as a **verbatim copy**.
 *
 * The plugin no longer needs a preset: it mounts at the host plane and
 * intercepts compaction in every session, whatever preset that session runs.
 * The preset id is kept only so sessions created during the earlier
 * preset-based experiment still resume — such a session resolves this
 * composition (the stock backend, unchanged), and the host row intercepts it
 * like any other. Nothing in it names this package, so a deployment may delete
 * it once no session records the id.
 *
 * Maintainer tooling (`pnpm preset:sync`), not a user command. Re-run after
 * harness updates and commit the refreshed `presets/` directory.
 *
 * Plain Node with no dependencies. The copy is byte-identical, and the script
 * fails loud when the shipped `standard` composition is missing.
 *
 * Usage:
 *   node scripts/make-web-preset.mjs [--presets-dir <dir>] [--out-dir <dir>]
 *     [--preset-id <id>]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Id of the shipped preset the generated preset derives from. */
const SOURCE_PRESET = 'standard'

/** Default id (directory name) of the generated preset. */
const DEFAULT_PRESET_ID = 'standard-rollover'

/** Directory names must stay path-contained; mirrors the harness preset rule. */
const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/

/**
 * Candidate roots holding shipped presets (`<root>/standard/agent.cordis.yml`):
 * explicit `--presets-dir` first, then the sibling DSH checkout this repo
 * develops against.
 * @param presetsDir - value of `--presets-dir`, when given.
 * @returns candidate preset-root directories, nearest first.
 */
export function candidatePresetRoots(presetsDir) {
  if (presetsDir !== undefined) return [resolve(presetsDir)]
  return [join(packageDir, '..', 'deepseek-harness', 'packages', 'preset', 'agent-presets', 'presets')]
}

/**
 * Find the `standard` composition the preset derives from.
 * @param presetsDir - value of `--presets-dir`, when given.
 * @param source - source preset id.
 * @returns the absolute composition file path.
 * @throws when no candidate supplies the source preset.
 */
export function findSourcePreset(presetsDir, source = SOURCE_PRESET) {
  for (const root of candidatePresetRoots(presetsDir)) {
    const file = join(root, source, 'agent.cordis.yml')
    if (existsSync(file)) return file
  }
  throw new Error(
    `make-web-preset: no "${source}" preset found; pass --presets-dir <harness>/packages/preset/agent-presets/presets`,
  )
}

/**
 * Render the preset metadata file.
 * @returns the `preset.yml` text.
 */
export function renderPresetMeta() {
  return `name: Standard + rollover (legacy id)\n`
    + `description: Kept only so sessions created during the preset-based experiment still resume. `
    + `The plugin now intercepts compaction from the host plane in every session, so this preset composes `
    + `the standard backend unchanged and adds nothing; safe to delete once no session records it.\n`
    + `order: 2\n`
}

/**
 * Minimal `--key value` / `--key=value` argument parser.
 * @param argv - process arguments without the node/script prefix.
 * @returns the parsed flags.
 */
export function parseArgs(argv) {
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) throw new Error(`make-web-preset: unexpected argument ${arg}; see --help`)
    const [key, inline] = arg.slice(2).split('=', 2)
    if (key === 'help') {
      flags.help = true
      continue
    }
    const value = inline ?? argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`make-web-preset: --${key} needs a value; see --help`)
    }
    if (inline === undefined) index += 1
    flags[key] = value
  }
  return flags
}

/** Print usage. */
export function printHelp() {
  console.log(`make-web-preset: regenerate the shipped legacy preset (maintainer sync)

Options:
  --presets-dir <dir>     shipped presets root (default: sibling DSH checkout)
  --out-dir <dir>         presets root to write into (default: this package's presets/)
  --preset-id <id>        generated preset id (default: ${DEFAULT_PRESET_ID})`)
}

/**
 * Run the generator.
 * @param argv - process arguments without the node/script prefix.
 */
export async function main(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv)
  if (flags.help) {
    printHelp()
    return
  }
  const presetId = flags['preset-id'] ?? DEFAULT_PRESET_ID
  if (!PRESET_ID.test(presetId)) {
    throw new Error(`make-web-preset: --preset-id must match ${PRESET_ID}, got ${presetId}`)
  }
  const source = findSourcePreset(flags['presets-dir'])
  const text = readFileSync(source, 'utf8')
  const outDir = flags['out-dir'] === undefined ? join(packageDir, 'presets') : resolve(flags['out-dir'])
  const dir = join(outDir, presetId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent.cordis.yml'), text)
  writeFileSync(join(dir, 'preset.yml'), renderPresetMeta())
  console.log(`make-web-preset: copied ${presetId} verbatim from ${source}`)
  console.log(`make-web-preset: wrote ${join(dir, 'agent.cordis.yml')}`)
}

const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
