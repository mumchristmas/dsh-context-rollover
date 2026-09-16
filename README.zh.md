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

最新版本（插件压缩包就挂在这个 release 上）：

**https://github.com/mumchristmas/dsh-context-rollover/releases/latest**

你已经在用 DSH，所以直接让会话里的 Agent 装：

```text
请把 dsh-context-rollover 的最新 release 附件下载到当前工作目录，并把它装进我的
"<profile>" profile —— 用 release 附件，不要用 npm —— 然后重启该 profile：

  curl -LO https://github.com/mumchristmas/dsh-context-rollover/releases/latest/download/dsh-context-rollover-0.3.3.tgz
  dsh plugin --profile <profile> add ./dsh-context-rollover-0.3.3.tgz
```

手工执行就是同样两条命令。因为插件组合变了，profile 需要重启一次；之后 **设置 → 插件配置**
里的卡片和输入框下方的模式按钮，就是它已经生效的凭证。

### 支持的 DSH 宿主线

peer 范围接受本仓库实际构建并测试过的每一条线：

| 线 | 版本 |
|---|---|
| 公开 compat 线（npm，`compat/` 中钉死） | `0.1.6-alpha.1` |
| 同级 checkout 的源码线 | `0.1.0-rc.x`、`0.1.5-rc.x` |

每条范围都写成显式并集 —— `>=0.0.1-rc.1 || >=0.1.0-rc.1 || >=0.1.5-rc.0 || >=0.1.6-alpha.1` —— 因为 semver
只允许预发布版本满足「`[major, minor, patch]` 三元组本身也带预发布」的比较符。**新增一条宿主
预发布线必须手工加进这个并集**；没有任何静态范围能接受任意靠后的三元组，`tests/metadata.spec.ts`
同时钉住了已接受的线和这一限制。范围不带上限，所以未来的大版本会照常安装：与某条线的兼容性由
「针对它构建并测试」确立，而不是由安装器决定。

`compat/` 里的包刻意钉死到具体版本而不是 `latest`：npm 上 `@deepseek-ai/dsh-*` 的 `latest`
标签是 `0.0.1-rc.1`，浮动写法会静默地针对一条远古线做检查，`npm run typecheck:compat`
也就不再是证据。改这些钉死的版本和上面的 peer 并集要同步进行，然后重跑
`npm run compat:install`。

### 在 DSH 0.1.6 上运行

升级前有两处宿主侧变化值得知道。两处都不需要改插件。

- **会话事件默认上报到 DeepSeek 官方端点。** DSH 0.1.6 把 `session-log-deepseek` 这一行从
  选择加入改成了默认开启（`enabled` 现在默认 `true`，且 `base` bundle 挂载该行时没有覆盖
  配置）。当使用 DeepSeek 适配器连接官方端点时，每次请求都会携带「上次确认之后」记录的会话
  事件 —— 其中包含本插件写入的 `compaction/summary` 与 checkpoint `user/message`，也就是你的
  笔记与 handoff 文本。若要留在本地，在 profile patch 里显式关掉该行：

  ```yaml
  - id: session-log-deepseek
    name: '@deepseek-ai/dsh-session-log-deepseek'
    config:
      enabled: false
  ```

- **DeepSeek 默认改用 Messages 协议。** 如果你手工钉过旧的官方根地址，请移除该覆盖，或改成
  `https://api.deepseek.com/anthropic`。这件事在这里有影响，是因为路由解析失败会让
  `requestContext().contextWindow` 取不到值，而没有窗口就没有百分比可算：提醒与自动滚动都会
  自行让位（显式的 `/rollover now` 和模型的 `new_context` 仍然可用）。

## 怎么用

- **它会自己工作。** 同一条刻度上的三个点，按触发顺序：窗口用到 72% 起，它每窗口提醒模型一次：保存笔记、
  在干净的节点跨过边界；从 76% 起它会把话说白：**这是最后一段，还剩多少空间，停下来把笔记写完**；
  到 79% 时它带着笔记和最近消息自动换窗。provider 确认的上下文超限会强制执行同样的换窗，并重试请求。
