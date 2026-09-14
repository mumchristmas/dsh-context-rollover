# dsh-context-rollover

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle for
**model-driven context self-management**: the model can deliberately end one
working context window and continue in a fresh one while preserving durable
state — with **no summarization**.

```text
fresh working context + durable model-managed notes + small recent raw tail + recoverable full history
```

Inspired by the context-management architecture in `openai/codex` (the
`new_context` tool, token-budget compaction without a summarizer, history/notes
separation) and `pi-posthorse`. Codex is the architectural reference; DSH is the
implementation authority — everything runs through DSH's own surface-replace
protocol and compaction transaction.

## How it works

The plugin is an **interceptor**, not a replacement, and it needs no preset:
it mounts at the host plane and its listeners are untagged, so they see every
session's events whatever preset that session runs. It registers its
`agent/pre-step` listener with `prepend`, so on every step it measures pressure
and crosses the boundary *before* the session's compaction backend (the shipped
`dsh-compaction-basic`, host-plane or preset-owned) reaches its own threshold.
That backend keeps its service, its identity, and its `/compact` path; after a
rollover it simply measures a smaller prompt and does nothing. See
[Interception and removability](#interception-and-removability) for the
threshold contract.

A rollover is a real DSH compaction: `compaction/start` →
`compaction/summary` → one replacement `user/message` with full source
provenance → `compaction/end` — but the "summary" is a **deterministic
checkpoint** (durable notes plus an optional handoff), never an LLM call. Raw
session events stay persisted; a token-budgeted recent tail stays verbatim on
the surface; `deriveMessages()` rebuilds automatically.

Responsibilities stay split (the Codex lesson):

| Concern | Owner |
|---|---|
| Request a boundary | `new_context` tool (records a pending request only) |
| Cross the boundary | `agent/pre-step` (before the next model request) and `agent/turn-stopping` |
| Track windows | rollover count + summary seqs read from the durable log |
| Measure pressure | `ctx.tokenMeter` + the routed model's context window |
| Replace the surface | `commitRollover` inside DSH's compaction transaction |
| Preserve selected state | `notes` tool (markdown files per session) |
| Recover old details | `history` tool (search/read over shadowed surface events) |

### Model-facing tools

- **`new_context({ handoff? })`** — request a context boundary at the next safe
  point. The handoff (bounded) becomes part of the new window's checkpoint. The
  boundary is crossed at a safe lifecycle point, never mid-tool-batch.
- **`get_context_remaining()`** — the numbers, in the window's own terms:

  ```text
  prompt used   15,255 / 32,000 (48%)
    of which conversation 3,100
  window left   16,745
  rollover at   13,545 more
  ```

  `prompt used` is what the next request would submit — a projection that
  moves with every turn and drops at a rollover, not a tally of what was
  spent; `window left` is the room before the hard limit; `rollover at` is how
  much further growth remains. A window with no honest reading yet answers
  `not measured yet`. The same quantity drives the pressure reminder and the
  rollover threshold, measured as the prompt a request would carry and not as
  the previous call's prompt plus its output.
- **`notes`** — `list | read | write | append | search` over per-session
  markdown files under `<dsh home>/notes/<session id>/`. Nothing is written
  automatically; the model decides what survives.
- **`history`** — `search | read` over conversation that left the active
  surface. Targeted recovery, not wholesale reconstruction.

### Settings

The plugin registers one settings namespace (`context-rollover`), so the Web
settings page shows a **Plugin configuration → Context rollover** card. The
`cordis.yml` row stays the composition layer: the card stores only what a user
changed, each field shows whether it is overridden, and *Reset* clears it back
to that layer. A write the engine could not run with (a reminder point above the
rollover point, a ratio outside `(0, 1]`) is refused before it is persisted, and
the effective configuration is re-resolved on every change — an edited threshold
applies to the next step, no restart.

The card keeps only what a session's owner actually tunes: the rollover
threshold, the reminder point, the retained tail in tokens (empty means the
deployment's share of the window), and whether the plugin takes over compaction
at all. A guardrail (handoff size) sits behind an **Advanced** disclosure;
retention as a *share* of the window and the `notes`/`history` tool mounts stay
deployment configuration, because two retention controls that override each
other read as a trap and tool mounts are not rollover policy. Overridden fields
are marked and reset individually, or all at once back to the deployment's
values.

The card also does the arithmetic a threshold cannot do alone: it reads what the
plugin knows about the compaction backends around it — the backends it has
actually resolved for a session (`GET /context-rollover/backends`), the presets
whose compositions mount a compactor, and the stock backend's unconfigured
default — and warns when the configured rollover threshold is **not below** the
backend's, which is the one misconfiguration that silently hands every session
to the summarizer. Deployments without a web server simply omit that route; the
card keeps the rest of its guidance.

### Languages

The plugin ships English and Chinese (`zh`, the two languages the browser
client carries). Human-facing text follows the same durable locale preference
the rest of the UI uses, resolved at call time, so switching the GUI language
changes the `/rollover` results, the status report, and the pressure reminder
without a restart:

- **Host text** — command description, command results, status report, and the
  reminder — is rendered through `src/i18n.ts` from
  `settings.locale.preference` (`zh*` → Chinese, anything else → English).
- **Browser text** — the mode button's tooltip and accessible name — is
  registered through the client locale service under the `context-rollover`
  namespace, so the shell re-renders it on a language switch; a shell without
  that service falls back to the document language.
- **Model-facing text** — tool descriptions, the `new_context` refusal, the
  guidance section, and the checkpoint body — stays English on purpose: it is
  prompt surface, and the guidance section is part of the cached request prefix.

### The session switch

`/rollover` also carries the per-session choice, and one icon button in the
session stats row (right end, beside the token counters) drives the same
command. The icon *is* the state — a cycle arrow for rollover, a shrinking
stack for standard compaction — and clicking it toggles:

| Invocation | Effect |
|---|---|
| `/rollover on` (alias `rollover`) | this session uses rollover |
| `/rollover off` (alias `compact`) | this session keeps its own compaction backend; the interceptor stands down for it |
| `/rollover status` | report mode, thresholds, the session's backend, and whether the interceptor is active |
| `/rollover` / `/rollover now` | start a new window immediately (rollover mode only) |

The choice is per **session**, durable, and takes effect on the next step: it is
recorded as that `/rollover` command's own `command/run` record — the session's
existing, known event vocabulary — so the log stays readable by any DSH build
and the choice survives reload, fork, and resume. The plugin publishes it as the
`contextRolloverMode` session projection, which is what the switch reads; the
switch writes by running the same command through the client command remote, so
the UI adds no second source of truth. `preempt: false` in the plugin config is
the global version of the same switch.

### Rollover paths

1. **Model-driven** (preferred): the model saves notes, calls `new_context`
   with a short handoff at a phase boundary (research → implementation, etc.).
2. **Pressure** (safety net): above `thresholdRatio` of the window the engine
   rolls over automatically with durable notes and the recent verbatim tail.
   Below that, a **one-per-window** checkpoint reminder suggests saving notes
   and rolling over.
3. **Overflow**: a provider-confirmed `CONTEXT_WINDOW_EXCEEDED` forces a
   rollover with the same notes + tail checkpoint and retries the request.
4. **Manual**: `/rollover now` starts a window immediately (the same standalone
   notes + tail rollover), and `/compact` stays the session backend's own
   command (a summary on an idle agent).

Only the model-driven path carries a **handoff**. The engine never writes one
for pressure, overflow, or manual rollovers: producing a handoff itself would
mean either an LLM summarization call or copying older user messages into the
fresh window, and the second option revives stale requests. Those paths
preserve intent through notes and the recent verbatim tail instead.

### Interception and removability

Two thresholds decide who acts first:

| Knob | Default | Meaning |
|---|---|---|
| `thresholdRatio` (this plugin) | `0.75` | where rollover happens |
| `compaction-basic.thresholdRatio` (any backend) | `0.8` (that package's default) | where a summary would happen |

The plugin's default is deliberately below the stock backend's, because it
intercepts compaction in *every* session rather than behind an opted-in
composition. As long as this plugin's threshold is strictly lower, the rollover runs first
and the backend never sees a prompt above its own threshold — this holds just
as well for a backend owned by a preset realm, which is what makes the plugin
preset-independent. If a deployment configures a backend lower (or a preset
does), this plugin **stands down** for automatic pressure and overflow and logs
exactly which two numbers decided that, once per backend. It does not silently
summarize, and it does not silently double-act: `new_context` and
`/rollover now` keep working in every configuration. Only the row that owns a
session's policy speaks about it either: no controller injects a reminder
computed from thresholds that session does not use.

Honesty extends to the requests themselves: `new_context` answers
`accepted: false` when the active context is already minimal (a checkpoint could
not shrink what it would shadow, so no boundary can commit), and a
model-requested rollover that a commit refuses is retried at the next boundary
rather than dropped.

That contract is what makes the plugin removable. Uninstalling it removes a
listener and four tools; `ctx.compaction` never changed hands, no preset names
this package, and every session — including ones created while the plugin was
installed — keeps compacting through its own backend with no repair step. The
same property makes the per-session switch cheap: `preempt: false` hands every
automatic path back to the backend while the model-facing rollover stays
available.

## What this plugin touches

- **Registers four model-facing tools** (`new_context`, `get_context_remaining`, `notes`, `history`),
  one system-prompt section, and the human command `/rollover now` — in every
  session of every preset, on every profile. The plugin is not opt-in per
  preset; the switch is the plugin's own configuration (`preempt`), and a
  per-session switch is future work.
- **Ships one browser-side plugin** (`dsh.client`, `lib/client.js`): an icon
  button in the session stats row that reads the `contextRolloverMode`
  projection and runs `/rollover on|off` through the client's command remote.
  It adds no host
  route and no second state; if the shell cannot load it, the command and the
  host half are unaffected. The browser half is authored as CommonJS against
  the shell's module table and wrapped by `scripts/build-client.mjs` rather than
  type-checked, because the shell's React types are not part of this package's
  dependency closure.
- **Writes files** in exactly one place: markdown notes under `<dsh home>/notes/<sessionId>/`.
  Nothing else on disk is written; no network calls, no telemetry.
- **Adds an intercepting lifecycle layer**: an `agent/pre-step` listener
  (registered with `prepend`), an `agent/turn-stopping` listener, an
  `agent/request-error` listener, and an `agent/status` listener. The
  session's compaction backend keeps its service, its identity, and its
  threshold: the bundle patch inserts one row and changes no other. Session
  logs stay fully compatible in both directions, and uninstalling leaves
  nothing to repair.
- **Adds no service and takes none away**: `ctx.compaction` still belongs to
  the standard backend. `backend: true` opts an otherwise backend-less
  deployment into this plugin providing it instead.
- **No credentials, no cloud services, no data leaves the machine.**

## Host version compatibility

The plugin typechecks against **both** host lines: the development checkout and
its installed profiles (`0.1.5-rc.1`, via generated tsconfig paths) and the
newest packages published to public npm (`0.0.1-rc.1`, the
`pnpm typecheck:compat` probe against `compat/node_modules`). Runtime
differences are bridged in `src/compat.ts`:

- the session log as `snapshotEvents()` (newer line) or `events` (published);
- `eventAt(seq)` versus indexing that array;
- per-node pricing as `heuristicTokens` (newer line) or `tokens`;
- the replacement operation as `{ startSeq, endSeq }` (newer line) or
  `{ start, end }`, probed once per process because each line rejects the
  other's field names.

Note the published `@deepseek-ai/dsh-*` packages are a *partial* mirror: some
of their peers reference packages that were never published publicly, so a
standalone npm-only host graph cannot be assembled. That is expected — the
plugin's peers resolve from the running dsh host's installation closure, and
installing the plugin itself into a profile fetches only this package.

## Install

From npm (recommended):

```sh
dsh plugin --profile <profile> add dsh-context-rollover
# or, without the dsh CLI:
pnpm --dir "$DSH_HOME/profiles/<profile>" add dsh-context-rollover
```

A custom profile initializes with just `dsh-base`; the bundle's patch applies
automatically because the package declares `dsh.bundle.patch`. After the first
install (a bundle-membership change is a boot-time composition), start the
profile once — the plugin's peer packages resolve from the running host's
installation closure, never from npm.

From GitHub instead of npm:

```sh
dsh plugin --profile <profile> add github:athif23/dsh-context-rollover
```

From a local checkout (development, see the HMR section below):

```sh
dsh plugin --profile <profile> add D:/path/to/dsh-context-rollover
```

**Windows note**: if the plugin loads but its `@deepseek-ai/*` imports fail at
runtime after an install from Git Bash, pnpm may have materialized broken
`link:` junctions (a Git Bash/Windows path-mangling bug). Recreate them with
`cmd /c mklink /J` as described in the HMR section below — the same fix
applies to any linked sibling package in the profile.

The bundle's `cordis.patch.yml` inserts one row (`context-rollover`) and
changes nothing else: it never disables a compactor, never retunes one, and
never edits `agent-presets`. `command-compact`, the token meter, and the
compaction invariant companions need no changes — they still depend only on
`ctx.compaction`.

### Every session, presets included

Nothing else is required after the install: restart once and the plugin
intercepts compaction in every session, on every profile.

- On base-only/headless profiles the host-plane `compaction-basic` is the
  session's backend, and the plugin's earlier pressure point wins (`0.75` vs
  the backend's `0.8`).
- On the **Web** profile the `dsh-web-app` layer keeps the host-plane
  compaction rows disabled by design — sessions compose compaction from their
  **agent preset** instead. The plugin's listeners are untagged, so they
  receive those sessions' events anyway, and it reads the *preset's* backend
  through the roster to compare thresholds. A `standard` (or `minimal`, or
  `ptc`) session therefore rolls over exactly like a headless one, with no
  preset to pick and no per-session setup.
- If a deployment runs a backend whose threshold is earlier than the plugin's,
  the plugin stands down for automatic pressure/overflow and logs the two
  numbers; `new_context` and `/rollover now` keep working.

The `standard-rollover` preset id is retained as a **legacy shim only**: it is
a verbatim copy of the shipped `standard` composition, contains no row from
this package, and exists so sessions created during the earlier preset-based
experiment still resolve their recorded preset and resume (the host row
intercepts them like any other). Deployments with no such sessions can drop
the bundle's `agent-presets` patch entry, or delete the preset directory; the
plugin keeps working either way.

Maintainers: `presets/standard-rollover/` is generated, not authored — re-run
`pnpm preset:sync` after harness updates and commit the refresh. The sync
copies the shipped `standard` composition verbatim and rewrites only the shim's
metadata.

Configuration (cordis.yml `config` on the plugin row):

```yaml
- insert:
    - id: context-rollover
      name: dsh-context-rollover
      config:
        thresholdRatio: 0.75         # automatic rollover point (fraction of window)
        reminderThresholdRatio: 0.6  # one-time checkpoint reminder point
        retainRatio: 0.1             # recent verbatim tail (fraction of window)
        retainTokens: null           # absolute tail budget; overrides retainRatio
        handoffMaxChars: 20000
        notesEnabled: true
        historyEnabled: true
        notesDir: null               # base dir override; default <dsh home>/notes
        preempt: true                # false: let the session's backend own automation
        backend: false               # true: replace ctx.compaction (only where it is unprovided)
```

## Local development with HMR

The fast loop runs DSH from your checkout with the plugin linked from this
directory and Cordis HMR watching the source:

1. **Create a dedicated profile and link this package**

   ```sh
   dsh plugin --profile rollover-dev add D:/path/to/dsh-context-rollover
   ```

   (A custom profile initializes with just `dsh-base`; the bundle's patch
   applies automatically because the package declares `dsh.bundle.patch`.)

2. **Enable the `hmr` row** in `$DSH_HOME/profiles/rollover-dev/cordis.patch.yml`
   (patch rows replace whole configs, so restate `root`):

   ```yaml
   - id: hmr
     config:
       root: ['.', 'D:/path/to/dsh-context-rollover/src']
       debounce: 100
   ```

   The base bundle mounts `hmr` disabled by default; the `timer` row it needs
   is already active.

3. **Run DSH from source**

   ```sh
   cd /path/to/deepseek-harness
   pnpm run build          # once; Typert host artifacts are required
   pnpm dsh --profile rollover-dev
   ```

   Source launch runs through tsx (`node --import tsx/esm`), which is what makes
   hot reload of TypeScript plugin sources work.

4. **Edit `src/*.ts` in this package** — the affected plugin reloads in place;
   registrations (tools, system-prompt sections, event listeners) unwind and
   reapply through Cordis effects. Profile patch edits also recompose live
   (`patchReload: live` is the default for custom profiles).

5. **Restart is still required for**: initial bundle installation, bundle
   membership changes (`dsh.plugin add/remove`), framework-level dependency
   changes (Cordis falls back to `loader.exit()`), and anything HMR cannot
   safely swap.

### Windows: `link:` junctions and Git Bash

`pnpm install` in a profile run from Git Bash mangles `link:D:/...`
specifiers into junctions with invalid targets (the drive colon is treated
as relative). If a profile's linked plugins fail to load after an install,
recreate the junctions with the real targets:

```sh
cmd /c mklink /J "%DSH_HOME%\profiles\web\node_modules\dsh-context-rollover" "D:\path\to\dsh-context-rollover"
```

(or run the install from PowerShell/cmd). This package's own runtime peers
are junctions into the shared installation closure at
`$DSH_HOME/profiles/node_modules/@deepseek-ai/*`. That is what lets the
engine share the host's module instances: a service plugin that extends
`CompactionEngine` must import the exact classes the host loaded, so
resolving its `@deepseek-ai/*` imports through the same closure as the host
is load-bearing, not an optimization.

## Tests and typecheck (no DSH build needed)

The DSH source checkout is the source of truth: `tsconfig.base.json` paths are
generated into `tsconfig.dsh-paths.json` and vitest aliases execute everything
from TypeScript source — the same source plane DSH's own suites use. Vendored
packages typecheck against their built declarations so `skipLibCheck` absorbs
their relaxed strictness.

```sh
pnpm install
pnpm test        # surface, notes, history, engine integration, tool rendering
pnpm typecheck
```

Tests mount the real session store, token meter, tool runtime, agent loop, and
**the compaction invariant companions**, so every committed rollover is
validated against DSH's own invariants. The integration test proves the
semantic experiment end to end: the model researches, calls `new_context`
mid-turn, and the fresh window carries notes + handoff + recent tail while the
turn continues.

## Working in this checkout

This checkout keeps a deliberately strict **public zone / dev zone** split:
`main` and `feature/*` are publishable and PR-ready, while `dev`, local notes,
the DSH checkout, and machine-specific config live in a private, gitignored dev
zone backed by a local bare remote. A pre-push guard blocks dev-zone material
from reaching GitHub. [`ZONES.md`](ZONES.md) is the reference;
[`CONTRIBUTING.md`](CONTRIBUTING.md) is the workflow.

```sh
pnpm dev:setup    # pinned DSH checkout + deps + private remote + zone guard
pnpm dev:doctor   # is the environment wired correctly?
pnpm dev:verify   # prove the zone split holds (guard matrix + repo state)
```

Two differences from a plain checkout, both local-only:

- the DSH sources are resolved by `scripts/dsh-dir.mjs` — `DSH_CHECKOUT_DIR`
  (environment, then `.env.local`), else `vendor/deepseek-harness`, which
  `pnpm dev:setup` clones at the pinned ref. CI keeps working with
  `DSH_CHECKOUT_DIR=./deepseek-harness`;
- `pnpm build` resolves `@deepseek-ai/*` to built declarations, preferring a
  built checkout and otherwise the host installation closure
  (`$DSH_HOME/profiles/node_modules/@deepseek-ai`); `DSH_BUILD_TYPES_DIR`
  overrides it. `pnpm dev:doctor` reports which source is in use.

## Scope and limits

- A rollover checkpoint contains durable notes, the model's handoff when it
  supplied one, and the retained verbatim tail that sits outside the
  checkpoint. No older user prompts are copied into it.
- Notes survive context rollovers within a session; no cross-session sync,
  embeddings, or cloud storage.
- Notes are files, not session events: `Session.append` cannot mark a plugin's
  custom event types `ignorable`, so unknown plugin events on a session log
  would make that log unreadable by any DSH build without the plugin. Only
  known event types (`compaction/*`, `user/message`) are written.
- The generic `<compaction>` checkpoint provenance is reused, so transcript UIs
  recognize rollover checkpoints like any compaction.
- Automatic preemption is a threshold contract, not exclusivity: a mounted
  backend that fires at or before this plugin's threshold wins, and the plugin
  stands down for automatic paths (with one warning naming both numbers).
  `new_context` and `/rollover now` are unaffected by that ordering.
- No DSH core was forked or patched; the plugin only consumes public seams.

## License

MIT
