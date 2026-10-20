# Harness² 首轮源码审查与确定性基线

审查日期：2026-10-20。工作分支：`review/round1-harness2`，起点：`b66d0567e3bd91af22cb6c5b731050f4abe46954`。
对象仅为 `vendor/harness2/`，对应上游 `1cfe254e8d25b15f37048c3730134686abe60335`；未访问父目录的另一个 Harness² checkout。
已读根 `AGENTS.md`、`CORE_CONTRACT.md` v0.1 和 `PLAN.md`。本次不修改业务源码、上游快照或契约。
下列源码路径均相对于仓库根；行号来自本轮固定快照。
本报告保留对初稿的审查意见；主智能体已将契约修订与仍需实现的部分汇总至
[首轮结果](../ROUND1.md)，不能将下文“补入”理解为生产代码已经修复。

## 结论与必须补入的最小契约

共同执行端口的方向与现有方法边界相容，但不能只接管 solver rollout。必须同时接管 `Proposer.call` 的生成、组合、选择、反思，以及这些调用内部的真实重试。现有代码没有平台级持久化接纳、取消确认、共享资源预算或统一 execution 身份。

1. **补一个 `invocationRef: Ref`。** `taskSnapshotRef` 始终代表原科研任务；`invocationRef` 冻结本角色的实际提示（mission/system）、可见输入与证据清单、工作副本初始配置及结果收集要求。它应绑定内容摘要，不能只是目录。普通 task/baseline/candidate 也保存实际生成的调用输入包。Python 的 `context_dir`、`harvest` 是端口内适配细节，无需成为公共字段。依据：`core/proposer.py:126-179`、`core/recursion.py:155-165,182-193`、`core/selection.py:300-333,466-482`（以下省略公共前缀 `vendor/harness2/harness2/`）。
2. **明确逻辑阶段与执行尝试分离。** `optimizationId + stageId` 标识逻辑阶段；每次真实模型/工具重试产生新 execution，携带 retry 关联。两次无效编辑重试和一次调用内的 transport retries 都不能隐于单个已完成执行记录。缓存命中关联先前完成执行，保留 reuse 来源，不伪造新模型调用。依据：`recursion.py:36-38,176-203,254-257`、`proposer.py:149-208`。
3. **说明 `R=4k / P=3k` 是每任务、每模式的方法恒等式。** `R=k shared base + 2k INV/DOM probes + k compositions`；`P=k INV+k DOM+k compositions`。agg/seq 共享同一批 k 个 base，因此双模式首次运行的唯一 rollout 是 **7k**，不是 8k；单模式为 4k。两模式改进阶段合计 6k；k>1 时各有一次 selector，启用 Library 且选择成功时各有一次 reflection；它们及其重试不在 P 内。方法账本会计入失败/回退阶段，不能据完整计数推断成功。共享基线在平台费用账本只记一次。依据：`ledger.py:15-33,58-76,89-132`、`schedule.py:619-635,513-538`。
4. **缓存复用须绑定完整执行身份。** 至少包含科研任务快照、invocation、AgentSpec、HarnessRevision、EnvironmentSpec、物化器/后端版本及结果证据完整性。保持 requestKey 去重、缓存复用和有意重试三种语义可区分。现有 namespace/marker/summary 不足以实现这一承诺（见下表与实证）；未知副作用不能沿用旧代码直接重跑的行为。
5. **停止信号不得进入方法回退。** 平台取消、预算拒绝/耗尽、进程状态未知必须向调度层传播并保留未完成阶段。它们不能被现有通用 `Exception`、`ProposerError` 路径降格为无效提案、死 rollout 或 selector fallback 后继续下一阶段。并发 INV/DOM、composition 和 rollout 须先预约共享预算与槽位，预算字段本身不能保证准入。依据：`recursion.py:166-174,195-200,242-250,289-300,328-339`、`selection.py:346-350`、`schedule.py:654-662`。
6. **冻结优化经验的输入前缀。** Library 以 run/mode/domain 和有序任务流隔离；每任务仅见严格先前前缀的完整已选配置树和有效经验。至少把本次 Library 快照/前缀摘要纳入 invocation，保留来源执行与方法模式。已有 `NO_ENTRY` 或 reflection 失败不会阻止成功选择，也不能被恢复成有效经验条目。实际隔离依赖调用方传入的 root；`library.py:215-222` 允许显式 tag 共享根，不能把文档约定误写成任何调用下都强制跨 run 隔离。
7. **“选择成功”不等于“采用默认配置”。** 上游 `adoption` 仅表示本任务从 finals 交付一个既有输出；selector 只看匿名最终产物及原任务/源资料。reflection 才能看非匿名配置、轨迹、编辑差异和选择映射。额外基线门槛、写回工作区或发布默认配置应作为独立采用动作；独立评分不回流 proposer/selector/reflection/Library。

