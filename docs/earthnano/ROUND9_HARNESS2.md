# 第九轮：Harness² 源码覆盖、方法等价与证据传输边界

本清单对照固定上游 `google-research/harness2@1cfe254e8d25b15f37048c3730134686abe60335`，以及 EarthNano 第八轮基线 `9aeb742ca`。不升级上游、不改变业务默认，不直接启用有再次付费风险的缓存恢复。本轮方法侧验证全部使用确定性夹具，无模型、key 或付费请求。

固定源码可由导入提交 `0a9d62c17:vendor/harness2` 核对，其 Git tree 为 `edc756a4d03a2826a248115482084a176e60e751`，与 `UPSTREAMS.json` 的 pinned tree 一致。当前核心文件并非与上游零差异：此前已在 schedule、recursion、proposer、selection、context 加入显式 `MethodExecution` 接缝及控制停止传播，prompts 增加受限 `claude-text` 表面。Library、runmark、ledger、tree 与原方法规则继续保留。第九轮不修改上述算法模块；Python 生产变更仅是私有 `earthnano_binding` 的预算常量命名和帧换行计数。

## 实际调用链

单任务为 `runPersistentOptimization` → `runHarnessProcess` → `harness2.earthnano.run` → 原 `schedule.run_task`。显式领域任务流改用 `harness2.earthnano_domain.run` → 原 `task_stream(seed=None)` → `run_domain` → 每任务的 `run_task`，并按 mode/domain 创建原 `Library`。

两者都将角色调用交给 `PortMethodExecution` → 私有 stdio `PlatformRequestFactory` → TS `HarnessOptimizationBinding`（领域使用 `HarnessDomainBinding` 路由）→ 共同 `ExecutionCore` → 原 ACP/candidate owner。已接纳的可信 scope 沿用同一 execution，不重复建立普通接纳。结果经过原 Session、固定 ArtifactVersion 与 Review owner，使用 config root 的 Session JSON 和数据目录的产物/Review snapshot；Python 不能以 cwd、路径字符串或 summary 自证固定版本。

## 逐项覆盖

