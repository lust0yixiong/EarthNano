# Alpha Notebook 验收原始结果

保留所有已发生的付费尝试，包括未通过的结果。以下文件是测试原始 JSON 的逐字节副本；不是挑选成功重跑，也不是完整 Alpha 或发布提交验收。早期测试没有记录精确源 head，最终发布前必须对固定提交重新验证。

| 文件                                   | 结果和边界                                                                                                                                                                                                                             | 原始文件 SHA-256                                                   |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `offline-notebook-stop-resume.json`    | 离线确定性 provider、真实 Claude Code / Notebook / Electron：完整普通任务、并行 k=2、停止、重开、显式续跑、独立评估和零付费重放通过。19/24 次接纳、57 个本地请求、8 次实际科研 Notebook 运行。模拟用量 0 不能解释为真实模型费用。      | `dff88f3b80a3e6e7993368787534af6bf0bdd317643df53870ea034fc313872e` |
| `deepseek-attempt-1.json`              | 真实 DeepSeek：科研、独立评估、续跑和重开检查执行完成，但最后 provider 拒绝计数断言失败，整个验收仍为失败。旧代理未保留该拒绝原因，不能追认它一定是主动停止。103 个本地请求，其中 1 个在转发前暂停；精确远端接受数和该次停止用量未知。 | `67132086c75134a4c03a2227c9b11497d0f7a168bc3d3aa614df7fbe5cbd9a56` |
| `deepseek-attempt-2.json`              | 真实 DeepSeek：6 次上游请求，无代理拒绝。普通科研任务生成产物后，原最终化证明报告 `version-message-conflict`，运行失败；未进入优化。                                                                                                   | `9ee7182905ac0fb439d04d22f671c211f04ef1fa78ff89659f1a39e3068d0a8a` |
| `offline-owner-fixed.json`             | 原产物竞争条件修复后的离线完整链通过；精确源码 `e934e2732`、干净工作树和实际构建入口摘要已记录。59 个本地请求，零上游请求；此时离线选择器仍另写文件，没有覆盖仅回复路径。                                                              | `19a9e7982801e8a4d89ba725abeb524e1f6e7806679b6378352e42d85869d998` |
| `deepseek-attempt-3.json`              | 同一源码和构建，真实 DeepSeek：普通 Send、基线/候选与组合完成；选择器提交合法回复但未另写文件，融合层完整性审阅因此阻断，独立评估尚未开始。19/24 次接纳含两次原停止阶段，98 本地 / 97 上游请求、1 次确认客户端取消，整体验收失败。     | `ec8e9f335381229695e5003551aa86f6388ec95ee7af9baa170ee8726b596a71` |
| `original-selector-reply-control.json` | 相同实际选择回复在固定 Harness² 原 `selection.run_selection` 和集成原实现中均接受：选择 B、非 fallback、一次模型桩调用、无需模型写文件；为离线契约对照，不是付费质量评估。                                                             | `bedc24b34ca3340e5443495b01bf66d5fdc833ebefa313449159338d4ce4550f` |

前三次付费尝试累计观测 input=762949、cacheRead=3085440、output=69201；本地请求合计 207。第一轮未知转发和停止用量仍未知；第三次的 `incompleteRequests=1` 明确保留，不会因修复了取消分类就声称费用完整。以上是观测计数，未覆盖的停止请求用量及货币费用未知；不能把缺失值当 0，也不能将本地请求数当模型 turn 数。每次限 160 个请求、单请求最多 2048 输出词元、90 秒上游超时；优化总接纳上限为 24。

第三次原始 journal 与 Session 均保存，两个已完成基线的续跑复用和精确取消 retry 关联可检查。仅回复的选择结果在原 Harness² 合法，但融合层额外要求选择器另写文件，导致空文件 inventory 的完整性 Review 警告阻断后续评估。原选择语法、候选完整性和预算未失效，修复须保留这些约束。

