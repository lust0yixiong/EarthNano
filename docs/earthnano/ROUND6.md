# 第六轮：接入 Harness² 原递归模式与真实候选选择

本轮是 Harness² 补全计划的第一步：在现有桌面优化入口开放原 sequential/parallel
方法、`k` 和并发限制，让多候选进入原匿名选择器。通过 PR 提交，不自动合并。
基础为已合并的第一至第五轮；应用图标 PR 独立处理。

## 核心复用与调用关系

```text
TaskOptimizationPanel
  → 原 typed command / preload / desktop-optimization-ipc
  → DesktopOptimizationManager
  → runPersistentOptimization
      → 原 Harness² earthnano.run
          → schedule.mode_token / Namespace / run_task
          → recursion.run_mode → run_sequential 或 run_parallel
          → selection_pool → trivial_selection 或 run_selection
      ↔ 私有 JSONL → HarnessOptimizationBinding → ExecutionCore
          → Claude candidate driver → 原 Claude Code / ACP runtime
          → 原 Session / ArtifactVersion / Review
      → 独立 semantic assessment → 原 Review 持久化
```

递归次序、INV/DOM 改进、组合、证据构造、匿名编号和选择规则由原 Harness² 提供。
平台负责冻结引用、排队与并发、执行接纳预算、取消和持久化。

相对本轮基线 `a0363969ed64acf5ea046c3aa859db733431f145`，
`vendor/harness2/harness2/core/` **没有新增修改**。本轮 vendor 改动限于 EarthNano
入口、说明和测试。此前为共同执行加入的 seam、控制停止传播和 `claude-text` profile
仍存在，不能把整个 vendor 目录称为未经修改的上游副本。

OpenScience 的 Session、产物版本、Review 及 Claude/ACP owner 继续作为事实来源；
没有创建另一套产物数据库或另写优化算法。上游固定版本和许可证保持不变，见
[UPSTREAMS.json](../../UPSTREAMS.json)。

## 用户可见行为

- 优化模式：sequential 或 parallel。每次优化选择一种；尚不提供双模式 sweep。
- `k` 为 1–8，并发上限为 1–4。算法的 parallel 模式与平台实际运行并发是两个参数。
- 单模式首轮执行数为 `7*k + (k>1 ? 1 : 0) + 2`，末尾两次为独立评估。
  `k=1` 为 9，`k=2` 为 17。预算最多 128；重试另外消耗同一预算，失败不会退还。
  此预算不是 provider 请求次数、token 或金额上限。
- 进度显示原阶段标识，完成后显示选择标签、候选数和理由。
- `k=1` 保留原 trivial selection；`k>1` 由模型在 k 个匿名最终产物间选择。
  原方法的候选池不包含基线和中间产物，不改为“保证比基线更好”的策略。
- 独立评估标准在开始前固定；多基线时预先指定 `base1` 与选定最终版本比较，
  不根据完成顺序或评分选择基线，也不把结果当作所有基线的统计平均。

省略 `method` 的旧调用仍按 sequential / k=1 / concurrency=1 运行，旧请求摘要保持兼容。
桌面 IPC 校验可选参数，未知字段与不完整参数在接纳前拒绝。

## 生命周期与证据

所有排队执行在接纳时占用预算；运行容量由共同核心控制，排队和运行中的候选都可停止。
未知清理仍保留栅栏，不能因为调用返回就释放容量。
并发停止时，在原 runtime 退出后最多再等待 25 秒，让实际 driver 完成 Session/Review
提交及终态落盘。超时或清理未确认仍保留 writer lock，不自动重放。

普通、已确认清理的失败尝试可以由原 Harness² 重试，保留失败记录和预算占用。
取消、超时、预算拒绝、契约冲突与清理未知继续作为控制停止传播。
选择器直接读取固定产物版本，并把原 choice/why 回复另存为 `selection.md`，
使原 Artifact/Review owner 同时保存选择证据。

平台仍要求每个 completed 执行通过固定版本完整性检查。这比原方法的文本树回退更严格：
空输出、缺失输出或非法 JSON 可能使 Python 在恢复后仍无法通过平台验收。
普通失败后成功重试已覆盖；不能据此声称所有失败形态与原 benchmark 环境完全等价。
原选择器格式错误时保留 first-final fallback 和 partial 状态，不展示为成功优化。

## 验证材料

执行结果与命令记录见 [ROUND6_VALIDATION.json](ROUND6_VALIDATION.json)，
真实模型调用记录见 [ROUND6_DEEPSEEK_VALIDATION.json](ROUND6_DEEPSEEK_VALIDATION.json)。
Python 测试将两种 k=2 模式的阶段、账本、证据树与 LEGACY 路径逐项比较。
真实进程测试使用原 Claude CLI、ACP、SQLite、Session、产物版本和 Review，
验证多候选选择、固定 base1、重开读取、预算与停止。

浏览器验证参数提交、选择结果、轮询及停止；真实 Electron 冒烟验证实际命令传递和
不支持路由在接纳前拒绝。DeepSeek 成功路径由生产 manager 集成测试驱动，
不是从 Electron 点击完成的付费运行。

最终检查通过：965 项相关单元测试、7 项原生进程/持久化测试、40 项 Python 回归、
6 项 Chrome UI 测试和 1 项 Electron 冒烟；类型、lint、格式、契约生成和适用构建也通过。
同步目录出现临时空读后，最终实现检查移到本地临时源码副本执行，依赖按原 lockfile 安装；
原仓库依赖和 schema 未变，环境细节保留在验证 JSON 中。

| DeepSeek k=2 验证      | 执行次数 | Session / 产物版本 / Review | 基线 / 候选评分 |
| ---------------------- | -------- | --------------------------- | --------------- |
| parallel，首次通过     | 17       | 17 / 21 / 19                | 100 / 100       |
| sequential，第二次通过 | 18       | 18 / 28 / 20                | 96 / 100        |

sequential 首次在最后评审未交付规定的唯一 `assessment.json` 时失败，完整失败记录保留。
第二次为有上限的整轮开发验证重跑，没有修改生产提示、标准或放宽校验，也没有加入评审自动重试。
两种成功运行都重新打开数据库并核对持久化证据。评分来自单个合成任务的模型评审；
即使出现 96→100，也不能据此声称可重复的科研质量收益。

## 后续边界

本轮尚未接入 Library、reflect_adoption、跨任务领域流和配置推广。
普通 Send 仍保留现有执行路径；完整迁移、科研工具 profile、恢复操作、费用预算、
默认自动触发和跨平台发布另行推进，见 [后续任务](NEXT_TASKS.md)。
小型 CSV 样例只验证机制和证据链，不能证明科研质量提升。
