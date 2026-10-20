# 第二轮 Harness² 执行依赖抽取

本轮将共同执行 seam 接入真实方法调用链，不包含桌面自动优化启动、生产传输或真实模型实验。
起点为共享契约门禁 `54135cd13`；共享回执校验由主智能体提供 `177dd60fb`，本分支以等价提交
`4cda397e8` 引入。本实现不修改 schema、生成类型、共享 validator、来源记录或外部兄弟 checkout。
`vendor/harness2/` 已包含本轮有意集成改动，上游固定来源仍为 `1cfe254e8d25b15f37048c3730134686abe60335`；
来源记录的集成状态由主智能体统一更新。

## 已接线的边界

- `core/method_execution.py` 提供 `MethodExecution`（legacy 默认）和 `PortMethodExecution`
  （显式注入共享 `ExecutionPort`、可信 `RequestFactory`、明确 `ResultReader`）。
- `schedule.run_sweep/run_domain/run_task` 透传 `execution`；baseline 和 candidate 经同一 seam；
  `recursion._run_stage` 将 INV/DOM 标为 proposer，将 AGG/COMPOSE 标为 composer；
  `selection` 的 selector/reflection 同样走 seam。
- 默认调用不需传新参数，仍使用原 `adapter.execute/execute_many`、`Proposer.call`、缓存和 CLI。
  legacy 的 native baseline batch 仍为一次 batch launcher 调用。端口路径改为逐个基线接纳，
  每个 rollout 有独立 execution/结果，单个普通失败不会抹去另一条成功记录。
- 端口路径不调用 legacy solver/proposer、不读 legacy marker 或 proposer cache，也不以旧 summary
  恢复结果。方法报告写 `summary.port.json`，避免与默认 `summary.json` 的缓存相互冒用。
  本轮不提供新的跨请求结果缓存；端口自身的相同请求接纳去重仍由共同核心负责。

本地 `Invocation` 只是提交给可信绑定的调用描述，不是新的 wire 类型，也不是不可变引用。
它带科研 task ID、方法 scope/逻辑阶段/角色、mission/system、上下文、初始配置路径、结果收集要求、
transport attempt 和 retry 来源。可信 factory 必须先冻结实际字节与可见证据，再返回共享
`ExecutionRequest` 的权威 refs、项目/优化身份、策略、预算和新 key；不能给路径贴上 Ref 标签。
本轮测试 factory 会复制上下文、配置及源资料，通过内容摘要生成不含路径的 opaque refs。
生产 factory 与引用存储仍待平台集成。

`ResultReader.rollout(record, invocation)` 明确解析已提交产物为现有 adapter 可读的视图；
`reply(record, invocation)` 明确返回文本和配置编辑结果 workspace。seam 不从 wire 文本猜路径，
不新增未来产物 wire 字段，不自行创建另一套产物/审阅 owner。

## 重试、停止与证据

端口路径的每次 transport attempt 都重新 submit；普通 failed record 或空答复可按原方法重试。
无效配置编辑仍保留两次校验尝试和修复反馈，每次真实执行使用新 requestKey/executionId，
通过 `retryOfExecutionId` 连到上一执行；逻辑 stageId 保持一致。seam 校验 factory 的 role、
optimization origin、retry 关联和新 key，并用共享 validator 校验完整 Handle/Record，核对请求摘要。

`ExecutionStopped` 在上下文读取、提案、rollout、选择、反思、任务、领域和 sweep 层均先于普通回退透出。
cancelled/interrupted、预算/超时拒绝、清理未确认以及请求/回执校验失败会停止作用域。
factory、submit、get 的非结构化异常同样停止：提交可能已接纳而回包丢失，不能自动重放。
已知 executionId 时读取失败或等待到期会 best-effort 请求取消；回执不会被解释为进程已退出，
不会释放平台槽位。响应丢失而没有 executionId 时保留为待核心核实，不能猜 ID 或新建重试。
已完成且 cleanup confirmed 的结果读取失败仍可作为方法的普通产物失败处理。

一个 `PortMethodExecution` 实例承载一个优化作用域；观察停止后，其 latch 拒绝后续提交，
包括并发队列中的兄弟阶段。已经接纳的执行仍由核心拥有，seam 不宣称强制终止了真实后端。
终态共享记录可由 `execution.records` 查看；它是本轮调用观察的副本，持久化权威仍是端口 owner。
费用/用量以共享 Record 为准，unknown 在 Reply 和 Record 中保留；原方法的浮点 usd 汇总不是
供应商账单或完整资源预算，solver 费用总账和金额准入不在本轮实现范围。

agg/seq、每模式 R=4k/P=3k、共享 k 条 baseline、k=1 直接选择、seq 的 c1…ck finals、
Library 严格先前前缀、NO_ENTRY 及失败选择不评分的语义继续保留。独立 judge 无新执行入口，
未将其分数送入优化。单条 baseline 失败后 demo 的既有产物提取器可能使任务 partial，
本轮保留该行为，不把部分失败伪装成方法成功。

## 接入示例

```python
from harness2.core.method_execution import PortMethodExecution

# port 满足共享同步 ExecutionPort；factory/reader 由可信平台绑定注入。
execution = PortMethodExecution(port, request_factory=factory, result_reader=reader)
result = schedule.run_domain(
    domain, task_ids, k, adapter=adapter, prop=proposer,
    runs_root=runs_root, library_root=library_root, execution=execution,
)
```

只验证一次 proposer 时也可调用：

```python
reply = execution.call(
    proposer, "阶段任务", context_dir, "inv1.a1", role="proposer",
    task_id="task-1", scope="optimization-smoke", stage_label="inv1", max_attempts=1,
)
```

## 验证记录

环境：Darwin arm64，Python 3.12.13，未安装新依赖。所有执行限于临时目录、demo 算术脚本、
fake port 与 mock；未调用任何真实模型、生产 benchmark、独立 judge 或外部数据集。

实际命令（工作目录 `vendor/harness2`）：

```sh
python3 -B -m unittest discover -s tests -v
```

最终 **24 项通过，退出码 0，15.911s**。原有 `test_workflow.py` 5 项保持不变；新增 `test_execution_seam.py` 19 项，
覆盖两个任务/两模式/k=1/2、六种角色、所有模型路径不旁路端口、native batch 兼容与逐次基线
部分失败、transport+validation 连续重试、Library/NO_ENTRY/失败选择不评分、旧 cache 不读取、
每角色预算和 timeout 停止、取消/中断/未知 cleanup、等待期限、上下文停止、sweep 停止、
submit 响应丢失、get 失败、非法 factory 请求、不完整或身份不匹配的 Record、unknown usage。
它们是方法接线/控制语义的确定性测试，不证明生产传输、后端加载或操作系统隔离。

在仓库根执行：`python3 scripts/earthnano/generate-contract.py --check`，退出码 0。
另用 Python `compile(source, path, 'exec')` 编译 9 个相关 Python 文件（六个实现文件、两个共享
Python 契约文件、一个新增测试文件），退出码 0，不写 pycache；`git diff --check` 通过。
本环境未安装 Ruff，未声称执行 Python lint。

尚待：生产传输和 bootstrap、可信引用存储/请求 factory/结果 reader、一个真实后端的配置加载
与候选隔离、进程清理确认、完整事件/产物证据连接、真实资源/费用记录和自动优化触发。
