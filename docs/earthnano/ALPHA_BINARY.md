# 原版本二进制产物进入统一优化执行

本轮补齐已有文件能力的候选路径，不新增科研运行时、产物数据库或优化算法。普通文件仍由固定 OpenScience 的 ArtifactVersion、ManagedFileVersion、Session 和 Notebook producer 管理；原 Harness² 的递归、匿名选择、Library 和续跑仍使用原模块。

## 模块与调用关系

1. `persistent-candidate-owner.ts` 从已接纳、完成且收尾确认的 Core Run 导出原 ArtifactVersion。原文本结构保持 `{path, content, digest, artifactRef}`；二进制只导出 `candidate-artifact.ts` 中的描述，包含原版本引用、大小、类型和校验和，不携带伪文本、Base64 或原宿主路径。
2. `harness-optimization.ts` 对照本任务实际接纳的 Run 再检查版本身份。Python 的 `core/earthnano_binding.py` 请求 owner 材料化，复用原结果目录及 `selection.py` 的 `deliverable_assets` 匿名复制钩子；完整大小与 SHA-256 校验失败时停止。
3. 后续阶段的二进制描述以 `CandidateInvocation.assets` 进入原快照和缓存身份。模型看到 INPUT 下的相对匿名资产路径及明确标注的元数据（包括原逻辑文件名）；私有 Core 身份不作为选择标签，宿主路径不作为模型读取授权。
4. `candidate-snapshot.ts` 调用原 owner 的 `materializeArtifact`，通过原 bounded copier 和原资源预算把固定版本复制到现有候选 INPUT。路径、文件身份、字节及停止信号均核验，之后仍由 `claude-candidate-driver.ts` 进入同一原执行生命周期。
5. 原选择器继续产生原 `choice` 回复。原 `schedule.py`、`recursion.py`、`proposer.py`、`selection.py`、`library.py`、`context.py` 在本轮未改。

Notebook 的二进制**输入**原本已走 `resolveOptimizationNotebookInputs` → `managedInputs` → `NotebookInputRegistry` → `ImmutableInputAuthority.stageContent` → 原版本租约 `copyTo`。本轮不为 RDS 等格式另建输入适配器。

## 一个生命周期和原资源边界

- 版本、Session、Core/native admission 和科研 producer 必须一致。科学产物还核对真实 Notebook Run 和 terminal prompt；一般 ArtifactVersion 的已有文件能力不被人为限定为 Notebook。
- 原租约负责固定字节。投影是临时文件，不是第二份权威产物库。停止和关闭失败使用原 owner 的收尾与重试机制。
- 二进制使用原单文件、单轮及磁盘余量预算，不套用旧文本的 UTF-8 大小上限。原文本快照和文本调用 JSON 保持兼容。
- 目录权限不能被称为操作系统沙箱。Windows 文件属性也不能替代字节和身份校验。
- 科研提示从此前融合层的“仅文本报告”恢复为数据、图像和报告产物；固定运行时、原 producer 及禁止私自切换环境等约束保留。

## 评估的适用范围

JSON 检查只读声明的文本 JSON。二进制命中该检查时明确拒绝评估，不假装解析过文件。混合产物的语义审阅可引用实际文本，但明确记录二进制内容未读取；全二进制结果在 reviewer 接纳前报告不可评估，不产生虚假通过或付费重试。Library 的经验仍要求实际文本，不把二进制描述当经验正文。

字节相同、producer 完整和流程成功不证明图像内容或科学结论正确。不同模型的图像读取能力也不由本次描述协议保证。

## 当前验证与剩余验收

首次根集成定向验证：287 项中 282 通过，5 项既有付费验收测试按条件跳过；真实 Python/R 的两个原 Notebook 用例均通过，完整 Node/sandbox/Web compiled types 通过。离线 provider 原有 11 项测试通过。原 consumer generator 已实际刷新并检查，没有新增清单豁免。

方法侧已验证两种递归模式、实际匿名复制字节，以及在第 4/12/14 次接纳后停止并重开时不重复材料化或接纳；纯文本两模式各 15 阶段的完整 freezeInvocation 参数 JSON 按原 task/scope/label 身份逐个匹配后字节相同。并发阶段的整体到达顺序不同，不能称完整轨迹数组逐字相同。

新增真实 RDS+PNG 用例与原 Python/R CSV 用例共 3/3 通过、无跳过：后续输入 head 改为 999，baseline/candidate 仍读取旧版本 2/4/6，分别通过原 producer 发布 JSON 与 PNG；四条原 used-input 精确指向旧 Version。两份 4704 字节 PNG 从原版本到材料化及 INPUT 投影的完整 SHA-256 相同，重开未重放。原 notebook-analysis 与固定上游目录 hash 相同，未放宽分析器或 producer 断言。原始记录见 [验证清单](validation/alpha/binary-current/manifest.json)。上述为最初原 owner/方法资产验收，后续真实桌面证据如下；Compute 等其余融合继续按 [完成契约](ALPHA_CONTRACT.md) 和 [功能来源](FUNCTION_ORIGINS.md) 推进。

## 同一构建的真实桌面及 DeepSeek 验收（2026-10-21）

干净源码 `4746f52f79a80aa9de5ec0d5ea184eb4fca18733` 的真实 Electron / 原 Claude Code 桌面链路已通过离线和 DeepSeek 验收。普通执行、原 parallel k2 的基线与候选使用同一固定科研任务，沿原 R Notebook producer、ArtifactVersion 和独立 Review 保存并重开；停止后显式续跑沿用同一预算与截止，重开零模型重放。离线为 20/24 次核心接纳、70 次 fixture 请求、0 次上游请求；DeepSeek 为 22/24 次核心接纳、142 次实际上游请求（其中 1 次取消）。这些请求数来自测试 provider，不是生产费用账本。

DeepSeek 运行有 26 份二进制上下文资产记录和 8 次真正的 PNG Read 图像 tool_result，原版本、匿名投影、模型工具收到的字节和 SHA 对应。**图像语义评估未执行**；独立 Review 只对冻结的数值文本标准给出模型判断，不能据此证明图像科学正确或配置改进收益。生产用量为 20/22 执行覆盖，API/美元仍未知。

实际联调先后暴露并修复：可信工作根的 `/var` 与 `/private/var` 别名、native 配置物化验证遗漏二进制 manifest、已验证 JSONL 信封误传为严格 payload；另修正真实 native 图像路径和 producer 证据的测试断言。四次失败桌面尝试及各项红/绿证据均保留，没有挑选重跑隐藏失败；旧 transport fixture 缺少 reader/writer、一次错误 Python 路径的结果明确标为测试设置错误。修复后原配置定向验证共 335 项，330 通过、0 失败，5 项原付费 opt-in 用例按条件跳过；完整 compiled types、原构建和 consumer generator 已通过。

原六个 Harness 方法模块本轮未变。独立源码审查未发现可证明的严重阻断；最后 native 完整性重读沿原 prepare API 没有 signal，不能声称该读取可即时中断。owner 投影/复制已有取消校验，派发前 driver 仍检查停止状态。原始报告、Session/journal、构建摘要、审查与故障记录见 [桌面验证清单](validation/alpha/binary-desktop-current/manifest.json)。

后续仅整合 CI 与文档，`src/packages/vendor/resources/e2e/contracts` 与受测 4746 源码相同。当前源码的 hosted 全量对照和最终 macOS/Linux 发布包仍待完成；Windows 按用户决定延期至 0.2-Alpha。上述证据不代替完整 Alpha 完成验收。
