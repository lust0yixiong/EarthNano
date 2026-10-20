# 第二轮：共享执行契约与两侧路径抽取

本轮完成共享类型、执行核心和确定性契约测试，再由两个 `gpt-6.1-sol / high` 子智能体
并行抽取 OpenScience 与 Harness² 的真实执行路径。主智能体审查并整合两个提交，补充
Python→TypeScript 跨进程验证。没有切换默认桌面执行入口或安装自动优化闭环。

本 PR 基于尚未合并的第一轮 PR #2（`docs/round1-core-contract`）。它只提交第二轮差异，
不自动合并前一轮，也没有启用上游 GitHub Actions。

## 门禁与协同顺序

1. 主智能体提交 `54135cd13`：单一 schema、TS/Python 类型、共同核心及16项契约测试；
   测试、生成物一致性及定向严格类型检查通过后才启动两侧抽取。
2. 两个子智能体分别在独立分支/worktree 工作，不自行扩展 wire 字段；主智能体补充损坏
   journal/退休 owner 测试，将核心门禁扩为19项，并提供 Python 完整回执校验。
3. 两侧提交整合后，主智能体在 `bd686944c` 统一回归；后续提交仅整理文档和来源记录。
   版本生成文件由同一脚本维护，不分别维护两套手写类型。

## 模块与实际调用关系

| 模块 | 本轮结果 |
| --- | --- |
| `contracts/execution/schema.json` | 唯一 wire 定义，包含冻结引用、角色、运行身份、配置事实、用量、证据、取消与事件 |
| `scripts/earthnano/generate-contract.py` | 生成 TS 类型、Python TypedDict 和随包 schema；`--check` 防漂移 |
| `src/main/earthnano/execution-core.ts` | 统一接纳/去重/冲突、次数预算、状态、取消、超时、事件与恢复 owner |
| `src/main/earthnano/execution-store.ts` | POSIX 单写者文件 journal；原子保存、锁、恢复时禁止自动重放 |
| `src/main/acp/task-prompt-execution.ts` | 从既有 TaskAgentPort 抽取 prompt 映射、通知、observed dispatch 和 cancel；原路径实际复用 |
| `src/main/acp/earthnano-execution-driver.ts` | 显式 opt-in 核心 factory，借可信 resolver 复用原 Session/Artifact/Review owner |
| `vendor/harness2/harness2/core/method_execution.py` | 方法执行依赖统一为 seam；端口模式使用同一 ExecutionRequest/Record |
| Harness² `schedule/recursion/selection/proposer/context` | baseline、candidate、proposer、composer、selector、reflection 贯通 seam，控制停止穿透普通回退 |

OpenScience 已有 Task API → TaskAgentPort → **抽取的共用 dispatch** → 原 ACP runtime。
新增内部入口 ExecutionCore → ACP driver → TaskAgentPort → **同一 dispatch**。
Session turn admission、provider acceptance 和核心接纳各自保留语义。

Harness² 方法 → MethodExecution：默认 legacy 保持原 adapter/Proposer 行为；显式注入
PortMethodExecution 时 → 可信 request factory → ExecutionPort → result reader → 原方法。
端口路径不再旁路调用 legacy solver/proposer，也不读取其旧缓存作为当前结果。

测试中另建立真实 Python method client → 测试 stdio → **同一个 TS ExecutionCore**：
普通 task 和 proposer 共用两次准入额度，第三次执行被拒绝，停止向方法层透出。
这段 stdio 是测试夹具；生产传输尚未安装。

## 验证结果

集成检查均在同一个源版本上进行。环境为 Darwin arm64、Node 24.22.0、Python 3.12.13，
复用第一轮依赖与当前平台 Prisma 生成物。逐文件统计见 [机器可读结果](ROUND2_VALIDATION.json)。

| 检查 | 结果 |
| --- | --- |
| Vitest：原有19文件764项 + 核心19项 + ACP driver21项 + 跨进程1项 | **22文件805项通过，0失败、0跳过** |
| Harness² unittest：原工作流5项 + 新执行 seam19项 | **24项通过** |
| `npm run typecheck:node` | 通过，包含 build:packages、全项目 Node strict 与 sandbox typecheck |
| schema/生成类型一致性 `generate-contract.py --check` | 通过 |
| 新增/修改的 TS 模块 ESLint | 通过 |
| Python core、生成脚本和跨进程夹具的源码 compile | 通过 |
| Git diff 与提交范围核对 | 通过；未改锁文件、工作流、公开 API 或默认 bootstrap |

重跑：使用 Node 24，在仓库根目录执行以下命令；Vitest 文件清单直接来自验证记录。

```sh
npm run build:packages
python3 scripts/earthnano/generate-contract.py --check
python3 - <<'PY'
import json, subprocess
with open('docs/earthnano/ROUND2_VALIDATION.json') as f:
    files = [r['path'] for r in json.load(f)['vitest']['results']]
subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run',
                '--project=default', '--maxWorkers=1', *files], check=True)
PY
npm run typecheck:node
(cd vendor/harness2 && python3 -B -m unittest discover -s tests -v)
```

中间遇到共享依赖目录的 `file:` 链接指向另一 worktree、部分包不可解析的问题；两个
worktree 同时准备依赖还会改写这些链接。只修复 ignored 依赖链接后，将最终检查集中在一个
拥有物理依赖的 worktree。最终805项和类型检查均通过，未用修改锁文件或业务代码绕过。

## 明确保留的边界

- `origin` 表示触发来源；实际执行 Session/prompt 放在 `identity`，候选可有独立目标会话。
- 取消请求、超时和进程退出不同；清理未知会保守阻止同项目同环境继续接纳。没有自动清理
  栅栏释放、生产 reconcile 或跨进程强杀能力。文件锁崩溃恢复需要确认旧 owner 已退休。
- 预算目前是持久化的准入次数，失败/取消也计入；不是金额上限。用量无事实时保留 unknown。
- 事件为有界回放，固定产物引用由原 owner 提供；不是完整审计仓库或新的产物数据库。
- 可信 Ref 内容存储、配置编译、生产 resolver/request factory/result reader、真实隔离、
  生产 transport、默认 bootstrap、自动优化触发均未完成。配置字段存在不代表真实加载成功。
- 本轮没有付费模型执行、Electron 启动、完整 npm test、桌面旅程或打包验证；确定性测试
  证明接口与控制语义，不证明科研结果正确或优化收益。

下一轮按 [任务清单](NEXT_TASKS.md) 的任务3推进一个后端的配置生效和候选隔离，随后再完成
生产连接与一次真实闭环。两侧详见 [OpenScience](ROUND2_OPENSCIENCE.md) 和
[Harness²](ROUND2_HARNESS2.md) 的实现记录。
