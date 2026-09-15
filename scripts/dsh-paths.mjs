/**
 * Shared path rules for the DSH tsconfig generators.
 *
 * Both generators locate the sibling checkout, rewrite its paths relative to
 * this project, and emit a config that `extends` the checkout's base tsconfig.
 * Keeping those rules here is what stops the `extends` line from drifting away
 * from the `paths` entries it has to agree with: a bare relative checkout value
 * is a *package specifier* to TypeScript, not a file reference, so resolving
 * only the `paths` entries left `extends` unresolvable (TS6053) for any layout
 * where the checkout sits inside this repository.
 */

import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** This repository's root. The helper lives beside the generators in `scripts/`. */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Normalize one path for a tsconfig `paths` target: forward slashes only, and
 * always a `./`-prefixed specifier that TypeScript reads as a path.
 * @param {string} path - a path, usually produced by `relative`.
 * @returns {string} the normalized specifier.
 */
export function withDotSlash(path) {
  const normalized = path.split(String.fromCharCode(92)).join('/')
  return normalized.startsWith('.') ? normalized : `./${normalized}`
}

/**
 * The sibling DSH checkout, honouring `DSH_CHECKOUT_DIR` when it is set.
 * @returns {string} the absolute checkout path.
 */
export function resolveCheckoutDir() {
  return resolve(PROJECT_ROOT, process.env.DSH_CHECKOUT_DIR ?? '../deepseek-harness')
}

/**
 * The `extends` value for one generated config: the base tsconfig as a path
 * relative to this project root.
 *
 * Works for every supported layout — the default sibling checkout, an absolute
 * `DSH_CHECKOUT_DIR`, and a checkout inside this repository — because the
 * result is always a `./`-prefixed relative path rather than the raw value of
 * the environment variable.
 * @param {string} baseTsconfig - absolute path of the base tsconfig.
 * @returns {string} the `extends` specifier.
 */
export function extendsTarget(baseTsconfig) {
  return withDotSlash(relative(PROJECT_ROOT, baseTsconfig))
}
