# OpenScience 首轮源码审查与开发基线

日期：2026-10-20。源码及初始契约基线：`b66d0567e`，分支 `review/round1-openscience`。
已阅读根目录 `AGENTS.md`、`docs/earthnano/PLAN.md` 与 `CORE_CONTRACT.md`；另只读复核主工作区
基于 `0326d1aa9` 继续修订的最终契约稿。本轮只新增本报告，不修改业务代码、锁文件或工作流；
不调用付费模型。

## 审查结论

契约方向与现有 OpenScience 能力基本吻合，但它定义的是待实现的统一执行投影，而不是现有
`sendPrompt()`、TaskRun 或委派执行接口的重命名。主分支修订稿已吸收本轮提出的接纳边界、
原 owner 权威、autoReview 时机、旧配置回退兼容及 cleanup 确认证据等主要建议。
最终复核时，原 runtime 身份关联、桌面示例接纳边界、可持久化证据范围与 thought 排除等
补充意见也均已纳入。下列意见保留初始审查依据，作为实现验收项；不表示最终契约仍遗漏。

| 领域 | 已有能力及源码证据 | 需抽取或新增 |
| --- | --- | --- |
| 桌面接纳 | `src/main/acp/handler-workflows.ts:461` 调用 `startPrompt()`；`runtime-coordinator.ts:983` 明确等待匹配的持久 Session turn admission，不等待后端输出或人工审批 | 抽取现有 facade 兼容层；新增核心持久队列接纳，不替换桌面响应边界 |
| Task API 接纳 | `src/main/tasks/task-runner.ts:1438` 生成 Run/user message 身份，先 `prepareSession`，`1473` 持久化 Run，`1540` 发布 accepted/session-ready 后异步 executeRun 并返回 | 新增请求摘要、项目内 requestKey 去重及冲突；不要在未完成准备前宣称旧 Task API 已接纳 |
| ACP 实际执行 | `src/main/acp/task-agent-port.ts:113` → coordinator → `runtime.ts:1473` → `prompt-turn-workflow.ts:410` admission → `provider-prompt-executor.ts:261` 的 `session.prompt()` | 抽取受现有所有权控制的执行适配；`sendPrompt` 等待完整 turn，不能直接实现异步 submit |
| 公开状态 | `src/shared/task-api.ts:50` 仅有 running/completed/failed/cancelled；`:54` 另有 accepted/session-ready/provider-accepted 等进展事件 | queued/preparing/interrupted 是新增内部状态；以兼容投影保持四种公开状态 |
| 取消与恢复 | `task-runner.ts:1570` 并发取消去重并等 completion；`:2590` 恢复 journal，能证明已提交的终态保留，其余在 `2635` 标 process_restarted；`runtime.ts:1681` 取消超时会断连，并明确退出尚未确认 | 新增面向核心的取消回执与 cleanup 证据；重启后的新核心记录不能自动重放模型/外部工具 |
| 配置 | `settings/backend-resolver.ts:443` 物化 skills，`:471` 合成指令并物化配置；`provider-session-creator.ts:94` buildSessionSetup，`:139` 配置模式/模型；`session-configurator.ts:70` 返回冻结配置事实 | 新增 HarnessRevision 编译、内容摘要、能力确认、独立候选 profile；文件已生成不能证明后端已加载 |
| 产物版本 | `src/shared/artifact-provenance.ts:166` 已有 artifactId/versionId/checksum，`:211` 有 pending/finalized descriptor；`task-runner.ts:2437` stageCompletion，`:2476` finalizeRun | 复用版本与现有产物 owner；新增 Execution 与固定版本引用，不能把候选 cwd 最新文件当作已冻结证据 |
| Reviewer | `reviewer/review-assessment-owner.ts:250` 冻结版本摘要和 scope，`:269` 保存 snapshot；`reviewer/artifact-digest.ts:60` 解析指定版本、`:81` verifyUnchanged；`reviewer/scope-snapshot.ts:45` 脱敏及限制快照大小 | 复用 Review 持久记录；新增到 Execution 的关联、统一预算及独立评测访问边界，不建立第二套 Review 库 |
| 证据流 | `web-service/public-task-event-stream.ts:52` 有公共递增 sequence，`:72` 游标过期/stream变化返回 resync-required；默认只保留 2048 帧/16MiB | 新增执行内持久证据序列及 gap 语义；公共内存流不是完整审计轨迹 |
| 优化控制 | 现有执行可报告 usage；例如 `task-runner.ts:2420` 缺用量标 unavailable，`restricted-inference-runner.ts:286` 返回观测用量 | TaskSnapshot、invocation、HarnessRevision、共享预算预约、优化调度、角色防递归和采用操作均为新增 |

