# 第九轮：科研流程验收、来源版本输入与 Harness² 能力覆盖

基于 PR #10 的 `9aeb742ca`，本轮继续叠加提交，不自动合并或升级固定上游。主智能体负责共同契约、桌面与真实模型验收，两个 `gpt-6.1-sol / high` 开发智能体分别核对原科研工具链和原优化方法，并在独立 worktree 提交。方法智能体另行只读检查产物输入的归属、冻结和生命周期。

## 一条连续的产品路径

`原项目 / Session → 上传 CSV → 原 Send / ExecutionCore → Claude Code → 原 Notebook MCP → 真实 Python → 原 Artifact MCP → 固定 ArtifactVersion → 用户显式选择来源版本 → 原 Harness² parallel(k=2) → 同一 Core → 匿名双候选选择 → 固定产物检查与独立 Review → 原项目导航重开`

桌面验收使用实际 renderer、preload、typed IPC、后台进程、原生 Claude Code、Notebook Python、SQLite 和原持久化 owner。离线模式只替换模型响应，真实模型模式将同样的原生请求转给 DeepSeek。脚本会实际关闭并重启 Electron，读取相同的 Session、产物和 Review，确认未重新调用模型。逻辑 mission 与 API 请求分别计量；SDK 后台标题调用属于真实请求，但不是另一次任务接纳。

这条代表性的 CSV 计算验证平台机制，没有把 EarthNano 限定为某个科研领域，也不能替代所有科研工作负载的验收。

## 修复的具体缺口

| 缺口                                        | 本轮实现                                                                                                                                                              | 验证                                                                                                                      |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 普通科研产物进入优化需要手动重新上传或复制  | 桌面可选择当前 Session 的原固定产物版本；main 用原 `ManagedFileVersionService.openVersion` 核对 Project / Session、版本、checksum 和实际字节，再冻结为现有文本输入    | 真实桌面科研产物直接进入两条原改进分支；外项目、外 Session、伪造版本、校验和、损坏、截断、无效 UTF8、大小与路径冲突均拒绝 |
| 来源版本与实验输入没有连续来源记录          | `input-artifacts.json` 关联原版本与各任务输入摘要；Core task snapshot 仍由原快照模块生成。runner 在分发前再次核对来源 checksum 与实际冻结输入，实验状态保留原版本身份 | 来源身份计入请求幂等 digest；改变版本不能复用旧请求键；后改 caller options 不改变已保存来源                               |
| 领域任务可能被 raw DTO 覆盖已解析来源文件   | manager 保留 main 准备的 domain；所有任务顺序冻结并核对同一来源，单任务错误须先关闭原版本租约再释放 Session / 数据根 writer                                           | 暂停并失败的版本读取测试核对 close 与 release 顺序，其他任务不会越过该 owner 继续读取                                     |
| 合法大产物在后续递归 / 组合时被融合层误拒绝 | TS / Python 私有传输统一有界证据包与逐帧限制，不再把全部 stdout 协议累计量当日志限额                                                                                  | 四个各 1MiB 固定产物完整通过原 seq 改进与组合；组合证据超过 12MiB，7 次 Core 接纳，无裁切或回退                           |
| 之前没有证明真实 Notebook 生产者到审阅的链  | 原生产工具链集成测试覆盖上传版本、Notebook MCP / RPC、真实 Python、Artifact MCP 发布、原 Reviewer command / MCP 与持久化                                              | 工作 CSV 和报告随后被改为 999，固定输入计算、原产物和重开的 Review 仍保持原结果                                           |

没有另写统计引擎、版本发布器、审阅存储或优化算法。普通 Send、Task API、Reviewer、委派与优化继续遵守上一轮同一 Core 的接纳、身份、取消确认和清理规则。桌面验收核对每个角色只有一次 Session admission 和 provider acceptance，候选不会重复落入普通 Send journal 或再次收费接纳。

## 对照两侧源码的结论