第二次日志的原错误链是 `validateArtifactFinalizationProof → ArtifactProvenanceMessageFinalizer.finalizeVerifiedRun → finalizeRunArtifacts`。原错误为同一 ArtifactVersion 已最终化到另一消息。既有日志显示产物在前置和最终两条助手消息中出现，但没有保留数据库足以确认首次认领者。原 proof/finalizer/ArtifactTurnOwner 相对固定上游无改动，尚不能据此归因为融合 Core。禁止覆写版本消息归属或削弱证明来通过验收。

现场保存缺口也按失败保留：第二次在优化目录建立前失败，旧 finally 中目录读取异常阻止了 Session 转储，且没有导出普通 Core journal。现已拆分三个独立保存路径并提前注册，后续失败将分别保留普通 journal、优化 journal 和原 Session 快照。缺失的历史事实不会补造。

后续已用固定上游原 owners 确定性复现同样的归属冲突，并完成最小修复；相同六场景原树 1 失败 / 5 通过，修复后连同原相关测试共 243 通过。详见 [原路径对照](../../ALPHA_ARTIFACT_FINALIZATION.md)。这不补造第二次遗失的数据库，也不追认该次验收通过。

下一次付费验证仍须先通过修复后的完整离线复验，不以随机重试代替修复。实际托管构建证据与最终提交另记。

## 当前固定提交的通过记录

源码 `5812df666a479d23ee4f7684c0449266f12f0238`，工作树干净，原生后端/桌面重新构建。离线与第四次真实调用记录了相同构建入口摘要、Electron 43.7.5、Claude Code 2.1.232 和 DeepSeek Flash 请求配置。

- 离线直接返回合法 selector 回复，不再另写 selection 文件：完整链通过，19/24 次接纳、58 本地请求、0 上游请求。
- 第四次真实 DeepSeek：完整普通 Send、同一任务/固定输入下的原 k2 parallel、提案/组合/匿名选择、停止/重开/显式续跑、原产物/Review 及固定源内容的独立语义评估通过。22/24 次接纳；133 本地请求、132 上游请求，0 拒绝、1 个转发前暂停、1 个确认取消。已完成阶段不变，重开 0 调用。
- 两项独立语义评估均通过，本次基线95分、候选100分，单次分差不作为优化收益或科研能力提升的证明；配置仅 eligible，未发布。使用同一模型的隔离评审，非多模型盲审。
- 第四次观测 input=408933、cacheRead=2050304、output=52452、incompleteRequests=1。四次累计观测 input=1171882、cacheRead=5135744、output=121653，本地请求340；全部停止用量与货币费用仍不完整，未估算价格。
- 当前整合 owner/binding/runner/诊断检查95项、同 Python3.12.13 的固定原 Harness5项/当前63项均通过，0失败/0跳过；原产物竞争条件的六场景及原237项对照另见专页。Node/Web类型、接口生成物和本机重新构建通过。
- 以下原始文件保持逐字节副本。跨平台源代码/原生安装包 CI仍待完成，此记录不代表完整 Alpha 已完成。

| 文件                                    | 原始文件 SHA-256                                                   |
| --------------------------------------- | ------------------------------------------------------------------ |
| `offline-reply-fixed.json`              | `f32a50d173b4f81c41b1168dd81e9e7010b11cbe824d92e84e01cce574cf0146` |
| `deepseek-attempt-4.json`               | `f3f19ab75bff4120df5f797f68b88a7ad7bb743e75240d4ec61d54d1d4592566` |
| `harness-baseline.json`                 | `7f9b4af1cb3b5bf8ef949ad9bdf9a71f9bf0d92f5f285250a9fa082365618448` |
| `harness-candidate.json`                | `f1a29b96a67ca7574982b64707ac3026144b42314a59dab6205992b640e39b0c` |
| `harness-comparison.json`               | `3ba465966c77f2ed47a0d4841439bdde37a4a5a8d012eec08ebec523aa7d6a03` |
| `original-missing-harvest-control.json` | `6e5489292c9fe1b26fb6c93fc0618652780e3495ddff1635f9818ad85b87bb15` |

## 原用量与多模式准备（后续一轮）

