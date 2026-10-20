# 第三轮：Claude Code 原生配置与候选隔离

本分工实现提交：`83ecce622`、安全修复 `7154b28dc`。本文记录本分工实际执行结果；
主分支合并后的完整回归由主智能体另行记录。本轮最终选择 Claude Code，未实现 OpenCode
候选执行器，未使用个人模型账号或付费推理。

## 实际生产路径

新增 `src/main/acp/claude-candidate-preparation.ts`，导出
`prepareClaudeCandidate`、`PreparedClaudeCandidate`、`ClaudeCandidateBinding` 和
`assertClaudeCandidateText`。准备函数接收平台已经解析、物化的冻结快照及明确的 provider/CLI
绑定，复用 `claudeCodeFramework.prepareModelConfig/buildSessionSetup/spawn`。
它返回可供现有 ACP owner 使用的 backend、原生 Session setup、runtimeOptions 和配置事实，
不是只在测试中使用的 SDK 示例。

主侧 `createClaudeCandidateDriver` 先保留 owner，再由 `preparePlan()` 创建真实 Session，
然后经过第二轮 `createAcpExecutionDriver`、`TaskAgentPort` 和共同 prompt dispatch。
真实集成测试实际构造生产 `AcpRuntime`、Base/Session owners、`AcpRuntimeCoordinator`、
`createAcpTaskAgentPort` 和 `createAcpCreateSessionWorkflow`；没有用直接 SDK `query()`
代替这条执行链。核心测试使用内存 ExecutionStore，未伪称测试创建了持久化 Session/Run 数据库。

## 配置与隔离边界

- 仅支持明确的 `custom/messages` provider、精确 model/providerRef/runtimeVersion 绑定。
  拒绝共享订阅账号、默认模型回退、其他协议和不支持的 profile。凭据仅留在干净的进程环境中，
  不写 snapshot、manifest、配置事实或 ACP Session metadata。
- 每次运行独立 cwd、输入/输出目录、runtime home、`HOME`、`CLAUDE_CONFIG_DIR`、
  XDG config/cache/data/state 和临时目录。生产 spawn 最后替换宿主环境，强制 `shell:false`；
  不继承宿主 Anthropic/OAuth 凭据、代理、调试设置或 `NODE_OPTIONS`。
- `settingSources:[]`、明确 tools/skills、`strictMcpConfig:true`，沿用原 framework 的
  native delegation 和 auto-memory 禁用策略。仅开放 Read/Write/Edit，以及非空技能集所需的
  Skill；不开放 shell、WebFetch、WebSearch 或原生委派工具。
- 自有 CLI `PreToolUse` command gate 只允许读取本候选 inputs/outputs/plugin，
  只允许写 outputs。未知工具/输入字段拒绝；路径及祖先逐层检查链接，拒绝 hardlink 文件、
  dangling symlink 和跨候选路径。Skill 只允许明确白名单名称，非空参数拒绝。
- native 技能为自有本地 plugin 中的冻结纯文本文件。每个包必须有根 `SKILL.md`，
  frontmatter 仅允许简单 `name`、`description` 两个字段；拒绝候选脚本、hooks、扩展策略、
  行内/多行动态 shell 上下文，并在 programmatic/managed settings 设置
  `disableSkillShellExecution:true`。
- 生成前重验完整 manifest、实际字节、摘要、普通文件、nlink 和 inode；runtimeHome 必须空，
  home/plugin/tmp/claude 使用 exclusive mkdir。预置子目录链接不会被跟随。
- 用干净环境实际执行有 10 秒上限的 `--version`，核对 CLI 输出；不能仅比较两份声明。
  `materializedDigest` 包含冻结投影、无凭据 native Session setup、gate 源码摘要、
  provider 引用/非秘密 endpoint/model 和版本，使用 `sha256:` 前缀。它是本次物化身份，
  包含实际路径，不是跨执行结果缓存身份。

这里的 `directory-process` 和 `provider-only` 表示独立目录/进程及工具层网络限制，
没有实现 OS 文件系统或网络沙箱，也不防御同 UID 外部进程的任意并发修改。当前 command hook
是 POSIX profile：Windows 显式拒绝，其相关测试明确跳过 Windows；实际证据仅来自 Darwin arm64，
Linux 未实测。既有默认桌面 Windows 路径没有改变。

## 真实发现并修复：原生自动上下文加载

在真实 CLI 2.1.232、本地 Anthropic HTTP 夹具中分别验证了两个路径：

1. `invocation.mission` 包含独立 `@/absolute/path`，首个 provider 请求已自动附加
   synthetic 宿主文件内容，模型尚未请求受控 Read 工具。
2. mission 恢复普通文本后，仅 Skill 正文含同样引用，Skill 加载后的 provider 请求仍出现
   synthetic 宿主 sentinel。

两个负向探针均退出 1，准确发现了工具 gate 覆盖不到的原生加载面；不是账号或 OS 沙箱测试。
原始长请求只在临时日志中，未加入仓库。修复后 `assertClaudeCandidateText` 在任何 native
准备/版本探针之前检查 task prompt、mission、harness instructions 和全部技能文本；主侧也用
同一函数复验 owner 最终组合的 prompt/history。当前保守拒绝所有 `@` 字符，包括 email；
相对路径、引号、标点邻接等形式都不能因 tokenizer 差异漏过。它明确报 unsupported，
不会悄悄重写用户文字。通用 email/文件提及支持需要下一阶段做受信转换和冻结引用解析。

