# 第二轮 2A：OpenScience 内部 ACP 执行入口

基线：`54135cd13`。分支：`feat/round2-openscience`。本轮只修改 ACP 适配代码、测试和本说明；
不修改共享 schema/types/core、UPSTREAMS、锁文件、Actions 或桌面 bootstrap。

## 已实现

`task-prompt-execution.ts` 从既有 `task-agent-port.ts` 抽取真实共用代码：Task prompt 到 ACP 的
字段映射、通知 track/untrack、observed dispatch、完整 turn 等待及 cancel 转发。原
`createAcpTaskAgentPort()` 已调用这段抽取代码，原 Task API 默认路径也因此实际使用它。
Session 创建/恢复、模型目标解析、权限设置和原通知行为保持既有路径。

`earthnano-execution-driver.ts` 提供 `createAcpExecutionDriver()` 与显式 opt-in 的
`createAcpExecutionCore({ store, agent, resolver })`。调用方把既有 TaskAgentPort 传入 factory，
配置共享核心的准入预算后提交共享 `ExecutionRequest`；普通 task 和 candidate 走相同 driver
及 TaskAgentPort dispatch。没有为优化另建一套 provider 调用或会话数据库。

```ts
const agent = createAcpTaskAgentPort(runtime, sessionWorkflow, notifications, archiveAvailability)
const core = createAcpExecutionCore({ store, agent, resolver })
core.configureBudget(projectId, budgetRef, admissionLimit)
const handle = await core.submit(frozenRequest)
```

以上变量由已有应用 composition 提供；本轮未安装默认 composition 或生产 resolver 实例。
`submit` 返回核心持久化接纳句柄；driver 在可信 `admit()` 经原 Session owner 提交后才标记
running/session-admitted，provider acceptance 另外记事件。它继续等待完整 prompt turn，之后
再等待原 Session/Artifact/Review owner 结果提交。桌面原 `startPrompt()` admission RPC 与
Task API 的准备/接纳/autoReview 终态语义没有被新入口替换。

## 可信边界与控制停止

resolver 必须只读解析并验证所有冻结 Ref 的版本/摘要，明确拒绝不支持的配置、角色或隔离
要求，返回已准备并归属原 owner 的 Session turn。`kind: rejected` 保留具体错误码；driver
还检查目标 Project、Session、prompt/provenance、配置 requestedDigest 以及交互策略。
origin 保留来源上下文，不强制把原用户 Session/prompt 改为候选执行目标身份。
`deny-unresolved` 映射为既有 ACP `permissionPrompts: none`，与 plan-first 的组合被明确拒绝；
interactive 路径不会默默改为 deny。

`TaskAgentPort.prompt()` 返回 void，不是文本、产物或终态。结果只能来自可信
`readResult(settlement)`，包括原身份、声明范围的证据、固定 artifact/version/checksum、
usage 和配置事实。新 driver 不读取当前 cwd 充当证据，不将 core executionId 覆盖原
run/provider session/prompt attempt/runtime execution/turnToken/promptExecutionId。
未提供生效配置或用量事实时，共享核心保留 unknown；没有虚构后端已加载 Harness 的确认。

取消在本轮 Session admission 之前只通过 signal 阻止该 admission，不会调用 session-only
cancel 而误伤另一个桌面 turn。admission 提交中收到取消，提交返回后再进入本轮归属检查。
已 admission 的取消必须经可信 `cancelOwnedPrompt(dispatch)` 原子检查原 prompt/token 仍有
取消所有权，随后才能转发既有 cancel；归属已失效时不得 dispatch。
取消 RPC 只请求停止，结果仍由原 owner 决定。provider 停止后，活跃 signal 继续传给结果/
Reviewer owner；此时不再 cancel 可能已经承载下一轮的 Session。