第 2 节“同一候选组使用同一个 TaskSnapshot、AgentSpec、EnvironmentSpec”应限定为**被比较的 baseline/candidate solver 执行**。proposer/composer/selector/reflection 的提示、工具范围与模型可不同，按各自冻结的 invocation 和 AgentSpec 记录；现有 `ChannelSpec` 就允许 proposer/selector 分开。该规则不应强迫改进角色伪装成科研任务本身。

## 已有、需抽取与新增的边界

| 领域 | 上游已有及源码证据 | 本轮契约与后续实现应如何处理 |
| --- | --- | --- |
| 任务/配置/执行身份 | `spec.py:132-174` 的 BenchSpec 是静态 benchmark/substrate 配置；`207-225` 是 task_id、可变输入路径和 execute(run_id)。`schedule.py:84-127` 的 namespace 为 benchmark/substrate/mode/k/seed/tag。RunView 无分数，只有 label/run_id/path/ok/delivered 等（`176-187`）。 | **抽取**为适配层元数据；**新增**任务不可变引用、executionId、请求冲突检测和 session/provider 映射，不能把 namespace 当平台身份。 |
| 两条执行路径 | solver 经 `adapter.execute`（`recursion.py:279`、`schedule.py:437-477`，含可选 execute_many）；改进调用直接由 Proposer 启动 Claude/OpenCode 子进程（`proposer.py:210-311`）。 | **抽取**两路径共同到 ExecutionPort；批量 launcher 仍须保留每个 rollout 的独立身份及部分失败，不能只给整批一个 execution。reflection 目前复用 selector channel（`schedule.py:529-538`），不能漏算。 |
| agg/seq 顺序 | agg 的 2k 独立提案并发→probes→k 独立组合并发→finals（`recursion.py:343-449`）；seq 每轮 INV/DOM→probes→ct→rollout，下一轮继承 ct 并带 history（`452-565`）。 | **保留**阶段顺序、稳定标签和并发后的稳定记账。seq finals 为 c1…ck，不只是 ck；k=1 两模式仍为独立生成。 |
| 无效提案与回退 | 树自动 trigger、surface/benchmark/评分泄漏验证（`recursion.py:108-132`）；两次编辑尝试累加费用，transport failure 可提前退出并继承当前树（`176-250`）。 | **抽取**方法语义；**新增**平台停止分类。P 是逻辑阶段计数，attempts=0 的证据构建失败也会成为回退阶段；不能当作实际模型调用数。 |
| 缓存/恢复 | proposer key 为 label+mission+system+context 路径/字节（`proposer.py:507-534`），命中只查非空回答/必要 workspace，不查 meta（`340-360`）；不含 ChannelSpec。runmark 写原子完成标记和源树 hash，但 None 固定为 base，读取不核对预期 run_id（`runmark.py:41-102`）。summary 查 chosen 产物、可选 artifacts_intact 与 chosen harness hash（`schedule.py:350-421`）。 | **保留**已有完成证据及产物检查；**新增**完整请求摘要与不可变结果证据。当前只能说明特定缓存可恢复，不能声称任务/模型/环境变化会失效。真实适配器另有完整性加强：LAB `benchmarks/lab.py:588-624`、JobBench `jobbench.py:717-759`，不可将 demo 的检查范围套用于所有适配器。 |
| 崩溃恢复 | 未标记或配置/产物改变会重跑甚至清理旧路径（如 `benchmarks/jobbench.py:723-742`）；summary 恢复失败会进入 run_task 重新运行（`schedule.py:611-625`）。 | **新增**平台执行所有权、interrupted 与副作用核实，替代直接复用同 run_id 重跑。原策略不能充当“重启不重复真实调用”保证。 |
| 选择 | finals 排除基线（`selection.py:93-111`），剔除失败/无产物候选（`114-153`），匿名且不裁剪候选（`183-218`）；k=1 直接选择（`360-399`）。 | **保留**。state_deliverable 且全部无文件时可使用成功运行自身的 trajectory；它不等同于所有任务必须产生文件。k>1 即使只剩一个可交付候选仍走 selector。 |
| selector 失败 | finals fallback 选排序后的第一个 final，并标 fallback，但 `ok` 仍 false（`selection.py:237-252,332-355`）。失败选择不能触发 judge（`judge.py:99-113`）。 | **保留失败事实**；不能把有 chosen_label 或 fallback 视为选择成功，也不能伪报基线回退。 |
| 独立评分隔离 | score 只由独立 judge 调用（`spec.py:247-250`、`judge.py:61-87`），无结果/异常保留未评分；优化核心不导入 judge。context 明确复制源资料、过滤 answer 路径、扫描 verdict markers（`context.py:191-216,399-518`）。 | **抽取**可见证据允许清单，**新增**平台访问边界。marker 是源码自己注明的 tripwire（`454-460`），不是通用保密保证，二进制/未知评测格式不能靠关键词隔离。assessment 仍须区分未执行/失败/零分。 |
| Library 实义 | 有效条目须有 cue/lesson/evidence（`library.py:43-47,106-152`），保存完整已选树及经验；按领域、模式隔离且每步 retain 先前任务前缀（`schedule.py:331-347,685-703`），跳过任务按已存经验恢复（`201-236`）。 | **保留**源执行和严格前缀；不能宣称向量检索、全球学习库、自动替换全局默认配置或“只有独立评分证明改进才入库”。入库依据是成功选择+有效经验。 |
| 配置生效 | substrate 区分 source fingerprint 与 staging（`substrate/base.py:26-44`）；OpenCode 按 install_mode copy/compose/注入 ctx（`opencode.py:184-224`）；Codex 复制限定 root entries（`codex.py:120-147`），execute 仍依赖 benchmark launcher（`187-198`）。 | **抽取**surface 校验/物化能力；**新增**实际物化树摘要、后端加载证据与 unknown。Install.fingerprint 是源树摘要，未覆盖 ctx 注入/生成文件，不能当物化摘要。参考 argv 不证明真实 launcher 采用同配置。 |
| 权限/取消/费用 | CLI 上游有绕过权限/沙箱的启动参数（`proposer.py:210-241`、`substrate/codex.py:149-174`），临时上下文隔离不等于系统权限隔离；无统一 cancel 接口。部分 benchmark 有 timeout 进程组终止（如 `benchmarks/lab.py:406-417`）。费用默认 0，缺失 parser usage 仍 0（`proposer.py:251,486-504`），recursion rollout 未回填实际费用（`recursion.py:279-300`）。 | **新增**平台权限策略、取消回执/进程清理确认、共享预算准入、unknown 用量。保留已有超时清理可用部分，不能把有限适配器的 timeout 当完整取消验证。 |

