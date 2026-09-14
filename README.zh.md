# dsh-context-rollover

[English](README.md) | 中文

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 组合包，实现
**模型驱动的上下文自管理**：模型可以主动结束一个上下文窗口，在全新的窗口里继续，
全程**不做摘要**。它自己写的笔记和最近几条消息会被带走；其余对话留在会话日志里，
随时可检索。灵感来自 `openai/codex` 的上下文管理模型。

本仓库在 athif23 发起的原始
[dsh-context-rollover](https://github.com/athif23/dsh-context-rollover) 基础上改写并延续。

## 有什么用

传统压缩会等窗口快满时，让一个 LLM 把即将丢弃的对话摘要掉。本插件改用干活模型自己写的
笔记：

| | 摘要（`dsh-compaction-basic`） | 滚动（本插件） |
|---|---|---|
| 活下来的是什么 | 一个 LLM 对被丢弃对话的摘要 | 模型自己的笔记、它的交接，以及最近消息的原文 |
| 什么时候发生 | 计数器一响就切，可能切在任务中途 | 模型自己选的阶段边界 |
| 被丢弃的对话 | 被摘要掉 | 保留在日志里，可用 `history` 工具检索 |
| 成本 | 每次压缩多一次 LLM 调用 | 零调用；同样的笔记永远得到同样的检查点 |

一句话：**交接由做过这件事的模型来写，而不是让一个陌生人去猜什么重要。**

它可以装进任意 profile，在每个会话里生效，并与已有的压缩后端并存 —— 它只是抢先一步，
不替换对方。没有凭据、没有网络调用、没有遥测；唯一写入磁盘的是
`<dsh home>/notes/<session id>/` 下的 markdown 笔记。

## 安装

### 让 Agent 帮你装

把下面这段发给你平时用的 Agent（Claude Code、Codex，或一个 DSH 会话）：

```text
请把 dsh-context-rollover 组合包装进我的 "<profile>" profile 并验证它能工作：
执行 `dsh plugin --profile <profile> add dsh-context-rollover`，重启该 profile 一次，
然后在会话里检查 `/rollover status`，并确认设置页出现了 "Context rollover" 卡片。
有不清楚的地方去读项目源码（github.com/mumchristmas/dsh-context-rollover），不要猜。
```

Agent 需要有 shell 权限和可用的 `dsh`。如果它卡住了，手工路径就是同样的步骤：

### 或者手工执行

```sh
dsh plugin --profile <profile> add dsh-context-rollover
```

- 没有 `dsh` CLI：`pnpm --dir "$DSH_HOME/profiles/<profile>" add dsh-context-rollover`
- 从 GitHub 安装：`dsh plugin --profile <profile> add github:mumchristmas/dsh-context-rollover`
- 从本地检出安装：`dsh plugin --profile <profile> add /path/to/dsh-context-rollover`

安装会改变 profile 的插件组合，所以首次安装后**重启该 profile 一次**。然后在任意会话里：

```text
/rollover status
```

它会报告模式、阈值、本会话的压缩后端，以及拦截器是否生效。卸载就是把同样的命令换成
`remove` —— `ctx.compaction` 从未易主，不需要任何修复。

## 怎么用

- **它会自己工作。** 窗口用到 75% 时，它带着笔记和最近消息自动滚动；从 60% 起，它每
  窗口提醒模型一次：保存笔记、在干净的节点跨过边界。provider 确认的上下文超限会强制
  执行同样的滚动，并重试请求。
- **模型可以主动控制。** `new_context` 请求在下一个安全点开新窗口，`notes` 是它自己的
  工作记忆，`history` 检索已经离开窗口的对话，`get_context_remaining` 报告数字。
- **你也可以控制。** `/rollover on | off | status | now`，或者会话统计行里的图标按钮
  （循环箭头 = 滚动，方块拆分 = 标准压缩）。选择是按会话的，能在 reload、fork、resume
  之后保留。
- **你能看到留下了什么。** 笔记就是 `<dsh home>/notes/<session id>/` 下的纯 markdown。
  随便读、随便改、随便留。

阈值和保留尾部在 **Plugin configuration → Context rollover** 设置卡片里（默认
`thresholdRatio: 0.75`、`reminderThresholdRatio: 0.6`、`retainRatio: 0.1`），
也可以写在插件行的 `cordis.yml` 里。

## 读源码，然后提 issue

这个组合包会改变你的对话如何被管理 —— 别只听 README 的。**把你手边最好的 Agent 拉到
源码前，一起审计：**

```text
读一下 github.com/mumchristmas/dsh-context-rollover（从 src/index.ts 和 src/rollover.ts 开始），
用大白话告诉我它对我的会话做了什么：写了什么文件、调了什么、什么时候触发、有没有风险。
请引用具体代码。
```

它是一个很小的 TypeScript 包：`src/index.ts`（拦截器、监听器、命令）、
`src/rollover.ts`（DSH 压缩事务里的表层替换）、`src/checkpoint.ts`（新窗口实际收到
什么）、`src/notes.ts` 与 `src/history.ts`（两个存储）、`src/tools.ts`（模型能调用的
工具）、`src/guidance.ts`（它加的唯一一段提示词）、`src/settings.ts` / `src/mode.ts`
（旋钮与会话开关）、`src/i18n.ts`（英中双语的人面向文本）、`src/client/index.cjs`
（浏览器按钮）。`src/compat.ts` 桥接两条宿主版本线。

发现了 bug、安全问题，或者不认同的设计？**欢迎提 issue** ——
https://github.com/mumchristmas/dsh-context-rollover/issues

## 致谢

感谢 athif23 发起了最初的
[dsh-context-rollover](https://github.com/athif23/dsh-context-rollover)：它的设计、实验与
地基都出自他，本仓库在此基础上做了改写与延续。

## 许可证

MIT
