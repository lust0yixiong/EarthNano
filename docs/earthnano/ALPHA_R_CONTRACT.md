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

先做合同红绿和原 R 同环境基线，再做有界离线 provider +真实原 kernel/Artifact/RPC 的科研流程。离线完整通过才启动有界 DeepSeek，不因随机模型响应或高分反复付费。旧 Python 单任务及逐任务来源路径须有适用回归。所有失败、辅助脚本误设、跳过条件、runtime/源码/build身份和用量缺失如实保存。仓库公开后 hosted CI 已实际运行，先前的账户限制不能继续作为当前阻断理由；仍以具体 job 和固定提交的结果为准。

### 重建期间可复核的预检

固定 Harness² pin 的原 5 项 unittest 和 EarthNano vendor 的 72 项 unittest 在同一 Python3.12.13 下全部通过；原清单比较结果为 `no-new-regressions`，新增 67 项，没有跳过。这是离线方法回归，不证明 R kernel 或真实模型效果。新增 Main 调用关系使 derived-consumer 索引过期，按原生成器更新后检查通过。

旧依赖的 manager 测试首次启动因文件读取 `errno -70` 在收集前失败；类型检查另有七项原模块声明缺失，不能记为全项目类型通过。后续该依赖能执行不依赖原生模块的 manager 单测：修复从冻结 profile 恢复 R 并核对 runtime 语言，Python 保留旧无字段 DTO。原未修 manager 配合同一新回归为 2 项失败、25 项通过；修复后的当前文件再次执行为 27/27 通过，文件摘要和精确命令见 [恢复回归记录](validation/alpha/r/resume/manifest.json)。这些测试使用 mock 执行入口，只证明桌面恢复身份和转发，不能替代 R kernel、原 Session/产物/Review 或 DeepSeek 验收。中间 fixture 错误的失败日志也保留在该目录。

2026-10-21 04:05 UTC 后检查确认旧安装、R 下载及 continuation 的三个 PID 已不存在，且没有成功退出记录；旧 `running` 状态已失效。04:13 UTC 在持久目录启动第二次有限恢复作业，保留原下载片段，并继续使用原锁文件、完整 `npm ci`、原 `fetchLanguagePack` / `resilientDownload` 与生产 provisioner。运行中的状态文件不算环境完成证据；须取得真实退出码、原校验和及探针结果后再更新验收状态。审计后的当前实施顺序是先收尾 R、已有 PR/CI 与可运行安装包，其他开发中的候选能力保存原工作树，暂不展开新功能；这段实施安排不新增用户验收要求。

现有白底图标的 ICNS 解包与尺寸检查通过（ICNS 最高 1024px），不等于已完成原生包外观验收。以上原始记录、失败、摘要与证据范围见 [预检清单](validation/alpha/r/preflight/manifest.json)；该目录不含 R 原生或 DeepSeek 验收通过声明。

## 后续实际验收（2026-10-21）

原生产工厂已在隔离目录完成 R 4.4.3 和 119 个包的供给，原 `r_loop.R` 探针返回 42。完整原锁文件安装、五项原生组件和实际 Electron 43.7.5 均已恢复；前述中断及失败记录仍保留，不追认为通过。

两次断点均先对照固定上游：

- R 计算正确但 `ArtifactVersionInput` 为空：原分析器不支持额外展示用 `jsonlite::toJSON`，因此保守标为 partial。16 次真实原 R 执行及原 observer/graph 对照证明，`write_json + print(report)` 能保留精确旧版本的 used edge，而加入 `toJSON` 后不制造该边。只调整离线 fixture 的展示语句，未改分析器、producer 或输入版本强断言。
- 桌面普通 R 被沙箱拒绝：外部 conda 的 `Rscript` 还会执行同一 prefix 下的 `lib/R/bin/R`，超出原默认 bin 读取范围。原沙箱同样拒绝；用原 Files API 对明确指定的环境 prefix 授予只读访问后成功。对照同时证明运行时写入和其他私有文件读取仍被拒。仅补测试用户的原授权操作，没有扩大生产沙箱。

| 验证                | 实际结果与边界                                                                                                                                                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 原 CI 新增回归      | 原 17 个失败文件 855/855，通过原 helper 核对 108 个新增失败 ID 均完整出现并通过。runtime/owner/release 修复已整合，但这不是完整 hosted source comparison 通过。                                                                          |
| R 契约与调用        | 16 文件 375/375；实际 Python/R Core + MCP + kernel + producer 测试 2/2，保留旧输入 Version、独立 Sessions/产物/Review、重开零重放和准备失败零模型调用。                                                                                  |
| 类型与完整应用构建  | 干净 `002d7b687` 完整 build 通过；Node/sandbox/Web 类型通过。后续 `72444d533` 仅改 E2E 的显式只读授权，生产源码和资源逐字节相同。                                                                                                        |
| 原生桌面离线 R      | 干净 `72444d533`，同一构建，79.6 秒通过普通 Send、原 sweep 双模式 k1、停止/重开/续跑、固定来源和独立 Review；零上游调用。                                                                                                                |
| 首次真实 DeepSeek R | 同一 head 和四个 bundle 摘要，321.3 秒通过；21/24 次 Core 接纳，124 本地/123 上游模型请求，零拒绝，1 次转发前暂停及 1 次确认取消。7 个已完成科研执行均有原 R producer；共享基线评审、两个独立候选评审及重开零重放通过。                  |
| 用量与效果边界      | 原用量覆盖 19/21 次优化执行，加普通任务核对 20 个原 owner；一次取消用量不完整。生产 API/美元仍未知。基线 100、两模式候选均 96，仅证明本样例验收，不证明配置收益或普遍科研正确性。                                                        |
| Node 资源 staging   | 原下载超时及云盘 dataless 缓存读取未通过，未绕过校验。后取得 49,963,763 字节镜像归档，SHA-256 与原官方 pin 完全相同；原 staging 脚本及最终文件摘要通过。桌面实测发生在 staging 前，使用原安装包的已签名 Node 22.23.3；两种证据分别记录。 |

完整原始报告、失败、命令、源码对照与 SHA-256 见 [本轮清单](validation/alpha/r/native/manifest.json)。实际提供的 API 密钥不在这些文件中。静态审查未发现本轮具体阻断，不替代完整 CI。R 的本轮融合已取得上述证据；Compute/二进制候选、原生安装包与完整上游回归等剩余融合和发布工作仍需完成，不能据此宣布整个 Alpha 完成。
