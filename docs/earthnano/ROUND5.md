# 第五轮：桌面任务入口与独立语义评估

当前 Session 可显式启动受限文本任务的优化，查看阶段、执行次数预算与结果，发起停止，并打开原 Session 和 Review。运行继续使用原 Harness² 方法与共同 ExecutionCore。独立评估在配置选择完成后进行，不把验收标准或评估结果反馈给优化过程。

本轮仍保留 OpenScience 普通 Send 的既有执行行为。新增的是实际接入桌面命令链的“优化任务”操作；尚未默认自动优化所有普通科研对话。

## 模块和调用关系

| 模块 | 责任 |
| --- | --- |
| `src/renderer/src/pages/workspace/TaskOptimizationPanel.tsx` | 当前 Session 的任务说明、文本附件、逐行验收标准、执行上限、进度轮询、停止及结果导航；会话切换隔离、加载完成门禁、错误 Notice 和八种翻译 |
| `src/shared/earthnano/desktop-optimization.ts` / `renderer-contracts/optimization.ts` | start/get/latest/stop、进度与评估摘要的共同类型，以及桌面预载接口 |
| `src/main/host-application-commands.ts` / `application-command-composition.ts` | 把四个方法注册到真实桌面 Node 后端 dispatcher 与 native inventory；拒绝 Web caller |
| `src/main/earthnano/desktop-optimization-ipc.ts` | 现代命令与兼容 IPC 共用的 DTO 白名单和脱敏调用；兼容 IPC 同时检查顶层 frame 与当前授权 |
| `src/main/composition/desktop-optimization.ts` | 构造唯一 manager，接原 Archive/Session/data-root writer 生命周期；明确解析选定的 Claude custom Messages provider、固定 CLI 与 Python；不修改宿主 Claude 配置 |
| `src/main/earthnano/desktop-optimization-manager.ts` | 显式任务准入、请求幂等、持久化进度投影、每项目活动栅栏、Stop 与退出/更新门禁；重启读取状态不重放模型调用 |
| `src/main/earthnano/run-persistent-optimization.ts` | 在优化前复制输入、冻结独立标准及摘要；投影共同 journal，统一总 deadline，优化结束后进行独立评估 |
| `src/main/earthnano/semantic-evaluation.ts` | 对 baseline 和 method.chosenArtifacts 精确对应的最终候选各创建一次 reviewer execution；受同一 ExecutionCore/budgetRef 管理 |
| `src/main/earthnano/persistent-candidate-owner.ts` | 在原目标 Session 创建独立语义 Review、固定 scope 和证据；保留原完整性 Review，二次核验评估文档与目标版本 |
| `electron-builder.yml` | 将 Harness² Python/JSON 源码与许可证放在 asar 外可读取的资源目录；不代表安装包已验收 |

实际路径：任务面板 → typed preload → 桌面命令派发 → Node application command owner → manager → 原 Harness² → ExecutionCore → Claude/ACP 与原持久化 owner → 独立评估 → 原 Review。Node 后端虽然以 headless 模式构建 application modules，也必须构造优化 owner；访问权限由可信 caller 检查控制。

## 进度、预算和停止

默认 12 次执行，允许用户设置 9–20 次；两个独立评估也计数，原方法的合法提案重试逐次扣减。预算不足时拒绝下一次接纳，不自动加预算。此数值是执行接纳次数，单次执行可能包含多个模型 API 请求，不是 token 或金额上限。

状态来自共同 execution journal 的提交事实，桌面文件只保存请求摘要与进度投影。请求重复点击不会重复提交；相同 requestKey 更改输入会冲突。源码进程重启后，未终结记录显示 interrupted，不自动继续付费调用。执行文件位于当前 dataRoot；进度元数据位于 configRoot，启动扫描不重建丢失的数据目录。

Stop 先进入 stopping，阻止新阶段接纳，取消原运行并等待实际清理。独立 Review 提交是副作用临界区：停止必须等待事务提交或标记错误的收尾完成，不能用 Promise.race 提前宣告终结。无法确认清理时保留 journal 栅栏与数据/会话 lease，显示 interrupted，后续须显式核对。退出、更新和数据搬迁遵守同一活动门禁。总 deadline 覆盖优化和两次评估，清理仍需等待。

## 独立语义评估

任务提交时就固定 1–16 条标准，保存 `assessment-plan.json` 及摘要。该文件不传入 Python 方法配置。评估器使用单独中性 Harness、Session 和上下文；仅得到冻结原任务、输入及指定版本产物，不接收候选身份、配置、执行轨迹、其他候选或其他 Review。

