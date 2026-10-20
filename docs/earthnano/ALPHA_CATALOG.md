# Alpha catalog：统一新建入口、原任务流与独立 Notebook 来源

本轮在 PR #15 的原 sweep-v2 上补齐桌面 catalog：所有新建单任务、多任务以及单/双模式实验均走同一 `startSweep → run_sweep → ExecutionCore`，保留旧实验的读取、停止和显式恢复。没有新增第二套 task-stream 或评分规则。完整 Alpha 仍以 [共同契约](ALPHA_CONTRACT.md) 为准。

## 模块与调用

`TaskOptimizationPanel` 维护每项任务自己的输入、验收条件和确定性检查；`OptimizationCatalogSource` 复用原 Session list/loadOne、活动会话分支和支持消息判断。Notebook 任务选择原来源 Session/prompt；文本任务保留原方式，并可显式复制当前文本输入，复制后各项独立。

`previewSweep` 的公共契约只接受 project/navigation Session、catalog 身份和 sweep 控制。Main 经过原导航授权、data-root/Session 生命周期租约，调用固定 Python `earthnano_sweep --preview → task_stream`。原模块决定 seed（包括 0）、filter、每域任务上限和顺序；UI 不重算原算法。预览不创建 Core、provider 或候选，不读取/冻结选中任务文件，但原导航授权内部仍可能读取 Session JSON。空选集只读展示且不能启动。

UI 以当前草稿绑定预览。`StartDesktopSweep.previewPlanDigest` 是兼容旧请求的可选字段；本轮 UI 总是提交。Main 重新计算原计划，摘要不符在逐任务来源读取/冻结之前拒绝；摘要保留原 `sha256:` 前缀。预览只绑定计划，启动时仍重复真实来源授权和版本冻结。改动草稿、Session 或运行参数会使旧预览失效；失败后的相同请求可保留原 requestKey，不能把编辑后的请求冒充原重试。

`resolveDesktopSweepTask → resolveOptimizationNotebookInputs` 分别授权每个来源，核对活动分支中原 prompt 的身份、原 ManagedFileVersion 租约、内容大小/摘要及该 Session 自己启用的 Python binding。基线与候选消费同一个该任务快照；不同任务不会继承导航 Session 的输入或 runtime。原 Notebook RPC、权限、不可变输入、Run producer、ArtifactVersion、Review 和停止/恢复继续作为事实来源。

manager 在异步授权前登记 preview，和 start/resume 队列分开；Stop 仍可用。关停/更新会取消预览并等待实际 Python 进程收尾才释放租约。IPC 保留原 top-frame caller 检查、字段白名单和错误隐去，Web 明确不开放新 API。8 个非英语 locale 及原 i18n guard 一并更新。

## 上游原故障对照与最小修复

两来源并发的离线桌面验收发现：一个候选的 Notebook token 无效，另一个候选计算正确，却得到归于前者 Session 的 fileEvidence，原 Artifact owner 拒绝发布。任务 task/scope、Core execution/Session 和输入快照仍独立。该失败没有保留临时 MCP alias 原值，不能声称直接捕获了碰撞 alias。

对照固定 OpenScience `9e18c7d3c143a9dba49c7a586ad6cac8096f6dd5`，原 owner 与 RPC 文件和失败提交 `30e5c784b1efc426896bb2af627a5576a0c1bed6` 完全相同。原 `createRoutingIds` 使用毫秒时间和实例内计数；多个独立 owner 同毫秒首启会生成相同临时身份。真实 loopback RPC 的确定性原/修复控制复现 token 撤销与错误 canonical 路由，并证明修复后的独立性；单 owner 和稳定 Session ID 两个反事实保留原行为。详见 [原源码控制及限制](ALPHA_ORIGINAL_SESSION_ALIAS_CONTROL.md)。

修复在原 `AcpSessionCapabilityOwner` 内为每实例加入私有 UUID；六类临时路由继续使用原前缀/计数。稳定 Session ID、原 token/alias 注册与释放、commit/handover 和授权不改。原 owner、交接和 runtime coordinator 共 322 项通过；真实 kernel/Artifact 另由桌面验收证明。没有改写 Harness 调度、Library 或缓存规则，也未用串行化候选或放宽 producer 检查回避问题。

## 验证记录

所有尝试、最终报告、journal、失败日志和源码对照见 `validation/alpha/catalog/manifest.json`；gzip 保留原字节及原始 SHA-256。密钥未进入仓库，原始测试数据均为隔离 fixture 的公开算术样本。