表中缩写文件名均位于 `src/main/` 下的已写明目录，并非新增模块建议。

## 契约修订建议及实现边界

1. **分别表达四个接纳阶段。** 核心持久接纳、准备会话、Session turn admission 与 provider
   acceptance 互不等价。`prompt-turn-workflow.ts:405` 先取得 interaction，`:410` 执行 admission
   回调，`:415` 建立 runtime turn，再记录 prompt；`provider-prompt-executor.ts:273` 在收到
   provider update 后才报告 accepted。主修订稿第 3 节已明确区分。第 7 节普通示例中的
   “接纳后返回”在最终主稿中也已标明桌面 facade 等待 Session admission。
2. **保留已有身份及权威 owner。** 新 core executionId 不能覆盖已有 `promptAttemptId`、
   `turnToken`、runtime `executionId`/event `promptExecutionId`、artifactRunId 或 providerSessionId。
   `runtime-coordinator.ts:1446` 的 prompt-attempt 序号是进程内身份；
   `session-interaction-owner.ts:427` 的 turnToken 是独立轮次 token；
   `session-persistence/runtime-session-owner.ts:593` 按 executionId、frame、branch、runtime segment
   判断同次执行，`:831` 据 promptExecutionId 拒绝旧事件。建议契约显式列出该关联关系，不能
   仅提 promptAttemptId；最终主稿已补充。持久终态由原 Session/Artifact/Review owner 各自提交，
   核心维护投影。
3. **保留 Task API 的结果提交与 Reviewer 时机。** `task-runner.ts:2097` 至 `2190` 完成结果、
   产物与 Session 提交；`:2193` 至 `2231` 等 autoReview，之后才提交 Run 终态。Reviewer
   失败记录在 run.review，不必使主执行失败。取消期间产物 finalize 失败仍可优先成为失败，
   不可简单将“收到了 cancel”覆盖真实持久化失败。主修订稿第 4 节已采纳这一边界。
4. **严格配置检查只施加于新增候选边界。** `session-configurator.ts:169` 至 `201` 允许
   optional model 失败后回退；`:205` 至 `225` 的 effort 设置失败返回 false，启动配置可继续。
   已有普通会话兼容该行为；新候选需要 required 能力、确认来源与 unknown 状态，不应以
   requested model/effort 伪充实际值。`specialist/session-reconfiguration.ts:31` 已有
   desired→pending→applied 事务，`:118` 在未应用时挡住新 prompt，可作为明确切换边界的参考。
5. **一次性推理基础设施可复用，不能直接当完成的候选执行器。**
   `acp/restricted-inference-runner.ts:185` 至 `260` 已创建独立 cwd/profile、受限工具、ACP runtime
   并收集输出/usage；`restricted-runtime-profile.ts:127` 对 Codex 隔离配置。但 runner 在
   `:314` 忽略 shutdownForQuit 的 reaped 结果，`:316` 继续移除 jobRoot。新增候选调度需独立确认
   cleanup 并保留 unknown 栅栏，不能据该 finally 已结束就释放下一候选槽位。
6. **证据存储必须早于公共投影裁剪，但保持现有可见范围。** 公共流只有短期重放能力；
   `session-persistence/runtime-session-owner.ts:822` 至 `827` 刻意不把 thought 写入持久 transcript。
   新证据层应复用允许持久化的事件和版本内容，并说明限制；不能将“完整轨迹”理解为收集原有
   私有思考。Review snapshot 自身也有脱敏、数组/对象大小及深度限制，应记录为有范围的证据。

## 开发环境与验证

初始环境为 macOS 27.2 / arm64，PATH 中 Node `v26.0.0`、npm `11.12.1`；`.nvmrc` 指定 `24`。
根目录使用 npm lockfile v3，根 package 未声明 engines；独立 SDK 包
`packages/open-science/package.json` 声明 Node `>=22.5.0`。初始没有 node_modules。

已通过 `npm exec --yes --package=node@24 -- node -v` 获取 Node `v24.22.0`，退出 0，并复制到
`/tmp/earthnano-openscience-round1/node24bin/node`；复制件与 npm 下载原件的 SHA-256 一致。
使用命令级 PATH，不改变全局 Node 配置。尝试官方 Node tar.xz 作为备用时下载很慢，获取 npm
二进制后主动终止备用下载（143）；这不是应用失败。

验证命令均从本 worktree 根目录运行。后续构建和测试使用
`PATH=/tmp/earthnano-openscience-round1/node24bin:$PATH`，npm 仍为 `11.12.1`。
原始日志仅保存在 `/tmp/earthnano-openscience-round1/`，不随报告提交。

