/**
 * Build-metadata coverage: the peer ranges that decide whether an installer
 * accepts a host line, and the `extends` rule both tsconfig generators share.
 *
 * The generator cases run against a throwaway copy of `scripts/` so they
 * exercise the real script end to end without rewriting this repository's
 * generated config.
 *
 * @module tests/metadata.spec
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import ts from 'typescript'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanup.length > 0) {
    const dispose = cleanup.pop()
    if (dispose !== undefined) await dispose()
  }
})

/**
 * The DSH checkout the generated path config points at, so the semver fixtures
 * follow `DSH_CHECKOUT_DIR` rather than assuming the default layout.
 */
async function checkoutDir(): Promise<string> {
  const generated = JSON.parse(
    await readFile(join(repoRoot, 'tsconfig.dsh-paths.json'), 'utf8'),
  ) as { extends: string }
  return dirname(resolve(repoRoot, generated.extends))
}

/**
 * The `semver` an installer would use, resolved from the DSH workspace that
 * consumes it — the same implementation npm/pnpm apply to a peer range.
 */
async function loadSemver(): Promise<{ satisfies(version: string, range: string): boolean }> {
  const require = createRequire(join(await checkoutDir(), 'apps', 'desktop', 'package.json'))
  return require('semver') as { satisfies(version: string, range: string): boolean }
}

/**
 * The versions of each DSH peer package that the two supported host lines
 * actually ship: the public compat line installed under `compat/`, and the
 * source line the plugin is developed against in the checkout.
 */
