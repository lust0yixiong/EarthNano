# EarthNano 0.1-Alpha 集成记录（验收进行中）

本分支延续第十轮 Notebook 深度融合，当前版本号为 `0.1.0-alpha.1`，尚未完成 Alpha 验收或发布。最终完成标准仍为 [ALPHA_CONTRACT.md](ALPHA_CONTRACT.md)，不能用本批已经完成的子集替代。

## 基线与已有 PR

- PR #12 的精确审查 head 为 `129a1f70fd834d7c29e7dae025d38af825092a54`。GitHub Codex 审查完成，无发现；既有验证范围见第十轮记录。
- PR #12 已合并到 `main`，合并提交 `2dee9be129bd6d66dae558bb94bc6e97d15400d7`。
- 固定上游及许可证继续以 `UPSTREAMS.json` 为准，没有升级上游版本。测试失败先检查原实现和原断言。

## 本批已实现的边界

1. 独立语义评估从原 ManagedFileVersion 租约读取源内容，核对身份、完整字节及摘要。基线和候选使用同一份源证据；不可表示的二进制或超限内容明确标记不可用。证据不反馈到优化方法或经验库。
2. 原 Harness² schedule/runmark/Library 支持显式续跑。缓存要求原任务、配置、模型、环境、源版本、方法源码与预算一致。完成阶段复用原执行、版本和 Review；没有自动重开付费任务。
3. 桌面恢复操作只接收原 Project/Session/实验三个标识。宿主从私有清单恢复原任务，重新授权当前配置，使用原剩余预算；`desktop.json` 不增加任务原文。预 Alpha 缺少清单的实验仍可查看，不能自动重放。
4. 原资源 owner 实际确认 ACP 与 Notebook 关闭后持久化精确凭证。显式宿主核对只确认资源收尾，保留失败/中断历史与原预算，不派发模型、不退款、不把历史失败提升为完成。凭证落盘前崩溃仍隔离；此能力不等于任意冷启动孤儿进程恢复。
5. 图标使用白底、保留原旋涡主体，提供 1024px master、Icon Composer catalog、ICNS/ICO 和小尺寸检查图。原托盘保持其专用资产。实际 catalog 编译和安装包观察仍待原生 CI。
6. 安装包显示及文件名使用 EarthNano，Alpha 更新配置与上游 stable CDN 分离。原 appId、协议、命令和存储标识保留。Alpha feed 尚未发布；仓库当前访问权限也限制匿名更新发现，不能声称更新服务已上线。
7. 独立 CI 同时执行固定上游与融合源码，记录失败/跳过并阻止新增回归；原生 lane 使用原构建和启动/资源检查。37 个继承的仓库 workflow 已显式停用，新 CI 不包含自动发布、签名凭证或付费模型密钥。

## 本机验证和未通过项

| 验证                                            | 当前证据                                                                                                                                       |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 桌面控制、IPC/preload、组件及八语言             | 六文件 956 项通过。真实路由漏注册 resume 已修复，并新增真实 command composition 分发与越权/替换预算拒绝检查。                                  |
| 版本、原更新 helpers/manifest、八语言及命令路由 | 五文件 857 项通过；保留原 Nightly 哈希不可排序规则，新增编号 Alpha/Beta/RC 比较。                                                              |
| CI、原 metadata smoke、builder/icon/版本配置    | 五文件 56 项通过。恢复原 Icon Composer 选择，白底配置和旧 ICNS 格式均保留检查。                                                                |
| 恢复、Core/store、driver 和真实进程资源凭证     | 七文件 82 项通过，包含真实 writer 和子进程关闭后的中断窗口；仍需整体验收。                                                                     |
| 类型与接口生成物                                | Node/Web 类型检查和派生接口检查通过；不是完整科研 E2E 的替代。                                                                                 |
| 本机 Harness 上游对照                           | 同一 Python 3.12.13：固定原树 5 项、当时集成 55 项均通过，无跳过；新增恢复实现另有专项验证，最终 CI 将重新执行全量。                           |
| 图标/原生环境                                   | 本机已核对实际 Electron 43.7.5；没有完整 Xcode/actool，不能声明本机完成 catalog 编译。                                                         |
| 完整桌面 Notebook 停止/重开/续跑                | 离线完整链通过：19/24 次接纳、57 个本地请求、8 次真实科研 Notebook；原完成 journal 不变、重开零调用。真实模型验收仍未通过。                    |
| 本批 DeepSeek                                   | 三次付费尝试均按失败保留：第一次旧代理拒绝计数失败；第二次原产物最终化冲突已修复；第三次合法仅回复选择结果被融合层额外文件要求阻断，正在修复。 |
| 跨平台包                                        | 独立 CI 已实际启动；原 Windows Notebook runtime 构建仍在进行，四个平台包尚无完成结果。未计为通过。                                             |

此前的离线失败尝试均保留，不作为通过重跑删除：

- 首次 PATH 选到 Python 3.9：优化在接纳前因需要 Python ≥3.11 被拒绝，零优化执行；已改用显式 Python 3.12 环境。
- 桌面 resume 命令漏注册：已复现、修复并补回归。
- 并行任务曾报告 `Runtime Session turn is unknown or superseded`：已确定为候选私有 authority 与应用原 authority 分离导致活跃接纳被原重启调和逻辑清除。现复用原应用 Session repository/coordinator，注册实际 runtime 的存活探针；保留原接纳/重启语义。确定性回归及同环境原上游 controls 通过，见 `ALPHA_SESSION_ADMISSION.md`。
- 恢复后的 method 严格缓存曾拒绝原请求：已确定私有 managed-inputs JSON 键序改变字节与 invocationRef。仅固定私有 adapter 的序列化顺序，原 schedule 严格缓存规则不变。版本、摘要或数组顺序实际变化仍拒绝，见 `ALPHA_METHOD_RESUME.md`。
- 最新 DeepSeek 普通任务失败为原 `ArtifactFinalizationProofError / version-message-conflict`：产物已关联另一消息。已在固定上游确定性重现同一窗口：兼容 marker 产生后、最终运行消息 flush 前，hydration 把唯一前置消息误认为最终归属。最小修复仅阻止同一 active prompt 的无 claim 推断，原 proof/finalizer 不改；相同六场景上游 1 失败 / 5 通过，修复后六场景与原 237 项共 243 通过，见 [原路径对照](ALPHA_ARTIFACT_FINALIZATION.md)。真实模型复验仍待完成，历史数据库缺失不补造。

三次付费尝试和离线通过报告已逐字节保存在 [validation/alpha](validation/alpha/README.md)，包含 SHA-256、用量观测、缺失证据和失败归因边界。旧代理不能区分主动停止与异常上游拒绝；现已补真实 HTTP 控制测试，只有自身取消且客户端已断开的请求才单列取消，异常拒绝仍失败。该修复不能追认第一次失败为通过。

完整本机诊断位于 `/tmp/earthnano-alpha-*`。第二次失败在优化目录创建前发生，旧 finally 的目录异常使 Session 转储被跳过，普通 Core journal 也未导出；此历史缺口明确保留。现已提前注册诊断，拆分普通 journal、优化 journal 和原 Session 的独立保存路径。早期报告没有记录精确源 head，不能作为发布提交验收；最终 PR 和发布需补固定提交的持久结果。
