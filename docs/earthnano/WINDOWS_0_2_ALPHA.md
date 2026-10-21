# Windows：延期至 0.2-Alpha

2026-10-21 用户决定：**Windows 安装失败留到 0.2-Alpha 修复，0.1-Alpha 先跳过 Windows 版本。**

0.1-Alpha 的源码对照、原生构建、安装与发布范围调整为 macOS 和 Linux；原生目标为 macOS ARM64/x64、Linux x64/ARM64。当前不再开展 Windows 安装器排查、构建、CI 重跑或发布。已有 Windows 源码、打包配置和失败证据保留。历史失败不改记通过，也不据此宣称 Windows 可用。

## 已知故障与证据

| 记录                                                                                                                                                       | 实际结果                                                                                                                                            | 结论边界                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| [原生运行 39555053834](https://github.com/lust0yixiong/EarthNano/actions/runs/39555053834)，源 `c1e663279038c4bdba9d26ba9f3d0c5484ecf2c7`                  | 四个 macOS/Linux 原生目标通过；Windows 构建出安装器，安装 smoke 返回 exit 2、目标目录为空                                                           | 此运行整体未通过五目标验收；四个成功目标属于当时提交，不能证明后续代码的最终发布包                                        |
| [诊断运行 39573702221](https://github.com/lust0yixiong/EarthNano/actions/runs/39573702221)，源 `8db97e9562b2af26b84aaacec16cfef30243b7df`                  | Windows 安装仍失败；默认 Node 参数序列化给 `/D=<含空格路径>` 整体加引号；旧 probe 首例失败后中止                                                    | 引号与原宏解析存在源码支持的冲突，但不能据此解释所有 exit 2；可选步骤的绿色状态不等于 probe 或安装成功                    |
| [诊断运行 39577934563](https://github.com/lust0yixiong/EarthNano/actions/runs/39577934563)，源 `f6329ed8cf5993a9b8a807b393b7640c395b42cd`                  | 改用 verbatim 参数及显式 argv0 引号后，安装仍 exit 2、目标目录为空；probe 因误选 stock `MultiUser.nsh` 缺少宏而编译失败，未执行任何 case            | 参数调整没有修复安装；尚无实际阶段证据确定根因。显式锁定 app-builder include 的后续本地修复未在 Windows 验证              |
| [源码运行 39566641858](https://github.com/lust0yixiong/EarthNano/actions/runs/39566641858/job/119111287665)，源 `e74c6f178a559bf04ec23e3695853536724226e9` | Windows candidate 8/8：19,573 断言，19,006 通过、91 失败、476 跳过，另有 2 个真实全局错误；baseline 8/8：18,731 断言，18,300 通过、2 失败、429 跳过 | 两侧原始断言与 sidecar 数量一致，但候选全局错误使原验证器判为 unavailable。不能笼统归为环境故障，也未放宽完整性或比较规则 |

最近一次原生失败的原始 job log、probe、构建配置及摘要见 [保留证据](validation/alpha/windows-deferred-0.2/manifest.json)。之前四个 Unix 目标的记录见 [原生构建证据](validation/alpha/native-39555053834/manifest.json)。源测试的原始报告与 sidecar 保存在对应 Actions artifact 及本地验证归档中，未重写。

## 已尝试内容与保存位置

固定上游仍为 OpenScience `9e18c7d3c143a9dba49c7a586ad6cac8096f6dd5` 和 Harness² `1cfe254e8d25b15f37048c3730134686abe60335`，以 `UPSTREAMS.json` 为准。恢复工作时继续对照同一环境的原源码、原脚本和原测试，不能通过降低断言或更换编译器来取得通过。

| 保留分支（已同步 GitHub）                                                                                                                   | 精确 head                                  | 状态                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| [fix/alpha-windows-0.2-preserved](https://github.com/lust0yixiong/EarthNano/tree/fix/alpha-windows-0.2-preserved)                           | `31cf7029e3f4f317403f961f7bd1012b2cb14e59` | 保存本轮安装器参数、probe、源码修复及诊断文档；包含未获真实 Windows 验证的工作，不并入 0.1                                                          |
| [fix/alpha-source-windows-regressions](https://github.com/lust0yixiong/EarthNano/tree/fix/alpha-source-windows-regressions)                 | `cb8df6f65879d2c18a8d4e886559d3912f99f21f` | 保存目录 durability、host 注入、UTF-8 fixture、快照攻击 fixture、ACL 检查及继承上游 SQLite 完整性修复；有本地定向证据，尚未通过 Windows hosted 验收 |
| [fix/alpha-windows-installer-stage-diagnostic](https://github.com/lust0yixiong/EarthNano/tree/fix/alpha-windows-installer-stage-diagnostic) | `0576b813739238f21dfdfa0272dad34d5c5b518c` | 仅未验证的隔离阶段诊断 helper；未接 workflow、未构建或安装，不能作为修复或成功证据                                                                  |

通用 CI 路径/UTF-8/测试分类修复 `171e0127070baf56aec206836815db362f2bdb5e` 同时关系 macOS 的严格对照，单独保留在 0.1 分支；其余 Windows 专项尝试不因延期而删除，也不作为本版交付内容。

## 0.2-Alpha 恢复清单

1. 核对保留提交与届时固定上游差异，先审查未验证诊断 helper；不要直接合并整条试验分支。
2. 在真实 Windows 上先验证锁定原 app-builder 宏的 probe，再定位静默安装的实际失败阶段。当前缓存 NSIS 未启用 `NSIS_CONFIG_LOG`，不能将 `/LOG` 当作已可用的日志方法。
3. 修复后重跑原安装资源、R/runtime、RPC/health、启动和用户数据兼容检查。安装器打包成功不足以证明可安装。
4. 在相同 runner/Node/Electron 条件下重跑原上游与候选源码测试，分别处理基线失败、新失败及全局错误；保留原 inventory、skip 和差异比较门槛。
5. 取得 Windows 源码与实际安装的完整证据后，再恢复 Windows 构建、验收及公开分发，并更新版本支持范围。

本次延期不改变 Python/R/Compute、产物/审阅及 Harness² 原方法的融合范围。0.1-Alpha 尚须完成其余融合、macOS/Linux 最终验证及 PR 审查，不能因跳过 Windows 就标记版本完成。

发布准备同步采用显式 `mac,linux` 范围，清单与认证聚合器均拒绝混入 Windows 文件或引用，不把缺少 Windows 记录伪装为完整五目标验收。相关 130 项本地检查使用合成文件字节，未执行 Windows 安装、诊断或 CI；见 [发布范围验证](validation/alpha/unix-0.1-release/manifest.json)。原稳定发布工具的完整默认保留，实际 Alpha 发布入口尚未启用。