| 能力                                                               | 当前状态                                                             | 证据与边界                                                                                                                 |
| ------------------------------------------------------------------ | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| OpenScience 项目、会话、数据上传、Notebook、产物及溯源             | 原模块保留；本轮实际贯通 Python 科研流程                             | [OpenScience 源码覆盖](ROUND9_OPENSCIENCE.md)；Notebook / Artifact / Upload 目录与固定上游 tree 相同                       |
| 文献、Compute、Skills 和普通后端选择                               | 原源码与入口保留，完整 ACP 请求继续走原工作流                        | 没有把这些能力缩减为候选文本 DTO；本轮没有逐一运行所有文献、远程环境和后端                                                 |
| 原 Reviewer / fix-loop、停止和恢复                                 | 原 owner 与共同 Core；保留前轮专项回归，本轮补固定科研产物审阅和重开 | Review pass 与科学正确性分别理解；原证据不足时不能扩权读源版本                                                             |
| Harness² sequential / parallel、递归改进、组合与匿名选择           | 实际进入共同 Core，保留原方法规则                                    | [Harness² 模块覆盖](ROUND9_HARNESS2.md)；k1/2/3/8 与 LEGACY 的阶段、ledger、证据树和选中配置等价；真实桌面运行 k2 parallel |
| 原任务流、反思与 Library                                           | 实验内已接通；本轮新增四任务前缀和大 Library 完整性验证              | 继承第七、八轮真实领域联调；本轮单任务桌面验收不声称新增了真实四任务经验迁移证明                                           |
| 原 runmark / cache resume、sweep / seed、benchmark / substrate CLI | 原源码保留；没有全部变成桌面共同运行服务的能力                       | Port 方法要求新 workRoot，暂不自动付费重放。安全实验续跑和更广 profile 仍是明确待办                                        |

本轮没有发现需要删减原 Notebook、Artifact、Upload、文献、Compute 或 Skills 的理由。源码保留、共同核心接通、测试覆盖和科研质量是四种不同结论；详细清单逐项标注，不能合并成“全部已验证”。

## 验证与限制

具体结果见 [汇总](ROUND9_VALIDATION.json)、[离线桌面](ROUND9_OFFLINE_DESKTOP.json) 和 [DeepSeek 桌面](ROUND9_DEEPSEEK.json)。

最终默认回归为 69 文件 / 1,579 项，新增原科研工具链与 Reviewer 架构共 9 项，原生 Session / candidate / domain 28 项通过、6 个付费用例默认跳过；Python 全部 53 项通过。另行显式执行的真实桌面 DeepSeek 用例通过，因此不以默认 skip 代替真实验证。离线桌面 17/20 次优化执行、40 次模拟模型请求；真实桌面 18/20 次优化执行、70 次真实模型请求（包含 1 次 SDK 后台标题调用），原 `dom1` 提案校正多消耗一次接纳。选择在两项 finals 间实际调用模型完成，没有选择回退。基线和最终候选的独立语义分均为 100，固定 JSON 检查通过，未证明优化收益。真实模型只使用用户授权的本地密钥文件；密钥不写入源码、证据或日志。测试代理明确区分健康探测、可选 token-count 探测与有预算的模型请求，不伪造 token 估算或模型输出。

受控产物输入仍采用原文本 profile：最多 32 文件、单个 64KB、总共 128KB；UTF8 字节与 BOM 均保留。二进制、大文件、Notebook / 远程 Compute 等候选工具表面没有因此自动开放。普通科研流程仍可使用原工具，不被此 profile 限制。

语义评估使用同一 DeepSeek 模型的独立上下文，确定性 JSON 检查独立核对数值。`completed`、产物 `passed`、配置 `eligible` 与发布分别记录，没有证明配置推广、跨任务收益或科研结论普适有效。外部 Python 的原来源证据可能为 partial，固定版本不等于完整环境复现证明。

本机 Electron 验收使用已有 43.4.0 缓存，未修改应用依赖的 43.7.5 声明。Linux / Windows、签名安装包和发布运行时仍需另行验证。原项目导航可以重开源 Session；内部候选 Session 保留可检查性，会占用首页最近记录，需要后续改善实验分组展示。

复现原生桌面测试必须显式设置 `OPEN_SCIENCE_E2E_ISOLATE_HOME=1`，准备已有的受支持 Claude Code 和 Python，不会自动安装或使用个人 Claude 配置。真实模型再显式设置 `EARTHNANO_LIVE_DEEPSEEK=1`、`EARTHNANO_LIVE_DEEPSEEK_KEY_FILE` 和可选报告路径 `EARTHNANO_LIVE_RESEARCH_REPORT`。默认离线、明确隔离的命令为：

```bash
OPEN_SCIENCE_E2E_ISOLATE_HOME=1 \
  node node_modules/@playwright/test/cli.js test \
  e2e/earthnano-research-workflow.spec.ts --workers=1
```