- **最后机会是真的。** 最后一段的提醒到来时，前面还留着窗口 3% 的空间，模型有地方回应它 ——
  仅仅被"告知"过窗口快满的会话从来没有这一步。这条提醒**不移动滚动点**：换窗仍然在 79% 触发，
  早于其它压缩后端的阈值，否则赢下这个会话的会是摘要。
- **你正在等的那个请求不会被丢掉。** 一个很长的自主回合会把开启它的那条消息挤出保留尾部；
  换窗依然会保住那条消息以及它之后的工作，代价是单次换窗腾出的空间更少。
- **模型可以主动控制。** `new_context` 请求在下一个安全点开新窗口，`notes` 是它自己的
  工作记忆，`history` 检索已经离开窗口的对话，`get_context_remaining` 报告数字。
- **你也可以控制。** `/rollover on | off | status | now`，或者会话统计行里的图标按钮
  （循环箭头 = 滚动，方块拆分 = 标准压缩）。选择是按会话的，能在 reload、fork、resume
  之后保留。
- **你能看到留下了什么。** 笔记就是 `<dsh home>/notes/<session id>/` 下的纯 markdown。
  随便读、随便改、随便留。

笔记目录被当作一条边界，而不只是一个文件夹：笔记路径同时做**词法**与**物理**校验，所以放在
里面的符号链接无法让一个合法的 `path=linked.md` 读到或覆盖目录外的文件；确实指向目录内的链接
仍然可用。写入以原子方式替换文件；读不出来的笔记绝不会被当成空文件 —— 它会被报出来，而不是被
覆盖。两条限制需要说明白：Node 没有 `openat`，解析与打开之间的竞态无法彻底消除；这是单机上的
按会话目录，不是沙箱。

滚动阈值、提醒阈值、最后机会宽度和保留尾部在 **Plugin configuration → Context rollover** 设置卡片里
（默认 `thresholdRatio: 0.79`、`lastChanceRatio: 0.76`、`reminderThresholdRatio: 0.72`；保留尾部按 Token 编辑，
留空表示沿用部署配置里按窗口比例保留的默认值 `retainRatio: 0.1`）。每一项也都能写在插件行
的 `cordis.yml` 里。三个值都是**点**，卡片会把它们按触发顺序编号排成一条刻度，最后一段的宽度
（79 − 76）作为推导值显示，不需要打开 tooltip 就能看出关系。

### 这套默认值面向大窗口

出厂的这条阶梯是照着当前主流的百万级窗口调的（国内模型尤其如此）。三档全都是窗口的**占比**，
所以对应的 Token 距离会随窗口一起放大：

| 窗口 | 第 3 档在 79% 执行 | 第 1 档早 70,000 Token 触发 | 第 2 档再早 30,000 开启 |
|---|---:|---:|---:|
| 1M | 790,000 | 720,000 | 760,000 |
| 272K | 214,880 | 195,840 | 206,720 |
| 128K | 101,120 | 92,160 | 97,280 |

在 1M 上这些距离是宽裕的。这也是默认带宽从早期版本的 10% 收到 3% 的原因：100 万 Token 的 10%
等于每个窗口都要在"最后一段"上花掉 100,000 Token。

**窗口小得多时，同样的占比会紧得多**，而且大约在 18 万以下，起决定作用的就是绝对距离而不是比例了：
128K 窗口上"提醒到换窗点"只有 8,960 Token，大致就是一次大工具输出的量，一步就可能把窗口从提醒点
推进到带内甚至越过它，预警拿不到一个可用的回合。如果你跑的是小窗口模型，请把这套默认值当作起点而不是策略，自行探索参数边界 ——
`get_context_remaining` 会报实时数字，卡片上的阶梯行也会显示每一档当前落在哪里。调高
`reminderThresholdRatio` 可以拉长预警提前量；调低 `lastChanceRatio` 能给模型留出更多余地；
保留尾部建议直接按 Token 显式设置，而不是用比例。

请保持 `reminderThresholdRatio + lastChanceRatio ≤ thresholdRatio`，并让滚动阈值严格低于本会话的
压缩后端（卡片会报出它观测到的最严格阈值）。违反前一条的阶梯不会发出提醒而是被静默压掉 ——
卡片会在写入前拒绝这种组合。

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

本项目基于 DeepSeek V4.1 Flash 编写，并经过 GPT-6-Astra Max 交叉审计。

## 许可证

MIT
