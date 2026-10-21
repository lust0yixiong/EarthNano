# Compute 候选融合：共同接线契约

固定来源仍为 `UPSTREAMS.json` 的 OpenScience `9e18c7d3c143a9dba49c7a586ad6cac8096f6dd5` 与 Harness² `1cfe254e8d25b15f37048c3730134686abe60335`。在已验证二进制融合 `ce0e1d498` 上继续实施；Windows 版本延期 0.2，当前验收为 macOS/Linux。

当前状态见文末“真实 owner 与桌面整合”；下列共享类型阶段的准入关闭描述保留为历史。当前已随真实 owner 开放 Compute snapshot 和同一任务目录入口，但完整原 Compute 服务链及 DeepSeek 验收仍未完成。

复用原 Node control REPL、ComputeService/Job repository、审批、结果回投、Notebook producer、ArtifactVersion 和 Review。不能新增 SSH/Job 引擎、第二份任务状态或产物存储。下文是实施契约；共享类型通过不等于 Compute 候选已可用。

## 已落地的共同类型

- `shared/earthnano/compute-profile.ts`：工具判别值为 `notebook-compute`，不属于 Python/R 数据语言。`FrozenComputeContext` 包含来源 Project/Session、原 `SessionComputeHostAccess` 和每个 enabled provider 的唯一 `{id,providerId,shape,executionMode}`。描述不含 SSH 配置、密码、probe、permission grant 或可变详情。
- `SessionComputeHostAccess` 的 type-only 定义移到原 `shared/compute.ts`，原 main owner 继续 re-export，行为不变。冻结来源使用原 Session policy，保留 legacy selected 缺省为 enabled、显式空 selected 的区别。selected 是原任务选择，不是执行批准。
- `normalizeFrozenManagedInputs` 提取原不可变输入的同一字段、去重、Project、相对路径、字节和摘要验证，允许 Compute 的 0 或多个输入；Python/R 的 `normalizeFrozenNotebookInputs` 保持原 1–10 及 JSON 字节。实际读取、预算和租约仍由原 input owner 负责。
- `main/earthnano/compute-candidate-ports.ts`：host-only `TrustedControlPolicy`；continuation target 精确引用原 `BackgroundResultDeliveryOwnerOptions` 的三个 callback，保留 admission 与 result 两个 promise；route 明确 ordinary/private/private-unavailable，后者不能回退普通 Send。
- `TrustedExecutionTurnOwner` 只抽取原可信 owner 的共同身份接口；delegated owner 保留原 frame/Attempt 字段，application owner 独立校验原 delivery dispatch，不伪造委派。

共享类型阶段没有开放 Compute 候选工具或改动原 Job/审批生命周期。下述基础设施整合继续保留候选准入关闭，尚未构成实际 Compute 优化闭环。

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

沿原 driver 的唯一 cancellation registration 组合 exact prompt 和现已新增的 optional `cancelOwnedBackground`，监听持续到 readResult 结束。先关闭新准入、取消待审批及 owned Jobs；来源撤权后仍可调用原内部取消。`shutdown.reaped` 必须包含原远端 Job settlement；本地 socket/进程退出或 cancel 请求返回不能升级 cleanup confirmed。未知远端结果保留 unknown 和原 owner 重试事实，不停其他 Session。

重开不调用模型或 submitJob；显式续跑前按原 owner 对已存 Job/continuation 调和。不能仅见 Core interrupted 就创建 retry 并重复提交未知资源。普通 TaskRun 的初始 Turn 边界保持，候选由自己的现有结果 owner 等待后台完成，不改原 Job 或 delivery 状态机。

后续验收必须覆盖：0/多个固定输入及旧 Version；host 撤权/替换/mode 变化；最小 RPC 与不可伪造 policy；无 grant 无 UI 等待；真实原 Node REPL/Job/投递第二 Turn；多 Job 与错误 delivery 拒绝；原 JSON/PNG producer→Version→匿名资产→Review；等待/审批/harvest 中 stop/deadline、远端 unknown、关闭失败及重开零重提。原文本、Python/R、binary、delegation 和 Harness 方法测试身份保留。先用原 repository/transport fixtures 证明明确层级，再用 DeepSeek 做真实后端验证；本地 transport 证据不能冒充外部 SSH/Slurm 验收。

