# dsh-context-rollover

[English](README.md) | 中文

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件，实现
**由模型自我驱动的上下文自管理**：模型可以主动选择结束当前工作的上下文窗口，写入本地工作笔记，开设全新的上下文窗口，记录笔记路径及旧窗口尾段原文，并继续任务，
以上过程**区别于传统摘要**。工作笔记构建出本地记忆，随时可召回、检索。灵感来自 `openai/codex` 的上下文管理模型。

本仓库在 athif23 发起的原始项目
[dsh-context-rollover](https://github.com/athif23/dsh-context-rollover) 基础上改写并延续。

## 有什么用

传统压缩会等窗口快满时，让 LLM 把原工作对话摘要后大幅丢弃。本插件改用工作中的模型自己编写笔记：

| | 传统压缩（`dsh-compaction-basic`） | 滚动归档（本插件） |
|---|---|---|
| 原文残留 | LLM 的浓缩摘要、部分最近原文 | 带有全部历史笔记路径的交接文档、部分最近原文 |
| 触发时点 | 固定式（DSH 默认为窗口的 80% 压力位），可能切在任务中途 | 浮动式，模型在你设置的区间中自行判断中断点 |
| 丢弃部分 | 摘要外的部分彻底灭失 | 筛选后记录在日志中，可用 `history` 工具检索 |
| 成本 | 每次压缩需要一次中断及额外 LLM 调用 | 无中断，无额外调用次数：笔记成为任务的一部分 |

一句值得思考的话：**使用模型中正经手处理这件事的（已激活）专家撰写工作记录，而不是让另一组（陌生）专家重新去猜哪部分更重要。**

经过改造，目前滚动归档策略无需繁琐配置，可在每个会话里独立激活，并与官方压缩后端并存 —— 微微抢先一步压低窗口大小，避免触发传统压缩。不替换模块，支持热更新、热卸载。

唯一多出来的部分是你
`<dsh home>/notes/<session id>/` 下的 markdown 格式工作笔记。

## 功能展示

<img src="assets/context-mode-bubble.webp" alt="滚动归档控件与它的悬停提示" width="620">

<img src="assets/context-mode-panel.webp" alt="滚动归档面板：已用比例、带刻度的进度条、下一步动作预告、以及模式开关" width="620">

<img src="assets/rollover-config-form.webp" alt="插件配置表单" width="620">

参数设置：侧边栏插件菜单 > 已安装 > 点击Context Rollover。
某些旧的DSH版本：侧边栏设置菜单 > 插件 > 点击Context Rollover

## 安装

最新版本（本插件分支使用github release发布.tgz包）：

**https://github.com/mumchristmas/dsh-context-rollover/releases/latest**

既然你已经在使用 DSH，不如直接让 Agent 动手：

```text
获取 mumchristmas/dsh-context-rollover 的最新 release ，使用“dsh plugin add”指令安装至当前运行的DSH配置中，不要使用 npm
```

### 支持的 DSH 版本

要求 `0.1.5-rc.x` 以上 
已于 `0.1.6-alpha.2` 完成兼容测试

## 怎么用

- **它会自己工作。** 在三个上下文压力点（可自行配置），触发以下流程：
    - 越过72%：软性提醒保存笔记，机制预热；
    - 越过76%：**预警式通知，提示窗口空间余量，完成笔记可自主换窗**；
    - 达到79%：强制触发换窗。
- **队列中的请求不会被丢弃。** 换窗会保住那条消息以及它之后的工作。
- **模型可以主动控制。**
    - `new_context` 工具用于主动请求换窗
    - `notes` 工具用于笔记记录
    - `history` 工具用于对离开窗口的笔记进行检索
    - `get_context_remaining` 则会报告确切窗口压力指标。
- **你也可以代为控制。**
    - `/rollover on | off | status | now`
    - 或是点击输入框下方的控件图标
- **你能看到留下了什么。**
    - 笔记就是 `<dsh home>/notes/<session id>/` 下的纯 markdown 文档。
    - 随读、随改、随留。

## 读源码，然后提 issue

这个插件会改变你的session管理模式 —— 别只听 README 的。**把你手边最好的 Agent 拉到
源码前，做一次深入审计。**

```text
读一下 github.com/mumchristmas/dsh-context-rollover（从 src/index.ts 和 src/rollover.ts 开始），
用大白话告诉我它对我的会话做了什么：写了什么文件、调了什么、什么时候触发、有没有风险。
请引用具体代码，仔细推理，不要臆造。
```

发现了 bug、安全问题，或者不认同的设计？**欢迎提 issue** ——
https://github.com/mumchristmas/dsh-context-rollover/issues

## 致谢

再次感谢 athif23 发起了最初的项目
[dsh-context-rollover](https://github.com/athif23/dsh-context-rollover)

本项目基于 DeepSeek V4.1 Flash 编写（尝试使用DeepSeek推动DeepSeek自身），并经过 GPT-6-Astra Max 交叉审计。

## 许可证

MIT
