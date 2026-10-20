# 第八轮：普通 Send 与 Harness² 共用执行核心

基于 PR #9 的 `372eba63f`，本轮继续叠加 PR，不自动合并。目标是把两侧实际执行放进同一套核心规则，同时保留 OpenScience 的用户能力和 Harness² 的原算法。

## 实际调用关系

| 入口              | 调用关系                                                                                                                                               | 原事实所有者                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| 桌面 Send         | 原 renderer / typed IPC → `AcpRuntimeCoordinator.startPrompt` → 公共 boundary → `ExecutionCore` → 原 ACP runtime                                       | Session / ArtifactVersion                                     |
| Headless Task API | 原 `TaskRunner` → `TaskAgentPort` → 同一个 coordinator / boundary / Core                                                                               | 原 Task workflow、Session、产物和可选 Review                  |
| Harness² 角色     | 原 schedule / recursion / proposal / composition / selection / reflection → 平台 execution port → Core → Claude candidate driver → 同一个 ACP boundary | 原实验配置版本、隔离目录及 Session / ArtifactVersion / Review |
| 普通 Reviewer     | 原 assessment owner → Core → 原 disposable Reviewer / MCP / provider observation → 原 Review 提交和资源处置                                            | 原 Review repository 和 Reviewer resource owner               |
| 后台委派          | 原 delegated preparation → Core → 原 private coordinator / child mission → 原 activeTurn 提交、process ownership 和资源清理                            | 原 delegated Frame / Attempt / runtime segment                |

普通 Send 的真实入口绕过 TaskRunner，因此本轮直接修改 coordinator 的物理分发边界。只迁移 TaskRunner 不能完成这项统一。
Harness² 已经被 Core 接纳的执行携带可信的进程内 scope，进入 ACP 时验证实际 Session / prompt 归属，沿用同一 execution ID；不会再建立普通 Session journal 或预留一次预算。

## 同一核心规则，原模块负责事实

`ExecutionCore` 负责请求校验、持久化接纳、执行次数预留、排队、身份不可覆盖、单次 admission / acceptance 事件、取消确认、deadline、终止记录和资源限制。
资源所有者只提供接纳、实际分发、精确取消、提交屏障与结果证据。

一次 execution 是一个逻辑 agent mission。上游 Reviewer 的最多一次协议恢复、委派 mission 内的后续消息仍是该 mission 的内部轮次；预算不假装计量 API 请求、token 或费用。
普通交互请求声明 `timeoutMs=0`，保留人工审批的等待行为；优化请求必须声明正数时限。两种声明由同一份生成 schema 和 TS / Python 校验器解释。

取消请求先等待原所有者确认。拒绝时不设置 accepted cancellation、不提前 abort；接受后传播到精确拥有的 prompt / token。
委派上游会先接受本地停止并撤销写入资格，随后独立核实进程清理；其底层 cancel RPC 失败不反向伪装成本地停止被拒绝。
先发生的 provider、Notebook、产物或持久化错误继续优先。

执行结果和资源清理保持正交。原 owner 可以保留成功产物以及 `cleanupError`，但 `cleanup=unknown` 始终限制其资源；下游安全采用要求 `phase=completed` 且 `cleanup=confirmed`。
Reviewer 的源 Review、Task 的源 Session commit 和 canonical execution 的状态分别保留证据；旧 Session 完成记录不能覆盖较晚的 canonical 失败原因。

同一 Session 的后续 Send / 原审阅修正可以在先前 native lease 释放后进入共同核心，旧执行继续等待自己的提交；迟到的未知清理限制不会被新执行覆盖。取消通过精确 execution link 控制，不能误送到同 Session 的后续 turn。

Task API 在 native prompt 返回后继续完成原 Session / artifact / Review 提交。`ownerCompletion` 屏障使 Core 等待这些提交，但不阻塞 native 返回，避免互相等待。
原 Task API 的公开完成状态等待 canonical settlement，并保存 execution ID；普通 autoReview 保留，内部优化角色不会因此递归启动普通审阅或优化。

## 保留与复用