## 验证环境、授权范围与结果

环境：Darwin 27.2.0 / arm64；`python3` 为 `/Users/yxmac_mini/.local/bin/python3`，版本 **3.12.13**；项目要求 `>=3.12,<3.14`、无必需第三方依赖。本轮未安装依赖。
工作目录为本 worktree 的 `vendor/harness2`。执行前已审阅 `tests/test_workflow.py` 全文及 `demo.py`：DemoProposer 完全脚本化；DemoAdapter 仅在 TemporaryDirectory 生成 CSV/脚本并用本 Python 运行算术汇总。唯一实际 Proposer 调用测试以 mock 替代 subprocess.run 和 OpenCode 路径。附加缓存检查同样 mock `_opencode`，未启动 CLI、模型、judge、网络请求或 benchmark 数据写入。临时目录退出自动清理，`-B` 不生成项目 pycache；最终 vendor 工作区无产物。

实际基线命令：

```sh
python3 --version
python3 -B -m unittest discover -s tests -p test_workflow.py -v
```

退出码 **0**，`Ran 5 tests in 6.030s`，`OK`。5 个测试分别覆盖：

- `test_recursion_budget_and_resume`：agg/seq、k=1/2 的 R/P、已选本地产物；完整 summary 重跑无新执行/调用；chosen harness 被改或已选产物被删时重跑；k=1 无 selector。
- `test_complete_evidence_and_library_prefix`：reflection 的源资料/轨迹/差异/决定/配置证据、seq 历史候选、后续任务只见先前 Library；answer 路径/verdict tripwire；两次 mock OpenCode 的 session 数据隔离。
- `test_invalid_proposal_retries_with_feedback_and_accumulates_cost`：无效 Python 编辑反馈、第二次修复、累计 mock 成本 3。
- `test_no_entry_stays_out_of_library_on_resume`：NO_ENTRY 与失败反思不入库，恢复也不伪造条目，保留 mock 费用。
- `test_failed_selection_is_never_judged`：选择失败记成本，judge 不调用 score，未评分不等于零。