执行后的 cleanup 仅在可信资源 owner 给出 confirmed 和非空退休证据时写 confirmed；signal
已 abort、cancel RPC 已返回、prompt Promise 已结束均不构成证明。其余为 unknown，由共享
核心保持环境栅栏。只读解析/拒绝阶段尚未 dispatch 时，confirmed 表示本次执行未启动资源，
不表示已有共享 provider 进程退出。owner 结果读取失败时返回 failed + unknown，不伪造证据。

## 验证

环境复用第一轮的 Node24.22.0、npm11.12.1 与已生成的当前平台 Prisma client。命令均在该
worktree 根目录执行，使用 `PATH=/tmp/earthnano-openscience-round1/node24bin:$PATH`。
日志及 JSON 结果位于 `/tmp/earthnano-openscience-round1/round2-*`，不提交大量运行日志。

| 检查 | 命令/范围 | 结果 |
| --- | --- | --- |
| 包准备 | `npm run build:packages` | exit 0，增量0.26秒 |
| 定向 Vitest | 下列8文件，`node node_modules/vitest/vitest.mjs run --project=default --maxWorkers=1` | exit 0，539 tests全部通过；新增21项 |
| Node 类型检查 | `node node_modules/typescript-native/bin/tsc --noEmit -p tsconfig.node.json --composite false` | exit 0；继承项目 strict/noUnused/noImplicitReturns 配置 |
| 修改文件 lint | `node node_modules/eslint/bin/eslint.js` 后接4个修改/新增的 ACP TS 文件 | exit 0 |
| diff 检查 | `git diff --check` 与 `git diff --cached --check` | exit 0 |

定向测试文件及用例数量：

| 文件 | 用例 |
| --- | ---: |
| `src/main/acp/earthnano-execution-driver.test.ts` | 21 |
| `src/main/acp/task-agent-port.test.ts` | 5 |
| `src/main/acp/handler-workflows.test.ts` | 56 |
| `src/main/acp/prompt-turn-workflow.test.ts` | 44 |
| `src/main/acp/runtime-coordinator.test.ts` | 225 |
| `src/main/acp/session-interaction-owner.test.ts` | 35 |
| `src/main/tasks/task-runner.test.ts` | 137 |
| `src/main/earthnano/execution-core.test.ts` | 16 |

新增测试通过真实 TaskAgentPort 和抽取 helper 驱动假 ACP runtime，覆盖 task/candidate 共同
入口、接纳阶段、等待 owner 提交、固定版本/原身份、unknown 配置/用量、配置/策略拒绝、
admission 前/提交中/完成后的取消、归属失效拒绝 cancel、取消 RPC 失败、无证明 cleanup、
结果读取失败及错误 provenance。没有调用真实模型或启动 Electron。
最后明确 origin 来源与实际目标身份的区别后，单独重跑新增文件21项，exit 0；该次复跑没有
重复计入539项总数，结果另存 `round2-final-driver.json`。

最初复用的 node_modules 中25个 `file:` 本地包链接目标为空，导致6文件 collection 失败，
其余51项通过；只按 package.json 声明在 ignored node_modules 重建这些链接，未重装依赖或
更改锁文件。链接修复后全量定向测试通过。开发时还修正了新增测试 mock 的泛型及 lint 问题；
最终通过结果不把准备缺口计为上游业务回归。

## 尚未接入

本轮提供并测试内部 opt-in seam，不表示已实现生产 snapshot/invocation 编译、Ref 内容存储与
摘要核验器、Harness 配置编译器、可信 resolver 实例、真实后端加载证明或候选隔离环境。
这些能力必须在下一阶段将真实 owner 绑定到 resolver 后验证；接口本身不能代替生效证据。
没有安装默认桌面/Task API 到 ExecutionCore 的路由、自动优化触发器、跨语言 transport、
计费预算或 cleanup reconciliation。共享核心当前仍是准入次数预算与有限事件重放。
本轮未运行完整 npm test、真实供应商/工具调用、Electron 启动或科研端到端旅程。
