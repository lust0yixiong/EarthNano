# EarthNano：原用量归属与 Harness 多模式准备

本轮沿用 PR #13 的 Notebook 深度融合，完整 Alpha 仍按 ALPHA_CONTRACT.md 验收。

- 主智能体先扩展唯一 JSON Schema 并生成 TypeScript / Python 类型；双语言 fixture 与 Core 契约门通过后才开放两侧接线。
- 平台侧读取原 Session / conversation graph / runtimeSessionAdmissions，不新增用量数据库。精确匹配真实 Session、prompt、runtime execution token、root frame、admitted branch 和 runtime segment，仅接受唯一完整的原用量 owner。ordinary settle/recovery 与候选 owner 使用同一 reader / mapper。
- input 不含 cache；缓存总数、read/write split、output 和 inference turns 保留上游语义。HTTP 请求、费用及时间不从 token 或 model turns 反推。
- 上游 finalizer 把 detached ask-user 续答累计为 logical prompt total。source 显式标为 logical-prompt；同 Session/prompt 被多次独立 Core admission 引用时，汇总排除这些重叠范围。共享 baseline 按 executionId 去重；失败/取消若有原完整 owner 的实际用量仍可统计，不能按 phase 当作免费。
- 桌面使用同一 Core records 投影并保存各项 coverage，区分 known / partial / unknown；历史无 attribution 数据可查看但不冒充可加总的完整费用。八语言齐全。
- 实际离线验收发现 live coordinator admission 未传 runtimeExecutionId。修复仅在原 onPromptStarted 回调把本已存在的真实 turnToken 填入 execution identity；未放宽 reader。相同测试修复前两项失败，修复后实际协调器/普通 native Send 通过。
- 多模式 v2 descriptor 与 slot helper 为后续 original run_sweep 准备，尚未接入生产 runner。原 Namespace、shared baselines 与两种 mode 的实际离线轨迹做对照；v1 resume / cache 路径未修改。不得把 helper 当成完整 sweep 产品能力。

需要明确的边界：

- 根 prompt usage 不含普通 Reviewer 独立 ledger 或 delegated child-frame 的完整费用。
- 缺失/被取消而未完整提交的 provider 用量依旧未知；本轮没有精确计费或 HTTP 次数生产采集，也没有时间统计产品化。
- 本轮 DeepSeek 的统计属于一次集成验收，不证明配置收益、跨任务迁移或科研正确性。
- CI 冷构建的 90m 超时不等于原 Windows runtime 源码失败。原 Node 编译约85m后才开始 PowerShell；修复 CI 调度等待和冷构建限额时保留原运行时及所有原测试/资源/安装门槛。

## 固定提交的验证

真实运行源码为 `b1cb766d6bc13fbb67787c18450b17df7c83d1a4`，工作树干净；后端和桌面重新构建。离线与第五次真实 DeepSeek 记录了相同的四个构建入口 SHA-256、Electron 43.7.5、Claude Code 2.1.232 与 deepseek-flash。其后至 CI 拆分 `469786c31` 仅改变 workflow、CI 测试和文档，没有改变该应用构建的源码。

| 检查                                         | 实际结果与边界                                                                                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 双语言用量契约、Core、原 reader、跨语言 port | 44 项 TypeScript 与共享 Python fixture 通过；生成物检查通过                                                                                                               |
| 用量投影、桌面持久化、UI、八语言             | 四文件827项通过；覆盖重复 prompt、共享 baseline、已知0、未知、溢出、重开零重放                                                                                            |
| owner / 原 native ACP / 方法 / v2 slots      | 集成九文件140项通过；包含原候选21个场景；独立 helper 未启用                                                                                                               |
| 真实协调器和 ordinary native Send            | 修复前两项明确失败；修复后六文件300项通过、1项付费测试显式跳过；root再核对四文件284项通过、相同付费测试跳过。两组有重叠，不相加为独立覆盖                                 |
| 原 Harness 对照                              | 同 Python3.12.13/平台/架构/精确 pin、tree、源码和 license：原树5项、当前66项通过，0失败/0跳过；候选报告源码为 d4b20667d，其后没有改变 Python 生产文件                     |
| CI 拆分与原比较器                            | 37项本机测试通过；不是 GitHub hosted 构建通过的证明                                                                                                                       |
| 类型、格式与构建                             | Node/Web类型、生成物、聚焦 ESLint/Prettier、consumer index及本机后端/桌面构建通过                                                                                         |
| 离线完整科研链                               | 19/24接纳，17次优化执行有原用量，另2次未知；普通用量另核对1次。停止、重开、显式续跑、同任务/版本、独立审阅均通过                                                          |
| 第五次 DeepSeek                              | 完整链通过：21/24接纳，19次优化执行有原用量，另2次未知；加普通 Send 共核对20个原用量 owner。118本地请求、117上游请求、0拒绝、1转发前暂停、1确认取消，incompleteRequests=1 |

本次两项独立语义评估均95分；单次同模型隔离评审不证明配置改善或科学正确性。配置仅 eligible，未发布。优化用量小计 input=315527、cache=1621760、output=38809、上游原记录 modelTurns=155，覆盖19/21；普通任务 input=39937、cache=156288、output=498、modelTurns=5。生产 API 请求数与美元费用仍未知。

测试代理另外观测 input=356355、cacheRead=1778048、output=39319，包含普通根 prompt 以外的调用且存在一次不完整取消。代理计数不是产品用量账本，也不用于补造完整账单；modelTurns 与 HTTP 数不能互换。五次付费尝试累计已观测 input=1528237、cacheRead=6913792、output=160972；停止用量与货币费用仍不完整。

失败同样保留：本轮首次离线检查在 ordinary Core 已完成后发现 usage unknown，零付费调用，未进入优化。该次记录源码60704869c、dirty=true，不能作为固定提交验收；原 journal证明缺少 runtimeExecutionId。随后在干净 d4b20667d 的相同新回归上明确重现，再修正原 live admission 元数据。没有通过放宽身份或随机付费重试掩盖失败。原始记录及摘要见 [validation/alpha](validation/alpha/README.md)。

## 下一步

先核对新的三平台源码 CI 与四目标原生包真实结果。完整 sweep 接通仍需由主智能体冻结有序 catalog/stream/多mode 契约，再调用原 `task_stream → run_sweep → run_domain → run_task`，共用原基线、Library、同一 Core、总预算和每 task/mode 独立评估。v2 descriptor 必须在查缓存和接纳前持久化核对，不能只换 slot 哈希。R、远程 Compute、二进制候选、跨任务采用与回滚、自动策略、时间统计和最终发布验收仍在原 Alpha 完成范围内。

## 首次托管 CI 暴露的环境缺口

PR14 首次运行39454904669在源码测试前暴露两个独立问题：macOS无法安装3.12.13；Linux候选的原生组件构建指纹不匹配。现用唯一CI版本文件固定共同可用的3.12.10（只改变CI，不覆盖本机/DeepSeek的3.12.13历史证据）；并恢复原生组件 producer workflow 的两个原上游Action固定值，重新匹配原目录的24cd5bc...指纹。没有放宽指纹、摘要、签名、原测试或失败门槛，旧producer仍禁用。

Linux另一分片为独立ECONNRESET，不能归因为同一个源码问题。失败日志、官方版本清单投影、原生指纹对照和workflow禁用状态均保留。四文件61项原生组件/CI回归通过；新的托管检查仍需完成，见 [CI事实与边界](ALPHA_CI.md)。
