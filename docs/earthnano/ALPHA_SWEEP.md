# Alpha：原 Harness² 完整任务流与 Notebook 共同执行

本轮把原 `task_stream → run_sweep → run_domain → run_task` 接入 EarthNano 现有运行核心。
两个优化模式共享每个任务的 k 份基线，保留各自递归、匿名选择、reflection 和 Library。
普通 Send 和每个基线/候选仍由原 Notebook、Session、ArtifactVersion 和 Review owner 执行、持久化。
配置不会因为进入优化模式而获得其他任务的数据或 Notebook 权限。

## 模块和调用关系

| 边界     | 本轮实现                                                                                                                                                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 共同契约 | `optimization-sweep.ts` 定义 catalog、mode、stream 和总预算；`sweep-contract.ts` 定义 Host 冻结后的逐任务来源与计划。新请求不携带被忽略的主任务。                                                                                           |
| 计划     | `previewOptimizationSweep` 只向原 `task_stream` 提供完整 ID/domain 目录；保留 seed（含 0/负数）、域/任务过滤、每域上限及原顺序。未选任务不传正文。                                                                                          |
| 来源授权 | `createDesktopSweepOptions → resolveDesktopSweepTask` 对每个选中任务分别取得原 Session、prompt、固定版本和已启用 Python runtime；共用 provider 与初始指引/Skills。                                                                          |
| 运行     | 同一个 `runPersistentOptimization`、FileExecutionStore、ExecutionCore、预算和 owners；现有 HarnessDomainBinding 仅把明确 taskId 路由到现有 task binding。                                                                                   |
| 方法     | 新 `earthnano_sweep.py` 直接调用一次原 `schedule.run_sweep`；本轮不修改 core 下的 scheduler、recursion、selector、reflection 或 Library。                                                                                                   |
| 恢复     | schema2 manifest 固定完整 request/catalog/任务输入/来源/环境/criteria/checks/预算、方法源码与 namespace；v2 slot 包含 task/scope，immutable invocation 同时固定 task/scope/descriptor。私有 index 是路由索引，不能替代原 owner 的完成证据。 |
| 结果     | `prepareSweepSummary` 按域/模式复用 `prepareDomainSummary`，核对原任务顺序、状态、归属、选中配置、reflection 版本和 Library。                                                                                                               |
| 独立评估 | 方法全部结束后按 task × mode 使用原 semantic/research verifier。第二模式从当前 durable journal 精确复用已完成 base1 reviewer；每个候选保持独立评估。criteria、expected 和评估源内容不进入方法或 Library。                                   |
| 桌面     | `startSweep` 使用现有 manager 接纳队列、进度、停止和显式续跑；原面板提供双模式比较，沿用原结果/Review/经验组件。旧 start/旧实验维持兼容路径，均使用同一执行核心。                                                                           |

## 预算与固定身份

完整首轮成功路径每任务为 `k + 模式数 × (6k + 选择 + 反思) + 独立评估`。
选择在 k>1 时为 1；每模式有 1 次反思；独立评估是 base1 一次加每模式候选一次。
因此四任务、k2、双模式为 120 次方法执行加 12 次独立评估，共 132 次接纳。
重试/停止历史可能额外消耗预算；这不是成功保证。

新 sweep 显式设整次实验上限 512，计划过滤后才核对总容量；旧入口上限 128 不变。
Core 并发与原 domain workers 分开，所有域/模式/重试/评审仍共享一份预算与停止控制。
恢复不能增加原预算。模式、seed、来源、runtime、模型/非秘密 provider route 或方法源码变化均拒绝复用。
不迁移 v1 slot，也不把新 namespace 当作授权重复执行旧付费任务的理由。

## 本轮验收与失败记录

固定测试源提交 `be1143b2ad1136ee450b73d75899c73f74e0d44a`，clean=true。它相对生产构建源 `0fcd53211` 只增加离线 fixture；生产源文件没有差异。离线与 DeepSeek 使用完全相同四个 bundle SHA：

- `out/backend/index.cjs`：`634d796158959879fcf872cd896b19312c4880de3412e9e911df48015dd4ccf0`
- `out/main/index.js`：`0420cf1b5e6c363173b3d774ce86ea861ec86cf6e1d8f7bcffb50f92006ce053`
- `out/preload/index.js`：`2016ba41b25ed87c678885cbe2ec1835a1b3d8f6f99d2e72fc005688d05ac59f`
- `out/renderer/index.html`：`7cf4d2f9ceace70715ef25b73fffd4f71737d21986352d1ca685c21e923b10d1`

