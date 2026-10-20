# 第三轮：Claude Code 配置加载与候选隔离

按用户指定，首个后端采用 Claude Code。本轮把冻结引用、候选目录和原生配置连接到第二轮
ExecutionCore/ACP driver；验证使用真实 Claude Code、真实 ACP adapter 与 OpenScience runtime，
模型响应来自本地确定性 Anthropic 协议端点，不调用个人账号或付费模型。

## 模块与调用关系

| 模块                                            | 责任                                                                                                                       |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `src/main/earthnano/candidate-snapshot.ts`      | 保存带类型/版本/摘要的不可变文本对象；核验五类引用及调用关联；为每次 execution 生成独立输入、输出、Harness 和 runtime 目录 |
| `src/main/acp/claude-candidate-preparation.ts`  | 复用既有 Claude framework，将冻结指令、Skills、模型与工具策略编译为原生配置；隔离进程环境并核对本机 CLI 版本               |
| `src/main/earthnano/claude-candidate-driver.ts` | resolve → materialize → prepare → 保留 owner → 创建真实 Session → 第二轮 ACP driver → 原 owner 清理确认                    |
| 既有 TaskAgentPort / ACP runtime                | 继续拥有 prompt admission、provider acceptance、取消和进程退出；不另写一套 provider 执行器                                 |

所有 candidate 使用同一共享类型。providerRef 是不含凭证的句柄，可信绑定显式解析 provider
和可执行文件，不从“当前活跃模型”或个人登录状态推断配置。配置准备失败在启动模型前拒绝。

`openOwner()` 必须先返回不启动进程的资源 owner。它的 `preparePlan()` 才创建真实 Session，
因此启动失败后仍保留 `shutdown()` 句柄。取消、prompt 完成或删除目录都不能证明清理；
只有原 runtime 返回 `reaped: true` 才写 cleanup confirmed。超时先被核心标为 interrupted 的
记录仍保留 unknown 栅栏，不用迟到结果自动解除。

## 本轮支持范围

- POSIX 候选 profile，仅实测 Darwin arm64；Windows 明确拒绝，Linux 尚未实测。
- 单一后端：Claude Code，使用显式 custom/messages provider；拒绝共享个人订阅配置回退。
- 输入与技能资源为文本；Harness 仅包含指令、受限的纯文本 Skills 与 `workspace-only` 工具策略。
- 每次运行独立 workspace、inputs、outputs、HOME、Claude 配置、XDG 与临时目录，独立进程/Session。
- 工具权限限制候选内读和 outputs 写，拒绝其他目录、输入改写、链接逃逸与未授权工具。
- `directory-process` 表示目录、进程和工具权限隔离；`provider-only` 是工具层网络限制。
  本轮没有操作系统文件/网络沙箱，不把同 UID 的恶意进程或 native CLI 漏洞纳入隔离保证。
- 快照摘要、配置物化摘要与实际加载证据分开。编译配置本身仍为 unknown；真实测试通过实际
  provider 请求和工具结果验证加载，不把“写出配置文件”当成“模型已使用配置”。

真实负向探针发现：mission 和 Skill 正文中的 `@文件` 都可在受控 Read 工具之前自动附加文件。
因此本轮在 native 准备前检查 task/mission/instructions/全部 Skill 文本，并在派发前复验 owner
组合出的 prompt、history 和 resume fallback history；一律拒绝 `@`（包括 email），且拒绝非空
Skill 参数。这个限制是首版 profile 的明确边界；后续需增加受信的冻结文件提及转换。

Claude Skills 原生支持动态命令及其他扩展，因此本轮的纯文本 profile 会拒绝这些语法，
并固定程序生成的策略；这些限制参考 [Claude Code 官方 Skills 文档](https://code.claude.com/docs/en/skills#inject-dynamic-context)，最终能力以锁定版本的实测为准。

## 验证记录

最终整合源码为 `9a23a1057`，在 Darwin arm64、Node 24.22.0、Python 3.12.13 验证；
后续提交仅补充本文及状态/验证记录。锁定后端为 Claude Code 2.1.232、ACP adapter 0.70.0、SDK 0.3.232。

| 检查                                                                                    | 最终结果                |
| --------------------------------------------------------------------------------------- | ----------------------- |
| 默认 Vitest project：第二轮 22 文件 + 新快照/driver/prep + 既有 Claude/env/process 回归 | 28 文件、899 项全部通过 |
| process Vitest project：真实 CLI/ACP/runtime                                            | 1 文件、2 项全部通过    |
| Harness² Python unittest                                                                | 24 项全部通过           |
| `npm run typecheck:node`（含包构建）                                                    | 通过                    |
| 共享契约生成一致性、7 个新增 TS 文件 ESLint/Prettier、diff check                        | 通过                    |

各文件精确数量与限制见 [机器可读记录](ROUND3_VALIDATION.json)。
真实 CLI 测试使用本地确定性 Anthropic HTTP 端点，验证不同 Harness 的 system marker、
实际 Skill 内容、按 tool_use_id 对应的 Read/Write 结果、越界工具拒绝、不同进程/Session/home，
以及取消 A 后 B 正常完成。provider 请求和退出证据来自真实链路，不调用付费模型。

复跑默认项目可从机器记录选取 `project=default` 的文件列表，执行
`node node_modules/vitest/vitest.mjs run --project=default --maxWorkers=1 <文件列表>`；
真实集成单独执行
`node node_modules/vitest/vitest.mjs run --project=process --maxWorkers=1 src/main/acp/claude-candidate-preparation.integration.test.ts`。
Python 命令在 `vendor/harness2` 执行：`python3 -B -m unittest discover -s tests -v`。

协同分工沿用两个 `gpt-6.1-sol / high` 子智能体：一侧实现快照和投影，另一侧实现原生准备与真实测试；
主智能体统一 owner 生命周期、整合验证及 PR。快照侧还对原生加载修复做了独立只读复核。
分工记录见 [候选快照](ROUND3_CANDIDATES.md) 和 [Claude 原生后端](ROUND3_CLAUDE.md)。

## 后续边界

默认桌面入口没有切换，现有科研工具能力继续沿用原路径。此处提供的是可调用、经过真实
后端测试的内部候选执行组合；应用级 Session/ArtifactVersion/Reviewer 持久化绑定由调用方提供，
本轮测试只读取原 runtime 的临时文本事件，明确记录 partial 范围。

下一步是把该组合接到实际应用 owner、生产 Python transport 和 Harness² request factory/result
reader，再验证一次完整优化；独立评测、科研收益、费用与耗时仍需后续实验。没有运行桌面
端到端旅程、打包或真实科研模型评测；GitHub Actions 继续关闭。

## 用户授权后的真实远端补测

后续通过 Claude Code 调用 DeepSeek 的两候选测试已通过，见 [真实 DeepSeek 验证](ROUND3_DEEPSEEK.md)。
上述原始整合记录保持不变；新增远端结果与测试专用配置限制单独记录。
