# EarthNano 0.1.1-Alpha 试用案例

本轮只补充两个上游案例与试用入口，沿用现有项目、会话、附件、Notebook、产物版本、Review
和统一执行核心。版本为 `0.1.1-alpha.1`，单独发布为 `v0.1.1-alpha.1`；不覆盖
`v0.1.0-alpha.1` 或旧 `alpha` Release、标签和安装文件。Windows 仍延期至 0.2-Alpha。

## 在现有试用项目中运行

1. 打开已有试用项目（名称可以保留用户自己的“Open-Science 试用”），新建会话。
2. 展开 **Try upstream examples（试用上游案例）**，在空白草稿中选择案例。
   输入文件通过原附件上传流程加入，任务说明可编辑；选择案例不会发送、运行或启动优化。
3. 确认已启用 Python Notebook 和模型提供商，检查草稿与两个附件后点击 Send。
   DeepSeek 使用原 custom Messages provider 配置；密钥不随案例分发，调用可能计费。
4. 查看 Notebook 的真实执行、生成文件、不可变版本和 Provenance。原有会话不会被覆盖。

## OpenScience：Case16 冻结输入复算

来源是 [OpenScience 论文](https://arxiv.org/abs/2610.17110v1)的
[公开验证材料](https://huggingface.co/datasets/AIPOCH-AI/case-validation/tree/5a775981cc7142651116960b0b96501088670c98/releases/2026-10-13-deidentified/case16)，
不是另造的演示数据。原脚本与输入逐字节保留，使用标准库在原 Notebook 中执行；
参考结果不发给执行智能体。

验收：`trial_calculations.csv` 和 `availability_summary.csv` 与原参考逐字节一致。
候选 93、纳入 80、排除 13，纳入记录中有登记结果 33，比例 41.25%。参考 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| trial_calculations.csv | `ce5be45173e72f859c525876424d87eacd4a9c88d79afce550fbf3232e719da6` |
| availability_summary.csv | `64e40cf520346dd84f3e07310314b3b7a8e5ce44929aa9963967b23e42c8721e` |

本案例只复算冻结输入，不重新采集登记库、不重放完整上游智能体，也不将数值一致称为结论的科学验证。

## Harness²：原 demo 的带符号账本任务

复用固定上游 [DemoAdapter 的两份 CSV](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/demo.py)。
使用 `Decimal` 对所有正负金额求和，发布 `ledger-results.json`：

```json
{"ledger-1":{"count":3,"total":"85.15"},"ledger-2":{"count":3,"total":"20.25"}}
```

普通运行完成后展开现有 **Optimize task**，勾选 **Repeat this task with Notebook**，选择 Python。
保留原任务及两个输入，填入独立验收标准与上述 JSON，输出文件选 `ledger-results.json`。
首次选择 sequential、k=1，预览任务容量后设置执行预算，显式启动。基线、候选和独立审阅
使用已有统一核心与原 Harness² 方法；停止、进度和恢复继续走现有操作。

原 demo 的初始脚本故意只累加正金额，会得到 105.25 和 35.50；原 deterministic demo
用脚本化编辑器演示修复，不需要密钥。桌面模型可能在基线就正确核算，不能为了显示提升而
人为制造错误，也不能把一次正确输出宣称为普遍优化收益。上游 demo 与桌面试用的执行证据分别记录。

## 验证与来源

原数据、脚本、许可证和摘要见 [resources/trials](../../resources/trials/README.md)。
`scripts/earthnano/verify-upstream-trials.py` 验证固定计算、原输入与原 k=2 双模式递归；
桌面 E2E 另验附件、Notebook producer、产物真实字节、同任务基线/候选、独立 Review 和重开。
离线模型只替代模型决策，不伪造工具或持久化结果。live DeepSeek 结果应单列实际版本与范围。
