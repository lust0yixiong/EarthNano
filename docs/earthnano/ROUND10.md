# 第十轮：Notebook 科研任务进入同一优化核心

本轮基于已审查合并的主分支 `7c08c9b7eb1b3fcc167b23acdab85d4c110df8b2`。主智能体先确定[最小契约](ROUND10_CONTRACT.md)，再由两个 `gpt-6.1-sol / high` 智能体在独立 worktree 分别实现原 Notebook 执行路径和 Harness² 科研配置表面，主智能体负责来源冻结、桌面入口、交叉审查和实际联调。

第九轮验证了“普通 Notebook 计算，再优化派生的文本任务”。本轮基线和候选直接重新执行原科研任务：读取相同的固定 CSV 输入，通过原 Notebook Python 计算，再用原 Artifact MCP 发布结果。没有新增统计引擎、Notebook 服务、产物存储或优化算法。

## 已合并的工作与图标

原有 PR #7、#1、#8、#9、#10、#11 已审查并依赖顺序合并。#7 的透明 EarthNano 图标覆盖应用运行、安装包及托盘资产；应用显示名称保持 EarthNano。原数据目录、凭据身份、CLI / MCP 名称、appId 和上游许可证继续保留。

合并前修复两项问题：#1 更新 Action 固定提交后的测试预期；#10 修复尚未接纳的分发失败缺少物理收尾证据、导致 Session 永久保留未知状态的问题。后者只接受准确执行身份、原持久化接纳未变化且原运行时确认已收尾的证据；有活动兄弟任务或未知状态时仍保留资源隔离。修复分别通过 163 项和 273 项定向回归。GitHub Actions 保持关闭。

## 模块和调用关系

| 模块                                                     | 保留、抽取或扩展               | 在共同链路中的职责                                                                                                  |
| -------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `TaskOptimizationPanel` / typed IPC / manager            | 扩展原入口                     | 显式选择重新执行 Notebook 任务；只传原 `promptMessageId`，固定原提示词，沿用方法、预算、进度、停止和幂等规则        |
| `optimization-notebook-input.ts`                         | 新增来源解析，复用原版本租约   | 在原活动会话图中验证完整用户消息，按版本读取原上传或产物，分块校验 SHA256；不采用 latest，不另发数据副本            |
| `notebook-profile.ts` / candidate snapshot               | 扩展共同模型                   | 冻结输入版本身份和原 Python 绑定描述，计入 Task / Environment 摘要；不携带存储路径和凭据                            |
| 原 Harness² `schedule` / `recursion` / selection         | 保留原实现                     | 原 parallel / sequential、递归提案、组合、匿名选择继续提交共同 Core；私有入口仅传递固定科研配置                     |
| `ExecutionCore` / ACP driver                             | 保留原共同规则                 | 每个角色一次接纳、预算、截止时间、停止和收尾；候选继承 scoped Core，禁止产生另一套普通 Send journal                 |
| `acp/notebook-binding.ts`                                | 抽取原运行时装配               | 普通 Send 与候选复用原 RPC 连接、权限、输入和产物绑定；候选在独立 Session / 连接 / home / lane 执行                 |
| 原 Notebook service / input registry / permission broker | 保留原 owner，补最小 host 接口 | 使用原启用的 Python、原输入 staging、风险判断和执行记录；host 只能为新 Session 固定绑定一次，受限策略沿用原权限分类 |
| 原 ArtifactVersion / producer / Review                   | 保留原发布和持久化             | 候选直接发布原版本及实际 Python producer；方法结束后才对固定产物做确定性检查与独立语义审阅                          |

实际调用链为：

`源 Session 的普通 Send → 原 Notebook / Python / Artifact → 桌面显式优化 → main 冻结同一原任务及输入、运行时 → 原 Harness² → 同一 ExecutionCore → 原 ACP / Notebook → 原 ArtifactVersion → 原匿名选择 → 固定产物检查和 Review → 重开原持久化事实`

`notebook-python` 只对 baseline / candidate 开放。提案、组合、选择、反思和独立 Reviewer 仍使用原受限文本配置；修改指令和 Skills 不会扩大工具、切换 Python 或修改源版本。Notebook 的实际环境和网络决定权仍属于原 owner，目录隔离不被描述为完整系统沙箱。

## 联调修复的具体缺口

- 原提示词没有内嵌附件时，原准备流程不会调用候选的固定输入注册器。增加仅 main 可设置的固定输入声明，继续由原 registry 与 prompt builder 装配输入；普通流程默认行为不变。
- 私有候选的风险授权不能流向普通 Session 的人机审批卡片。复用原权限 broker 的受限分类和原风险分析，风险代码明确拒绝，不模拟用户点击；普通交互授权路径保持原行为。
- 原 `shutdownSession` 同时设置删除墓碑，不能用于候选正常结束。改用原非删除 shutdown，等待原 agent / Notebook 物理收尾；同一应用内即可重开 Notebook，未知收尾继续隔离。
- 科研产物不经过文本任务的文件导入器。发布必须引用本候选的实际完成 Python producer，并核对同一固定输入与运行时；导出后改写 Notebook 证据会被拒绝。
- 实际模型可能分多个 cell 完成计算和发布。验收分别核对真实计算 run 与实际发布 producer，二者都必须属于本 Session、完成且带相同固定输入，不强行要求它们是同一个 cell。
- 真实评分不保证提高。验收核对原准入规则：产物检查与语义审阅通过后，候选评分低于基线时必须 `blocked / score-regression`，否则才 `eligible`；不修改生产规则来获取通过结果。