- 完整 `AcpPromptRequest` 继续经过原 runtime：图片、附件、parts、文献 / 产物 / Session 引用、Skills、历史、记忆、context reset、plan-first、权限、后端选择及恢复。
- `TaskRunner` 保留科研 workflow、专才 / compute / Session 资源准备和原结果提交职责；模型分发与取消进入公共核心。
- 统一的 original-turn evidence reader 使用原 review-safe scope 和固定 ArtifactVersion。普通二进制 / 大产物不会被候选文本 profile 的 UTF-8 / 大小上限误截断。
- 原 Harness² sequential / parallel、递归、组合、匿名选择、反思、Library、任务顺序、`NO_ENTRY` 与回退不改写；独立评分仍在方法完成之后，不能泄漏到优化或经验上下文。
- 原后台委派允许主回复结束后继续运行。子 mission 有独立的共同 Core execution 和原父任务引用，不要求父 execution 持续处于 running；私有 coordinator 验证当前 mission、Session 和精确 activeTurn。

## 恢复与证据

Session JSON 和应用 SQLite projection 沿用原配置目录；固定 ArtifactVersion 字节、Review snapshot 和 execution journal 沿用数据目录。测试使用真实分离的两个目录核对 UI 可重开；未自动搬动早期原型文件。

Session、Reviewer 和委派 journal 共用 `recoverExecutionJournals` 和 `FileExecutionStore.recoverStale`。
只有旧 PID 明确不存在才可接管其锁；活跃或无法确认的所有者不被抢占。恢复只标记中断 / 读取原事实，不分发模型请求，也不退还已预留预算。

Session 的精确最后 admission token、原 turn outcome、固定版本和原 lease 释放证据可以完成可信 reconciliation。
显式 Resume 保留原 `resumeRecovery` 语义：旧执行保持 interrupted，证实旧资源已释放后允许用户的新 attempt；不能把新的同 ID prompt 结果倒填给旧执行。
缺少证据的资源继续受限制，其他环境不被全局阻断。同一进程的恢复 owner 串行保留锁，后来获得原证据后可以重试 reconciliation。

普通输入记录完整请求指纹和允许保存的配置元数据，临时图片字节不进 journal。活动科研 workspace 并未变成隔离的可复现候选快照；普通配置生效记录在没有运行时正证据时保持 unknown。

## 验证范围

详见 [验证记录](ROUND8_VALIDATION.json)、[普通 Send 的 DeepSeek 记录](ROUND8_ORDINARY_DEEPSEEK.json) 和 [优化闭环的 DeepSeek 记录](ROUND8_OPTIMIZATION_DEEPSEEK.json)。

普通验证从真实 `AcpRuntimeCoordinator.startPrompt` 进入，以原生 Claude Code 的标准工具调用 DeepSeek。产物由原 `ArtifactTurnOwner` 夹具桥接成固定版本后核对；这不是完整桌面科研 workflow 的真实模型验收。
真实桌面 E2E 还核对普通 Send 的落盘 journal：一次预算预留、一次 Session admission、一次 provider acceptance，随后优化对不支持的后端在 0 次优化预留时明确拒绝。
停止测试确认共享 Session 可以保留；恢复夹具使用原 renderer Resume command，历史中断不会自动再次付费。

本轮领域联调使用 `deepseek-flash`，21 次执行、21 个 Session、30 个产物版本、27 个 Review、81 次 API 请求，预算上限 23。
两项固定产物检查通过，配置仅为 eligible，未发布。保留了一次原 `dom1` 回退及其额外执行预留。首任务没有产生可供后继读取的经验，本次真实模型没有证明跨任务经验传递；该路径由离线原生进程和原方法等价测试覆盖。
`k=1` 的最终池为单候选，真实联调没有调用 LLM selector；原 `k=2` sequential / parallel 匿名选择由离线原生与 Python 等价测试覆盖。

剩余范围包括完整科研流程回归、Linux / Windows、固定发布运行时及签名安装包、全局经验与配置发布、更多可优化工具 / Skills / 数据表面、费用计量和默认自动触发。
优化仍需用户显式启动，当前候选 profile 的隔离和文件限制保持原约束。目录 / 进程隔离不是 OS 安全沙箱；模型语义评审不是科研正确性的证明。