| 检查                                                       | 结果及边界                                                                                                                                                                                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 集成契约、Main/IPC/manager/host/preload/source、UI/i18n 等 | 21 文件 1177 项通过；后续 UI 小改后 46 panel + 777 i18n 通过（集合有重叠，不相加）                                                                                                                                       |
| Node/Web 类型、ESLint、consumer inventory、构建            | Node/Web 类型、35 个变更代码文件 ESLint、consumer inventory、后端/桌面构建均通过；app 构建保留原警告，不等于全平台发布通过                                                                                               |
| 原 Python 同环境对照                                       | Python 3.12.13 arm64；固定原树 5/5、vendor 72/72；原测试身份保留，无失败/跳过；源码 receipt 为 ff663a4c37eb6652809f4cead3d07842efd50c0e，之后 Python 树未改                                                              |
| 浏览器尝试 1                                               | 原锁定 Playwright 的 Chromium 1234 未装，7 项启动前失败；核对原 lock 的版本/来源/integrity 相同后用原 CLI 安装，无依赖/锁文件修改                                                                                        |
| 浏览器尝试 2                                               | 4 通过/3 失败：新增预览 status 与旧进度 status 的测试定位冲突；为原进度增加明确 testid，保留断言                                                                                                                         |
| 浏览器尝试 3                                               | 7/7 通过，覆盖 390/1100px 原布局/滚动/停止/结果/来源导航；fixture 不作为原算法证明                                                                                                                                       |
| 原生离线尝试 1，65ac12aa0                                  | 两项在优化前因新 E2E 字段名称定位错误失败；仅修 E2E 两处 locator，生产树未改                                                                                                                                             |
| 原生离线尝试 2，30e5c784b                                  | 单任务 v2 parallel k2 通过（20/24 接纳）；两来源 dual-mode k1 失败（28/48 接纳），触发上述原 owner 对照与修复；均零真实上游请求                                                                                          |
| 原生离线尝试 3，a13ccfd44                                  | 两项通过，2.9 分钟：单任务 k2 为 20/24 接纳、57 本地模型请求；两来源双 mode k1 为 37/48 接纳、109 本地模型请求，零拒绝、零上游请求                                                                                       |
| DeepSeek                                                   | 首次实测通过，8.0 分钟；40/48 次接纳，210 本地 / 209 上游模型请求，零拒绝，1 转发前暂停、1 上游取消、用量 incompleteRequests=1；两份基线均100，parallel候选均100、sequential候选均95；6 个独立 Reviewer 通过，不证明收益 |

最终原生构建来源为干净 `a13ccfd44f2fc223c1434a7dbb0b05e4b4450c63`。之后实测 source head 为干净 `bedb1da41bae64a7a2a36d801640d54bf75bbe1b`，仅加入原/修复控制脚本、说明和证据，生产与 E2E 源码字节不变。两次验收的四个构建入口 SHA 完全相同，`source-and-checks.json` 保留源码范围及对照。报告保留各次实际 HEAD、dirty 和入口摘要，不混称一个提交。测试 runner 为 Node26.0.0，Electron43.7.5、Claude Code2.1.232、Python3.12.13；不代表各打包平台的 runtime。

生产用量覆盖优化根执行 38/40：input700219、cache2587136、output85737、modelTurns283；API 和美元仍未知。测试代理另观测 input792376、cacheRead2940672、output87063，包含普通任务及不完整取消，不能和生产小计相加或当作完整费用账本。

两来源用同名 CSV 的不同版本，A 为 3/12/4、B 为 2/30/15（count/sum/mean）。验收核对每任务内基线/候选同 task/environment refs、不同任务的固定输入、实际 Notebook Run 与同 Session 原 producer、6 个独立 Reviewer（每任务跨 mode 仅共享基线评审），停止前 journal 与完成事件不变，以及重开后零模型重放。确定性检查和独立审阅使用各任务自身数据。k1 原本是 trivial 单候选，无 selector Session；单任务 k2 的原匿名选择另行验收。不能宣称两任务双 mode k2 已做原生实测，也不能用算术样本或相同满分证明科研普遍正确或优化收益。

## PR 和剩余范围

PR #13 → #14 → #15 尚待托管验证和审查。PR15 精确 head `1d6df496d70d579e01d3bf1e7e7cf0a4c92d3a33` 的 Actions 为失败/跳过；GitHub 在前次原始 annotation 明确表示账户付款/支出限额，相关 job 没有 runner 和步骤。本轮核对最终状态，不把这种运行记作源码测试通过，也不绕过它合并。

本轮 PR 以 PR15 为 base。完整 Alpha 还需 R、Compute、二进制原字节及评估覆盖；跨任务验证与显式采用/回滚；可靠证据触发的可选自动优化；实际 API/费用/耗时事实；实验分组、后端/CLI 可达性及全平台原包/安装/升级/发布。继续沿原 owner、原方法和原验证模块实施。
