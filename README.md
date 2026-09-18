# dsh-context-rollover

[English](README.md) | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin for
**model-driven context self-management**: the model may choose to end the context window it is
working in, write its working notes to disk, open a fresh context window, carry over the notes'
path and the tail of the old window verbatim, and continue the task — **not summarization**.
Those working notes become local memory, recallable and searchable at any time. Inspired by
the context-management model in `openai/codex`.

This repository is a rewrite and continuation of the original
[dsh-context-rollover](https://github.com/athif23/dsh-context-rollover) started by athif23.

## What you get

Traditional compaction waits until the window is nearly full, then has an LLM summarize the
work conversation and discard most of it. This plugin has the model doing the work write its
own notes instead:

| | Traditional compaction (`dsh-compaction-basic`) | Rollover (this plugin) |
|---|---|---|
| What survives | the LLM's condensed summary, plus some recent messages | a handover document carrying the paths of every note, plus some recent messages |
| When it fires | fixed — DSH's default is 80% window pressure — possibly mid-task | floating; the model picks the break point inside the range you set |
| What is dropped | everything outside the summary is gone for good | what is filtered out stays in the log, searchable with the `history` tool |
| Cost | one interruption and one extra LLM call per compaction | no interruption, no extra calls: the notes are part of the task |

One line worth thinking about: **the expert already handling the work writes the record,
rather than a second, unfamiliar expert guessing again at what mattered.**

Rollover needs no elaborate configuration: it activates per session, alongside the official
compaction backend, and steps in slightly earlier to take the window down before traditional
compaction would fire. It replaces no module, and supports hot reload and hot
unload.

The only thing it adds is your working notes: markdown, under
`<dsh home>/notes/<session id>/`.

## Screenshots

<img src="assets/context-mode-bubble.webp" alt="The rollover control and its hover tooltip" width="620">

<img src="assets/context-mode-panel.webp" alt="The rollover panel: context used, a tiered bar, what fires next, and the mode switch" width="620">

<img src="assets/rollover-config-form.webp" alt="The plugin configuration form" width="620">

Configuration: sidebar Plugins menu > Installed > click Context Rollover.
Some older DSH versions: sidebar Settings menu > Plugins > click Context Rollover

## Install

Latest release (this branch publishes a `.tgz` through GitHub releases):

**https://github.com/mumchristmas/dsh-context-rollover/releases/latest**

Since you already run DSH, just let the agent do it:

```text
Fetch the latest release of mumchristmas/dsh-context-rollover, and install it into the running
DSH configuration with the "dsh plugin add" command. Do not use npm.
```

### Supported DSH versions

Requires `0.1.5-rc.x` or newer.
Compatibility tested on `0.1.6-alpha.2`.

## Use

- **It works on its own.** Three context-pressure points (all configurable) drive the flow:
    - past 72%: a soft reminder to save notes, warming the mechanism up;
    - past 76%: **an advance warning with the room left in the window — with the notes done, it can change windows on its own**;
    - at 79%: the rollover is forced.
- **The request in flight is never dropped.** The rollover keeps that message and the work
  after it.
- **The model can steer it.**
    - `new_context` asks for a rollover
    - `notes` records notes
    - `history` searches the notes that have left the window
    - `get_context_remaining` reports the exact window-pressure figures.
- **You can steer it too.**
    - `/rollover on | off | status | now`
    - or click the control icon under the input box
- **You can see what survived.**
    - The notes are plain markdown under `<dsh home>/notes/<session id>/`.
    - Read them, change them, keep them.

## Read the source, then file issues

This plugin changes how your session is managed — do not take this README's word for it.
**Point the best agent you have at the source and have it audit deeply.**

```text
Read github.com/mumchristmas/dsh-context-rollover (start from src/index.ts and src/rollover.ts)
and tell me in plain language what it does to my sessions: what files it writes, what it calls,
when it fires, and whether anything is risky. Quote the actual code, reason carefully, and do
not invent anything.
```

Found a bug, a security problem, or a design you disagree with? **Issues are welcome** —
https://github.com/mumchristmas/dsh-context-rollover/issues

## Credits

Thanks again to athif23 for starting the original
[dsh-context-rollover](https://github.com/athif23/dsh-context-rollover)

Built on DeepSeek V4.1 Flash (an attempt to use DeepSeek to advance DeepSeek itself), and
cross-audited by GPT-6-Astra Max.

## License

MIT
