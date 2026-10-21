# Compute 候选融合：共同接线契约

固定来源仍为 `UPSTREAMS.json` 的 OpenScience `9e18c7d3c143a9dba49c7a586ad6cac8096f6dd5` 与 Harness² `1cfe254e8d25b15f37048c3730134686abe60335`。在已验证二进制融合 `ce0e1d498` 上继续实施；Windows 版本延期 0.2，当前验收为 macOS/Linux。

复用原 Node control REPL、ComputeService/Job repository、审批、结果回投、Notebook producer、ArtifactVersion 和 Review。不能新增 SSH/Job 引擎、第二份任务状态或产物存储。下文是实施契约；共享类型通过不等于 Compute 候选已可用。

## 已落地的共同类型

- `shared/earthnano/compute-profile.ts`：工具判别值为 `notebook-compute`，不属于 Python/R 数据语言。`FrozenComputeContext` 包含来源 Project/Session、原 `SessionComputeHostAccess` 和每个 enabled provider 的唯一 `{id,providerId,shape,executionMode}`。描述不含 SSH 配置、密码、probe、permission grant 或可变详情。
- `SessionComputeHostAccess` 的 type-only 定义移到原 `shared/compute.ts`，原 main owner 继续 re-export，行为不变。冻结来源使用原 Session policy，保留 legacy selected 缺省为 enabled、显式空 selected 的区别。selected 是原任务选择，不是执行批准。
- `normalizeFrozenManagedInputs` 提取原不可变输入的同一字段、去重、Project、相对路径、字节和摘要验证，允许 Compute 的 0 或多个输入；Python/R 的 `normalizeFrozenNotebookInputs` 保持原 1–10 及 JSON 字节。实际读取、预算和租约仍由原 input owner 负责。
- `main/earthnano/compute-candidate-ports.ts`：host-only `TrustedControlPolicy`；continuation target 精确引用原 `BackgroundResultDeliveryOwnerOptions` 的三个 callback，保留 admission 与 result 两个 promise；route 明确 ordinary/private/private-unavailable，后者不能回退普通 Send。
- `TrustedExecutionTurnOwner` 只抽取原可信 owner 的共同身份接口；delegated owner 保留原 frame/Attempt 字段，application owner 独立校验原 delivery dispatch，不伪造委派。

本阶段没有开放 Compute 候选工具或改动原 Job/审批生命周期。

## 后续实现共用的字段与权限

`CandidateHarness.tools` 和 `CandidateEnvironment.compute?: FrozenComputeContext` 的类型已声明，序列化准入仍待接通，不能直接启动该 profile。实现时 compute 与 `notebook` runtime 互斥，仍用原 `provider-and-notebook-policy`。`CandidateTask.managedInputs` 复用原 frozen input 类型及 staging。旧未含 compute 的快照、缓存和 JSON shape 不变；Python/R 仍完整验证原 1–10 约束。

主智能体实现同一 `freezeComputeContext` / `assertFrozenComputeContext`，从原 Session 与 host repository 读取；原 host reservation 只覆盖创建私有 Session 的窗口。private Session 用原 persisted access policy 和 projection，不只修改内存 registry。新 work 要重新核对来源仍启用这些 host、原 row id/shape/归一化 executionMode 未变；来源后来新增或新选择不会悄悄改变冻结任务，撤权不能阻止清理已拥有 Job。

原 `repl_execute` 到原 `executeControl`，不伪造 `FrozenNotebookRuntime.language='repl'`。provider 模型及实际控制运行时的观察来自原 executor；未观察的配置仍 unknown。

## 两侧接线边界

| Owner          | 文件/职责                                                                                                 | 必须保留                                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 主智能体       | 共享类型、来源 freeze/assert、candidate snapshot/method/桌面装配与整体验证                                | 一个配置/任务/执行与证据模型；不新增 Compute 数据库或 provider                                               |
| 平台控制 owner | 原 Notebook RPC capability、Compute approval/context、control policy resolver                             | 最小方法与原集合取交集；token 覆盖模型自报身份/producer/policy；实际 private Session 查 grant                |
| 执行 owner     | 原 ACP boundary/driver、persistent candidate owner、原 background result routing、Job/producer/导出与收尾 | exact owned application Turn，不变 mission identity；同一 Core budget/deadline；原 Job/投递 owner 是事实权威 |

