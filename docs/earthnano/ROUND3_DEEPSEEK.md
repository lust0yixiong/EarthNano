# 第三轮补充：真实 DeepSeek 验证

用户授权后，使用仓库外文件中的 API key，对 `deepseek-flash` 做小规模真实远端验证。
Claude Code 仍是执行后端，DeepSeek 是提供推理的模型服务；没有替换 ACP 或共享执行核心。

## 配置依据与初始连通

官方文档：[Anthropic 兼容接口](https://api-docs.deepseek.com/guides/anthropic_api/) 与
[Claude Code 配置](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/)。
使用 `https://api.deepseek.com/anthropic`，显式模型 `deepseek-flash`，不借用 Claude 模型别名。
官方注明 `thinking.budget_tokens` 被忽略，因此不能把该字段当作有效开销上限。

2026-10-20 初始直连探针返回 HTTP 200，响应模型为 `deepseek-flash`；
输入 39 tokens、输出 32 tokens，`stop_reason=max_tokens`。该探针只证明认证和协议连通，
没有输出预期答案，不计为任务通过，也不将其用量混入后续 Claude 执行链测试。

## 凭据与验证范围

凭据从用户指定的仓库外文件读取，只在调用时使用。测试与报告不保存密钥、原始认证头或
原始 provider 请求/响应。传给远端的任务、输入及技能内容均为专门构造的测试数据。

此前 [第三轮整合记录](ROUND3_VALIDATION.json) 的 901 项测试中，真实 CLI 集成使用本地模型夹具，
其原始结论仍保留；本补充单独记录真实远端测试，不能据此推导科研收益或完整优化闭环。

## 实测结果

首次远端候选测试通过：1 个 live integration 用例，2 个并发候选，无需重跑。
测试用时约 5.20 秒（含本机执行链，不是单次模型延迟）。A/B 共享任务和 Agent 快照，
Harness 分别包含 A/B 指令。每个候选都实际调用 Skill → Read → Write，再给出最终回答。

| 检查         | 结果                                                                |
| ------------ | ------------------------------------------------------------------- |
| 远端请求     | 8 次 HTTP 200，A/B 各 4 次                                          |
| 配置         | 请求模型均为 deepseek-flash；各自 system marker 不含对方 marker     |
| 技能与输入   | provider 后续上下文含技能验证值和对应 Read tool_result 的真实输入值 |
| 输出         | 两个独立 result.json 的 candidate/input/skill 字段均精确匹配预期    |
| 最终回答     | 分别以 EARTHNANO_A_OK、EARTHNANO_B_OK 结束                          |
| 执行状态     | 两个 completed、cleanup confirmed；各一个 ACP 进程，Session 不同    |
| 输入保护     | 两份冻结输入字节均保持不变                                          |
| 本地边界拒绝 | 共 10 次进入测试观察端点，其中 2 次未转发远端，不计付费模型请求     |

远端逐请求 usage 合计：非缓存输入 **9,961**、缓存读取 **26,368**，输入总计 **36,329**；
输出 **652**。A 为输入 18,193/输出 329，B 为输入 18,136/输出 323，与 runtime 汇总一致。
另有前述初始直连探针的输入 39/输出 32；本次所有远端调用总计 9 次，输入 36,368/输出 684。
没有根据客户端估计账单金额。脱敏逐请求记录见 [JSON](ROUND3_DEEPSEEK_VALIDATION.json)。

## 测试专用限制

新增 `src/main/acp/claude-deepseek-live.integration.test.ts`，默认 skip，须同时显式开启
`EARTHNANO_LIVE_DEEPSEEK=1` 与设置 `EARTHNANO_LIVE_DEEPSEEK_KEY_FILE` 才执行。
可选 `EARTHNANO_LIVE_DEEPSEEK_REPORT` 指定脱敏 JSON 输出文件；密钥变量只传文件路径。
命令使用 `node node_modules/vitest/vitest.mjs run --project=process --maxWorkers=1`
后接上述测试文件，Node 版本为 24.22.0。

真实 key 只在测试观察转发器内存里，CLI 使用随机 loopback token。转发器只访问固定 DeepSeek
地址，最多 12 次请求、每候选最多 6 次，每次输出最多 768 tokens；请求输入限制为 256 KiB，
并非精确的输入 token 或总金额限额。远端请求超时 45 秒，执行超时 100 秒。

实测 CLI 请求未携带 thinking 字段，测试转发器显式增加 `thinking:disabled` 并限制 max_tokens；
测试 owner 还增加 maxTurns=5。它们是控制本次开销的 **test-only override**，不是生产配置加载
或完整冻结配置 attestation 的证据。未改生产后端代码、默认桌面配置或共享契约。

该 live 用例验证远端模型与现有执行链的兼容性、正向工具流程和 A/B 结果区分。
越界拒绝与取消互不影响仍依据先前本地确定性模型的真实 CLI 测试，本次没有对付费模型重复这些
用例。当前 @ 文本限制、非 OS 沙箱边界、应用持久化 owner 和完整优化闭环未接线等限制不变。

## 代码与静态检查

测试源提交 `7c2821836`（与子智能体已验证的 `c2333a1bf` 内容相同）。默认无启用变量时
1 项明确 skip；Node strict 类型检查、新文件 ESLint/Prettier 与 diff check 均通过。
由第二位智能体独立只读复核凭据、限额和异常清理；未重复付费运行。
