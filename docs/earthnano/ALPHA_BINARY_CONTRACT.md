# Alpha 二进制产物：最小契约与实施边界

本分支从 R 集成 `78d99aae5` 开始，独立推进原先已列入完整 Alpha 的二进制产物能力。R 运行时准备和验收继续进行；二进制类型存在不代表产物、选择或评估已接通。

## 已核对的原模块

- `ArtifactReference`、`ArtifactVersion` 和 `ManagedFileVersionReadPort` 继续是身份、字节与固定版本租约的权威。原 `readRange`、`copyTo`、`verifyUnchanged` 可直接复用，不新增字节存储或模型可调用的任意版本读取器。
- `PersistentCandidateOwners.readFiles` 已沿原版本读取并核对摘要，但目前总是 fatal UTF-8 解码。原 Notebook/Artifact producer 已能发布二进制，候选导出会在此失败。
- Harness² 原匿名选择的 `deliverable_assets` 已支持显式命名的文件资产；当前 EarthNano adapter、`PlatformResultReader` 和私有 JSONL 只接受文本，尚未使用该资产路径。
- 原候选 native `Read` 已限定在准备好的 INPUT、OUTPUT 和 plugin 范围。为选择者展示合法产物，应物化进已受限的 INPUT，而不是扩大到原数据目录或宿主任意路径。

## 共同契约

1. `CandidateTextArtifactFile` 保留原 `{path,content,digest,artifactRef}`，旧文本不增加 discriminator、长度、MIME 或其它字段。旧 JSON、摘要、缓存和方法上下文字节要有回归证据。
2. `CandidateBinaryArtifactFile` 仅有 `{path,representation:'binary',sizeBytes,contentType?,digest,artifactRef}`。长度和 contentType 来自原 Version；digest 必须与引用 checksum 一致。描述不包含 content、bytes、base64、宿主路径、权限或虚构 producer。
3. 共享 normalizer 只检查传输形状及引用一致性。原 owner 仍须核对执行、Project、Session、producer、Version 身份，遵循原路径/资源预算，并读取整段字节验证摘要与租约。类型校验不代表拥有读取权限或字节已验证。
4. `exportResult.files` 演进为上述 union。科学执行直接复用原 producer 和 ArtifactVersion；workspace-only 原文本写入能力不因新增 union 获得 Shell、安装或任意二进制写入权限。
5. 方法传输保留 binary descriptor。仅在已确认 execution evidence 中的同一引用，可经原租约复制到受控临时投影。复制后的文件须核对长度/摘要，路径仍用既有 portable path 规则；软链接、重名及重叠路径继续拒绝。临时投影不是第二份产物事实。
6. 匿名选择复用原 `selection.py` 与显式 `deliverable_assets`。文本 deliverable 保持原文；二进制只显示明确标注的元数据和真正物化的资产。不能把元数据写进 `figure.png` 冒充原文件；不能把资产存在说成选择者已经阅读、理解或验证。
7. 资产身份进入原 invocation/投影恢复身份，仍绑定同一 Core 的已提交 execution/ArtifactReference。更换引用、字节、runtime 或配置时拒绝旧缓存；停止、重开和显式续跑不能重新调用已完成阶段。
8. 独立评估保留原 Review。JSON checks 只检查声明的 JSON 输出；图像/列式数据等格式不能替换解码后送入 JSON parser。未提供适用 verifier 或可读证据时，应明确不可评估，不能生成通过或科学正确性结论。额外二进制产物本身不妨碍已有可检查文本标准，但不等于已审阅该二进制内容。

### 原 owner 与方法之间的内部边界

- 平台在 `PersistentCandidateOwners` 增加 `materializeArtifact(record, artifactRef)`，返回 `{file: CandidateBinaryArtifactFile, assetPath: string}`。仅当 host 配置了隔离的 `artifactProjectionRoot` 才可调用；owner 自行选择其下唯一目标，调用者不能传入宿主目标路径。原执行、版本、producer、整段字节和租约须全部验证，返回的 assetPath 仅供固定方法进程读取。
- 方法沿已有绑定增加内部 `materializeArtifact` 操作，只接受 `{executionId, artifactRef}`；execution 必须是该 task binding 已接纳且收尾确认的 baseline/candidate。descriptor 必须与该 record 的原导出一致，再转发上述 owner，不接受任意 Project、Session 或版本查询。
- 匿名资产文件名使用原版本身份的稳定不透明别名并保留扩展名，防止原 `selection.py` 按 basename 复制时不同逻辑目录重名。逻辑文件名与别名的对应明确标注；别名不泄漏 baseline/candidate 标签。
- 需要把资产送入角色 INPUT 时，方法给出 `{path, sourceExecutionId, artifact}` 的内部 manifest：path 是该上下文中的相对别名，artifact 是原 binary descriptor。绑定先核对已接纳源执行和引用；主智能体将 manifest 加入原 invocation 身份并沿原快照物化。manifest 的私有执行/版本身份不作为候选身份标签展示给选择者；模型只看到匿名路径、声明的元数据及真实可读资产。

以上不是新建执行接口或产物存储。三方使用同一字段和原事实记录；如原模块存在具体不兼容，先报告共同边界，不自行另起协议或状态库。

## 实施顺序与 owner

| 顺序         | 范围                                                                                | 验证                                                                                                          |
| ------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1 主智能体   | 共享文件 union、旧文本兼容和二进制描述契约                                          | 原 owner text 类型与 JSON 字节不变；混合内容、额外授权字段和引用不一致拒绝。测试通过后再并行修改两侧。        |
| 2 平台智能体 | 原版本 owner 导出、流式校验和精确引用物化；沿原 INPUT/native Read；独立 Review 证据 | PNG 等真实产物从 producer 到 Version 再到回读/物化逐字节一致；其它执行/版本不得取得访问，停止及租约释放保留。 |
| 2 方法智能体 | 原私有 JSONL/PlatformResultReader、EarthNano adapter 与原匿名资产 hook              | 文本方法轨迹不变；二进制无伪 content，匿名资产确为对应候选字节；选择只选原候选，恢复不重放。                  |
| 3 主智能体   | 同一 Core 科研任务及桌面集成、固定构建和有界 DeepSeek                               | 基线/候选共用固定输入，JSON 与二进制均有原 producer/Version；重开、停止续跑、独立评估边界与原科研流程回归。   |

不复制原选择算法、另建产物数据库或开启默认自动采用。所有上游差异须以固定 pin 对照；原有二进制导出限制不能通过删除产物、降低断言或只测文本来绕过。

## 当前证据状态

共享元数据契约的四项测试已通过，normalizer 源文件的独立严格类型检查通过。测试验证旧文本 JSON/类型形状、二进制描述及错误字段/引用的拒绝；没有调用原生组件或证明真实版本字节。第一次范围内类型检查因 TypeScript7 的 CLI 配置选择规则未启动，改为显式 `--ignoreConfig` 并提供完整目标/模块/严格参数后通过；全项目类型检查仍待完整依赖环境。本分支还未接入生产调用。原生依赖重建中的缺失组件不用于原生验收。R 与本分支分别保留验证记录、精确源码身份和 PR，不将任一部分算作完整 Alpha 完成。
