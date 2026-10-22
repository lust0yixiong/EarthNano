# Windows 0.2-Alpha：恢复与验收

## 当前验收状态：2026-10-22

最终产品提交 `60e922b99ce77186374d219df2954de1c63acb5f` 已整合 0.1.1 的
`ef4fd17618d468123ffdf6cd172205916ec8872a`，保留 `0.1.1-alpha.1` 构建版本，
本轮没有发布 0.2 标签或公开安装包。

[规范运行 39708999081](https://github.com/lust0yixiong/EarthNano/actions/runs/39708999081)
的原生 Windows x64 job `119596188024` 已通过：原 NSIS 安装、包内身份／许可证／
资源、MCP／Artifact RPC、Python Notebook 环境部署、current／restart、新建与
原始旧数据库各两次启动／关闭、迁移 ledger 和卸载。四项原数据库证书
`freshInstall`、`legacyAdoption`、`reopen`、`specialPath` 均通过；未提供 previous
installer，因此不代表已发布版本间升级、DeepSeek、R 科研或 WSL 授权认证已验证。
原生验收证据及 API 摘要已独立复核，见[原生原证据归档](validation/alpha/windows-0.2-native/manifest.json)。完整源码对照仍在同一 run 执行。

[先前运行 39708148492](https://github.com/lust0yixiong/EarthNano/actions/runs/39708148492)
的原 smoke 仍为真实失败：已推进到新库 profile，shutdown 返回 202 且响应体读取
完成后，子进程未在原 60 秒内报告退出。同次隔离诊断重跑及最终规范原生验收通过，
停机相关源码相同，不能将后续绿色写成已修复该间歇性问题的证据。日志中的
transport-close 可能发生于超时强杀清理，不能据此确定原因；本轮未改退出超时、
频道或通过条件，也未仅凭标题移植无关的上游 UI 退出改动。

## 恢复工作：2026-10-22

用户已启动本清单的两个 P0：Windows 安装失败和固定上游源码对照。
修复在独立仓库和工作树完成，先以 `793a196509d1ff335b318cf97ed2fb8d82b84ae7`
为分析基线；正在迭代的 `0.1.1-Alpha` 不被覆盖。修复验证后通过 PR 提交，
在完整的 0.1.1 上整合和复验，再形成 `0.2-Alpha`。本阶段不改已发布标签、
安装包或更新频道，不提前将诊断构建称为 0.2 发布。

- 安装侧复用原 smoke、app-builder/NSIS 宏和保留 probe，先取得真实失败阶段。
  失败后的隔离诊断不能将原 smoke 改记成功。
- 源码侧保留固定上游、原测试、完整 inventory/sidecar 和比较规则，分别处理
  基线失败、候选新增失败与全局错误。旧报告断言数量完整，不将真实错误笼统归为环境。
- 保留分支逐项审查和移植，不整支合并未验证试验；默认 Unix 验收继续独立。
  手动 `windows=source/native/all` 仅选择 Windows 验证，`off` 保持既有路径。
- 当前生产代码仍有 Windows 候选执行限制，原方法的文件锁也存在平台边界。
  安装和源码 P0 通过不代表 Windows 优化、真实模型或完整科研流程已经验证；
  不删除限制或扩大 skip 来作出支持声明。
- 不新增自动优化触发、配置治理、完整费用账本或第二套执行/优化规则；固定上游不升级。

### 本轮定位和移植

开发分支已整合 `0.1.1-Alpha` PR #27 的 `ef4fd17618d468123ffdf6cd172205916ec8872a`。
0.1.1 仍在独立迭代，最终 PR 以其届时已公布的提交为合并基础；本轮不提前改版本号或发布。

| 工作 | 实际证据与处理 | 当前边界 |
| --- | --- | --- |
| Windows checkout | 恢复运行发现六个历史证据路径超过 Windows 路径限制；仅缩短归档文件名，逐一校验原压缩字节和解压字节，保留路径映射 | 不删除证据，不改变原结果 |
| 安装器 exit 2 | [运行 39700451549](https://github.com/lust0yixiong/EarthNano/actions/runs/39700451549) 的原安装 smoke 失败；隔离诊断定位到 `prepare` 的 `Add-Type -TypeDefinition`，原参数 probe 同时确认 verbatim `/D=` 的实际传递 | 参数修正不能单独解决运行时编译失败 |
| 上游安装修复 | 定向移植 [OpenScience 814f30751](https://github.com/aipoch/open-science/commit/814f30751bbbe04efe3a03412ef17a7869d82524)：五个生产模块和 extractor 原测试逐字节复用；构建时编译、原签名钩子、私有 DLL 加载和 UTF-16LE 输出 | 不移植同一提交的六分片调度或其他无关改动；`UPSTREAMS.json` 的对照 pin 保持不变 |
| PowerShell 回归 | [旧红 39702517939](https://github.com/lust0yixiong/EarthNano/actions/runs/39702517939)：x64/x86 中文 TEMP 两例失败、英文两例通过；[修复后 39703245660](https://github.com/lust0yixiong/EarthNano/actions/runs/39703245660)：四例原 prepare/publish/cleanup 断言全部通过，实际位数和 TEMP UTF-16 原字节已核对 | 新运行共 10 通过、15 条件跳过；窄例不代替原 NSIS 完整安装、资源和 RPC 启动 smoke |
| 源码对照 | 历史 `ede07` 的 16 份报告与原比较器已完整执行；后续修复仍待新提交验收 | 不以 job 绿色代替原断言结果，不将基线失败抵消候选新失败 |

安装模块的 Git blob、SHA256 与原 C# / 目录事务主体保真证明见
[上游移植清单](validation/alpha/windows-0.2-upstream-installer/manifest.json)。
原安装的目录身份、ACL、reparse-point、发布和清理事务主体保持逐字节一致。
真实 PowerShell 红绿报告、四项 profile 的环境见证和原始 ZIP 摘要见
[窄验证归档](validation/alpha/windows-0.2-publication/manifest.json)。
临时 NSIS 参数探针和隔离阶段诊断工具保留在验证提交
[`cd292f8f0`](https://github.com/lust0yixiong/EarthNano/tree/cd292f8f0a14537c38666f5886ebae992c4b3400)，
不进入最终产品维护范围。产品原生 workflow 与原 recipe 哈希证明已恢复；上游原
publication、extractor、安装 smoke 和真实失败证据全部保留。诊断分支的额外观察
不能将原 smoke 的失败改记为通过。

历史 `ede07` 完整对照：基线 115,591 项、16 失败、4,254 跳过；候选 116,997 项、
72 失败、4,350 跳过。原比较器退出 1，记录 68 个新增失败身份，0 全局错误、
0 阶段回退。完整 inventory / sidecar / cohort 校验成立，不能将这次失败称为
断言观测不完整或环境不可用。原 CLI 的通用异常收据虽名为 `validation-unavailable`，
实际完整比较结果为 `new-regressions`，见
[原始比较与 16 份 artifact 摘要](validation/alpha/windows-0.2-source-red/manifest.json)。
本记录不覆盖后续修复提交的状态。

本轮另修三个原测试夹具：以平台分隔符归一化 `globSync` 的文件名比较；将非法
URL 后缀保留在原 checksum/feed 输入、真实文件使用字面 basename，避免 Windows
在验证前就因 `?` 文件名失败；版本身份测试约束合法 Alpha 格式和原 package/lock/
更新渠道一致性，移除写死旧 `0.1.0-alpha.1` 的构建号。生产发布范围、URL 拒绝规则、
校验和、更新渠道及版本号均未改动。

完整候选执行和原 Harness 全方法中的 13 项 POSIX 集成用例明确列为 Windows
平台不适用，未计为通过；Unix 原名称、回调、断言和超时保留，实际 Windows
host guard 拒绝用例继续执行。范围与别名注册证明见
[平台边界清单](validation/alpha/windows-0.2-posix-scope/manifest.json)。

### PE 版本检查修正

PE 身份检查由 EarthNano 提交 `d8af1a7bb19e3994a0ffdd10336098cdd17208ef` 额外引入；原上游通过启动后的 `bootstrap.appVersion` 精确检查完整版本。
[真实取证 39706440979](https://github.com/lust0yixiong/EarthNano/actions/runs/39706440979) 确认锁定构建器写入 `ProductVersion=0.1.1.0`，保留完整版本的字段是 `FileVersion=0.1.1-alpha.1`。
因此 PE 检查改为精确比较 `FileVersion`，继续精确检查 `FileDescription`、`ProductName`，并保留原上游 `bootstrap.appVersion` 精确检查；`ProductVersion` 继续取证，不作版本匹配的替代或回退。
这只修正本项目的字段假设，不改包配置、版本或频道；完整安装 smoke 仍须重跑通过。
四字段实测、阶段记录及原始证据 ZIP 见
[PE 身份取证](validation/alpha/windows-0.2-pe-identity/manifest.json)。

以下内容为 2026-10-21 的延期记录和恢复依据。其当时的“停止 Windows”与
“0.1 尚待发布”描述不覆盖上面的恢复决定，也不把历史尝试标记为已验证修复。

### 本轮不可变文件缓存测试夹具的边界

[运行 39700451549](https://github.com/lust0yixiong/EarthNano/actions/runs/39700451549)
的 candidate 3 在 `version-file-operator.test.ts` 的重复打开缓存用例失败；原比较器
仍将其记为新增失败。该生产实现和原测试与固定 OpenScience 提交逐字节相同。
相邻的原范围恢复测试已用有界 `vi.waitFor` 建立真实 `ctimeNs` 变化，说明 Windows
同 tick 写入可能共享 ctime；重复打开用例此前没有建立这个触发缓存复核的前提。

本轮只沿用相邻上游测试的方法：同大小改写并恢复原 mtime，等待并明确断言 ctime
已变化，再执行原 `INTEGRITY_FAILED`、缓存复用和四倍／五倍读取计数断言。
受控元数据别名探针可复现原失败，补足前提后通过；原 50 项正常测试全部保留。
这不证明历史 Windows 跑次的具体时序，实际 Windows 仍须在新提交完整复验。
原始红绿报告、受控观测脚本和摘要见
[缓存夹具证据](validation/alpha/windows-0.2-cache-fixture/manifest.json)。

**该修改不是生产完整性修复。** 继承实现中，若 dev、ino、size、mtime 和 ctime
全部不变，缓存 lease 可能沿用既有摘要；本轮未修改该生产缓存规则，也未增加
每次读取重新哈希等机制。旧失败和此限制均保留，不能以夹具通过宣称该限制已修复。

### 本轮 Claude 策略单测的实际平台边界

同一历史运行的 candidate 6 有三个 Python/R 策略用例在 Windows 命中生产 POSIX
guard。它们检查编译后的工具 gate 与原 broker 权限，没有运行 POSIX hook 命令。
本轮仅在这些单测里沿用原 `process.platform` descriptor／finally 恢复模式，显式
构造 POSIX 策略；生产 guard、原 ask／deny 断言和已有跳过范围均不变。

Windows 夹具只使用现有锁文件固定的 `@anthropic-ai/claude-agent-sdk` `0.3.232`
平台包，路径为 `@anthropic-ai/claude-agent-sdk-win32-{arch}/claude.exe`，与原 ACP
集成测试的解析方式一致。它在隔离 HOME、无凭证的环境中仅执行有界 `--version`，
把实际输出版本冻结进 snapshot；gate 仍由实际 Node 执行。新增的实际 host 用例
在 Windows 保留默认拒绝，并用不存在的 executable 验证该拒绝早于 prepare 自身
的版本探针。本地 macOS 验证不能证明 Windows 探针或候选执行支持，实际 Windows
版本输出和原对照仍待新提交复验；本轮没有调用模型、凭证或真实 POSIX hook。

### 本轮原 owner 文件系统边界修复

历史 candidate 8 的原审阅恢复测试有六项在 owner settlement 目录 `fsync` 抛出
`EPERM`；二进制投影有七项在 `mkdir('C:\\')` 失败。本轮分别复用已有
`@aipoch/durable-files` 同步目录契约，并按原生 `dirname(root) === root` 语义避免
创建已存在的文件系统根。普通文件同步仍必须成功，根和所有祖先仍经过原目录／
符号链接检查，子目录仍逐层创建。既有 receipt 重开使用原 durability owner 的
`r+` 文件 flush 前提，不改变独占写入和内容验证。

外部受控 EPERM 探针只改变这两项系统操作，保留真实文件、原生产调用和全部原断言，
原 26 项中 14 项失败，修正后 26 项全部通过；含 store／resume 的原正常回归为
56 项全部通过。本地结果不代替新 head 的完整 Windows 对照，也不解除候选运行的
POSIX 限制。原 consumer 生成器重建无差异，未增加边界规则。

### 本轮二进制 JSONL 单测的范围

`harness-optimization.test.ts` 的六处真实 Python 调用统一使用原 workflow 已提供的
`EARTHNANO_RESEARCH_PYTHON`，没有值时沿用 `python3`；子进程只保留 PATH、系统根与
临时目录等必要环境，不继承凭证。历史报告只给出经过收敛的失败信息，不能仅凭它
断言 Windows 的 `python3` alias 是唯一根因。

原 `JsonLineClient` 真实 fd 分支使用 POSIX `select`。二进制 envelope 单测只验证
TS 关联字段分离和 payload 校验，现以仅转发真实 `sys.stdin.readline(size)` 的
file-like 代理走客户端已有无 fileno 分支，没有伪造或预置回复。真实 Python／TS
管道、原 MAX 长度、3 秒停止界限和所有正负断言保留，生产客户端与 vendor 未改。
实际本地 Python 3.12.13 全文件 52 项通过；受控 Windows stdin select 拒绝条件下，
该两项由一项失败变为全部通过。此单测不验证 POSIX select／fcntl transport，也不
宣称 Windows 原 Harness 方法已受支持；真实 Windows 必须继续在最终 head 复验。

## 原延期记录：2026-10-21

2026-10-21 用户决定：**Windows 安装失败留到 0.2-Alpha 修复，0.1-Alpha 先跳过 Windows 版本。**

0.1-Alpha 的源码对照、原生构建、安装与发布范围调整为 macOS 和 Linux；原生目标为 macOS ARM64/x64、Linux x64/ARM64。当前不再开展 Windows 安装器排查、构建、CI 重跑或发布。已有 Windows 源码、打包配置和失败证据保留。历史失败不改记通过，也不据此宣称 Windows 可用。

## 已知故障与证据

| 记录                                                                                                                                                       | 实际结果                                                                                                                                            | 结论边界                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| [原生运行 39555053834](https://github.com/lust0yixiong/EarthNano/actions/runs/39555053834)，源 `c1e663279038c4bdba9d26ba9f3d0c5484ecf2c7`                  | 四个 macOS/Linux 原生目标通过；Windows 构建出安装器，安装 smoke 返回 exit 2、目标目录为空                                                           | 此运行整体未通过五目标验收；四个成功目标属于当时提交，不能证明后续代码的最终发布包                                        |
| [诊断运行 39573702221](https://github.com/lust0yixiong/EarthNano/actions/runs/39573702221)，源 `8db97e9562b2af26b84aaacec16cfef30243b7df`                  | Windows 安装仍失败；默认 Node 参数序列化给 `/D=<含空格路径>` 整体加引号；旧 probe 首例失败后中止                                                    | 引号与原宏解析存在源码支持的冲突，但不能据此解释所有 exit 2；可选步骤的绿色状态不等于 probe 或安装成功                    |
| [诊断运行 39577934563](https://github.com/lust0yixiong/EarthNano/actions/runs/39577934563)，源 `f6329ed8cf5993a9b8a807b393b7640c395b42cd`                  | 改用 verbatim 参数及显式 argv0 引号后，安装仍 exit 2、目标目录为空；probe 因误选 stock `MultiUser.nsh` 缺少宏而编译失败，未执行任何 case            | 参数调整没有修复安装；尚无实际阶段证据确定根因。显式锁定 app-builder include 的后续本地修复未在 Windows 验证              |
| [源码运行 39566641858](https://github.com/lust0yixiong/EarthNano/actions/runs/39566641858/job/119111287665)，源 `e74c6f178a559bf04ec23e3695853536724226e9` | Windows candidate 8/8：19,573 断言，19,006 通过、91 失败、476 跳过，另有 2 个真实全局错误；baseline 8/8：18,731 断言，18,300 通过、2 失败、429 跳过 | 两侧原始断言与 sidecar 数量一致，但候选全局错误使原验证器判为 unavailable。不能笼统归为环境故障，也未放宽完整性或比较规则 |

最近一次原生失败的原始 job log、probe、构建配置及摘要见 [保留证据](validation/alpha/windows-deferred-0.2/manifest.json)。之前四个 Unix 目标的记录见 [原生构建证据](validation/alpha/native-39555053834/manifest.json)。源测试的原始报告与 sidecar 保存在对应 Actions artifact 及本地验证归档中，未重写。

## 已尝试内容与保存位置

固定上游仍为 OpenScience `9e18c7d3c143a9dba49c7a586ad6cac8096f6dd5` 和 Harness² `1cfe254e8d25b15f37048c3730134686abe60335`，以 `UPSTREAMS.json` 为准。恢复工作时继续对照同一环境的原源码、原脚本和原测试，不能通过降低断言或更换编译器来取得通过。

| 保留分支（已同步 GitHub）                                                                                                                   | 精确 head                                  | 状态                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| [fix/alpha-windows-0.2-preserved](https://github.com/lust0yixiong/EarthNano/tree/fix/alpha-windows-0.2-preserved)                           | `31cf7029e3f4f317403f961f7bd1012b2cb14e59` | 保存本轮安装器参数、probe、源码修复及诊断文档；包含未获真实 Windows 验证的工作，不并入 0.1                                                          |
| [fix/alpha-source-windows-regressions](https://github.com/lust0yixiong/EarthNano/tree/fix/alpha-source-windows-regressions)                 | `cb8df6f65879d2c18a8d4e886559d3912f99f21f` | 保存目录 durability、host 注入、UTF-8 fixture、快照攻击 fixture、ACL 检查及继承上游 SQLite 完整性修复；有本地定向证据，尚未通过 Windows hosted 验收 |
| [fix/alpha-windows-installer-stage-diagnostic](https://github.com/lust0yixiong/EarthNano/tree/fix/alpha-windows-installer-stage-diagnostic) | `0576b813739238f21dfdfa0272dad34d5c5b518c` | 仅未验证的隔离阶段诊断 helper；未接 workflow、未构建或安装，不能作为修复或成功证据                                                                  |

通用 CI 路径/UTF-8/测试分类修复 `171e0127070baf56aec206836815db362f2bdb5e` 同时关系 macOS 的严格对照，单独保留在 0.1 分支；其余 Windows 专项尝试不因延期而删除，也不作为本版交付内容。

原 `ci/earthnano-native` 的 Windows 诊断 tip `f6329ed8cf5993a9b8a807b393b7640c395b42cd` 已完整保存到 [archive/alpha-windows-native-20261021](https://github.com/lust0yixiong/EarthNano/tree/archive/alpha-windows-native-20261021)。原生验证分支后续只指向本版最终 Unix 候选；保留旧 tip 不会执行 Windows 任务。

## 0.2-Alpha 恢复清单

1. 核对保留提交与届时固定上游差异，先审查未验证诊断 helper；不要直接合并整条试验分支。
2. 在真实 Windows 上先验证锁定原 app-builder 宏的 probe，再定位静默安装的实际失败阶段。当前缓存 NSIS 未启用 `NSIS_CONFIG_LOG`，不能将 `/LOG` 当作已可用的日志方法。
3. 修复后重跑原安装资源、R/runtime、RPC/health、启动和用户数据兼容检查。安装器打包成功不足以证明可安装。
4. 在相同 runner/Node/Electron 条件下重跑原上游与候选源码测试，分别处理基线失败、新失败及全局错误；保留原 inventory、skip 和差异比较门槛。
5. 取得 Windows 源码与实际安装的完整证据后，再恢复 Windows 构建、验收及公开分发，并更新版本支持范围。

本次延期不改变 Python/R/Compute、产物/审阅及 Harness² 原方法的融合范围。0.1-Alpha 尚须完成其余融合、macOS/Linux 最终验证及 PR 审查，不能因跳过 Windows 就标记版本完成。

发布准备同步采用显式 `mac,linux` 范围，清单与认证聚合器均拒绝混入 Windows 文件或引用，不把缺少 Windows 记录伪装为完整五目标验收。相关 130 项本地检查使用合成文件字节，未执行 Windows 安装、诊断或 CI；见 [发布范围验证](validation/alpha/unix-0.1-release/manifest.json)。原稳定发布工具的完整默认保留，实际 Alpha 发布入口尚未启用。
