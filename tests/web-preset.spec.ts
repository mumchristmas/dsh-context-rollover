/**
 * Preset-sync coverage: `scripts/make-web-preset.mjs` regenerates the shipped
 * legacy `standard-rollover` preset as a verbatim copy of a shipped
 * `standard` composition, fails loud when that composition is missing, and the
 * committed preset always matches a fresh sync. The copy carries no row from
 * this package — the plugin intercepts compaction from the host plane — so a
 * session that recorded the id simply resumes on the stock backend. The bundle
 * patch's preset-root expression is evaluated with the real loader against a
 * fake profile dir.
 *
 * The script runs as a real subprocess against temp directories, so this
 * suite covers the shipped artifact rather than an import of it.
 *
 * @module tests/web-preset
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { evaluate } from '@deepseek-ai/cordis-plugin-loader'

const script = fileURLToPath(new URL('../scripts/make-web-preset.mjs', import.meta.url))
const repoRoot = resolve(dirname(script), '..')

/** Minimal shipped-shape fixture: surrounding rows plus the real compaction group. */
function standardFixture(): string {
  return `# fixture standard preset
- id: persona
  name: '@deepseek-ai/dsh-persona'

# \`compaction-basic\` reads \`toolResultPrune\` through \`ctx.get\`, so the pruner must
# share this realm rather than sit outside it.
- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
    toolResultPruner: true
  config:
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'

    - id: command-compact
      name: '@deepseek-ai/dsh-command-compact'

    - id: tool-result-pruner
      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
      config:
        thresholdChars: 8192
`
}

/** Scratch dirs for one run: a presets root holding `standard/` and an out dir. */
function scratch(fixture: string): { presetsDir: string; outDir: string; cleanup: () => void } {
  // Temp dirs inside the repo: the sync names the engine relatively, which
  // cannot cross drives (the script fails loud on that instead).
  const base = mkdtempSync(join(repoRoot, 'tmp-scratch-'))
  const presetsDir = join(base, 'presets')
  const outDir = join(base, 'out')
  mkdirSync(join(presetsDir, 'standard'), { recursive: true })
  writeFileSync(join(presetsDir, 'standard', 'agent.cordis.yml'), fixture)
  return { presetsDir, outDir, cleanup: () => { rmSync(base, { recursive: true, force: true }) } }
}

/** Run the script, returning stdout; throws (with status/stderr) on failure. */
function run(args: readonly string[]): string {
  return execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' })
}

describe('make-web-preset', () => {
  it('copies the shipped composition verbatim, with nothing from this package', () => {
    const { presetsDir, outDir, cleanup } = scratch(standardFixture())
    try {
      run(['--presets-dir', presetsDir, '--out-dir', outDir])
      const composition = readFileSync(join(outDir, 'standard-rollover', 'agent.cordis.yml'), 'utf8')
      // Byte-identical to the source: the legacy id must resolve to the stock
      // composition, because the plugin is no longer part of any preset.
      expect(composition).toBe(standardFixture())
      expect(composition).not.toContain('context-rollover')
      expect(composition).not.toContain('lib/index.js')
      const meta = readFileSync(join(outDir, 'standard-rollover', 'preset.yml'), 'utf8')
      expect(meta).toContain('order: 2')
      expect(meta).toContain('legacy id')
    } finally {
      cleanup()
    }
  })

  it('fails loud when the source composition is absent', () => {
    const { outDir, cleanup } = scratch(standardFixture())
    const empty = join(outDir, 'nowhere')
    try {
      expect(() => run(['--presets-dir', empty, '--out-dir', outDir])).toThrow(/no "standard" preset found/)
    } finally {
      cleanup()
    }
  })

  it('rejects an invalid preset id', () => {
    const { presetsDir, outDir, cleanup } = scratch(standardFixture())
    try {
      expect(() => run(['--presets-dir', presetsDir, '--out-dir', outDir, '--preset-id', 'Bad Id']))
        .toThrow(/--preset-id must match/)
    } finally {
      cleanup()
    }
  })

  it('committed preset matches a fresh sync of the sibling checkout', () => {
    // Temp dir inside the repo: the sync names the engine relatively, which
    // cannot cross drives (the script fails loud on that instead).
    const outDir = mkdtempSync(join(repoRoot, 'tmp-sync-'))
    try {
      // No --presets-dir: the sync must find the sibling checkout on its own.
      run(['--out-dir', outDir])
      const fresh = readFileSync(join(outDir, 'standard-rollover', 'agent.cordis.yml'), 'utf8')
      const committed = readFileSync(join(repoRoot, 'presets', 'standard-rollover', 'agent.cordis.yml'), 'utf8')
      expect(fresh).toBe(committed)
      const freshMeta = readFileSync(join(outDir, 'standard-rollover', 'preset.yml'), 'utf8')
      const committedMeta = readFileSync(join(repoRoot, 'presets', 'standard-rollover', 'preset.yml'), 'utf8')
      expect(freshMeta).toBe(committedMeta)
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  })

  it('registers the installed presets dir through a profile-relative expression', () => {
    // The patch keeps its expression on one line; the capture below fails
    // loud if anyone wraps it, instead of silently testing a stale copy.
    const patch = readFileSync(join(repoRoot, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('default: standard')
    expect(patch).toContain('includeShippedRoot: true')
    expect(patch).toContain('includeUserRoot: true')
    expect(patch).toContain('trust: system')
    const line = patch.split('\n').find(candidate => candidate.includes('path: !!js '))
    if (line === undefined) throw new Error('bundle patch has no !!js preset-root path')
    const expr = line.slice(line.indexOf('path: !!js ') + 'path: !!js '.length).trim()
    // baseUrl is the profile directory at boot; the expression must resolve
    // the installed package's presets dir from it in any install layout.
    // (Drive-letter URL: fileURLToPath rejects drive-less URLs on Windows.)
    const base = 'file:///C:/fake-profiles/web/'
    const resolved = evaluate({ baseUrl: base }, expr)
    const expected = fileURLToPath(new URL('node_modules/dsh-context-rollover/presets/', base))
    expect(resolved).toBe(expected)
  })
})
