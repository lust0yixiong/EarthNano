# EarthNano 功能来源与 Alpha 范围

本页区分源码来源、融合改造和新增产品设计。来源不等于实现状态，也不单独决定用户是否授权。固定基线来自 [UPSTREAMS.json](../../UPSTREAMS.json)：OpenScience `9e18c7d3c143a9dba49c7a586ad6cac8096f6dd5`，Harness² `1cfe254e8d25b15f37048c3730134686abe60335`。修改后的 vendor 和 EarthNano 新模块不能用作“上游已有”的证据。

## 上游已有能力与融合工作

| 能力                                                 | 固定上游依据                                                                                                                                        | EarthNano 所需工作                                                                   |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Python / R Notebook                                  | OpenScience `src/shared/notebook-language-contract.ts`、`src/main/notebook/environment-operations.ts`                                               | 复用原语言/runtime/权限和 producer，使基线与候选重新执行同一冻结任务；不另造 kernel  |
| 远程 Compute                                         | OpenScience `src/main/compute/agent-compute-service.ts` 的 `submitJob/cancelJob` 与原 job workflow                                                  | 将候选配置接到原授权、job、取消/收尾及产物证据；不重写 Compute 产品                  |
| 文件与二进制产物、不可变版本、审阅                   | OpenScience `src/main/artifacts/mcp-server.ts`、`src/main/managed-file-versions/service.ts`、`src/main/reviewer/artifact-version-review.ts`         | 保留真实字节和原 owner，将固定版本、实际 producer 与独立评估贯通；不可评估时如实显示 |
| 递归提案、组合、seq/par/k、匿名选择                  | Harness² `harness2/core/recursion.py`、`proposer.py`、`selection.py`、`schedule.py`                                                                 | 使用原方法调用同一个执行核心，不建立第二套候选选择规则                               |
| 完整 task stream / sweep、seed、过滤、domain workers | Harness² `harness2/core/schedule.py` 的 `task_stream/run_sweep/run_domain/run_task`                                                                 | 映射平台任务和来源，提供入口，保持原顺序、模式与并发语义                             |
| Library、反思与同域后续任务经验                      | Harness² `harness2/core/library.py`、`selection.py` 的 `reflect_adoption`、`schedule.py` 的 `run_domain`                                            | 保留原经验传递和采用行为，关联平台配置、执行与产物事实；独立评测不回流方法           |
| 已完成阶段的缓存与续跑                               | Harness² `harness2/core/runmark.py`、`schedule.py` 的 `_resume`                                                                                     | 与原 Session、固定配置/输入、资源收尾和剩余预算一致；重开不自动重放                  |
| 模型用量与方法成本记录                               | OpenScience `src/shared/acp-usage-contract.ts`、`src/main/database/migrations/0015-session-model-call-usage.ts`；Harness² `harness2/core/ledger.py` | 复用可得的原记录并关联、去重，保留已知/部分/未知，不从 token 推算真实 API 次数或账单 |

上述上游普通能力必须保留。工具代码留在仓库不等于已经进入候选执行；Compute/二进制的候选接线仍是待完成的融合工作。完整 sweep、Library 与 R 本身不能称为自行扩散的功能。

固定源码可从 [OpenScience 基线](https://github.com/aipoch/open-science/tree/9e18c7d3c143a9dba49c7a586ad6cac8096f6dd5) 与 [Harness² 基线](https://github.com/google-research/harness2/tree/1cfe254e8d25b15f37048c3730134686abe60335) 核对。方法对照不得以 EarthNano 的 `earthnano*.py` 代替原调度器。

## 单独跟踪的新增设计

| 设计                                     | 与上游能力的区别                                                             | 本轮边界                                                                      |
| ---------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 按普通任务的失败证据自动启动优化         | 原 Harness² 由调用方发起任务/sweep，不监听 OpenScience Send 决定何时升级优化 | 保留为后续策略；显式优化入口继续可用，不作为上游功能缺失或本轮新增开发任务    |
| 平台级配置审批、发布、推广和回滚         | Library adoption 是原算法选用 harness 并记录经验，不是全局配置审批发布协议   | 原 adoption 与经验传递须融合；额外治理流程单列，不混入 Alpha 的原能力补全门槛 |
| 所有角色的完整精确 API / 美元 / 耗时账本 | 上游仅提供部分用量事实与 runner 传入费用；没有完整跨角色生产账本             | 继续显示真实记录与覆盖范围；不为“补全上游”新建计价系统或以估计值补未知        |

这些设计曾进入讨论和计划，不能仅因不是上游功能就一概称为未授权；也不能因此自动成为首版融合的发布前置条件。本轮不展开这些新增机制，长期目标不在此删除。

## 用户明确要求的交付

EarthNano 命名、白底图标及 Apple 规范、多智能体协同、DeepSeek 验证、PR 交付和可用的 0.1-Alpha，属于本项目明确要求。它们不是上游算法功能，但也不是自行扩散。图标、安装包、更新渠道和原用户数据兼容性按实际交付证据验收；未发布的 feed 或未完成的包不能写成可用。

Alpha 的核心门槛是保留两侧能力、完成共用执行与证据链、取得适用的上游对照和真实端到端证据，并交付对应提交的可运行应用。具体状态见 [完成契约](ALPHA_CONTRACT.md)、[工作队列](NEXT_TASKS.md) 和各轮原始记录；历史文档中的后续设想不自动增加本版硬门。