共享阶段 6 个测试文件 136/136、无跳过，完整 Node/sandbox/Web compiled types 通过；原始证据随本轮提交保存。执行/审批/Job 候选路径与真实模型验收仍待实施，不因上述 DTO 检查通过就标记功能完成。

来源 helper 已实现为 `main/earthnano/compute-context.ts` 的 `freezeComputeContext` / `assertFrozenComputeContext`，只读原 Session/host repository。可选 providerId 检查原冻结 enabled 集合；原 row id/shape/mode 变化或来源撤权拒绝，新选择/新增 host 不扩张旧任务。3 文件 58/58、完整 compiled types 及 lint 通过，见 [来源身份验证](validation/alpha/compute-source-context/manifest.json)。这些 helper 尚未接入候选启动，不是执行授权或实际 Compute 验收。

## 控制与生命周期基础设施整合

固定 `56c083b1b` 已合入可信 control token 的最小方法交集、源身份复查、原 Compute 审批 policy 传递、原 application attribution 与同 Core continuation admission。原 ACP driver 的唯一取消注册现可在初始 prompt 结束、`readResult` 等待期间取消 owned background；实际 owner 仍须负责当时的 continuation 与原远端 Job 收尾。native preparation 明确接收原 `request.role`，Compute 仅允许 baseline/candidate，方法角色在创建资源前拒绝。

整合的 18 套检查 1024/1024、零跳过，完整 Node/sandbox/Web compiled types、lint、format 通过。原模块 ownership/完整 host DAG 检查也已通过：修复此前九个新增文件的精确登记，未修改原断言、拓扑规则或豁免。原 Job repository、delivery repository、Notebook repository、TaskRunner、Core/scope 等保护文件逐字节保持；两智能体的初始架构失败、原 pin 三例审批红对照和最终结果一并保留，见 [原始验证记录](validation/alpha/compute-control-lifecycle/manifest.json)。

这些检查尚未执行真实 Compute 候选。候选 Session reservation、原 Job 结果等待、跨 Turn producer 证明和桌面接线仍待实现；serializer 继续拒绝 Compute profile。取消 hook 不得反等 `readResult` 或同一 context signal，避免原 Core 等物理取消时形成循环等待。未开展 Windows、外部 SSH/Slurm、付费模型、原生包或发布操作。

后续固定 `36bf60321` 修复了独立审查复现的“availability 检查后私有 owner 退役，零 admission 仍消耗原 delivery 重试次数”竞态：使用原 owner 导出的明确 host-only 不可用异常，原 repository 只释放精确 claim，保留 correlation 与重试预算；普通错误、已消费和处置优先规则保持。三个真实 SQLite race 修复前红、修复后恢复只发送一次或直接认领已保存 continuation，五套原检查 76/76。原三项 ordinary callback 对整合 base 字节相同、对固定上游 AST 相同。

同一提交还整合固定源读取与评估消费者：`resolveOptimizationComputeInputs` 允许原任务零输入，所附文件仍走同一个原 Version lease/hash/tuple 检查；Python/R 保持原非空约束。受控语义源 reader 支持明确空集合，评估摘要可携带全部真实 `reviewIds`，保留原 primary `reviewId` 和旧 JSON shape；实际各 Turn 的 Review 提交仍由后续 owner 完成，不能拼造 aggregate TurnScope。最终 15 套整合检查 565/565、零跳过，完整 types/原架构检查通过；初次 `it.each` 空数组误展开的 fixture 失败也保留，未充作生产红绿证据。见 [投递、固定来源和审阅引用记录](validation/alpha/compute-delivery-sources/manifest.json)。以上仍不证明完整 Compute 候选路径或外部计算环境已验收。

进一步原有 owner 集成回归发现取消兼容缺口：为后台等待引入的 live getter 改变了普通任务审阅提交中 Stop 的既有结果。主集成树在未修改旧 owner 的条件下复现原 `stop-during-submission` 断言失败，`b288c6801` 已恢复无后台 hook 时的原 snapshot 语义；四套 105/105、完整 types 通过，原断言保留。只有 Compute 后台 hook 使用 live 状态。

