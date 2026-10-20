# EarthNano 最小核心契约

状态：v0.1 草案，供首轮双侧源码审查；尚未实现。范围：普通科研执行与 Harness² 内部执行共用的边界。
基线：`0a9d62c1`，上游提交见 [UPSTREAMS.json](../../UPSTREAMS.json)。

## 1. 共同术语与所有权

| 对象 | 最小含义 | 所有者 |
| --- | --- | --- |
| TaskSnapshot | 一次执行的任务描述、输入及上下文的不可变快照；不是整个会话 | 平台任务输入层 |
| HarnessRevision | 可编辑指令、技能、脚本及后端支持的策略配置版本 | 平台配置层 |
| Execution | 使用指定输入、后端及配置的一次执行；一次真实重试产生新执行 | 统一执行核心 |
| Evidence | 该执行的事件、输出及已有产物版本引用 | 平台证据层 |
| Assessment | 对指定证据的审阅、复现或独立评测记录 | 对应评估服务 |

OpenScience 的 Project、Session、消息分支、ArtifactVersion 和 Review 继续作为原有事实来源。
新增对象保存关联，不建立第二套会话、产物或审阅数据库。Harness² 的阶段标签和目录不作为
平台执行身份。平台最终状态由执行核心维护，优化方法不能自行宣布运行完成或更改权限。

## 2. 最小请求

以下为跨 TypeScript / Python 边界的语义字段，不是本轮新增的生产类型或公开 HTTP API。
`Ref` 表示由平台解析的不可变引用及内容摘要，不能仅指向可变的工作区路径。

```ts
type ExecutionRole =
  | 'task' | 'baseline' | 'candidate'
  | 'proposer' | 'composer' | 'selector' | 'reflection' | 'reviewer';

interface ExecutionRequest {
  contractVersion: 1;
  requestKey: string; // 在项目内对同一提交去重
  projectId: string;
  taskSnapshotRef: Ref;
  agentSpecRef: Ref; // 后端、模型、推理参数、版本；凭据仅保存受控引用
  harnessRevisionRef: Ref;
  environmentSpecRef: Ref; // 输入挂载、工作目录策略、工具范围、计算目标
  role: ExecutionRole;
  origin: {
    kind: 'interactive' | 'automation' | 'optimization';
    sessionId?: string;
    promptMessageId?: string;
    optimizationId?: string;
    stageId?: string;
    parentExecutionId?: string;
    retryOfExecutionId?: string;
  };
  interactionPolicy: 'interactive' | 'deny-unresolved';
  budgetRef: string; // 共享预算账本；不允许内部角色另开无约束预算
  timeoutMs: number;
}
```

约束：

- TaskSnapshot 包括用户要求、版本化输入清单、必要的文本/附件/图像上下文和上下文摘要。
  普通对话可在提交时创建快照，无需用户预先建立 benchmark 任务。
- 同一候选组使用同一个 TaskSnapshot、AgentSpec 和 EnvironmentSpec；有意改变这些变量时
  必须记录为另一种比较设计，不能宣称只改变了 Harness。
- EnvironmentSpec 是计划；执行还应记录实际运行环境及版本。可变外部数据必须记录版本、
  摘要或不可重放原因。
- HarnessRevision 不包含凭据、应用权限的授权决定或独立评测答案。
- 任务和候选角色可使用不同工具配置；proposer 只能修改自己的候选配置副本。
  配置编译器明确拒绝不支持的配置内容，不能默默忽略。
- `deny-unresolved` 表示无法在现有授权内继续时返回明确原因，不表示自动批准。
- 优化内部执行带 `optimizationId` 和 `stageId`，不能再次触发一个新的自动优化过程。

## 3. 最小接口及返回

```ts
interface ExecutionPort {
  submit(request: ExecutionRequest): Promise<ExecutionHandle>;
  get(executionId: string): Promise<ExecutionRecord>;
  cancel(executionId: string): Promise<CancellationReceipt>;
  events(executionId: string, afterSequence?: number): AsyncIterable<ExecutionEvent>;
}
```

- `submit` 在持久化接纳后返回句柄，不等待模型或优化流程结束。
  参数校验失败返回结构化拒绝，不能产生已经开始执行的假象。
- `ExecutionHandle` 至少包含 `executionId`、`requestKey`、当前 phase，以及已知的 OpenScience
  `runId/sessionId/promptMessageId` 映射。provider session ID 与应用 session ID 分别记录。
- `ExecutionRecord` 包含请求引用、phase、时间、错误、等待原因、生效配置记录、
  证据引用、资源消耗和清理状态。映射现有 `promptAttemptId` 时记录关联，不覆盖原身份。
- 相同项目的相同 `requestKey` 与相同请求摘要返回同一执行；不同摘要返回冲突。
  有意重试使用新 key 和 executionId，通过 `retryOfExecutionId` 关联。
