# Alpha R：共同契约与并行实施边界

本轮基于 PR16 `6e1a03bc520fd8635a350387aac1b600b2f80c33`，继续完成 Alpha 原科研能力融合；不替换上游 R kernel 或 Harness² 调度算法。先完成公开语言/快照契约测试，再并行实施两侧链路，整合后验收并提交独立 PR。二进制和远程 Compute 继续属于完整 Alpha，不能因本轮先验证 R 的固定 CSV→JSON 而删除其要求。

## 核心约定

1. `NotebookOptimizationSource.language?: NotebookLanguage` 使用原 `NotebookLanguage`（python|r）。缺省只为兼容旧 Python 请求；normalizer 保留原无字段形式，显式 undefined/null/未知语言拒绝。不根据提示词、已有哪个 binding 或默认 runtime 猜测语言。
2. catalog 的 Notebook source 复用该类型。文本任务不接受 language。新桌面请求显式选择 Python/R，旧 manifest/request 不迁移；preview plan 仍是原身份流摘要，草稿语言变动使界面预览失效，启动仍重新授权冻结来源。
3. `FrozenNotebookRuntime.language` 复用原语言 union。managed/external、provenance、canonical runtimeId/interpreterPath/version 均沿原发现和准入，不能把 Rscript 路径手造为 runtimeId。source Version tuple/原租约和摘要检查不变。
4. `NotebookToolsProfile` 是 notebook-python|notebook-r；共享 `notebookLanguageForTools` 和 `notebookToolsForLanguage` 只映射这个已声明 discriminant。CandidateSnapshot 在 freeze 和 resolve 两处检查 profile/runtime 语言一致，跨语言不能复用环境或配置缓存。旧 Python task/harness/environment 摘要用变更前真实 store receipt 固定验证。
5. Main 分别取来源 Session 的 `listing.bindings[language]`，核对同语言 enabled/runnable/active 精确目标，冻结该任务的原环境。普通 Send 不改用户语言选择规则；基线/候选执行完全相同原 prompt 和固定输入。
6. 候选复用原 Notebook binding、host binding permit、输入 staging、授权、producer 和物理进程收尾。自动 grant 只给 notebook_execute:<冻结语言>；不借此授予安装、环境切换、后台任务或 Shell。原风险审批仍 deny-unresolved。
7. R 的 native gate 必须要求 `language:'r'`；原 notebook_execute 省略语言默认 Python，不能在 R profile 中放行省略字段。Python 旧省略语义保留。错误语言、外部输入、后台执行等继续拒绝。
8. 产物完成必须有原 Notebook Run，kernelKind 等于冻结语言，runtime/input/Session/prompt 及原 ArtifactVersion producer 证据一致。不能仅凭模型回复、JSON 文件存在或 kernel 退出通过。保留原 partial/unknown 输入读取证据，不能补造成完整科学证明。
9. Harness² 仍用原 Python task_stream/run_sweep/run_domain/run_task、递归/匿名选择/reflection/Library。只扩已有 profile transport 和严格校验；基线/候选可用科学 profile，方法角色和独立评估仍 workspace-only。独立评分/expected 不进入方法或 Library。
10. R 沿同一个 Core、总预算、停止、原 Session/版本/Review、冻结 manifest 与显式续跑；改变语言或 runtime 身份拒绝旧缓存。旧 Python 及旧实验正常读、停、续跑；不默认重复调用模型。

## 并行范围

| Owner      | 写入范围                                                                                                                                               | 验收                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| 主智能体   | shared source/runtime/tools 契约、candidate-snapshot 及测试；Main desktop composition/sweep-source/validation；桌面/8 locale；provider/E2E；集成和证据 | 先冻结契约，验证 Python 摘要不变；同任务普通/R基线/候选真实链、停止/恢复/Review；最终固定构建和 DeepSeek            |
| 平台智能体 | acp/claude-candidate-preparation、claude-candidate-driver、persistent-candidate-owner 及对应测试；原R基线复核                                          | gate严格语言/权限，原host permit/binding、R producer及物理收尾；旧Python回归；原同环境R tests与实际R候选            |
| 方法智能体 | run-persistent-optimization、harness-optimization、semantic-evaluation、sweep-input、既有 binding/projection/private Python接口及相应测试              | 新R和混合语言逐任务 frozen descriptor、原Library/独立评估隔离、缓存身份/恢复；旧Python manifest字节和原方法测试保留 |
| Luna       | 只读审查公共契约、来源/授权/缓存与最终证据范围                                                                                                         | 不直接修改开发文件；发现阻断时报告精确调用/复现                                                                     |

各开发智能体在独立 worktree/分支提交。不得修改对方或公共文件；接口变更先报告主智能体。共享 node_modules、构建目录及原依赖/锁文件不得重建或修改；原供应源码和算法有故障时先对照固定上游。不要开新线程或另建状态/结果数据库。

## 运行时基线与实际验收

先前在 `/tmp/earthnano-r-original-provision-20261021` 的隔离供给和探针记录，随临时目录清理已不可复核；不能作为本轮当前验收证据。2026-10-21 重新检查确认旧依赖链接失效，找到的另一份依赖缺失五项原生二进制，只可用于静态检查。现按原锁文件、完整安装流程和原 `createProductionProvisioner.provisionR` 在持久验证目录重建。必须重新取得原发现返回的 canonical interpreter/runtime ID、原 r_loop.R 探针和实际应用/Core/Artifact/Review 的日志后，才记录对应通过。新增测试使用隔离 env prefix，保持普通用户 runtime/config 不变。

先做合同红绿和原 R 同环境基线，再做有界离线 provider +真实原 kernel/Artifact/RPC 的科研流程。离线完整通过才启动有界 DeepSeek，不因随机模型响应或高分反复付费。旧 Python 单任务及逐任务来源路径须有适用回归。所有失败、辅助脚本误设、跳过条件、runtime/源码/build身份和用量缺失如实保存；hosted CI 的账户限制不等于源码通过，也不阻止本地其余 Alpha 工作。

### 重建期间可复核的预检

固定 Harness² pin 的原 5 项 unittest 和 EarthNano vendor 的 72 项 unittest 在同一 Python3.12.13 下全部通过；原清单比较结果为 `no-new-regressions`，新增 67 项，没有跳过。这是离线方法回归，不证明 R kernel 或真实模型效果。新增 Main 调用关系使 derived-consumer 索引过期，按原生成器更新后检查通过。

旧依赖的 manager 测试启动因文件读取 `errno -70` 在收集前失败；类型检查另有七项原模块声明缺失。两者均不能记为功能测试通过。审查同时发现 legacy 单任务恢复会丢失 R 语言；修复从冻结 profile 恢复 R 并核对 runtime 语言，Python 保留旧无字段 DTO，回归测试待新环境执行。

现有白底图标的 ICNS 解包与尺寸检查通过（ICNS 最高 1024px），不等于已完成原生包外观验收。以上原始记录、失败、摘要与证据范围见 [预检清单](validation/alpha/r/preflight/manifest.json)；该目录不含 R 原生或 DeepSeek 验收通过声明。
