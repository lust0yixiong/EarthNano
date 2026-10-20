# 第九轮最小验收契约

本轮基于第八轮 `9aeb742ca`，沿用同一 ExecutionCore 与原事实所有者。验收先覆盖一条可计算、可重开的科研路径，再按上游模块列出覆盖证据；单条路径通过不代表所有领域、工具或平台均已认证。

1. 普通科研路径使用原 Project / Session、上传输入、Notebook MCP、真实 Python、Artifact MCP 与固定 ArtifactVersion。Notebook producer、Session turn 和共同 execution ID 必须能相互核对；不能由夹具另行发布文件来冒充工具工作流。
2. 优化显式启动，继续调用原 Harness² schedule / recursion / proposal / composition / selection / reflection / Library。方法层只读取任务、轨迹和合法候选，不读取独立验收答案。
3. 普通科研产物可作为优化输入。renderer 只提交当前 Project / Session 中固定 ArtifactVersion 的不透明身份、校验和及相对目标名；main 从原 ManagedFileVersionService 核对归属、版本、字节与校验和，冻结为现有候选文本输入，并保存来源清单。不得读取 renderer 任意宿主路径，也不得退回最新版本。
4. 现有文本 profile 的数量、单文件和总大小限制保持。二进制、大文件、Notebook / compute 候选工具仍需单独扩展，拒绝不能被报告成支持。显式领域任务共享选定来源文件，但各任务原有文件与验收条件保持独立。
5. 独立确定性检查和语义 Review 指向固定版本；实验完成、产物通过、配置 eligible 分别记录。重开读取原 Session / ArtifactVersion / Review 与实验状态，不重复执行或计费。
6. 离线原生进程、桌面 E2E 和付费 DeepSeek 的范围分别记录。DeepSeek 只在确定的次数、输出和时限内运行；密钥不进入仓库、报告或 provider prompt。

主智能体负责共同契约、受控产物输入、桌面验收与 DeepSeek；平台智能体负责原科研工具和存储链；方法智能体负责 Harness² 源码覆盖、方法等价与缺口修复。两条开发 lane 使用已约定的 `gpt-6.1-sol / high`，在独立 worktree 提交后整合。
