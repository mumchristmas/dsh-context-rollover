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

## 功能展示

**开关就在你本来就会看的地方。** 会话统计行里的图标*就是*状态 —— 循环箭头代表本会话使用滚动，
方块拆分代表保留自己的压缩后端 —— 悬停即可看到当前模式在做什么、点击会切到什么。

![上下文模式按钮与它的提示](assets/context-mode-button.webp)

**旋钮，以及替你算好的算术。** 设置卡片可以调滚动阈值、提醒阈值和保留的最近对话，并显示本会话
实际走的压缩后端（图中是 `compaction @ 80%`），提醒你把滚动阈值保持在它之下。

<img src="assets/rollover-settings-card.webp" alt="Context Rollover 设置卡片" width="620">

*截图为中文界面；人面向文本会跟随应用语言。*

## 安装

每个版本都以**构建好的 tarball 附件形式挂在对应的 GitHub Release 上**——发布渠道是
Release，不是 npm。选好版本，装它的 tarball，然后重启 profile。

### 让 Agent 帮你装

把下面这段发给你平时用的 Agent（Claude Code、Codex，或一个 DSH 会话）：

```text
请读 https://github.com/mumchristmas/dsh-context-rollover/releases/latest，把那个 release
装进我的 "<profile>" profile —— 用 release 里的 tarball 附件，不要用 npm。

1. 从该 release 页面下载附件 `dsh-context-rollover-<version>.tgz`，<version> 就是 release
   标签里的版本号。
2. 执行：dsh plugin --profile <profile> add <上面那个 .tgz 的路径>
3. 重启该 profile 一次 —— 它的插件组合变了。
4. 验证并回报两项结果：会话里的 `/rollover status`，以及 设置 → 插件配置 里的
   "Context Rollover" 卡片。
5. 告诉我你装的是哪个版本。

如果那个 release 没有 .tgz 附件，停下来告诉我。不要改用 npm，也不要从源码构建。
```

Agent 需要有 shell 权限和可用的 `dsh`。如果它卡住了，手工路径就是同样的步骤：

### 或者手工执行

```sh
curl -LO https://github.com/mumchristmas/dsh-context-rollover/releases/latest/download/dsh-context-rollover-0.3.1.tgz
dsh plugin --profile <profile> add ./dsh-context-rollover-0.3.1.tgz
```

安装会改变 profile 的插件组合，所以首次安装后**重启该 profile 一次**。然后在任意会话里：

```text
/rollover status
```

它会报告模式、阈值、本会话的压缩后端，以及拦截器是否生效。卸载就是把同样的命令换成
`remove` —— `ctx.compaction` 从未易主，不需要任何修复。

### 为什么用 tarball，以及哪些方式不行

安装时不会在你机器上跑任何东西：`dsh plugin add <tarball>` 解包的就是预构建好的 `lib/`。

- **npm** —— 注册表上那份是更早的版本线；受支持的是 Release。
- **`dsh plugin add github:mumchristmas/dsh-context-rollover`** —— git 安装拉的是**源码**，
  而且没有任何环节替你运行构建脚本（pnpm 默认拒绝执行 git 依赖的构建脚本），装完会缺
  `lib/`。
- **自己构建**可行，但需要一个 DSH **源码**检出——构建要从 `packages/*/src` 读 DSH 的
  类型声明，所以应用自带的 `…/dependencies/dsh`（那是安装包，不是检出）不够用：

  ```sh
  git clone --depth 1 --branch v0.3.1 https://github.com/mumchristmas/dsh-context-rollover
  cd dsh-context-rollover
  pnpm install --ignore-scripts
  DSH_CHECKOUT_DIR=/path/to/deepseek-harness pnpm pack
  dsh plugin --profile <profile> add ./dsh-context-rollover-0.3.1.tgz
  ```

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

滚动阈值、提醒阈值和保留尾部在 **Plugin configuration → Context rollover** 设置卡片里
（默认 `thresholdRatio: 0.75`、`reminderThresholdRatio: 0.6`；保留尾部按 Token 编辑，
留空表示沿用部署配置里按窗口比例保留的默认值 `retainRatio: 0.1`）。每一项也都能写在插件行
的 `cordis.yml` 里。

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