| 验证层 | 实际命令 | 结果及范围 |
| --- | --- | --- |
| Node 版本 | `npm exec --yes --package=node@24 -- node -v` | 退出 0，v24.22.0；临时 PATH 的 `node -v` / `npm -v` 为 v24.22.0 / 11.12.1 |
| 依赖安装 | `npm ci --ignore-scripts --no-audit --no-fund` | 退出 0，1484 packages，约18分钟；此命令启动时为 Node26，未执行 postinstall |
| 原生工具链夹具 | `node --test packages/credential-identity-probe-native/test/probe.test.cjs packages/credential-identity-probe-native/test/validator.test.cjs` | 退出 0，2 tests 通过，0失败/跳过；macOS 假 Security API 打印43场景，Windows假CryptoAPI测试另断言10场景；生产入口仅编译，不执行真实凭据访问 |
| 包构建 | `npm run build:packages` | 退出 0，Packages ready，9.02秒；包含 providers 的 build:assets |
| 既有补丁准备 | `node scripts/prepare-shadcn-patch.mjs` → `node node_modules/patch-package/index.js --error-on-fail` → `node scripts/check-claude-acp-patch.mjs` | 均退出 0；9个既有补丁成功，Claude ACP 0.70.0完整性检查通过；只修改 node_modules |
| 定向 Vitest 首轮 | 下方命令，全部19文件 | 退出 1；14文件通过，执行331 tests全部通过；5文件因 Prisma client 未生成而 collection 失败，非业务断言失败 |
| 定向 Vitest 修复后 | 同一命令，仅下表标“重跑”的5文件 | 退出 0；5文件、433 tests全部通过；两次合计19个独立文件、764个不重复用例通过 |
| 完整测试 | `npm test` | 未运行；本轮不声称全套回归通过 |
| Electron 就绪探测 | `node -e 'try { console.log(require("electron")); } catch (error) { console.error(error.message); process.exitCode = 1; }'` | 退出 1；require 自动启动 install.js 下载二进制，本轮主动终止该 installer 后 probe 报错；不是已观察到的上游下载或业务失败 |
| Electron 启动 | `npm run dev` / 桌面旅程 | 未运行；没有完成完整原生组件、Electron及运行时资源准备，无法据单元测试判定应用启动成功 |

依赖安装跳过 root postinstall；其内容包括补丁、Prisma client、Electron安装、原生组件、路径修复
及包构建（`package.json` scripts.postinstall）。本轮只补了上述补丁、包构建与当前平台 Prisma
测试准备，没有执行整个 postinstall、全量原生构建或桌面启动。没有改动全局 Node、GitHub Actions
或用户真实数据，也未启动无限 watch/dev 进程。

定向测试的命令前缀与报告参数如下；首次追加下表全部文件，第二次只追加标“重跑”的5文件。
第二次 JSON 输出改为 `vitest-retry-results.json`。所有模型端均使用既有假后端/测试夹具。

```sh
node node_modules/vitest/vitest.mjs run --project=default --maxWorkers=1 \
  <下表测试文件> --reporter=default --reporter=json \
  --outputFile.json=/tmp/earthnano-openscience-round1/vitest-results.json
```

| 文件 | 通过用例 | 时机 |
| --- | ---: | --- |
| `src/main/acp/handler-workflows.test.ts` | 56 | 首轮 |
| `src/main/acp/prompt-turn-workflow.test.ts` | 44 | 首轮 |
| `src/main/acp/provider-prompt-executor.test.ts` | 21 | 首轮 |
| `src/main/acp/session-configurator.test.ts` | 18 | 首轮 |
| `src/main/acp/session-interaction-owner.test.ts` | 35 | 首轮 |
| `src/main/acp/task-agent-port.test.ts` | 5 | 首轮 |
| `src/main/reviewer/artifact-digest.test.ts` | 7 | 首轮 |
| `src/main/reviewer/artifact-version-review.test.ts` | 3 | 首轮 |
| `src/main/reviewer/scope-snapshot.test.ts` | 3 | 首轮 |
| `src/main/session-persistence/runtime-resume-recovery.test.ts` | 18 | 首轮 |
| `src/main/session-persistence/runtime-session-owner.test.ts` | 93 | 首轮 |
| `src/main/specialist/session-reconfiguration.test.ts` | 10 | 首轮 |
| `src/main/tasks/task-run-journal.test.ts` | 15 | 首轮 |
| `src/main/web-service/public-task-event-stream.test.ts` | 3 | 首轮 |
| `src/main/acp/restricted-inference-runner.test.ts` | 30 | 重跑 |
| `src/main/acp/runtime-coordinator.test.ts` | 225 | 重跑 |
| `src/main/reviewer/model-runtime-owner.test.ts` | 13 | 重跑 |
| `src/main/reviewer/review-assessment-owner.test.ts` | 28 | 重跑 |
| `src/main/tasks/task-runner.test.ts` | 137 | 重跑 |