## 验证记录

最终结果汇总见 [ROUND10_VALIDATION.json](ROUND10_VALIDATION.json)，离线与真实模型的完整验收事实分别保存在 [ROUND10_OFFLINE_DESKTOP.json](ROUND10_OFFLINE_DESKTOP.json) 和 [ROUND10_DEEPSEEK.json](ROUND10_DEEPSEEK.json)。原生桌面测试实际经过 renderer、preload、typed IPC、后台进程、Claude Code、原 Notebook MCP / RPC、真实 Python、SQLite、产物和 Review，最后关闭并重启 Electron，确认读取旧事实不会再次付费执行。

离线模型脚本只替代模型选择，实际工具、文件和持久化不伪造。定向原生测试另行验证：源文件存在更新版本时仍读取指定旧版本；checksum、绑定版本改变或运行时停用时，零模型请求失败；受限代码不触发普通审批卡片；停止后原 Notebook 事实仍可重开。基线与候选必须全部完成，不能把原 Harness² 合法失败回退视为全链路验收通过。

最终离线桌面为 17 / 20 次执行、56 次模拟模型请求。最终 DeepSeek 桌面为 20 / 24 次执行、131 次真实 API 请求（包括 1 次后台标题调用），其中两次基线和六次候选全部完成真实 Python 计算，使用同一 TaskSnapshot / EnvironmentSnapshot 和固定来源版本；选择无 fallback，产物检查通过。基线和候选语义评分均为 90，配置仅为 `eligible`，没有自动发布，也没有证明优化收益。原生进程及重启检查均通过。包含两次先前未通过验收的消耗，本轮实际 API 请求共 364 次，详见[尝试记录](ROUND10_LIVE_ATTEMPTS.json)。

共享核心及原工作流回归通过 73 文件 / 1,664 项，1 项需显式 Python 环境的用例另行运行；原生 Session / candidate / domain 28 项通过、6 个默认付费用例跳过，实际付费桌面用例已单独通过。新增真实科研候选测试通过，原科研工具链 / Reviewer 架构 9 项、Python Harness² 55 项、八语言及原结果准入规则 786 项通过。Node / renderer 类型检查、backend / Electron 构建及 37 个变更 TypeScript 文件零警告检查通过。各组有重叠，不相加声称独立测试总数。

补充原 Notebook runtime、RPC 收尾、风险准入及 host 权限专项，4 文件 / 958 项通过，包含显式启用真实 Python 的停止与重开；2,749 个依赖另行配置 Python / R 风险环境的原可选矩阵用例跳过，不记为通过。

复现时先构建 backend 与 Electron，准备已有 Claude Code 及启用的 Python，明确隔离个人配置。离线命令：

```bash
OPEN_SCIENCE_E2E_ISOLATE_HOME=1 \
  node node_modules/@playwright/test/cli.js test \
  e2e/earthnano-notebook-optimization.spec.ts --workers=1
```

真实模型另设 `EARTHNANO_LIVE_DEEPSEEK=1`、`EARTHNANO_LIVE_DEEPSEEK_KEY_FILE` 和可选 `EARTHNANO_LIVE_NOTEBOOK_REPORT`。密钥仅由测试代理在内存读取，不保存到源码、应用设置或验收证据。模型 API 请求与 Core 执行次数分别统计。

## 能力边界与后续顺序

本轮支持一个完整原用户消息、1–10 个固定上传 / 产物输入及原启用的 Python。输入通过原版本租约和 Notebook staging，不受旧内嵌文本 64KB 上限约束。方法输出仍只导出有界 UTF8 报告（最多 64 文件、每个 1MiB、总共 4MiB）。原普通 Send 的文献、图像、PDF、R、远程 Compute、二进制产物及其他后端能力没有删除；这些尚未映射为科研候选配置。Notebook 模式暂不混用特殊消息上下文、领域后继任务、raw 文件或另选派生产物。

外部 Python 保留上游 partial 来源证据：固定输入附着、真实计算和 producer 已核对，不能据此声称完整文件访问跟踪或完整依赖环境复现。独立语义审阅使用同一模型的隔离上下文，不能等同多模型事实证明；配置 `eligible` 仍不是发布，也不代表跨任务改进已证实。

验收期间发现一次并发基线在模型调用前失败，原 SDK Session 已创建，但没有 prompt-start / Notebook / provider 记录；独立重跑通过，原因尚未确定。保留失败事实及后续诊断任务，不把重跑成功称为已修复。首次真实模型验收暴露了上述多 cell 测试假设（119 次 API）；第二次所有 17 次执行完成，产物通过，语义评分 92 / 85，系统正确阻止配置推广，但脚本错误地要求必须 `eligible`（114 次 API）。两次均计为未通过验收并记录消耗。修正测试后继续验证此前未执行的 producer 与重启断言，不以重跑挑选更有利的评分。

下一轮优先完善可诊断的前置失败记录与安全续跑，随后做配置跨任务验证、经验发布与回滚；再逐项扩展 R / Compute / 二进制产物等候选配置。并行整理候选 Session 分组和来源导航。Linux / Windows、签名安装包、独立发布运行时、费用核对与 EarthNano CI 继续单独验收。当前本机桌面使用 Electron 43.4.0 缓存，依赖声明 43.7.5 未修改。
