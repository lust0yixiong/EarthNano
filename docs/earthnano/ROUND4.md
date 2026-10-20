# 第四轮：持久化执行与最小优化闭环

本轮保留原有桌面路径，新增可由宿主显式调用的 `runPersistentOptimization`。普通基线、候选、提案与组合都进入同一个 ExecutionCore，并使用 OpenScience 原有 Session、产物版本和 Review 数据 owner。两个 gpt-6.1-sol / high 子智能体分别负责 OpenScience 持久化与 Harness² 方法绑定，主智能体负责统一调用、集成和真实验证。

## 模块与调用关系

| 模块 | 实现与边界 |
| --- | --- |
| `src/main/earthnano/run-persistent-optimization.ts` | 组合快照、共享核心、Claude driver、持久化 owner 与 Python 子进程；统一执行次数预算、超时、取消与最终持久化核验 |
| `src/main/earthnano/persistent-candidate-owner.ts` | 复用 SessionPersistenceCoordinator / RuntimeSessionOwner、ArtifactTurnOwner、ManagedFileVersionService 和 ReviewRepository；保存真实 Session、固定版本与审阅 scope |
| `src/main/earthnano/harness-optimization.ts` | 可信请求工厂与私有 JSONL transport；固定研究任务，按角色冻结调用；仅接受本工厂的请求和本轮执行 ID；结果必须通过版本引用与字节摘要验证 |
| `vendor/harness2/harness2/core/earthnano_binding.py` | 接回 PortMethodExecution；读取平台固定版本导出，转换为原方法需要的只读轨迹及候选配置文件 |
| `vendor/harness2/harness2/earthnano.py` | 配置驱动入口，调用原版 schedule.run_task 的 k=1、seq 方法；不复制另写优化算法 |
| `vendor/harness2/harness2/core/prompts.py` | 新增受限 claude-text profile；既有 profile 保持原语义 |

调用链：宿主 → runPersistentOptimization → Python 原版 schedule/recursion → JSONL → 可信请求工厂 → ExecutionCore → Claude candidate driver → 原 ACP/runtime 与持久化 owner → 固定版本结果 → 原方法下一阶段。

宿主须先初始化与 ownerOptions.dataRoot 相同的应用数据根、迁移数据库并提供现有 projectId；workRoot 必须是新的绝对路径。提供显式 Claude executable/provider binding，不从用户订阅或当前模型猜测凭证。入口尚未接到默认桌面按钮或自动触发器。

## 本轮方法与证据

一次闭环为基线、INV/DOM 两个提案、两个候选试跑、组合、最终候选，共 7 次执行；原方法账本为 R=4/P=3。k=1 使用原方法的平凡选择，没有额外 LLM 选择或 Library 反思。配置指令/纯文本 Skills 可变化，任务快照、模型和环境绑定保持固定。只读证据 JSON 的 @ 与反引号采用可还原 unicode 转义，避免 native 文本预展开；可执行指令仍沿用严格限制。

每个输出冻结为原生 ArtifactVersion，版本名可逆记录相对路径；读取验证固定 versionId 与内容摘要，不读取后续工作目录或 latest。Session turn 与 Review 均有固定引用和摘要；发生修改时拒绝冒充原证据。所有执行都必须 cleanup confirmed，最终完整性 Review 必须 complete/pass。失败、停止和未知清理不自动重放付费请求；未确认清理保留单写锁，须显式核对后恢复。

Review 当前执行确定性的摘要、UTF-8 与 JSON 检查，写入真实 ReviewRepository 和 scopeSnapshot；不是语义科研 Reviewer。其验收结果不反馈给优化模型。原 Harness 方法仍可能有其合法回退，验证明确要求此次 configurationChanged=true 且 fallbackStages=[]。

## 实际验证

- 原生 Claude Code 2.1.232、ACP/runtime、真实迁移 SQLite、本地确定性 provider 完成全部七阶段；数据库重新打开后能读取原执行、产物版本和审阅。
- DeepSeek Flash 实际完成同样七阶段：7 个 Session、8 个产物版本、7 条审阅；4 个 solver 均通过匹配 Read tool_use_id / 非错误 tool_result 证明读取真实 CSV，输出 count=3、sum=6；配置改变、无回退、重新打开数据库验证通过。
- 真实测试转发 21 次模型请求，7 次请求被本地观察代理拒绝且未转发。服务端报告 token：未缓存输入 45,732、缓存读取 87,296、输出 5,175；未按价格推算账单。测试约 39.60 秒（含启动/校验）。
- 测试限定最多 10 次执行、32 次转发请求、单次执行 120 秒、闭环 480 秒；观察代理关闭 thinking、将 max_tokens 限为 1536。密钥只在本地代理内存中使用；未提交密钥或原始模型响应。
- 主回归 29 文件 910 项通过；原生进程回归 2 文件 3 项通过；本地七阶段 1 项和 DeepSeek 1 项分别通过。额外既有 owner 回归 5 文件 165 项通过（其中 93 项与主回归重叠，不累计声称独立总数）。Python 33 项通过；Node 类型检查、共享契约生成检查、六个新增 TS 文件 lint/格式检查通过。

详见 [机器可读验证](ROUND4_VALIDATION.json) 与 [真实调用摘要](ROUND4_DEEPSEEK_VALIDATION.json)。真实测试需显式设置 EARTHNANO_LIVE_DEEPSEEK=1、EARTHNANO_LIVE_DEEPSEEK_KEY_FILE 和可选报告路径，默认跳过；默认回归不产生付费模型调用。

## 尚未验证及后续

此结果证明配置改进闭环与持久化链路可运行，不证明科研质量提升。当前仍是文本、受限工具、目录/进程隔离 profile，非操作系统沙箱。未验证 Linux/Windows、全量 Electron 启动、打包、默认桌面集成或完整科研工具集。编译配置的 attestation 不被自动提升为已验证；此次实测证据只覆盖指定任务/profile。

下一步将入口连接到桌面任务的明确触发点，展示进度/预算/停止和原有产物审阅；增加独立语义验收与多任务基线，再扩展工具与配置发布。自动恢复必须先解决 unknown cleanup 的人工核对及去重语义。GitHub Actions 保持关闭，PR 不自动合并。