- 幂等接纳不承诺外部工具“恰好一次”执行。崩溃后的未知副作用必须先核实，不能自动重放。

## 4. 生命周期、等待与取消

内部 phase：

```text
queued → preparing → running → completed | failed | cancelled | interrupted
queued / preparing → failed | cancelled | interrupted
```

`waiting` 是 running 下的 attention（例如人工交互、计划审批或工具等待），不另造终态。
queued 表示已持久化接纳，preparing 表示准备环境与配置，running 表示进入实际执行。
provider 已接纳、首段输出等保留为事件，不等价于 completed。

- `completed` 只表示执行及其必要的结果提交完成，不代表产物正确或候选优于基线。
- cancelled 由核心确认；`cancel()` 返回取消已请求、已完成或已经终止的回执，
  不把取消请求本身等同于进程已经退出。重复取消幂等。
- 终态只能提交一次；完成与取消并发时由核心现有执行所有权与持久化顺序决定，不能后到事件覆盖。
- 重启后无法证明已完成的执行标记 interrupted，并保留证据；恢复过程不能直接重复模型调用。
- 清理状态单独记录 `pending | confirmed | unknown`；unknown 时保留资源占用或隔离栅栏，
  不把未确认退出的进程槽位交给下一候选。
- 预算在执行前准入，重试、选择、反思及 Reviewer 均计入；缺失用量记 unknown，不按零费用处理。
- 公共 Task API 原有四种状态保持兼容。内部 interrupted 对外可映射为
  `failed + process_restarted`；内部 queued/preparing 不直接扩展现有公开枚举。
  桌面继续保留现有人工交互及流式事件语义。

## 5. 配置生效与证据

生效配置记录至少包括：请求配置摘要、物化配置摘要、实际后端/模型/运行时版本、
加载的指令与技能清单、可用工具范围，以及每项能力的确认方式。
区分“已生成配置文件”和“已确认后端加载”；无法确认时记录 unknown，不能报告已生效。
已有会话不能安全热切换的配置，通过独立 runtime 或明确的会话切换边界应用。

每条事件包含 executionId、该执行内单调序号、事件类型、时间及可用的原有消息/工具标识。
证据记录在 UI 合并或公共流裁剪之前接收。读取缺口明确返回 gap，不能把缺失事件当成完整轨迹。
结果证据状态至少区分 complete / partial / unavailable。

输出包括文本以及 OpenScience 已有 `artifactId/versionId/checksum` 引用；配置提案可以附带
新的 HarnessRevision 引用。产物后续修改不能改变已经用于选择和审阅的版本。
候选产物先存为其自身版本，写回用户工作区或默认配置属于后续采用操作，不由试跑隐式完成。

Assessment 引用具体执行/产物版本，注明 `review | reproducibility | independent-evaluation`。
优化角色只能读取为该过程明确开放的证据，独立评测结果不进入候选生成、选择或经验上下文。
复现通过不等价于科研结论正确。Assessment 失败、未执行与得分为零分别表达。

## 6. Harness² 方法兼容约束

- 同时覆盖 `adapter.execute()` 与 `Proposer.call()`，后者包括生成、组合、选择和反思调用。
- 保留 agg / seq 阶段顺序、无效提案重试和回退；平台取消和预算耗尽另记中断原因。
- 原版 finals 选择池排除基线，k=1 有直接选择路径。选择成功不能被写成改进已被证明；
  后续若增加基线回退或发布门槛，应与原方法选择结果分开记录。
- 原 Library 给改进过程提供历史配置与经验上下文，并非直接替换后续普通任务的全局默认配置。
- 保留 R=4k、P=3k 的方法计数检查；它们不替代平台总预算，未完成过程不能伪造完整计数。

## 7. 两条最小调用示例与后续验收

普通执行：桌面消息 → 创建输入/配置引用 → submit(role=task, origin=interactive) →
接纳后返回 → ACP 执行及原有人工交互 → 产物版本提交 → completed。

优化执行：冻结任务输入 → 登记 optimizationId → 方法提交 baseline/candidate 及
proposer/composer/selector/reflection 执行 → 相同核心执行与采集 →
选择记录及经验引用。整个流程共享预算，普通用户会话保持自身生命周期。

下一轮应以假执行器先验证：重复提交去重与冲突、接纳后异步完成、取消竞争、预算拒绝、
重试新身份、重启未知状态、事件缺口、固定产物版本，以及两种请求走同一执行端口。
随后在一个真实后端验证配置生效和候选隔离。

## 8. 本轮审查边界

本轮只冻结对象含义、请求/结果语义、所有权及兼容规则。模块位置、存储表、进程划分和公开
API 升级在实现时确定；本契约不表示现有源码已实现这些能力。
两侧审查必须注明哪些行为已经存在、哪些需要抽取、哪些是新增，并记录基线测试的真实范围。