Electron43.7.5、Claude Code2.1.232、Python3.12.13；NodeRunner26.0.0 是测试 runner，不能当成所有打包平台的 backend runtime 证明。

1. 主智能体先提交共同契约，通过测试后由两名开发智能体分别实现方法和桌面/来源接线；Luna 及方法智能体做只读复核。
2. 集成验证 12 文件/944 测试通过（包含八语言检查）；核心专项 7 文件/99 测试通过。后续真实 Python 配置/投影回归整组 38 测试通过；各组有交集，不相加为唯一总数。
3. 相同 Python 3.12.13 executable/platform/arch/license 下，上游 Harness² 5/5、融合源码 72/72 通过，无新增失败/跳过。原方法真实离线 port 对照覆盖两域四任务/k2/双模式，测得 120 次方法接纳；它不冒充 132 次真实 Notebook/model 接纳。
4. 第一次原生离线验收在任何优化接纳前退出：Host 把 coreConcurrency 漏出 private Python config。真实 Python validator 红绿测试复现并修复（8065beb9c）。
5. 第二次离线验收完成基线/提案、停止且重开零调用，但续跑在 input projection 失败：缺省字段被 canonical serializer 写成 undefined。红绿测试复现后只修投影构造，并在首次写入前解析 JSON；保留既有哈希算法（0fcd53211）。两次均无真实 DeepSeek 调用，失败证据全部保留。
6. 离线模型 fixture 补原 reflection reply 格式。第三次原生验收通过：固定 CSV 为 3 行、sum12、mean4；同一真实普通任务进入两个模式，验证原 producer/固定产物/源证据/Review、共享基线和其评审、停止/重开/续跑/旧 journal 不变、最后重开零重放。19/24 次接纳，两个模式各有原 Library 经验和独立候选评审。
7. 首次真实 DeepSeek 验收通过（deepseek-flash、原 Anthropic 兼容端点、同一构建）：20/24 次接纳，98 次本地模型请求/97 次转发，0 rejected，1 次请求在转发前暂停，另有 1 次上游取消且用量不完整。共享 baseline 评审 ID 完全相同，两个候选评审不同，只有 3 个已完成独立评审。base95、parallel95、sequential98，产物检查均通过；parallel 未形成 Library 经验，sequential 有原 reflection/Library 证据，未伪造空经验。关闭重开零自动调用；续跑复用已完成阶段并保留两条停止历史。生产用量核对 18/20 个优化根 owner（另有普通 owner1个），API/美元仍未知；代理观察是验证辅助，不能混作生产账本。

原始记录及 SHA 见 `validation/alpha/README.md`。
同样分数、通过工具调用或代码退出状态均不证明优化收益或普遍科研正确性；eligible 仅供继续验证，未发布配置。

## 上游对照与尚未覆盖

- Hosted PR14 的 Ubuntu candidate3/4 在 npm-ci 下载原 onnxruntime-node1.24.3 时 ETIMEDOUT/ENETUNREACH，未进入 pretest/typecheck/tests。锁定依赖与 OpenScience9e18 完全一致，不据此改源码、跳过下载或把任务记成通过。专用 CI 现固定 Host Node24.22.0，并保留严格 image 比较；跨平台最终比较及原生包仍待真实 CI。
- 旧 EarthNano 分支的 host command inventory 测试遗漏既有五个优化命令：原未加 sweep 的独立 worktree 重现 85 对 80 的两个失败。本轮保留上游 80 命令断言与测试身份，并显式核对新六命令、同组接纳/权限及卸载；不删原断言或屏蔽测试。
- 原 ManagedFileVersion/Notebook 删除语义保留。单次版本 read lease 和 archive admission 不等于持续来源删除锁；正常 Session 删除仍保留可读版本历史，删除进行中或 logical-file tombstone 会拒绝读取。没有新增一个会误拒绝 archived/retained 来源的平行权限规则。
- 真实 Notebook/model 验收是一个科研任务的双模式 k1；四任务 k2 与两个不同源 Session/runtime 的覆盖分别是离线原调度对照和来源 owner 单测。多来源完整真实桌面实验仍需补齐。
- 桌面面板可比较当前任务/原文本后续任务；跨 Session catalog 编辑、完整 seed/filter/worker 操作界面待补。API/方法实现不等同这些界面已完成。
- R、Compute、二进制/更多数据工具、完整费用/时间事实、跨任务配置采用与回滚、证据触发自动优化、原生安装升级/发布仍按 `ALPHA_CONTRACT.md` 推进，未由本轮缩减或宣布完成。