async function hostLineVersions(): Promise<Array<{ line: string, versions: Map<string, string> }>> {
  const compat = new Map<string, string>()
  const compatScope = join(repoRoot, 'compat/node_modules/@deepseek-ai')
  for (const entry of await readdir(compatScope)) {
    const manifest = join(compatScope, entry, 'package.json')
    if (!existsSync(manifest)) continue
    const parsed = JSON.parse(await readFile(manifest, 'utf8')) as { name: string, version: string }
    compat.set(parsed.name, parsed.version)
  }

  const source = new Map<string, string>()
  const packages = join(await checkoutDir(), 'packages')
  for (const group of await readdir(packages, { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    const groupDir = join(packages, group.name)
    for (const entry of await readdir(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const manifest = join(groupDir, entry.name, 'package.json')
      if (!existsSync(manifest)) continue
      const parsed = JSON.parse(await readFile(manifest, 'utf8')) as { name?: string, version?: string }
      if (typeof parsed.name === 'string' && typeof parsed.version === 'string') {
        source.set(parsed.name, parsed.version)
      }
    }
  }
  return [{ line: 'compat', versions: compat }, { line: 'checkout', versions: source }]
}

describe('peer ranges', () => {
  it('accepts every host line this repository actually builds against', async () => {
    const semver = await loadSemver()
    const manifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as {
      peerDependencies: Record<string, string>
    }
    const violations: string[] = []
    for (const { line, versions } of await hostLineVersions()) {
      for (const [name, range] of Object.entries(manifest.peerDependencies)) {
        if (!name.startsWith('@deepseek-ai/dsh-')) continue
        const version = versions.get(name)
        // A line that does not ship the package says nothing about the range.
        if (version === undefined) continue
        if (!semver.satisfies(version, range)) {
          violations.push(`${line}: ${name}@${version} does not satisfy ${range}`)
        }
      }
    }
    // The whole point: the declared range has to accept what both lines ship,
    // prerelease tuples included. `>=0.1.0-rc.1` accepted neither 0.0.1-rc.x
    // nor the 0.1.5-rc.2 line the checkout and the shipped host both use.
    expect(violations).toEqual([])
  })

  it('keeps a future prerelease line a documented maintenance point', async () => {
    const semver = await loadSemver()
    const manifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as {
      peerDependencies: Record<string, string>
    }
    const rule = manifest.peerDependencies['@deepseek-ai/dsh-session'] as string
    // semver only lets a prerelease satisfy a comparator whose [major, minor,
    // patch] tuple also carries a prerelease, so no static range can accept an
    // arbitrary later tuple. This is the documented limit, not a regression:
    // a new host line has to be added to the enumeration. 0.1.6-alpha.1 is the
    // newest enumerated line, so 0.1.7 is the next one that will need adding —
    // and a prerelease *of an enumerated tuple* (0.1.6-rc.1) is already accepted.
    expect(semver.satisfies('0.1.7-rc.1', rule)).toBe(false)
    expect(semver.satisfies('0.1.7', rule)).toBe(true)
    expect(semver.satisfies('0.1.6-rc.1', rule)).toBe(true)
  })
})

describe('tsconfig generators', () => {
  /**
   * A throwaway project holding a copy of `scripts/`, with a fake checkout laid
   * out exactly where `DSH_CHECKOUT_DIR` points — so the generator is exercised
   * for that layout rather than for a rewritten one.
   */
  async function generatorFixture(relativeCheckout: string): Promise<{ root: string, checkout: string }> {
    const parent = await mkdtemp(join(tmpdir(), 'dsh-rollover-paths-'))
    cleanup.push(() => rm(parent, { recursive: true, force: true }))
    const root = join(parent, 'project')
    await mkdir(root, { recursive: true })
    await cp(join(repoRoot, 'scripts'), join(root, 'scripts'), { recursive: true })
    const checkout = resolve(root, relativeCheckout)
    await mkdir(join(checkout, 'src'), { recursive: true })
    await writeFile(
      join(checkout, 'tsconfig.base.json'),
      JSON.stringify({ compilerOptions: { paths: { '@fake/pkg': ['src/index.ts'] } } }),
      'utf8',
    )
    await writeFile(join(checkout, 'src', 'index.ts'), 'export {}\n', 'utf8')
    return { root, checkout }
  }

  it.each([
    ['the default sibling layout', '../deepseek-harness', '../deepseek-harness/tsconfig.base.json'],
    ['a checkout at the project root', 'fake-checkout', './fake-checkout/tsconfig.base.json'],
    ['a nested checkout inside the project', 'vendor/fake-checkout', './vendor/fake-checkout/tsconfig.base.json'],
  ])('emits a resolvable extends for %s', async (_label, relativeCheckout, expectedExtends) => {
    const { root } = await generatorFixture(relativeCheckout)
    execFileSync(process.execPath, ['scripts/generate-dsh-paths.mjs'], {
      cwd: root,
      env: { ...process.env, DSH_CHECKOUT_DIR: relativeCheckout },
      stdio: 'pipe',
    })
    const generated = JSON.parse(
      await readFile(join(root, 'tsconfig.dsh-paths.json'), 'utf8'),
    ) as { extends: string, compilerOptions: { paths: Record<string, string[]> } }

    // A bare relative value is a package specifier to TypeScript, not a file
    // reference: it points at an existing file and still fails to resolve. The
    // `paths` entries were already rewritten this way; `extends` now is too.
    expect(generated.extends).toBe(expectedExtends)
    expect(generated.compilerOptions.paths['@fake/pkg'])
      .toEqual([`${relativeCheckout.startsWith('.') ? relativeCheckout : `./${relativeCheckout}`}/src/index.ts`])

    const errors = ts.parseJsonConfigFileContent(
      { extends: generated.extends, files: [] },
      ts.sys,
      root,
    ).errors.filter(error => error.code === 6053)
    expect(errors).toEqual([])
  })

  it('shares one path rule between both generators', async () => {
    // The divergence this guards against is the `extends` line being built
    // from the raw environment value while the paths entries are resolved.
    for (const script of ['generate-dsh-paths.mjs', 'generate-dsh-build-paths.mjs']) {
      const source = await readFile(join(repoRoot, 'scripts', script), 'utf8')
      expect(source).toContain("from './dsh-paths.mjs'")
      expect(source).not.toContain('extends: `${process.env.DSH_CHECKOUT_DIR')
    }
  })
})
