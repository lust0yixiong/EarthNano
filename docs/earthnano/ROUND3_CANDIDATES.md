# 第三轮候选输入快照与目录物化

实现起点 `5496df99a`。本轮按用户最新指定支持 **Claude Code**；不实现 OpenCode backend、
自动优化或生产 Python transport。范围仅 `candidate-snapshot.ts`、其测试及本记录。

## 已实现的最小边界

`createCandidateSnapshotStore({ root, candidatesRoot })` 创建两处互不包含的内容存储和候选目录。
API 使用共享 wire 中现有 `Ref`，不新增共享字段：

- `freeze({task,harness,agent,environment})` 返回四个引用。task 为 prompt 与 `{path,content}`
  文本文件；harness 为 instructions、通用路径的 Skill 文本资源和 `tools:'workspace-only'`；
  agent 仅接受 `backend:'claude-code'`、model、opaque providerRef、runtimeVersion；
  environment 仅接受 `directory-process / provider-only` 声明。
- `freezeInvocation({taskSnapshotRef,harnessRevisionRef,mission})` 冻结本次实际提示，并核实其两项来源。
- `resolve(request)` 读取并验证五个引用的 kind、version、SHA-256、规范化字节和完整 payload；
  invocation 引用的任务与 Harness 必须与请求一致。返回深度冻结的 payload。
- `materialize({executionId,refs})` 仅在全体引用通过核验后，独占创建新候选目录，返回 cwd、
  inputDir、outputDir、runtimeHome、harnessDir、instructionsPath、skillsDir、已核验 payload、
  相对路径 manifest 和 materializedDigest。已有目录、文件或链接都不得复用或覆盖。

内容存储使用规范 JSON 与不含工作路径的 opaque ID；文件和目录 fsync 复用既有 durable-files。
原对象后续修改不影响快照；重新打开 store 仍可验证引用，不依赖内存注册表。
创建失败留下的损坏内容对象不会被静默覆盖；目录物化失败不返回“已准备”结果，部分目录留给
上层确认并处理。模块不启动进程，也不承担活进程目录的删除或清理确认。

候选有独立 `workspace/inputs`、`workspace/outputs`、`runtime` 和 `harness`。
输入、instructions、Skill 文件均复制为独立普通文件，不做 symlink/hardlink 共享；文件 0400、
对应目录 0500，outputs 和空 runtime 保持可写。上层负责把通用 Skill 文件映射为 Claude 原生布局。
路径拒绝绝对路径、穿越、反斜杠、控制字符、保留设备名、重复与常见 Unicode/大小写碰撞，
也拒绝文件与目录重叠。Skill 资源仅接受 md/txt/json/yaml/yml/csv/tsv，不支持执行脚本或任意工具。
目录逐层创建并核查，不在未核查的链接祖先下递归写文件；对象读入同时校验普通文件、链接数、
目录/文件身份、实际 UTF-8 字节及摘要。O_NOFOLLOW 外另做 lstat，以兼顾缺少该标志的平台。

Agent 对象不接受 key、URL、executablePath 等字段；模块不读取进程环境、登录目录或 provider
认证配置，不生成含凭证的 native settings。providerRef 必须由可信调用方提供 opaque handle。
任务和指令本来就是用户授权的文本，模块不声称能从任意文本中自动识别或脱敏秘密。

## 能证明与不能证明的内容

`materializedDigest` 只证明本模块准备时的输入/指令/Skill 投影，包括引用及逐文件摘要；
不涵盖后续生成的 Claude native settings、凭证、实际模型加载或执行后产物。原生配置的摘要、
生效证据和产物版本仍由运行层及既有结果 owner 记录。

directory-process/provider-only 是本轮许可策略与连接范围声明，不是 OS 沙箱承诺。
同 UID 仍可 chmod 自己的只读副本；测试明确证明这种修改不会影响另一候选或内容存储。
实际工具检查、只允许写 outputs、禁止越界读取、provider 路由、取消与进程树退出确认属于
Claude runtime/owner。该模块不把“已创建独立目录”报告为所有隔离和清理边界已通过。

## 实测与范围

环境：macOS arm64，复用主智能体已安装的 Node 24 与现有 node_modules。
worktree 仅创建 ignored 依赖链接，未安装或更新依赖，未运行 build:packages，未修改锁文件。
本模块测试只在临时目录读写；没有模型、账号、个人凭证或外部数据请求。

实际命令（仓库根；以下均使用 `PATH=/tmp/earthnano-openscience-round1/node24bin:$PATH`）：

```sh
node node_modules/vitest/vitest.mjs run --project=default --maxWorkers=1 src/main/earthnano/candidate-snapshot.test.ts
node node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck --target ES2022 --module NodeNext --moduleResolution NodeNext --esModuleInterop src/main/earthnano/candidate-snapshot.ts src/main/earthnano/candidate-snapshot.test.ts
node node_modules/eslint/bin/eslint.js src/main/earthnano/candidate-snapshot.ts src/main/earthnano/candidate-snapshot.test.ts
node node_modules/prettier/bin/prettier.cjs --check src/main/earthnano/candidate-snapshot.ts src/main/earthnano/candidate-snapshot.test.ts
git diff --check
```

首次实现提交 `f1acd7c11` 的实际结果：**29 项 Vitest 通过，退出码 0，751ms**；TS strict、ESLint
及 diff 检查通过。主智能体另整合并重跑模块与 owner 测试，结果由主报告记录。
补充显式 lstat 与 inode 一致性检查后，复验仍为 **29 项通过，退出码 0，749ms**；
TS strict、ESLint、Prettier 及 diff 检查通过。不把本机测试宣称为 Windows 验证。

覆盖：输入对象修改后快照稳定、规范顺序/并发去重/重开存储、五引用与 invocation 配对、
磁盘 tamper/非法 UTF-8/伪造引用、路径与大小写碰撞、策略/脚本/秘密字段拒绝、环境不被序列化、
symlink/hardlink/中途插入链接拒绝、重复 execution 拒绝、同任务两个候选的独立 inode 与
outputs、投影摘要可重复性。未测真实 Claude 配置加载、模型响应、OS 沙箱及进程清理。