每份 `assessment.json` 必须覆盖每条标准，包含 0–100 整数分数、结论、理由和证据。每条引用的路径、ArtifactReference、摘要及原文片段必须与给定固定文件一致；不能把输入/标准文件冒充目标产物引用，不能用“模型说通过”替代校验。所有检查都通过时才允许 pass，否则 flagged；非法结构或证据直接失败，不自动修复或重试评估。

评估文档本身冻结成 ArtifactVersion，并在目标 Session 的 ReviewRepository 中独立保存 scope、模型、标准摘要、评估 execution/版本引用与完整文档。遵守原最多五条 Finding 的限制，用一条汇总 Finding 锚定固定版本，逐项证据保留在固定文档与 provenance log；warn 不被升级为 fail。基线与候选均用相同配置模型的独立会话评估，不能称为多模型盲审或科学事实证明。

## 实际验证

| 层次 | 结果和限制 |
| --- | --- |
| 核心及原有执行回归 | 31 文件 941 项通过；后续停止/总 deadline/预算输入门禁另有针对性回归 |
| 原桌面对话、组件、预载、provider、i18n | 第一轮整合 8 文件 1233 项通过；真实派发修复及最终小改后另跑相关套件，详见机器报告 |
| 生命周期/应用接线 | 4 文件 57 项通过；首次发现旧 mock 缺少新 owner，已补明确所有权断言 |
| 原生进程及真实 SQLite | 3 文件 6 项通过，2 个付费用例默认跳过；包含七阶段、九次执行与双评估、重开固定证据，以及真实 native 基线等待中 Stop 后不启动后续阶段 |
| 真实 Chrome | 4 项组件协议测试通过，覆盖 1100/390 宽度、开始/轮询/停止、结果/Review 导航、会话切换与错误；后端为协议夹具 |
| 真实 Electron 43.7.5 | 隔离 HOME/config/data 冒烟 1 项通过（8.7 秒）；离线 fake ACP 普通对话、新面板、真实预载/Node dispatcher，以及不支持的路由在调用模型前拒绝、已用预算 0。此项不宣称桌面中跑完付费优化 |
| 构建与资源 | Node backend、Electron main/preload/renderer 构建和原 Node runtime staging 通过；按资源过滤器复制后 Python 入口 `--help` 可运行。未制作签名安装包 |
| DeepSeek Flash | 完整执行 manager→原方法→两次评估与真实数据库验证通过；请求经过有界观察代理，并非由 Electron 点击触发 |

真实 Electron 首次运行确实发现了只读审查/mock IPC 没发现的缺口：新 owner 没有在 Node 后端构造、命令不在 native inventory。修复并重跑后才记录上述通过结果。

DeepSeek 共尝试三次。第一次评估引用输入文件为目标版本，被严格校验拒绝；第二次在 10 次接纳后失败，初始测试清理未保留底层原因，不推断原因或 token 总数。补充引用规则、失败诊断及重试预算余量后，第三次通过：10 个 execution/Session（含一次原方法提案重试、两次 reviewer）、13 个产物版本、12 条 Review；四个 solver 有匹配 Read 工具结果，固定版本与审阅重开验证通过，无方法 fallback。

基线和候选均评为 100 分，该样例没有改善证据。成功的第三次用时约 55.71 秒，转发 34 次 API 请求，本地拒绝 10 次请求未转发；provider 报告未缓存输入 64,387、缓存读取 147,712、输出 8,263 token。仅这是成功尝试的统计，不能当三次总账单。测试关闭 thinking、max_tokens 限 1536、最多 48 次转发与 12 次执行；密钥未进入仓库。

详见 [验证记录](ROUND5_VALIDATION.json)、[真实调用摘要与失败记录](ROUND5_DEEPSEEK_VALIDATION.json) 和 [Luna 独立进度评估](ROUND5_PROGRESS_ASSESSMENT.md)。付费测试仍要求显式环境变量开启，日常回归不会调用 DeepSeek。

## 使用边界与后续

当前使用 Claude Code 2.1.232、显式 custom Messages API provider、Python 3.11+，执行前解析并固定 Python 绝对路径。实测 Darwin arm64；Linux 尚未实测，Windows 和 Web 隐藏入口。初始桌面 profile 为小型文本任务：最多 32 文件，单个 64,000 字节、总计 128,000 字节，避免接受超出方法证据包限制的附件；沿用受限纯文本 Harness/Skills 与目录/进程隔离，非 OS 沙箱。

下一步是多任务及保留任务集上的独立比较、可核对的 token/费用记录、未知清理的恢复操作，再扩展科学数据引用/工具、配置推广与经验库。默认自动触发、Library 反思、跨平台与签名打包、全量 npm test 和 CI 启用尚未完成。GitHub Actions 保持关闭，PR 不自动合并。
