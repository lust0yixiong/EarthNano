# EarthNano 首个整合开发基线

本页记录第一至第五轮已合并基线。第六轮候选分支新增模式、k 和并发选项，
预算上限调整为 128；其范围和独立验证见 [ROUND6.md](ROUND6.md)。
以下 9–20 的预算和 k=1 描述仅适用于原整合基线。

日期：2026-10-20。范围为第一至第五轮 PR [#2](https://github.com/lust0yixiong/EarthNano/pull/2)、
[#3](https://github.com/lust0yixiong/EarthNano/pull/3)、
[#4](https://github.com/lust0yixiong/EarthNano/pull/4)、
[#5](https://github.com/lust0yixiong/EarthNano/pull/5)、
[#6](https://github.com/lust0yixiong/EarthNano/pull/6) 的累计实现及合并前修复。
按用户本次选择，审查通过后依次合入 `main`，使用 merge commit 保留历史。

这是可从源码启动、在 Darwin arm64 验证的开发基线。仓库仍为私有，应用名称及包名仍沿用上游，
尚未发布 EarthNano 安装包。README 的上游下载链接不包含本次融合功能。

## 已落地能力

- 跨 TypeScript/Python 的最小执行契约、共享类型、执行核心和一致性校验。
- Claude Code 的冻结输入与配置、独立候选目录/进程，以及原 ACP 执行与取消。
- 原 Session、ArtifactVersion 和 Review 持久化；模型/方法读取固定版本证据。
- 原 Harness² 的 `k=1 / seq` 最小优化方法；共用执行次数预算、停止和总 deadline。
- 当前桌面 Session 的“优化任务”入口、进度、执行次数预算、停止及结果导航。
- 预先固定标准，对基线和最终候选分别进行独立语义评估，并保存为原 Review。

普通 Send 保留原执行路径，尚未全面迁入共同核心。默认自动触发、Library 反思、配置推广、
费用预算和未知清理恢复操作仍未完成；跨任务质量收益也尚未证明。

## 从源码启动和试用

需要仓库访问权限、Node.js 24、Git，以及原 OpenScience 源码开发所需依赖。优化另需 Python 3.11+
和已在设置中选定的 Claude Code。CLI 沿用原项目兼容性检查，并把实际探测到的版本固定到本次运行；
本次真实后端验证版本为 2.1.232，不能将其等同于所有兼容版本均已验收。

```bash
git clone https://github.com/lust0yixiong/EarthNano.git
cd EarthNano
git switch main
npm install
npm run dev
```

开发和打包细节沿用 [开发参考](../development-quick-reference.md)。

1. 在应用设置中选择 Claude Code，并配置明确支持 Messages API 的 custom provider 与模型。
   优化复用该 provider 的受控凭据解析，不支持个人订阅配置回退。
2. 打开或创建项目中的普通 Session，展开“优化任务”。初始任务说明来自最近的用户消息，
   不会自动打包整个会话或整个工作区；按需要补充任务和文本附件。
3. 填写 1–16 条独立验收标准，每行一条，每条最多 2,000 字符。执行预算默认 12，范围 9–20，
   包含提案重试及两次独立评估。这不是模型请求次数、token 或金额上限。
4. 启动后查看进度；可停止当前优化，结束后通过结果入口打开对应 Session 和 Review。
   不支持的 provider/runtime 会拒绝执行。重启后的 interrupted 任务不自动重放。

初始 profile 最多 32 个纯文本附件，单文件 64,000 字节、合计 128,000 字节，仅支持受限工具；
文件名须为简单名称。目录/进程隔离不提供操作系统沙箱保证。Web 和 Windows 隐藏该入口，
Linux 尚未实测。

## 合并前发现和修复

两个开发智能体按执行/持久化、方法/评估分工复核；Luna 只读核对进度和交付材料，主智能体整合。
GitHub 现有审阅意见也逐项核对。以下修复已在同一源码基线上验证：

| 问题 | 修复与回归证据 |
| --- | --- |
| 输出 6 个文件会超过原 Review 的最多 5 条 Finding 约束 | 聚合为一条完整性 Finding，逐文件路径、摘要、版本引用和 JSON 检查保留在原 Review 日志；真实多文件持久化用例通过 |
| `RESULT.JSON` 等大写扩展名绕过 JSON 语法检查 | 大小写无关匹配；非法大写 JSON 被记为 flagged |
| Review 提交失败或提交期间停止可能留下 running/迟到 pass | 等待提交及错误收尾，将 Review 标为 error、清空 outcome；故障注入和停止竞争通过 |
| 超大超时被 Node timer 截断为约 1 毫秒 | 在计时器、目录、owner 或子进程创建前拒绝；同时校验 Python RPC 上限，默认期限保持 |
| 桌面把运行时写死为开发机的 Claude 版本 | 探测并冻结选中可执行文件的实际版本，每次候选仍精确核对；未知、不兼容及版本变化回归通过 |

## 本次整合验证

源码验证提交为 `54dcb848ae11078170e03a992d85a86d1596a04b`；后续提交为基线文档。
完整文件列表、命令和限制见 [BASELINE_VALIDATION.json](BASELINE_VALIDATION.json)。

| 检查 | 结果 |
| --- | --- |
| 相关默认回归，包括原执行/对话/生命周期及新增能力 | 47 文件、2,356 项通过 |
| 真实 Claude/ACP 进程、SQLite 与优化闭环 | 3 文件、10 项通过，2 项付费测试跳过 |
| Harness² Python 回归 | 33 项通过 |
| Chrome 组件协议测试 | 4 项通过，覆盖 1100/390 宽度和停止按钮可见性 |
| 真实 Electron 43.7.5 冒烟 | 1 项通过；隔离 HOME/config/data，实际桌面命令派发，不支持的路由在模型接纳前拒绝 |
| Backend/Electron 构建与原 Node runtime staging | 通过，复用现有依赖与 Node 22.23.3 runtime |
| Node/Web 类型、9 个修复文件 lint/格式、契约生成、diff | 通过 |

这些是针对累计改动的本地检查，未运行全量 `npm test`，GitHub Actions 仍关闭。
本次没有新增付费模型调用。此前 DeepSeek 的真实闭环走生产 manager 集成测试，
不是从 Electron 点击完成；基线与候选同为 100 分，前两次失败记录保留在
[第五轮真实调用记录](ROUND5_DEEPSEEK_VALIDATION.json)。本次修复后的付费闭环未重放。

下一步以该基线开展代表性科研任务的可靠性、质量和成本验证，并推进普通执行的共同核心迁移；
具体后续任务见 [NEXT_TASKS.md](NEXT_TASKS.md)。