固定应用源码 `b1cb766d6bc13fbb67787c18450b17df7c83d1a4` 的离线与第五次 DeepSeek 使用相同构建并通过，见 [本轮边界与验证](../../ALPHA_USAGE.md)。本轮首次离线缺少实时 runtime identity 的失败、原 journal及同场景修复前/后日志均保留；失败报告的60704869c工作树为dirty，不能冒充干净提交验收。候选 Python66项对照报告在干净 d4b20667d生成；v2原 scheduler control 的范围与源码摘要见 [专页](../../ALPHA_SWEEP_BINDING_V2.md)，并未启用 sweep。

第五次为21/24接纳、19/21优化用量覆盖，118本地/117上游请求，0拒绝、1确认取消、不完整用量1次。两项独立评分均95，没有收益证明；API/费用生产采集仍未知。

| 原始文件                                   | SHA-256                                                            |
| ------------------------------------------ | ------------------------------------------------------------------ |
| `usage-offline-token-missing.json`         | `819aafca59039810d2a2e6a0048a4fe1997d3c25a8dddc8d6ae5b77e04130c04` |
| `usage-offline-token-missing-journal.json` | `8bb03626e5f2fb6d93abb8f7ed3dd5dfcbf0a7343dc155a729ce4b94b2906e78` |
| `usage-offline-fixed.json`                 | `1c79f58f98ffa93ed92fedbc35334cde4b65aec45243d5840aacfce31284ad54` |
| `deepseek-attempt-5-usage.json`            | `3b287fa112e8b979ca691bf287b8c45e43dc058224c9ec511025bc783d0e70f9` |
| `usage-harness-baseline.json`              | `7f9b4af1cb3b5bf8ef949ad9bdf9a71f9bf0d92f5f285250a9fa082365618448` |
| `usage-harness-candidate.json`             | `6eeef0806b52160f7d97ed1111cea3dc68bc7724e2fcc4ee25b7b74c3bcc983e` |
| `usage-harness-comparison.json`            | `58b42e4c3ecb5b048b322dbf6dc38448397d2db0e9b7630d1c4ae44f1ce5c583` |
| `sweep-binding-v2-control.json`            | `80aa516396473fc478957901e998c6884c38655db8bcf5476fc6d5dd4608168b` |
| `usage-identity-red.log`                   | `f42232bd6b65da6f385256167f906de7a7081408a504559794dfe9fb47d2c11e` |
| `usage-identity-green.log`                 | `0a3bb4fa89fbb529ad7fefc7ae944bf9d6c75d3f795be75281e295d75b5fdebd` |
| `windows-runtime-cold-timeout.log.gz`      | `f567df43ca37098859ee3e705ac7238762991d0165e8aa16a9608ea6c3a81cb6` |

