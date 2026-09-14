# dsh-context-rollover

[English](README.md) | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle for
**model-driven context self-management**: the model ends a context window on purpose and
continues in a fresh one, with **no summarization**. Its own notes and the last few
messages carry over; everything else stays in the session log, searchable on demand.
Inspired by the context-management model in `openai/codex`.

This repository is a rewrite and continuation of the original
[dsh-context-rollover](https://github.com/athif23/dsh-context-rollover), started by
athif23.

## What you get

Stock compaction waits for the window to fill up, then has an LLM summarize what it is
about to drop. This plugin replaces that with notes the working model wrote itself:

| | Summarization (`dsh-compaction-basic`) | Rollover (this plugin) |
|---|---|---|
| What survives | an LLM's summary of the dropped conversation | the model's notes, its handoff, and the last messages verbatim |
| When it happens | when the counter trips — possibly mid-task | at a phase boundary the model picks |
| The dropped conversation | summarized away | kept, and searchable with the `history` tool |
| Cost | one extra LLM call per compaction | zero; the same notes always give the same checkpoint |

In one line: **the model that did the work writes the handover, instead of a stranger
guessing what mattered.**

It installs into any profile and works in every session, next to the compaction backend
that is already there — it preempts that backend, it does not replace it. No credentials,
no network calls, no telemetry; the only thing it writes are markdown notes under
`<dsh home>/notes/<session id>/`.

## Screenshots

**The switch sits where you already look.** The icon in the session stats row *is* the
state — a recycle mark means this session rolls over, a split square means it keeps its own
compaction backend — and the tooltip spells out what the current mode does and what a click
switches to.

![The context-mode button and its tooltip](assets/context-mode-button.webp)

**The knobs, with the arithmetic done for you.** The settings card edits the rollover and
reminder thresholds and the retained tail, and reports the backend this session compacts
through (`compaction @ 80%` here), so the rollover threshold can stay below it.

<img src="assets/rollover-settings-card.webp" alt="The Context rollover settings card" width="620">

*Screenshots show the Chinese UI; human-facing text follows the app's language.*

## Install

Every version ships as a **built tarball attached to its GitHub release** — the release is
the distribution channel, not npm. Pick the release, install its tarball, restart the
profile.

### Let an agent do it

Paste this into the agent you already work with (Claude Code, Codex, or a DSH session):

```text
Read https://github.com/mumchristmas/dsh-context-rollover/releases/latest and install that
release into my "<profile>" profile — from its release tarball, not from npm.

1. Download the asset `dsh-context-rollover-<version>.tgz` from that release page, where
   <version> is the version in the release tag.
2. Run: dsh plugin --profile <profile> add <path to that .tgz>
3. Restart that profile once — its plugin composition changed.
4. Verify and report both results: `/rollover status` in a session, and the
   "Context Rollover" card under Settings → Plugin configuration.
5. Tell me which version you installed.

If that release carries no .tgz asset, stop and tell me. Do not install from npm, and do
not build from source.
```

The agent needs shell access and a working `dsh`. If it gets stuck, do the same thing by
hand:

### Or do it by hand

```sh
curl -LO https://github.com/mumchristmas/dsh-context-rollover/releases/latest/download/dsh-context-rollover-0.3.1.tgz
dsh plugin --profile <profile> add ./dsh-context-rollover-0.3.1.tgz
```

Installing changes the profile's plugin composition, so **restart the profile once** after
the first install. Then, in any session:

```text
/rollover status
```

It reports the mode, the thresholds, the session's compaction backend, and whether the
interceptor is active. Removing it is the same command with `remove` — `ctx.compaction`
never changed hands, so nothing needs repairing.

### Why the tarball, and what does not work

Nothing runs on your machine at install time: `dsh plugin add <tarball>` unpacks a
prebuilt `lib/`.

- **npm** — the registry copy is an older line; the release is the supported version.
- **`dsh plugin add github:mumchristmas/dsh-context-rollover`** — a git install pulls
  *source*, and no build script runs for you (pnpm blocks git-dependency build scripts by
  default), so `lib/` would be missing.
- **Building it yourself** works, and needs a DSH **source** checkout — the build reads
  DSH's type declarations from `packages/*/src`, so the app's bundled
  `…/dependencies/dsh` (an install, not a checkout) is not enough:

  ```sh
  git clone --depth 1 --branch v0.3.1 https://github.com/mumchristmas/dsh-context-rollover
  cd dsh-context-rollover
  pnpm install --ignore-scripts
  DSH_CHECKOUT_DIR=/path/to/deepseek-harness pnpm pack
  dsh plugin --profile <profile> add ./dsh-context-rollover-0.3.1.tgz
  ```

## Use

- **It works on its own.** At 75% of the window it rolls over using the notes and the
  last messages; from 60% it reminds the model once per window to save notes and cross at
  a clean point. A provider-confirmed context overflow forces the same rollover and
  retries the request.
- **The model can steer it.** `new_context` asks for a boundary at the next safe point,
  `notes` is its own working memory, `history` searches what left the window, and
  `get_context_remaining` reports the numbers.
- **You can steer it.** `/rollover on | off | status | now`, or the icon button in the
  session stats row (recycle mark = rollover, split square = standard compaction). The
  choice is per session and survives reload, fork, and resume.
- **You can read what survives.** Notes are plain markdown in
  `<dsh home>/notes/<session id>/`. Read them, correct them, keep them.

The rollover and reminder thresholds and the retained tail live in the **Plugin
configuration → Context rollover** settings card (`thresholdRatio: 0.75`,
`reminderThresholdRatio: 0.6` by default; the tail is edited in tokens, and empty means the
deployment's share of the window, `retainRatio: 0.1`). Every knob also has a row in the
plugin's `cordis.yml`.

## Read the source, then file issues

This bundle changes how your conversation is managed — do not take this README's word for
it. **Point your best agent at the source and audit it with you:**

```text
Read github.com/mumchristmas/dsh-context-rollover (start with src/index.ts and src/rollover.ts)
and explain in plain language what it does to my session: what it writes, what it calls,
when it fires, and anything that looks risky. Quote the code.
```

It is a small TypeScript package: `src/index.ts` (the interceptor, its listeners, the
commands), `src/rollover.ts` (the surface replacement inside DSH's compaction
transaction), `src/checkpoint.ts` (what the fresh window receives), `src/notes.ts` and
`src/history.ts` (the two stores), `src/tools.ts` (what the model can call),
`src/guidance.ts` (the one prompt section it adds), `src/settings.ts` / `src/mode.ts`
(the knobs and the per-session switch), `src/i18n.ts` (human-facing text, English and
Chinese), `src/client/index.cjs` (the browser button). `src/compat.ts` bridges two host
version lines.

Found a bug, a security concern, or a design you disagree with? **Open an issue** —
https://github.com/mumchristmas/dsh-context-rollover/issues

## Credits

Thanks to athif23, who started the original
[dsh-context-rollover](https://github.com/athif23/dsh-context-rollover). Its design, the
experiments, and the groundwork are his; this repository rewrites and continues that work.

## License

MIT
