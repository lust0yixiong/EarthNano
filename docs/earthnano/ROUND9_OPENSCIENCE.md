# 第九轮：OpenScience 科研流程保留与原生离线验收

本审计以 `UPSTREAMS.json` 固定的 OpenScience `9e18c7d3c143a9dba49c7a586ad6cac8096f6dd5` 为上游，以 EarthNano `9aeb742cab7d5dbce94fca94c33279cd6659f89a` 为本轮起点。本文件记录新增持久化链验收；桌面 Electron、原生模型进程及优化流程由本轮独立验收记录负责，不能用本测试替代。

## 保留证据与缺口

第八轮普通执行验证通过 `ArtifactTurnOwner` 夹具桥接产物，尚未证明 Notebook 输入、运行时绑定、Python 计算、MCP 发布和固定 producer 的连续链。本轮补齐该验收缺口，未发现需要另写 Notebook、Artifact 或 Review 发布逻辑的融合缺陷。

以下目录在固定上游与本轮起点具有完全相同的 Git tree：

| 原模块               | 两侧相同 tree ID                           |
| -------------------- | ------------------------------------------ |
| `src/main/notebook`  | `1004bae752b781ba0d2bedb7f95e1fd817e4c0c7` |
| `src/main/artifacts` | `0a8bd955319b1777f22415b3e52033ff8fa58636` |
| `src/main/uploads`   | `b0fc1beec5584687030c9c57c715dd01466613dc` |

同一范围内，`src/main/literature`、`src/main/compute`、`src/main/skills` 相对固定上游没有文件变化。`src/main/reviewer` 的差异集中在 assessment / fix-loop owner、facade、IPC 及相关测试，用于共同 Core admission、可信父归属、原提交／处置屏障和 headless 等待。目录相同只证明源码保留，不等于所有科研功能都已运行验收。

## 新增验收的实际调用链

测试为 [research-workflow.integration.test.ts](../../src/main/earthnano/research-workflow.integration.test.ts)，装配为 [research-workflow.test-fixture.ts](../../src/main/earthnano/research-workflow.test-fixture.ts)。科学操作直接复用已存在的 [research-analysis.mjs](../../e2e/fixtures/research-analysis.mjs)，没有复制另一份统计或产物发布算法。

| 用户流程                | 本测试实际复用的原能力                                                                                                 | 核验内容                                                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 上传 CSV 并作为本轮输入 | `UploadRepository`、`ManagedFileVersionService`、`ImmutableInputAuthority`、`NotebookInputRegistry`                    | 固定 UploadVersion 进入 prompt 输入和 Notebook run；随后把 workspace 源 CSV 改为 999，实际计算仍为 3 个样本、均值 4.00                        |
| 发现、绑定并运行 Python | 原 Notebook MCP、`NotebookLocalRpcServer`、`NotebookRuntimeService`、运行时设置及发现                                  | MCP `list_notebook_runtimes` → `notebook_bind_runtime` → `notebook_execute`；真实启用的外部 Python 子进程，真实运行历史和工作文件             |
| 发布科研报告            | 原 Artifact MCP `write_artifact_file`、RPC capability、provenance repository、版本服务和 Session runtime owner         | 传入真实 `producerRunId`，原 owner 完成固定版本与 Session publication；Version snapshot 保留 producer，原 Notebook run 保留注册输入身份       |
| 审阅固定版本            | 原 `createReviewerCommandOwner` → Review facade／assessment owner → 同一 `ExecutionCore` → 原 Reviewer MCP／repository | `waitForCompletion` 等待完整提交与 canonical settlement；实际 HTTP MCP 读取固定内容／trace 并提交 findings                                    |
| 重开结果                | 原 `SessionRepository`、`ReviewRepository` 和固定版本 lease                                                            | 新 repository 实例读回相同 Session 版本和 Review；把 Notebook 工作报告改为 999 后，审阅和重开固定版本仍为 4.00，checksum 检查通过             |
| 执行归属                | 原 Session execution host／ACP boundary 与 Reviewer execution owner                                                    | 两个不同 execution ID，角色分别为 task、reviewer，同一原 Session／prompt，均 completed 且 cleanup confirmed；不把内部工具调用计为新 admission |

普通执行使用原 `ArtifactTurnOwner` 提供当前 run capability，并由原 `RuntimeSessionOwner` 完成 Session 提交；报告字节来自真实 Python，经原 Artifact MCP 发布。测试没有直接写入一个伪造的 finalized ArtifactVersion。

测试的主执行已完成后才请求手动 Review。原命令 owner 仅承认仍活跃且匹配 Project／Session 的父 execution，因此本验收不声称证明活动父任务的 autoReview 关联，也不伪造已退出的 execution scope。

## 证据边界

这是生产工具链与持久化 owner 的离线集成验收：Notebook／Artifact MCP 使用 SDK 真实协议和内存连接，再访问真实认证 loopback RPC；Python、文件、SQLite、不可变输入与产物、Review HTTP MCP 和各原 owner 均实际执行。Electron 只提供测试环境路径 stub，没有启动桌面窗口。主 Agent 的 dispatch／事件与 Reviewer 的工具选择和 pass 决策是确定性脚本；它们不是原生 ACP 模型响应、真实模型质量或独立科研正确性的证明。

该装配运行外部本地 Python，未装配生产网络隔离 owner。上游文件证据仍可为 `partial`，输入可只有 `turn-attached` 关联，不能由“Python 运行成功”推断完整文件访问证明。固定 ArtifactVersion snapshot 的已证明输入集合也不包含这种仅关联的源文件；原 Notebook run 仍保存注册输入身份。原 Reviewer 范围仅在已有证据允许时包含源 UploadVersion；缺少 `file-evidence` 时，源 Version 的 `read_artifact` 请求应被拒绝。测试核对这一原边界，不扩权、不补写虚假的访问证据。固定报告 Version 和捕获的 producer trace 可供审阅。

本测试没有覆盖 R、真实网络与远程 compute、文献导入／引证、Skills 安装、图像／大文件、Notebook 全部失败恢复、OS 安全隔离、Linux／Windows、包发布或真实付费模型。Session 重开是新 repository 实例读取真实持久化数据，不是关闭并重新启动 Electron。取消、deadline、未知清理与陈旧 journal 的共同规则继续由第八轮专项测试负责，此处只验证成功链。

## 重现与验证

需要调用者显式提供已安装、可运行且允许启用的 Python；测试不下载或安装解释器，不读取模型凭据，不调用付费模型。没有 `EARTHNANO_RESEARCH_PYTHON` 时该原生 Python 用例明确跳过。

```bash
EARTHNANO_RESEARCH_PYTHON=/absolute/path/to/python3 \
  node node_modules/vitest/vitest.mjs run \
  src/main/earthnano/research-workflow.integration.test.ts \
  src/main/reviewer/reviewer-orchestrator.architecture.test.ts --maxWorkers=1
node node_modules/typescript-native/bin/tsc --noEmit -p tsconfig.node.json --composite false
```

上述两文件共 9 项测试通过（原生科研链 1 项、Reviewer 架构约束 8 项），主进程 TypeScript 检查与 `git diff --check` 通过。

本机显式使用 `/Users/yxmac_mini/.local/bin/python3`，Python 只运行标准库 `csv`、`statistics`、`pathlib`。不会将 macOS 的开发工具 stub 当作可用运行时。验收未运行 `build:packages`。

本次提交只新增科研验收夹具、测试与此审计文档。现有生产模块没有修改；统计、不可变版本发布、Review commit／cleanup 和 Session 持久化继续由原模块负责。