Windows日志是bootstrap run [39438006915](https://github.com/lust0yixiong/EarthNano/actions/runs/39438006915) 的完整原始日志gzip副本，解压后 SHA-256 `1d5caccd7683c930baffbfda56affebcb306ab84eec7cdc469dc5f5810e11af0`。90分钟取消发生在原 Node约85分钟编译完成后、PowerShell crossgen2 阶段；后续source/native均跳过，不能计作通过。新CI的冷编译预算150分钟及Unix独立启动仅经过本机结构检查，hosted结果另记。

## PR14首次托管CI的失败原件

Run [39454904669](https://github.com/lust0yixiong/EarthNano/actions/runs/39454904669)，head2fc2a58f4，实际merge6a910b720与head文件相同。macOS job118739140883在安装Python3.12.13时失败；Linux候选job118739141566为native recipe fingerprint不匹配、job118739140680为独立npm ECONNRESET，均未执行源码测试。对照及修复见 [CI说明](../../ALPHA_CI.md)。保存观察时原Linux baseline仍运行，不能声称原版测试已通过或失败。

版本清单文件是官方manifest的两个版本条目投影，明确不是完整原始manifest；记录完整manifest SHA和投影生成UTC时间。gzip文件解压为原始日志，无文字改写。workflow状态文件为修复前真实API响应，确认原producer保持disabled_manually。

| 文件                                      | SHA-256                                                            |
| ----------------------------------------- | ------------------------------------------------------------------ |
| `ci-python-macos-unavailable-job.json`    | `eba06d07af70deb0638c32d30e3b27eb0b7eb41417cc4e60af7d97f93a3e2fbd` |
| `ci-python-macos-unavailable.log.gz`      | `8faf5b2d01a2a9bae0acd8be6f19b630ad1cab76c9922dda060953148408e9be` |
| `ci-python-availability-projection.json`  | `94625041765f6d2ed44dfd1000319ca7e757afcb34feed7a2240426c3cd51992` |
| `ci-native-fingerprint-control.json`      | `dda66acbd0c38eba5ccf5f3cbd3543a547665800689d916291650f7570a9b3fe` |
| `ci-native-workflow-disabled.json`        | `bcdf8d393c7b62aa2a3aa8598a49a978cd2c19bdc2727c0935c27bc6757bdd95` |
| `ci-linux-fingerprint-source-report.json` | `aafb1b2f60a91161596440bb13d6a18538ec337c8eba6b23430765dfdc2786e9` |
| `ci-linux-fingerprint-npm.log.gz`         | `097654e0f42b687267d78ab31b5abe75d0ac26cc0864ccf9735c80a020188893` |
| `ci-linux-network-source-report.json`     | `dd94b3172fe57c1b52cfc408267692252e2eb0233c5b701e04108072db325a25` |
| `ci-linux-network-npm.log.gz`             | `2bf4d642ec40d388713b270237f735906e4ad652a2294d72f70683625254d061` |

解压日志 SHA-256：macOS=`70ff6e10235ef9819e7007221092e65f2afc77e4a7aedf21cdd37e389573a0ff`；Linux指纹失败=`d58d2cd300b1580d6b0a9d02a1687337b09a28a3d80fd7166abac26759a3c047`；Linux网络失败=`14df712586c7e6080ee6da8e3a5ff883e838611715eb57229cd8856371dc5641`。

## 原完整 sweep 与 Notebook 双模式验收

固定源 `be1143b2a` 的离线第三次和 DeepSeek 首次使用同一构建；前两次离线失败、两份真实配置/投影红绿回归及 CI 下载失败全部保留。详见 [本轮范围和结果](../../ALPHA_SWEEP.md)。gzip 解压后为未改写原件；下面列压缩文件 SHA，附原字节 SHA。两次 `-t` 红测主动仅选择新增用例，未选的既有用例不算环境跳过，完整绿测另记。

| 文件                                              | SHA-256                                                            | 解压后 SHA-256（若 gzip）                                          |
| ------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `sweep-harness-baseline.json`                     | `7f9b4af1cb3b5bf8ef949ad9bdf9a71f9bf0d92f5f285250a9fa082365618448` | `—`                                                                |
| `sweep-harness-candidate.json`                    | `85e0de606d6076126377d39292aa5aab7319977229324886c41dc4263742773d` | `—`                                                                |
| `sweep-harness-comparison.json`                   | `4f93d48bea5a4ee4f81d70ac70599a8b00b06f47e20eb65bc452a943990dbf43` | `—`                                                                |
| `sweep-deepseek-attempt-1.json`                   | `585dbc7f22071e5192446aabc80e4bded898c5e4a6db66e6f672bc05836b6edf` | `—`                                                                |
| `sweep-offline-attempt-1.json`                    | `f69275cdb2e63b194900d2909a9568532025dbb0670afbce9b0ead13e466dc38` | `—`                                                                |
| `sweep-offline-attempt-2.json`                    | `12d136cd7a33b95eae9ff8805b60f1ab178aaef00a2dd56cefe11db72c3f21e6` | `—`                                                                |
| `sweep-offline-attempt-3.json`                    | `337c2a565574ca927a1c90fd1b9e3b0d1e62848e2bd5479ce1897d06f6ffd2a5` | `—`                                                                |
| `ci-sweep-linux-candidate-3-source-report.json`   | `b947a9ebca29a69a6addfaba67b3d450eab65687bb14fc499089d675413e437a` | `—`                                                                |
| `ci-sweep-linux-candidate-3-unavailable.json`     | `62fda2b777638e2944d5135b541a3103242d8ffa5da74135751b79c9cbd10446` | `—`                                                                |
| `ci-sweep-linux-candidate-3-diagnosis.json`       | `a23289613f4d5c1ce5dc0cad3d4404c753903a3bb88be37396275c19bdc07f76` | `—`                                                                |
| `ci-sweep-linux-baseline-3-source-report.json.gz` | `d03e58e39008b354ef2471de3edf373fa9375532bf6974c1cf1854a75ac17646` | `d8a5ed31527f4eedd5807abd6e3def652faca6a25b4d24463f3029f81f096c6e` |
| `ci-sweep-linux-baseline-3-summary.json`          | `9b70ac11a793ae77e5e4d1ac0bebf8d1dcfb7125af3a4b74f193c1b82970444a` | `—`                                                                |
| `sweep-config-red.log.gz`                         | `dbc0258295c42adf79c156a88647539bb0ae966e34c506ac90a6e262c3dca0ce` | `57145c0efa8066646a7f21d6b71d0dd0e3310e8e08894f7c06414b9d93812097` |
| `sweep-config-green.log.gz`                       | `69e22c69e6114a6dade84f17ce2a283e03ee205f347ed836ac9660e4deb4815b` | `599211c7ec7eaedb553629a365cd75d3779127331ae975a2e09c05dc637e20ca` |
| `sweep-source-json-red.log.gz`                    | `bc3472b0be1dc58f4d669a80c058d7afcf0ce46237b4c0ac475eb0fd0a24a9f7` | `9be316f9d749a3dd75a8be180e6a0837e083e5f1106c3e9cf4813564d64ef6a9` |
| `sweep-source-json-green.log.gz`                  | `e99c7e428bac932e527fe8128265f6780960b785ffccedc52d566ede64f1086e` | `e4772384ba7c0ff25afe7c1d239965e2d892f2ce8ed1c4be8dc4ad6e24fcd0ef` |
| `sweep-host-inventory-control.log.gz`             | `48086d0ec25c0baa3a915660655ebfedbdae5b5866162d267baed779e9957ffd` | `79937cb85ff3be0d4fff9568c8817ddecb9c6fe2e6126a44e9a6ecc752600d50` |
| `ci-sweep-linux-candidate-3.log.gz`               | `b7a8f9e1d7a27ef4cb2c90268198c65d15fe4e73b5406d5d54dc2a306438be85` | `e6f52f5154616034cb511813ef1a1ebe5590bc41bd00cd0f618e26411faef481` |
| `ci-sweep-linux-candidate-3-npm.log.gz`           | `4f3c1be60f4e1c54e3ec1345193fb7004b3051688407467475e787cf9628bc8d` | `a752b9d7b0c7a28de10374697d813d100d0c90a85e9e21fdf57f6994b157f132` |
| `ci-sweep-linux-baseline-3-vitest.json.gz`        | `a4871e6e159ab7d4bf0f03403c49d4763d36ef2358a9d7226d685a932cc69149` | `cb8796cc69fdafd5870a5dd983acc06e00f80fc0133e8cb781a739ef603033a6` |
| `ci-sweep-linux-baseline-3-npm.log.gz`            | `4eada3a3e2f55f1c177aa59c71e54f7c090043db6f1c51abdfe2011219565073` | `d5eb8dcc2dfcdd83d3b84cd0e213b29b6533ca2eddfcca61b87cace759f1a0fe` |
| `sweep-offline-attempt-1.log.gz`                  | `6543513a01d610942235f0e4a996c9f70cc09ab1c89b33491b45c1a9d915b5ff` | `fc3f61d8a1c217579cb88ede1d09086c24174c907ac00421ba08ca85973cc0fb` |
| `sweep-offline-attempt-2.log.gz`                  | `29e68af212d571285b1c9421be7d49e55f0de08101c9bef2ac85cd8f267858b8` | `7e39da1d314e8dcd1a2a13d8140419efbf2b6f5b805c2418173fb8d24a9eb465` |
| `sweep-offline-attempt-3.log.gz`                  | `59088eed3caaa098a43418b017a451b4bb330ac6bb41ddce0732627c977a2de3` | `2e82ade7855f0a9bef2d42545403b1ab9ef5c6212b565c36984bb50f9a5f032c` |
| `sweep-deepseek-attempt-1.log.gz`                 | `b72203fe427603fdbd79fc494ef218fcd2cdbdd308a68c0332e7a887b8417006` | `40de3f206c2f693ba268ca26912a74dca8ecbed809a62831d151eb9793d2782a` |

Hosted baseline3 的 18,953 passed/295 skipped/0 failed 是上游单分片原始事实，candidate3 的安装失败没有测试结果；其 Node/runner image 不同，不能据此声称匹配环境的候选回归比较已完成。原失败 run/job/artifact 标识、阶段、环境和其他原文件 SHA 均保留在上述诊断及 source report。

精确 Host Node 官方 release/index 核验记录：`ci-exact-node-official.json`，SHA-256 `04462df9d97b9a2d42a16a436ac8ebfd7f2fdb805c03d16aeeb6d860dfec71ee`。它记录官方发布链接/校验值；本机直连探针超时，未冒充二进制下载或执行。

## PR15 托管 CI 在 runner 分配前被账户限制阻止

Run [39464594843](https://github.com/lust0yixiong/EarthNano/actions/runs/39464594843)，固定 head `3b8e6222450a8b40f13f051a7596273f29e1c955`。plan job118772549558 和 Windows runtime job118772549335 的原始 annotation 均报告近期付款失败或需要提高支出限额；plan 的 runner_name 为空、steps 为空。源码、依赖安装、Python/Node 设置与测试均未运行；这不是 Node 固定修复的通过或失败证据。不修改账户费用设置，也不以重复触发替代恢复账户可用性。本轮本机/DeepSeek 证据继续有效，跨平台与原生包验收仍待完成。

| 原始 API 返回                               | SHA-256                                                            |
| ------------------------------------------- | ------------------------------------------------------------------ |
| `ci-sweep-account-plan-annotations.json`    | `7f755c7b6906256c87f396c463ee0db865c8ae5564f57ec4915c288ca57b1625` |
| `ci-sweep-account-windows-annotations.json` | `7f755c7b6906256c87f396c463ee0db865c8ae5564f57ec4915c288ca57b1625` |
| `ci-sweep-account-plan-job.json`            | `3bf60a04a03984604ee3e736150e9b1aa01367191e6374a6acb226173ae90180` |

## Catalog 与两来源 Notebook 验收

见 [本轮范围与所有尝试](../../ALPHA_CATALOG.md)。`catalog/manifest.json` 记录 105 份原始文件的压缩前/存储 SHA-256，涵盖三次浏览器、三次原生离线、首次 DeepSeek、原源码控制及最终检查；gzip 解压后为原字节。`catalog/source-and-checks.json` 另存固定源码/四构建入口相同的对照与最终检查范围。原始失败的 JSON、Session/journal 与日志保留，未挑选付费高分重跑。

首次 DeepSeek 两来源双模式 k1 通过：40/48 核心接纳、210 本地/209 上游请求，零拒绝、1 上游取消、用量不完整1项。生产覆盖38/40；API/美元未知。两来源同任务/固定版本/实际 Notebook producer/6个独立评审、停止/重开零重放通过。单任务 k2 的本轮原生验证为离线；更广 Alpha 与平台打包未因此完成。

Windows 检出路径修复：`catalog/archive-path-map.json` 保存三份 ordinary journal 的原路径到短路径映射。只缩短归档文件名，gzip 存储字节、解压后的原始字节及两组 SHA-256 均保持不变；`catalog/manifest.json` 指向现有短路径。保留证据中的历史文件名通过映射追溯。

2026-10-22 Windows 恢复：真实运行 `39699282330` 在检出时遇到六份后期证据的长路径。`windows-0.2-archive-path-map.json` 保留旧路径到短路径的映射；只改归档文件名及 manifest 定位字段，gzip 字节、原始字节和两组 SHA-256 不变。没有删除证据或改动原测试。