| 固定源码/机制                                                    | EarthNano 实际使用                                                                      | 已验证范围                                                                                       | 可达性与限制                                                                                                        |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `schedule.Namespace/ns/mode_token`                               | 原命名构造器生成共享 base、单 mode 的 harness/run/selection 路径                        | seq/par k1、k2、k3、k8；选中 harness 与 ledger/上下文等价                                        | 当前一次实验选一个 mode；未开放 seed/tag 与同次双 mode 对照                                                         |
| `task_stream/stream_order`                                       | 领域入口调用原 `task_stream(seed=None)`                                                 | 2/4 任务稳定参考顺序、输入路由、同字节 task 的独立归属                                           | 一个显式 domain、1–4 个任务；排序由有序 `root-0001` 等 ID 保证。未开放随机 seed、多领域 sweep/filter                |
| `schedule.run_task/_roll_bases`                                  | k 个独立接纳 base；原共享基线语义                                                       | base1..basek、部分 base 失败、R/P 恒等式；评估预先固定 base1                                     | 每个真实 base 记预算；并非一个 native batch 当一次执行                                                              |
| `recursion.run_mode/run_sequential`                              | 原 k 层嵌套 INV/DOM、rollout、composition；上一轮 c 成为下一轮指导                      | k1/2/3/8 与 LEGACY 完整 stage、ledger、证据树逐项一致；第三轮实际读取 c2                         | 未把 seq 写成独立候选批量生成；并发由 TS Core 的 cap 控制                                                           |
| `recursion.run_parallel`                                         | 原共享 base 的 2k 独立改进与 k 个独立 aggregate finals                                  | k1/2/3/8 与 LEGACY 等价，原 pool/decisions 完整传递                                              | Python 保留原阶段宽度，平台控制实际运行并发；两者不混为一项预算                                                     |
| `_run_stage/_accept_tree`                                        | 原 transport retry、一次非法提案修正、验证、原树回退                                    | 原 workflow 与 execution-seam 测试覆盖反馈、成本累计、linked execution、新 requestKey            | 正常提案失败仍保留记录与预算；Stop/超时/预算/身份或结果不确定性不能吞成普通回退                                     |
| `context.build/mission`                                          | 原 task/source、完整 trajectory、deliverables、harness、pool、decisions、Library 文件树 | LEGACY 完整上下文等价、路径/摘要/链接拒绝、grader guard、4MiB 固定产物跨真实 stdio               | 本轮修复文本证据传输预算不一致；不静默裁切；超过显式证据预算仍拒绝                                                  |
| `selection.selection_pool/assign_ids/run_selection`              | finals-only、原稳定匿名映射、原 choice/why parser                                       | k2/3/8：只含 k 个 finals；选择 c2/agg2 而非机械选最后一轮；malformed choice 原回退               | selector 不看到原 harness/阶段 label、独立评分或候选 trajectory；不能把模型选择称为事实证明                         |
| `trivial_selection`                                              | 原 k1 单候选路径，不调用 selector                                                       | 两 mode k1，7 次方法接纳；领域再加 reflection                                                    | k1 真实联调没有证明 LLM 匿名选择；该机制由确定性 k>1 测试验证                                                       |
| `reflect_adoption/_distil`                                       | 领域模式直接调用原反思与 `<edits>/<experience>` parser                                  | 正常反思、重复/空格字段、NO_ENTRY、畸形/普通失败、control stop、固定反思产物来源                 | 普通单任务入口不启用 Library/reflection；没有经验也是合法结果；不是每次反思都应产生条目                             |
| `Library.add/context_dir/retain/rebuild_index`                   | 每实验、每 mode/domain 独立的完整所选树与 raw experience                                | 2/4 任务前缀为 0/1/2/3；跨实验/领域/mode 隔离；选中配置与固定反思版本核验；大 inventory 不丢文件 | 没有跨实验全局 Library 发布；独立 assessments 在方法结束后运行，不进入经验上下文                                    |
| `schedule._resume/_restore_libraries`                            | 默认 LEGACY 路径仍保留；Port 模式显式不使用                                             | 原 workflow 的缓存摘要/Library 恢复与修改后拒绝；Port 不复用 legacy summary                      | EarthNano 入口要求全新 workRoot，使用 `summary.port.json`。尚未接通用户可达的实验级安全方法恢复，不能宣称已完整覆盖 |
| `runmark`                                                        | 原 LEGACY completion marker/harness fingerprint 不变                                    | 原 workflow 检查输出/harness 改变会失效                                                          | 不能直接启用上游“失效即重跑”；平台必须先按 execution/Session/固定版本证明原结果和资源处置，不能自动再次付费         |
| `ledger`                                                         | 原每 mode R=4k、P=3k，selector/reflection 在其外                                        | k1/2/3/8 恒等式；真实执行接纳包含重试、selector、reflection、独立评估                            | 原 ledger 与平台次数、API 请求数、token、费用不是同一度量；未知用量不因 ledger 数字为零变成已知免费                 |
| `judge/adapter.score`                                            | 优化期不调用原 benchmark judge；adapter 明确拒绝优化期评分                              | no legacy launcher/judge、grader 泄漏防线、独立评估隔离                                          | 任意科研任务没有 benchmark 隐藏答案；固定 JSON/文本 checks 与独立模型 Review 分别保留含义，不能据此声称科研结论正确 |
| `schedule.run_sweep`、原 OpenCode/Codex substrates/benchmark CLI | 原源码保留，不是桌面此次优化入口                                                        | execution-seam 覆盖 sweep Stop 与 legacy native batch 行为                                       | 尚未把所有 benchmark、substrate、seed/filter/CLI 功能暴露到桌面。保留源码不等于已完成产品接通或验收                 |

## 本轮修复：合法产物进入下一轮时被误拒绝

原 candidate profile 允许每产物 1MiB、总产物 4MiB，但 TS 角色证据曾只接受每文件 256KB、总量 512KB；stdio 又使用单行 1MiB、整次 stdout 累计 16MiB。原 `context.build` 把完整产物送入后续改进/组合时，即使产物合法，也会在已执行 base 后被拒绝。较长实验累计合法消息同样可能被杀掉。

现在私有绑定统一为：