真实 Compute snapshot 支持另存于独立 `feat/alpha-compute-snapshots` 的 `0354708fc`，尚未并入本集成分支或开放入口。四套 147/147、完整 types/lint 通过，覆盖零/多个固定输入的实际 freeze/resolve/reopen/materialize、跨 Project/profile 拒绝，原 Python/R snapshot SHA 与附件约束保持。它供执行 owner 用真实 store 做下一阶段原 Node/SQLite 验证，不能替代实际 Job 结果或 DeepSeek 验收。上述普通回归红绿、独立 snapshot 与最初 readonly fixture 类型错误记录见 [原始证据及准入边界](validation/alpha/compute-snapshot-preparation/manifest.json)。

## 真实 owner 与桌面整合

固定业务实现 `a93b8def1` 已整合 snapshot、原私有 Session reservation/persistence、Node control REPL、多 Job/多 Turn 投递、原 producer→Version→Review、共享桌面路由与来源任务。`67207ef3c` 补齐真实 FileExecutionStore 重开证据；该提交相对桌面构建 `addeeda5e` 只改测试文件。

调用关系为：原优化面板的 Notebook runtime 选择 Compute → 原 `startSweep` / `normalizeDesktopSweep` → `resolveDesktopSweepTask` 读取原消息、固定 Version 与 host 身份 → 同一 `runPersistentOptimization` / Harness² 原 sweep → 原 candidate owner / ExecutionCore / ACP driver → 原 Node RPC 与 Compute 服务。proposer、composer、selector、reflection 仍沿原隔离角色；基线和候选共享同一冻结 Task 和 Compute 环境。没有第二份 Job/Task 状态或结果数据库。

共享路由在原 application startup 的后台投递与 Notebook bridge 创建前安装同一组闭包，工厂在任何 dispatch 前注册原能力；正常 reaped 后才退役，unknown 保留重试 handle。冷启动只读原 desktop、resume、execution 记录，不自动重提、不偷锁；明确的 setup-only 尚未执行证据由原 manager 保存。所有工厂都返回路由能力，普通 Python/R 无需注入 Compute 服务，原 control profile 保持。

整合中修复两个实际 TCP 反例：受限 token 不再写共享 host details；Compute 请求必须属于读取 body 前的原 active invocation，缺失或跨 invocation 拒绝。原普通 token 的五种时序行为保留。普通候选在共享路由中的真实原生失败也已红绿验证并修复。新增 fixture 发生的“断言全绿但 Prisma 全局错误/进程 exit1”保留为失败，退出时现 join 原 delivery drain，不改生产 dispose API。

主集成树检查分组：来源 59/59、桌面与 i18n 906/906、原依赖/归属 504/504、原生联验 135/135、控制/投递 125/125、磁盘 journal 6/6，均零跳过且进程 exit0；分组有重叠，不相加。完整 Node/sandbox/Web types、原 derived-consumer 检查、后端与桌面构建通过。原 Core、scope、TaskRunner 和 Job/Notebook/delivery repositories 以及 Harness² vendor 代码在本轮保持，原守卫断言未放宽。

真实磁盘测试只在 owner 已 reaped、Core settle 且原记录 cleanup confirmed 后正常 close/reopen；新原 Core/driver/factory 对同请求返回同记录，模型、Job、binding、native Run 和预算不增。unknown 情况保留原真实锁、字节与预算并拒绝第二 store；不把预算已耗尽说成独立资源 fence，也不声称新 Core 已接管未知远端资源。

同一构建的实际桌面 Python 科研流程通过普通 Send→原 sweep 的基线/候选→独立评估→Stop→重开→续跑，20/24 admissions、59 次本地 fixture 请求、零上游 API；原固定来源、producer、Version 和 Review 均核对。白底 master 已复看，最终发布包对应关系仍需验证。

证据和失败原文共 169 份 gzip，逐字节 roundtrip 与摘要核对、实际 API key 匹配为零，见 [原始记录](validation/alpha/compute-owner-desktop/manifest.json)。当前 Compute owner fixture 注入 submit/harvest；这只证明原生/Node/SQLite/外层 owner 整合，不能冒称原完整 dispatcher/reaper 或外部 SSH/Slurm，更不是 DeepSeek 调用。后续以原连接/运输端口验证完整服务链，保留原 Project/private grant 与字段保护条件，禁止 auto-once/明文放行；然后开展真实模型验证、PR 和最终 Unix 包验收。