候选仅 baseline/candidate 可有 Compute profile；proposer/composer/selector/reflection 仍 workspace-only。最小 control RPC 为 `computeCall`、`capabilitiesCall`、`hostSdkHelp`，与原 allowlist 取交集，不能顺带获得 agents/LLM/connectors/environment mutation。冻结输入已经 staging，不开放任意 Version 或宿主路径。

审批 context 的 `interactionPolicy` 只能来自可信 token/owner。沿原 private Session 和原 PermissionGrantAdapter 查询已有 scope；source Session grant 不复制。deny-unresolved 下无有效授权或需要明文持久化显式批准时，直接拒绝，不广播卡片、不建等待 timer、不记 once/新 grant。普通 interactive 行为保持。

## 同一执行中的后台计算

1. 初始 prompt 经原 Core 与 Session admission，原 control REPL submit 返回原 job_id；**回执不是完成**。原 Session 初始 Turn 终态提交并释放其 lease 后，逻辑 Core 仍 running，占同一并发 slot 和绝对 deadline。
2. 原 Job/harvest/BackgroundResultDelivery 触发同一 private runtime 的合法 application Turn。只接受原 attribution、deliveryIds、continuationMessageId 和精确 owned Session/Job/producer。Core 初始 identity 不覆盖，不新建 Core 或 TaskRun，不让普通任意第二 Turn 通过。
3. 使用原投递 owner 的 admission/result/已保存 continuation 检查；known-private 但 owner 不可用时保留 pending。读取完整 final result 才沿原规则抑制自动分析；多个 Jobs/批次不丢，不另建 poll/状态队列。
4. 每个原 admitted Turn、Notebook control Run、Job、producer、Version 与 Review 保留可核对引用。Compute 完整结果的 producerRunId 沿原规则发布，可在合法后续分析 Turn 发布，不强迫等于初始 prompt；外 Session/外执行 producer 拒绝。
5. 原 Core admission-count 预算不退不重置；continuation 属于同一逻辑执行。多 Turn 原 usage 保存在 Session 事实中，初始 logical-prompt 用量不能冒称全程；缺少适用聚合表达时返回 unknown 并说明来源。

## 停止、恢复与验证

沿原 driver 的唯一 cancellation registration 组合 exact prompt 和拟新增 optional `cancelOwnedBackground`，监听持续到 readResult 结束。先关闭新准入、取消待审批及 owned Jobs；来源撤权后仍可调用原内部取消。`shutdown.reaped` 必须包含原远端 Job settlement；本地 socket/进程退出或 cancel 请求返回不能升级 cleanup confirmed。未知远端结果保留 unknown 和原 owner 重试事实，不停其他 Session。

重开不调用模型或 submitJob；显式续跑前按原 owner 对已存 Job/continuation 调和。不能仅见 Core interrupted 就创建 retry 并重复提交未知资源。普通 TaskRun 的初始 Turn 边界保持，候选由自己的现有结果 owner 等待后台完成，不改原 Job 或 delivery 状态机。

后续验收必须覆盖：0/多个固定输入及旧 Version；host 撤权/替换/mode 变化；最小 RPC 与不可伪造 policy；无 grant 无 UI 等待；真实原 Node REPL/Job/投递第二 Turn；多 Job 与错误 delivery 拒绝；原 JSON/PNG producer→Version→匿名资产→Review；等待/审批/harvest 中 stop/deadline、远端 unknown、关闭失败及重开零重提。原文本、Python/R、binary、delegation 和 Harness 方法测试身份保留。先用原 repository/transport fixtures 证明明确层级，再用 DeepSeek 做真实后端验证；本地 transport 证据不能冒充外部 SSH/Slurm 验收。

共享阶段 6 个测试文件 136/136、无跳过，完整 Node/sandbox/Web compiled types 通过；原始证据随本轮提交保存。执行/审批/Job 候选路径与真实模型验收仍待实施，不因上述 DTO 检查通过就标记功能完成。

来源 helper 已实现为 `main/earthnano/compute-context.ts` 的 `freezeComputeContext` / `assertFrozenComputeContext`，只读原 Session/host repository。可选 providerId 检查原冻结 enabled 集合；原 row id/shape/mode 变化或来源撤权拒绝，新选择/新增 host 不扩张旧任务。3 文件 58/58、完整 compiled types 及 lint 通过，见 [来源身份验证](validation/alpha/compute-source-context/manifest.json)。这些 helper 尚未接入候选启动，不是执行授权或实际 Compute 验收。