| 边界                                            | 明确限制                                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Python/TS stdio 帧                              | UTF-8 序列化 JSON 加换行最多 32MiB，收发双向核验；未结束的超大帧也中止                      |
| 单个角色 context/harness 文本包、Library 导出包 | 总文本最多 16MiB、最多 512 个安全相对文件；保留原字节，不裁切                               |
| 待处理 stdio 工作                               | 最多 2 帧；正常原客户端一问一答，不能通过堆积小帧绕过内存边界                               |
| stderr 诊断                                     | 整次累计最多 1MiB，排空而不保存任意 provider 诊断                                           |
| 整体执行                                        | 原 deadline、共同接纳预算和停止/清理约束继续有效；stdout 的合法协议累计量不再误当诊断日志量 |

超过任一明确预算会停止，不能隐式截断证据后继续优化。16MiB 是角色证据包上限，并非承诺任意 k 个最大产物的全部排列都能装入一个包。候选输入、产物、工具和权限 profile 均未扩大；这些传输预算不授予新的能力。

真实 Python 原 seq k1 与 TS Core/快照夹具使用四个各 1MiB 的固定产物：两个改进者实际收到超过 4MiB 的完整证据，组合者收到超过 12MiB；方法总计 7 次接纳、无 fallback。此链同时超过旧单行与累计限制，并校验冻结的原 source、最终四个 artifact refs 与无独立评分回流。另以两个各 64 文件的完整候选树核对 Library：131 个导出文件、大于旧 512KB，固定配置篡改仍被拒绝。

## 科研数据和工具的真实边界

`claude-text` 是 EarthNano 的受限 profile，不是 Harness² 算法本身的能力上限：

- `CandidateTask`/私有 config 接受 `{path, content}` UTF-8 文本；桌面原限制为每输入 64KB、总输入 128KB。受控 ArtifactVersion 引用入口由本轮主线另行实现/验收，不因此变成任意二进制或大文件 profile。
- `TEXT_SURFACE` 只允许非空 `instructions.md` 和 `skills/<name>/SKILL.md`；always-on 限制为 32,000 字符。Skill 使用受限 name/description frontmatter，原自动触发机制仍调用，不能认为所有已有 OpenScience Skills/配置表面都已可优化。
- native candidate preparation 只开放 Read、Write、Edit、Skill；MCP 配置为空，冻结 input/output/plugin 路径受控，拒绝动态 shell、文件 mention、scripts/hooks/plugins/subagents/settings。普通 Send 保留的 Notebook、文献、Compute、其他后端/权限并未自动成为候选的可优化工具表面。
- candidate owner 导入最多 64 个普通 UTF-8 输出、每文件 1MiB、总量 4MiB。真实科研图像、栅格、PDF、NetCDF、二进制表格、Notebook execution 和远程 Compute 需要分别设计固定版本引用、工具授权、结果提取与验收，不能只扩大模型上下文或绕过隔离。
- 目录/进程隔离与文件权限不等于 OS 安全沙箱。实验 completed、产物通过 checks、模型 Review pass、配置 eligible/发布、科研结论有效是不同事实。

本清单不声称完整科研流程、跨平台、真实模型优化收益、全局经验推广或配置发布已验收。Stop/进程中断会保留原 execution/Session/版本事实；领域完整投影仍依赖方法结束，原记录存在不等于实验可以无付费风险地续跑。

## 可重复检查

```sh
PYTHONPATH=vendor/harness2 python3 -B -m unittest discover -s vendor/harness2/tests
node node_modules/vitest/vitest.mjs run src/main/earthnano/harness-optimization.test.ts src/main/earthnano/harness-domain-binding.test.ts src/main/earthnano/domain-results.test.ts src/main/earthnano/harness-large-evidence.test.ts src/main/earthnano/harness-roundtrip.test.ts --maxWorkers=1
node node_modules/typescript-native/bin/tsc --noEmit -p tsconfig.node.json --composite false
```

本分支记录：Python 53 项通过（包含原 workflow 5、execution seam 19 和 EarthNano 29）；TS 方法/绑定相关 5 个文件共 58 项通过；node 类型检查和修改文件 lint 通过。上述全为离线确定性检查；没有运行付费调用，未改变上游版本或业务默认。