另执行一次 `python3 -B - <<'PY' … PY` 的本地检查（以下精简重放体使用相同公开调用和断言），退出码 **0**、6 个检查全部满足**当前行为**；其中缓存/用量检查证明的是缺口，不是新契约已通过：

| 检查 | 实际观察 |
| --- | --- |
| 一个任务、双模式 k=1、无 Library | R/P 分别 (4,3)，唯一 rollout 7，proposer 调用 6。 |
| 一个任务、双模式 k=2、无 Library | R/P 分别 (8,6)，唯一 rollout 14，proposer 调用 14（含两个 selector）。 |
| k=1 完成后把 ledger.csv 改为 999.00 | 再运行 status=skipped，新 rollout=0：输入变化未失效缓存。 |
| 相同 audit/mission/label，从 model-A 改为 model-B | cached=true，返回 `model A answer`，B 的 mock 执行未被调用。 |
| 无 harness 的完成 marker | fingerprint=`base`；is_complete 不要求预期 run_id、任务、模型或环境。 |
| OpenCode text 事件无任何 usage | `_opencode_cost` 返回 0.0，无法区分未知和零。 |

可重放附加检查（本工作目录运行；只写临时目录）：

```python
import tempfile
from pathlib import Path
from unittest.mock import Mock
from harness2.core import schedule, runmark
from harness2.core.proposer import Proposer, _opencode_cost
from harness2.core.spec import ChannelSpec
from harness2.demo import DemoAdapter, DemoProposer

with tempfile.TemporaryDirectory(prefix="earthnano-h2-audit-") as temp:
    root = Path(temp)
    for k in (1, 2):
        a = DemoAdapter(root / str(k))
        p = DemoProposer(a.spec.channels["proposer"])
        args = dict(adapter=a, prop=p, runs_root=a.spec.runs_root)
        result = schedule.run_task("ledger-1", k, **args)
        assert result.status == "ok"
        assert [(result.modes[m]["ledger"]["R"], result.modes[m]["ledger"]["P"])
                for m in ("agg", "seq")] == [(4*k, 3*k)] * 2
        assert a.execution_count == 7*k
        assert len(p._calls) == 6*k + (2 if k > 1 else 0)
        if k == 1:
            (a.task_files("ledger-1") / "ledger.csv").write_text("amount\n999.00\n")
            before = a.execution_count
            assert schedule.run_task("ledger-1", k, **args).status == "skipped"
            assert a.execution_count == before
    audit = root / "audit"
    p = Proposer(ChannelSpec("opencode", "local/model-A"), audit_dir=audit)
    p._opencode = Mock(return_value=("model A answer", 0.0, ""))
    p.call("fixed mission", None, "cache-check")
    q = Proposer(ChannelSpec("opencode", "local/model-B"), audit_dir=audit)
    q._opencode = Mock(side_effect=AssertionError("cache miss"))
    reply = q.call("fixed mission", None, "cache-check")
    assert reply.cached and reply.text == "model A answer"
    q._opencode.assert_not_called()
    runmark.mark_complete(root / "mark", run_id="original", harness_dir=None)
    assert runmark.is_complete(root / "mark", harness_dir=None)
    assert runmark.fingerprint(None) == "base"
    assert _opencode_cost('{"type":"text","part":{"text":"no usage"}}') == 0.0
```

**未测**：任何真实付费模型/benchmark/外部数据集、后端实际加载、端到端评分、操作系统权限隔离、取消竞争、进程退出确认、崩溃副作用恢复、总费用预算准入、并发预算预约、事件持久化/缺口和 OpenScience 集成。这些不能由上述 5 个测试推断通过。本轮停止/预算边界为源码审查，未伪装成运行测试。

## 后续最小任务与验收

1. 冻结 invocationRef、完整请求摘要、逻辑 stage 与每次执行身份；保留方法 label 为关联字段。先用假执行器验证两路径与批量部分失败都进入共同端口。
2. 将 proposer transport retry 和无效编辑 retry 外置为可追溯的新执行；引入平台 stop 分类，证明取消/预算停止不会继续 composition、selection 或 reflection，并发阶段预算只预约一次。
3. 用不可变引用替换路径复用判定；加入任务、模型、环境、Library 前缀和物化器变化的失效用例，同时保留本轮有效缓存无额外执行的基线。
4. 采集真实 rollout usage，未知显式标注；独立评测保留单向证据访问。选中结果、经验入库、工作区采用分开记录。
5. 最后在一个真实后端验证指定配置确已加载、两候选隔离、取消后资源退出及已完成证据可读取，再扩大后端和科研任务范围。
