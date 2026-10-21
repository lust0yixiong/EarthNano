# EarthNano 0.1-Alpha 使用指南

本稿对应产品源码 `bdc0246383a25990030854f4c2fa100895f29ea6`（`0.1.0-alpha.1`）。0.1 面向 macOS 与 Linux，Windows 延期至 0.2。四目标原生构建及原包 smoke 已通过；同源 MacARM 包的原 Python 科研、停止/续跑/重开流程已用离线模型通过。**新源码完整对照仍待核定，资产汇总及公开发布尚未进行。** 取得最终发布链接和校验清单后再据其下载，不把 README 中 OpenScience 上游下载当作 EarthNano。

## 取得应用

尚未发布时，可在自己的独立目录试用固定源码：

```bash
git clone https://github.com/lust0yixiong/EarthNano.git
cd EarthNano
git fetch origin bdc0246383a25990030854f4c2fa100895f29ea6
git switch --detach bdc0246383a25990030854f4c2fa100895f29ea6
npm ci
npm run dev
```

开发使用仓库 `.github/earthnano-node-version` 指定的 Node（本快照为 24.22.0），并满足[原开发依赖](../development-quick-reference.md)。首次安装按原脚本下载、校验 Electron 与原生资源，需要网络；不要把跳过安装脚本的依赖树当成可运行应用。优化方法另需可用的 Python 3.11+，优先使用本次测试采用的 Python 3.12。

取得经最终核验的候选包后，按处理器架构选包：

| 系统 | 包及安装入口 |
|---|---|
| macOS Apple Silicon | `EarthNano-0.1.0-alpha.1-mac-arm64.dmg`；挂载后将 EarthNano 拖到 Applications。也保留 ZIP。 |
| macOS Intel | `EarthNano-0.1.0-alpha.1-mac-x64.dmg`；同上。也保留 ZIP。 |
| Linux x64 | `EarthNano_0.1.0-alpha.1_amd64.deb` 或 `EarthNano-0.1.0-alpha.1-linux-x86_64.AppImage`。 |
| Linux ARM64 | `EarthNano_0.1.0-alpha.1_arm64.deb` 或 `EarthNano-0.1.0-alpha.1-linux-arm64.AppImage`。 |

Debian/Ubuntu 使用原 `.deb` 安装方式，例如 `sudo apt install ./EarthNano_0.1.0-alpha.1_amd64.deb`；AppImage 赋予执行权限后启动，宿主仍须满足原运行依赖。这些 Alpha 包按 **unsigned** 交付，不是稳定版。公开发布后，请从**同一个 EarthNano 实际 Release** 下载安装包和 `SHA256SUMS.txt`，计算下载文件的 SHA-256，例如：

```bash
# macOS：以 Apple Silicon DMG 为例
shasum -a 256 EarthNano-0.1.0-alpha.1-mac-arm64.dmg

# Linux：以 x64 AppImage 为例
sha256sum EarthNano-0.1.0-alpha.1-linux-x86_64.AppImage
```

将输出的完整摘要与清单中**相同文件名**的条目对照；使用其他架构或包格式时替换为实际下载的文件名。校验和一致只说明文件字节与清单一致，不单独证明构建来源；本 Alpha 未产出或声明 SLSA attestation、Developer ID 签名或公证。当前尚未公开发布，下载入口与最终清单仍待核定。