这些测试覆盖匹配 prompt admission、provider acceptance、等待完整 turn、配置回退、Session所有权、
取消竞争、journal/恢复、固定产物版本及 Reviewer 的生命周期。它们不验证真实供应商模型配置
加载、实际工具副作用、成本精度、新增 ExecutionPort、Harness²融合或真实桌面科研旅程。

## 环境准备缺口与修复证据

首轮5文件的共同错误为 `Cannot find module '.prisma/client/default'`。首次执行
`node node_modules/prisma/build/index.js generate` 等待约185秒，无输出或 engine 落盘后主动
SIGTERM，退出143；不能据此认定上游源码回归或下载服务器故障。独立 curl 探测官方 engine
URL 返回200。随后使用与已安装 `@prisma/engines-version` 一致的 commit
`c2990dca591cba766e3b7ef5d9e8a84796e47ab7`，从以下官方前缀获取当前平台引擎及其
`.gz.sha256` 文件，curl 均退出0：

`https://binaries.prisma.sh/all_commits/c2990dca591cba766e3b7ef5d9e8a84796e47ab7/darwin-arm64/`

| 压缩文件 | 校验后的 SHA-256 |
| --- | --- |
| `libquery_engine.dylib.node.gz` | `8414b51cb1612c3b4b0f15b98a55da7d7ec9520c593602699ec263823c79804e` |
| `schema-engine.gz` | `a951b600d83214e145bf7822a81ee31e5d5488a45d3890e68f1c5fd912f7d773` |

实际下载使用 `curl --fail --location --max-time 120 --silent --show-error -o <临时文件> <官方URL>`，
校验文件下载上限20秒；Python以 hashlib.sha256 对照官方校验值，通过后才解压到 ignored
`node_modules/@prisma/engines/`。`schema-engine-darwin-arm64 --version` 返回匹配的 commit，退出0。
CLI `generate --help` 退出0，并说明 `--no-engine` 仅用于 Accelerate，因此未用它替代本地数据库测试。

原 schema 的 generator 还要求 darwin/x64 和 rhel-openssl-3.0.x。两项附加 query engine 下载在
90秒上限退出28（各约1.7/2.2 MB部分数据），没有使用未校验的部分文件。为只验证当前平台，
复制原 schema 到 ignored `.cache/earthnano-round1/schema.prisma`，仅把 generator 的
binaryTargets 改为 `["native"]`，output 指向本 worktree 的 `node_modules/.prisma/client`；
模型、字段、关系与原 `prisma/schema.prisma` 均未改动。最初放在 `/tmp` 的 schema 因无法定位
项目根而生成失败（退出1）；改为上述项目内 ignored 副本后，再明确指定已校验的引擎路径：

```sh
PRISMA_QUERY_ENGINE_LIBRARY="$PWD/node_modules/@prisma/engines/libquery_engine-darwin-arm64.dylib.node" \
PRISMA_SCHEMA_ENGINE_BINARY="$PWD/node_modules/@prisma/engines/schema-engine-darwin-arm64" \
PRISMA_GENERATE_SKIP_AUTOINSTALL=1 \
node node_modules/prisma/build/index.js generate --schema .cache/earthnano-round1/schema.prisma
```

最终命令退出0，生成 Prisma Client 6.19.3（166ms）。显式路径前的 native副本生成仍等待自动
获取引擎，已主动停止（退出143）；指定本地路径后解除该缺口，原先5文件随后全部通过。
跨平台 engine 获取、完整 Electron/原生资源准备、全量测试及真实启动仍是后续基线工作，
本轮没有将它们标为通过。提交前 `git diff --check` 与 `git diff --cached --check` 均退出0；
测试数量已逐文件对照两次 Vitest JSON 结果核实，提交范围仅本报告。

## 下一轮最小任务

1. 先以假后端实现持久接纳、原身份映射、固定请求引用、请求去重/冲突及异步 completion，
   用桌面匹配 admission 与 Task API 准备/接纳/autoReview 测试保护旧入口。
2. 只选一个后端实现候选严格配置编译与独立 cwd/profile，证明 actual model/effort、指令、
   skills 和工具边界；覆盖不支持配置拒绝、配置已物化但未确认加载、候选互不污染。
3. 加入预算预约、取消/终态竞争、未知 cleanup 栅栏、重启不重放及事件缺口测试；再接 Harness²
   的 solver 与 proposer/composer/selector/reflection。把控制停止信号与普通方法回退分开。
4. 通过既有 ArtifactVersion 和 Review owner 保存证据引用，验证固定版本、版本损坏/缺失、
   Reviewer 失败/未运行/零得分和 partial evidence 各有独立表达，再开展真实后端与桌面回归。