## 本机后端与依赖

| 项目            | 实际值                                                                          |
| --------------- | ------------------------------------------------------------------------------- |
| Node            | 临时隔离 Node `v24.22.0`；未改全局 Node                                         |
| Claude 原生 CLI | `node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`               |
| 原生版本探针    | `2.1.232 (Claude Code)`，退出 0                                                 |
| ACP JS 入口     | `node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js`，包 `0.70.0` |
| SDK / 平台包    | `@anthropic-ai/claude-agent-sdk` / darwin-arm64 包 `0.3.232`                    |
| 另一已安装 CLI  | `/opt/homebrew/bin/claude` 指向全局 Claude Code `2.1.232`；本轮执行未采用它     |

复用首轮已安装的依赖和包生成物；本轮未安装/升级依赖，未修改 lockfile、Actions 或真实研究数据。
没有启动 Electron。集成仅 mock Electron 的 app metadata，不启动其进程；原生 ACP 和 CLI 均真实。

## 已执行验证

以下命令前均使用
`PATH=/tmp/earthnano-openscience-round1/node24bin:$PATH`，工作目录为本 worktree。

| 检查                                                    | 结果与精确范围                                                                                                                                                  |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 定向既有/新增回归                                       | 收口前版本 9 文件、380 tests，通过、退出 0，见下方清单                                                                                                          |
| 最终 prep unit                                          | `node node_modules/vitest/vitest.mjs run --project=default --maxWorkers=1 src/main/acp/claude-candidate-preparation.test.ts`：22 tests，通过、退出 0            |
| 最终真实集成                                            | `node node_modules/vitest/vitest.mjs run --project=process --maxWorkers=1 src/main/acp/claude-candidate-preparation.integration.test.ts`：2 tests，通过、退出 0 |
| Node 完整类型检查                                       | `node node_modules/typescript-native/bin/tsc --noEmit -p tsconfig.node.json --composite false`：退出 0，沿用项目 strict/noUnused 配置                           |
| ESLint                                                  | `node node_modules/eslint/bin/eslint.js` 检查新增 3 个 ACP TS 文件：退出 0                                                                                      |
| 格式/提交检查                                           | 3 文件 Prettier；`git diff --check` 和 staged check：退出 0                                                                                                     |
| npm ci / build:packages / 完整 npm test / Electron 启动 | 本轮未运行；不作为通过项                                                                                                                                        |

9 文件回归命令为 `node node_modules/vitest/vitest.mjs run --project=default --maxWorkers=1`
后接以下文件；JSON 输出在 `/tmp/earthnano-openscience-round1/round3-regression.json`。

| 文件                                                            | tests |
| --------------------------------------------------------------- | ----: |
| `src/main/acp/claude-candidate-preparation.test.ts`（当时版本） |    14 |
| `src/main/earthnano/candidate-snapshot.test.ts`                 |    29 |
| `src/main/earthnano/claude-candidate-driver.test.ts`            |     7 |
| `src/main/acp/earthnano-execution-driver.test.ts`               |    21 |
| `src/main/acp/task-agent-port.test.ts`                          |     5 |
| `src/main/acp/prompt-turn-workflow.test.ts`                     |    44 |
| `src/main/acp/runtime-coordinator.test.ts`                      |   225 |
| `src/main/earthnano/execution-core.test.ts`                     |    19 |
| `src/main/agent-framework/claude-code.test.ts`                  |    16 |

后续修复新增了 8 个 prep tests，并单独重跑最终 22 项；这里不把重复执行相加成新的测试数量，
也不把收口前 380 项描述为最终整合 head 的完整回归。

真实集成的两个用例验证：同 TaskSnapshot/AgentSpec 的 A/B 候选，仅 Harness 指令不同；
实际 HTTP 请求中各自 system marker 唯一、model 精确；原生 Skill 调用后才出现技能正文，
按 `tool_use_id` 核对成功 Read 的实际输入内容、成功 Write、以及跨候选/宿主读取、写 inputs、
dangling-link 写入和不可用 WebFetch 的错误结果。项目恶意 `.claude/settings.json` 和
`CLAUDE.md` 在 spawn 前放置。并发候选拥有不同 ACP PID/Session/home/cache，输入字节不变、
输出各归其位。取消 A 后 B 完成，cleanup 由原 runtime `shutdownForQuit().reaped` 与已退出的
ACP child 确认；signal/cancel RPC/删除目录均不充当退出证据。

最终临时日志为 `round3-unit-final.log`、`round3-integration-final.log`、
`round3-typecheck-final.log`、`round3-eslint-final.log`，均位于上述临时目录；未提交长日志。

## 仍未接入的范围

准备函数默认记录 `configuration.status:unknown`，真实加载的正向证据限定于本轮锁定 CLI 和
本地夹具；没有伪造生产端通用配置 attestation。集成 owner 只读原 runtime 的瞬时可见文本，
证据标 partial，明确没有 ArtifactVersion/Review 持久化；cwd 文件不冒充版本引用。

生产后续最小任务是将受信 provider binding、持久 Session/Run/Artifact/Review owner 和真实
配置观测接到此 opt-in driver，并保留 archive/通知/权限/admission 原语义；补冻结文件提及转换，
再逐项放宽目前明确拒绝的文本、技能参数、工具和平台策略。默认桌面/Task bootstrap、
自动优化触发、真实模型质量与实际远端账号认证都不在本轮验证范围。