若 macOS 提示未公证或无法验证开发者，确认来源与未篡改并尝试打开后，可按 [Apple 官方说明](https://support.apple.com/en-us/102445)在 **System Settings → Privacy & Security → Open Anyway → Open** 仅允许该 App；该路径不适用于“损坏”或“恶意软件”提示。本轮未观测 Gatekeeper，也未更改系统设置。

## 先完成一次普通科研任务

1. 依原首次向导完成 Environment、Data location、Agent runtime、Model provider；按需要设置 Notebook。已有数据目录、凭据与 CLI/MCP 仍使用 OpenScience 兼容标识，不要因显示名 EarthNano 自行迁移或删除它们。
2. 新建 Project 与 Session，选择模型，上传或引用输入文件，写明目标、方法和预期产物后发送。原权限批准、工具活动、Notebook、文件版本、Provenance 和 Review 入口继续使用。
3. Python/R：先在原 Notebook 设置中安装/登记并启用对应运行时；普通任务可使用原运行时发现与绑定工具。外部环境的文件访问仍依原 Files 权限，缺包或权限问题先在普通流程解决。产物应通过原文件工具发布，并保留真实 Notebook producer 与 Version。
4. Compute：先在原 Compute 入口配置并启用 host，再在当前 Session 选择需要的资源、按原审批执行 Job。已选择 host 不是执行授权；提交回执不是计算完成。结果与后续分析沿原 Job、投递、Notebook producer 和产物入口保存。无需为了使用本地 Python/R 先配置远端主机。

一个便于起步的 Python/R 任务是上传含 `value` 列的 CSV，要求用对应 Notebook 计算行数、总和与均值，保存并发布 JSON 报告；随后检查工具记录、报告正文及来源版本。普通任务可处理数据、图像和报告，不被优化 profile 的限制替代。

## Claude Code 与 DeepSeek 示例

普通工作台保留原模型配置能力；当前桌面优化要求 **Claude Code + 明确的 custom Messages provider**，不会回退个人订阅设置。

在原 Settings 的模型提供商表单添加自定义 provider：选择 `Messages (/v1/messages) — Claude / Anthropic-compatible`，Base URL 填 `https://api.deepseek.com/anthropic`，填写自己的 API key 与明确模型 `deepseek-flash`；再在 Agent runtime 选择并检测 Claude Code。该组合来自本快照的原 provider 配置和已归档的历史 DeepSeek 实验；本次新包验收使用离线 provider，不是新的 DeepSeek 测试。其他后端依实际兼容性配置，不能借用这一组结果声称全部通过。

密钥通过原凭据入口保存，不写入任务、Skills、报告或 Git。运行开始后模型、provider 路由和实际 CLI 版本被冻结；需要修改这些设置时新建实验，不让旧运行暗中换配置。

## 显式优化同一个任务

在桌面 Session 展开 **Optimize task（优化任务）**。该入口不在 Web 或本版 Windows 中开放；原 CLI/Web 普通任务入口继续保留。

1. 选择原任务及来源。Notebook runtime 可选 Python、R 或 Compute；可从其他聊天添加 Notebook 任务。Python/R 使用各自已启用运行时和 1–10 个原不可变输入；Compute 可没有文件输入，仍须有真实任务来源、原启用/选中 host 和有效授权。每个任务自己的来源与版本分别冻结。
2. 填写独立验收标准（每行一项）；需要时启用预期 JSON 检查，填写文件名、JSON pointer 和真实期望值。数值标准应独立于候选回复；独立评估不会回流到方法提示或 Library。
3. 选择 sequential/parallel、递归 k、并发；可比较双模式，并设置 seed、domain/task 过滤、每域任务数和 domain workers。点击 **Preview task stream** 核对原顺序与最低容量，再设置整次执行预算并显式启动。
4. 从进度、对应 Session、固定产物和 Review 查看结果。基线与候选执行同一冻结任务；原匿名选择和反思/Library 继续使用 Harness² 方法。Library 没有 entry 可以是合法结果，不补造经验。
5. 可点击停止；只有原资源实际收尾才能确认清理。关闭重开先读取已有事实，继续工作须点击 **Resume optimization**，沿原任务身份和剩余预算续跑；不自动重放完成阶段。远端 Job 收尾 unknown 时不把本地退出当作完成，也不通过新实验重复提交未知资源。

当前新实验统一使用 sweep，最多 32 个目录任务、k=1–8、Core 并发及 domain workers 各 1–4，整次接纳上限 512；旧兼容入口仍保留其 128 上限。预览最低容量覆盖首尝试路径，重试与停止历史可额外占用预算，最低值不是成功保证。预算统计 Core 接纳的实际方法/评审执行，不等于 HTTP 请求、token 或美元。原用量仍区分 known/partial/unknown，不补造缺失费用。

候选的权限比普通互动任务更窄：Python/R 固定运行时和输入，不安装包、切换运行时、使用 Shell 或启动后台工作；Compute 只在基线/候选开放原控制能力，source Session 的 grant 不复制到私有 Session，未解决授权直接拒绝。方法角色保持 workspace-only。目录/进程隔离不能称为 OS 沙箱。

优化配置加载也受当前 profile 限制：仅接纳受支持的指令与带简单 `SKILL.md` 的 `.md/.txt/.json` 文本资源；候选自带 Hooks、任意插件、可执行 Skill 脚本和动态 Shell 内容会被拒绝。宿主生成的权限 hook/本地 Skill 插件是受控装配，不代表任意插件可用；配置已编译不等于原运行时已加载，未获可信观察的加载状态仍保留 unknown。

二进制按原 Version、producer 和真实字节传递，不伪装成文本。JSON 检查只适用于文本 JSON；二进制本身不能充当语义引用。混合产物可审阅可读文本，全二进制无适用文本证据时明确不可评估。PNG Read、字节相同、任务 completed 或评估高分，都不单独证明图像科研正确或配置普遍更好；`eligible` 只表示可继续验证，不会自动发布配置。

## 原 Harness² CLI 与完整任务流

源树 `vendor/harness2` 保留原 `harness2`、`harness2-setup/check/judge/report/demo` 和可选 bridge 入口；完整 benchmark 的依赖、模型认证和费用沿[原 README](../../vendor/harness2/README.md)与[SETUP](../../vendor/harness2/docs/SETUP.md)。原 README 使用 Linux/Python 3.12/uv 安装，其 Python 包范围为 3.12–3.13；不要与桌面方法的 Python 探测条件混淆。

原 deterministic demo 无需模型凭据；原 benchmark CLI 支持 sequential/parallel、k、seed、域/任务过滤、workers、dry-run、独立 judge/report 和同命令 resume。评估和报告须保持同一 executor/子集/模式/k/seed。命令仍由原 Harness² 管理 benchmark 输出，不是新增 EarthNano headless/Web 优化 API，也不由 EarthNano 的 custom provider 表单自动配置。桌面则用原 task_stream/run_sweep/run_domain/run_task 驱动同一 Core。

## 来源与当前验证边界

OpenScience `9e18c7d3…` 提供普通 Send/Task、Python/R、Compute/Job/审批、产物/Version/Review 等原能力；Harness² `1cfe254e…` 提供递归提案/组合、调度、选择、反思/Library、CLI 和缓存/续跑。EarthNano 的必要融合是把二者接到同一执行、身份、资源与证据链，并提供显式桌面入口；两侧 Apache-2.0 许可证与固定来源见 [UPSTREAMS](../../UPSTREAMS.json)。

本次四目标 native `39658781703` 已通过；MacARM 包的原 science `39662102991` 通过，覆盖同 Task 的 2 baseline+6 candidate、8 个原 Notebook producer/固定 ArtifactVersion、独立 Review、停止/续跑/两次重开和 3 次原 Keychain 元数据确认，零上游模型请求。这是离线模型下的真实包工作流证据，不是新 live DeepSeek、R/PNG、Compute、Intel/Linux GUI 或所有科研任务的证明。历史真实 DeepSeek、R/二进制与 Compute 分层证据继续保留，不转移为本包已测范围。

**待最终核定：** 新 source `39658771118` 完整结果、同源四目标资产/认证/checksum/feed/manifest 汇总、PR/公开 Alpha 发布及实际下载入口。旧 4a 完整 Unix 对照为零新增回归，但 Linux 29 / Mac 2 个双方共有失败及全部跳过仍保留；不能用其替代新 bdc source gate。

自动触发优化、平台级配置批准/发布/回滚、完整精确费用账本属于另列后续设计；新增 headless/Web 优化产品、真实 SSH/Slurm、Dock/tint 和 Windows 不增加为本版门槛。
