# EarthNano

EarthNano 将 OpenScience 科研工作台与 Harness² 配置优化机制融入同一执行核心：先在项目与会话中完成科研任务，再对同一个任务比较基线和候选配置，保留 Notebook、产物版本、来源与审阅记录。

当前版本：**[0.2.0-alpha.1](https://github.com/lust0yixiong/EarthNano/releases/tag/v0.2.0-alpha.1)**，提供 macOS ARM64/x64、Linux x64/ARM64 和 Windows x64 安装包。本版为未签名 Alpha 预览；Windows 配置优化仍不受支持，安装验收和已知限制见 [Windows 记录](docs/earthnano/WINDOWS_0_2_ALPHA.md)。

[安装](#安装) · [首次配置](#首次配置) · [试用上游案例](#试用上游案例) · [第一次科研任务](#第一次科研任务) · [完整使用指南](docs/earthnano/ALPHA_USER_GUIDE.md)

## 安装

普通用户下载已打包的应用即可，无需克隆仓库、安装 Node.js 或执行 `npm ci`。

| 系统与架构 | 下载文件 |
| --- | --- |
| macOS Apple Silicon（M 系列） | [ARM64 DMG](https://github.com/lust0yixiong/EarthNano/releases/download/v0.2.0-alpha.1/EarthNano-0.2.0-alpha.1-mac-arm64.dmg) / [ZIP](https://github.com/lust0yixiong/EarthNano/releases/download/v0.2.0-alpha.1/EarthNano-0.2.0-alpha.1-mac-arm64.zip) |
| macOS Intel | [x64 DMG](https://github.com/lust0yixiong/EarthNano/releases/download/v0.2.0-alpha.1/EarthNano-0.2.0-alpha.1-mac-x64.dmg) / [ZIP](https://github.com/lust0yixiong/EarthNano/releases/download/v0.2.0-alpha.1/EarthNano-0.2.0-alpha.1-mac-x64.zip) |
| Linux x64 | [DEB](https://github.com/lust0yixiong/EarthNano/releases/download/v0.2.0-alpha.1/EarthNano_0.2.0-alpha.1_amd64.deb) / [AppImage](https://github.com/lust0yixiong/EarthNano/releases/download/v0.2.0-alpha.1/EarthNano-0.2.0-alpha.1-linux-x86_64.AppImage) |
| Linux ARM64 | [DEB](https://github.com/lust0yixiong/EarthNano/releases/download/v0.2.0-alpha.1/EarthNano_0.2.0-alpha.1_arm64.deb) / [AppImage](https://github.com/lust0yixiong/EarthNano/releases/download/v0.2.0-alpha.1/EarthNano-0.2.0-alpha.1-linux-arm64.AppImage) |
| Windows x64 | [EXE 安装器（未签名）](https://github.com/lust0yixiong/EarthNano/releases/download/v0.2.0-alpha.1/EarthNano-0.2.0-alpha.1-win-x64-setup.exe) |

macOS ZIP、所有安装文件及[校验清单](https://github.com/lust0yixiong/EarthNano/releases/download/v0.2.0-alpha.1/SHA256SUMS.txt)均在[同一 Release](https://github.com/lust0yixiong/EarthNano/releases/tag/v0.2.0-alpha.1)。下载后可用以下命令计算摘要，并与清单中相同文件名的完整 SHA-256 对照：

```bash
# macOS：Apple Silicon DMG 示例
shasum -a 256 EarthNano-0.2.0-alpha.1-mac-arm64.dmg

# Linux：x64 AppImage 示例
sha256sum EarthNano-0.2.0-alpha.1-linux-x86_64.AppImage
```

### macOS

1. 打开与你处理器架构对应的 `.dmg`。
2. 将 **EarthNano.app** 拖到 **Applications（应用程序）**，从应用程序目录启动，然后弹出安装磁盘。
3. 本版是未签名、未公证的 Alpha 预览。若提示无法验证开发者，核对下载来源及摘要后，按 [Apple 官方说明](https://support.apple.com/en-us/102445)，在 **系统设置 → 隐私与安全性 → 仍要打开** 中仅允许该应用；不需要关闭系统整体安全检查。“损坏”或“恶意软件”提示不适用此操作。

已有 OpenScience 用户请先退出原应用并备份数据。EarthNano 保留原数据目录与凭据兼容身份，不要因应用改名删除或手动搬移原数据，也不要同时运行两款应用。

### Linux

Debian/Ubuntu 在下载目录安装 `.deb`，只执行与你架构对应的一条：

```bash
# x64
sudo apt install ./EarthNano_0.2.0-alpha.1_amd64.deb

# ARM64
sudo apt install ./EarthNano_0.2.0-alpha.1_arm64.deb
```

其他支持 AppImage 的 Linux 环境可赋予文件执行权限后启动；ARM64 请替换为对应文件名：

```bash
chmod +x EarthNano-0.2.0-alpha.1-linux-x86_64.AppImage
./EarthNano-0.2.0-alpha.1-linux-x86_64.AppImage
```

## 首次配置

1. 跟随首次向导检查环境、选择数据位置，设置智能体运行时和模型提供商。
2. 在设置中安装或选择 **Claude Code** 并运行检测。普通任务保留原有模型配置能力；当前桌面优化使用 **Claude Code + 明确的自定义 Messages provider**。
3. 添加自己的模型提供商与 API key。以下为已验证过的 DeepSeek 配置示例，不会自动使用个人订阅设置：

   | 字段 | 示例值 |
   | --- | --- |
   | API 类型 | `Messages (/v1/messages) — Claude / Anthropic-compatible` |
   | Base URL | `https://api.deepseek.com/anthropic` |
   | 模型 | `deepseek-flash` |
   | API key | 自己的 DeepSeek API key，在应用提供商表单中保存 |

4. 做 Notebook 科研计算时，在设置中安装或登记并启用需要的 **Python / R** 运行时。优化方法另需 Python 3.11+，本版本验证使用 Python 3.12。仅使用本地 Notebook 无需配置远端 Compute 主机。

API key 由应用凭据入口管理，不写入任务、Skills、报告或 Git。调用模型会产生提供商费用；应用的执行次数预算不等于 API 请求数、token 或美元额度。

## 试用上游案例

打开现有试用项目（或新建 EarthNano 试用项目），点击 **New** 新建会话，展开 **Try upstream examples（试用上游案例）**：

- **OpenScience：复跑 Case16**，自动附上原脚本和冻结登记库输入，复算两张可逐字节核对的 CSV。
- **Harness²：带符号账本核算**，附上原 demo 的两个账本；普通运行后，可用现有 Optimize task 对同一任务比较基线与候选。

选择案例只准备草稿和附件，不自动执行；检查后再点击 Send。现有会话继续保留。所需环境、参考结果与优化操作见[案例指南](docs/earthnano/UPSTREAM_TRIALS.md)。

旧版 [0.1.1-alpha.1](https://github.com/lust0yixiong/EarthNano/releases/tag/v0.1.1-alpha.1)、[0.1.0-alpha.1](https://github.com/lust0yixiong/EarthNano/releases/tag/v0.1.0-alpha.1) 及其安装包保留；本版本单独发布，不覆盖旧 `alpha` 发布入口。

## 第一次科研任务

1. 新建 **Project（项目）** 和 **Session（会话）**，选择模型。
2. 准备一个 `sample.csv` 并作为输入添加到会话：

   ```csv
   value
   1
   2
   3
   ```

3. 在聊天中发送：

   > 使用已启用的 Python Notebook 读取 sample.csv，计算 value 列的有效数值行数、总和与均值。不要修改输入文件；将结果写入 summary.json 并发布，保留计算过程和产物来源。

4. 按提示批准任务实际需要的权限，在 Notebook 与文件预览中检查结果。上述示例应得到行数 `3`、总和 `6`、均值 `2`；可从产物版本、Provenance（来源）和 Review（审阅）入口核对过程与证据。

文献、数据、Skills、R、Compute 与普通聊天能力继续保留；更多操作见[完整使用指南](docs/earthnano/ALPHA_USER_GUIDE.md)。

## 使用 Harness² 优化同一个任务

先确认普通任务能够执行，再在桌面 Session 展开 **Optimize task（优化任务）**：

1. 选择任务来源、已启用的 Notebook 运行时与输入文件，填写独立验收标准。
2. 首次可选择 `sequential`、`k=1`，点击 **Preview task stream** 查看任务与最低执行容量，再设置预算并启动 **Start optimization**。
3. 查看基线与候选的进度、对应会话、不可变产物版本和独立 Review。它们通过同一核心执行同一个冻结任务；后续可使用 parallel、更高 k 和多任务 sweep。
4. 需要中断时点击停止。重开应用只读取已有状态；继续工作须显式点击 **Resume optimization**，沿用剩余预算，不自动重放已完成阶段。

优化仍需用户显式启动；单次评审高分不证明科研正确或配置普遍更优，也不会自动发布配置。候选的权限和配置 profile 有明确限制，详见[预算、恢复与支持范围](docs/earthnano/ALPHA_USER_GUIDE.md#显式优化同一个任务)。

## 开发与验证资料

- [源码安装与开发基线](docs/earthnano/BASELINE.md)、[开发依赖](docs/development-quick-reference.md)
- [功能来源与范围](docs/earthnano/FUNCTION_ORIGINS.md)、[执行契约](docs/earthnano/CORE_CONTRACT.md)、[完成契约与已知限制](docs/earthnano/ALPHA_CONTRACT.md)
- [本次源码验收范围与明确豁免](https://github.com/lust0yixiong/EarthNano/releases/download/v0.2.0-alpha.1/SOURCE-CI-ACCEPTANCE.json)；本版原始 CI：[macOS 原始源码报告](https://github.com/lust0yixiong/EarthNano/actions/runs/39744881823)、[四个 Unix 原生包构建与安装验收](https://github.com/lust0yixiong/EarthNano/actions/runs/39746583897)、[Windows 原生安装验收](https://github.com/lust0yixiong/EarthNano/actions/runs/39751493083)
- [历史科研/原生包证据](docs/earthnano/validation/alpha/final-bdc/manifest.json)、[历史完整上游源码对照](docs/earthnano/validation/alpha/source-39658771118/manifest.json)、[历史发布文件验证](docs/earthnano/validation/alpha/assets-39683248168/manifest.json)
- [固定上游与许可证](UPSTREAMS.json)：两侧 Apache-2.0 许可及兼容标识保留。

本版安装包源码为 `ca96faed10916edde870aae47da6d70f31e55300`；后续文档更新不会改变已发布安装包。macOS 原始源码对照无新增测试或阶段回归，既有失败与跳过保留，这不代表全部测试通过。两个 Linux 全量源码 batch 及其依赖的完整比较按用户本次明确决定豁免，未作发布验收；原运行与规则保留，不计为通过。五个平台原生构建与安装验收均已按原规则通过。Windows 安装验收不代表已发布旧 Windows 安装器间升级或 Windows 配置优化已受支持；真实模型、安装包与科研工作流的验证范围分别记录。当前 Alpha 不承诺所有模型、所有科研任务或全部平台 GUI 都已验收。

<details>
<summary>OpenScience 上游说明（原下载、发布、截图和性能声明不代表 EarthNano 交付）</summary>

以下保留上游说明与许可。下载链接和 Homebrew 命令安装的是 OpenScience；EarthNano 的安装与使用请按本页上方说明操作。上游各语言 README 同属原项目资料。

---

<h1 align="center">AIPOCH Open-Science</h1>

<p align="center">
  AI research workbench for reproducible science — open-source, local-first, and model-agnostic.
</p>

<p align="center">
  <a href="https://aipoch.com/open-science/download">
    <img alt="Download" src="https://img.shields.io/badge/Download-Latest%20Release-2f9e44?style=flat">
  </a>
  <a href="https://github.com/aipoch/open-science/releases/latest">
    <img alt="Version" src="https://img.shields.io/github/v/release/aipoch/open-science?label=Version&style=flat&color=4dabf7">
  </a>
  <a href="https://doi.org/10.5281/zenodo.22252246">
    <img alt="DOI" src="https://img.shields.io/badge/DOI-10.5281%2Fzenodo.22252246-0b7285?style=flat">
  </a>
  <a href="https://arxiv.org/abs/2610.17110">
    <img alt="AIPOCH Open-Science preprint on arXiv: 2610.17110" src="docs/images/readme/arxiv-preprint.svg">
  </a>
  <a href="#benchmark-performance">
    <img alt="AIPOCH Open-Science — highest scores in reported benchmark comparisons" src="docs/images/readme/benchmark-comparisons.svg">
  </a>
  <a href="https://github.com/aipoch/open-science/releases/latest">
    <img alt="Platforms macOS Windows Linux" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-4263eb?style=flat">
  </a>
  <a href="LICENSE">
    <img alt="License Apache 2.0" src="https://img.shields.io/badge/license-Apache--2.0-7950f2?style=flat">
  </a>
  <a href="https://aipoch.com/open-science">
    <img alt="Website aipoch.com" src="https://img.shields.io/badge/website-aipoch.com-e8590c?style=flat">
  </a>
</p>

<p align="center">
  <a href="./README.md"><img alt="README in English" src="https://img.shields.io/badge/English-d9d9d9"></a>
  <a href="./docs/zh-Hans/README.md"><img alt="简体中文 README" src="https://img.shields.io/badge/简体中文-d9d9d9"></a>
  <a href="./docs/zh-Hant/README.md"><img alt="繁體中文 README" src="https://img.shields.io/badge/繁體中文-d9d9d9"></a>
  <a href="./docs/ja/README.md"><img alt="日本語 README" src="https://img.shields.io/badge/日本語-d9d9d9"></a>
  <a href="./docs/ko/README.md"><img alt="한국어 README" src="https://img.shields.io/badge/한국어-d9d9d9"></a>
  <a href="./docs/fr/README.md"><img alt="Français README" src="https://img.shields.io/badge/Français-d9d9d9"></a>
  <a href="./docs/ru/README.md"><img alt="README на русском" src="https://img.shields.io/badge/Русский-d9d9d9"></a>
  <a href="./docs/de/README.md"><img alt="German README" src="https://img.shields.io/badge/Deutsch-d9d9d9"></a>
  <a href="./docs/es/README.md"><img alt="Español README" src="https://img.shields.io/badge/Español-d9d9d9"></a>
</p>

AIPOCH Open-Science is an AI research workbench for scientists and researchers, developed by [AIPOCH](https://aipoch.com/open-science) with an open-source, local-first, model-agnostic approach. It enables reproducible, inspectable research with scientific AI agents, Python and R execution, scientific data connectors, and cross-platform support for macOS, Windows, and Linux. Create a project, describe your research goal in plain language, and let the agents read files, search the web, run code, query scientific data sources, and produce reports, tables, and figures with traceable provenance—all in one workspace.

AIPOCH Open-Science supports computational and data-intensive research across disciplines, including machine learning, statistics, life sciences, chemistry, materials science, physics and environmental science. It supports the research process from literature review and hypothesis development to code execution, data analysis, simulation, visualization, and the production of traceable research outputs.

Completed research sessions can also be exported as portable `.science` packages for review, handoff, and archiving, with selected conversation branches, file versions, Notebook records, and verification evidence.

> 💡 **AIPOCH Open-Science v1.0.0** _(updated October 2026)_. This milestone brings together the local-first research workspace, scientific agents, Python/R Notebook execution, literature tools, and portable `.science` research packages. See the [1.0.0 release notes](release-notes/1.0.0/en.md) for changes since v0.37.2 and CLI upgrade changes. Downloads continue to follow the [latest published release](https://github.com/aipoch/open-science/releases/latest).

<p align="center">
 <img width="1920" height="1140" alt="AIPOCH Open-Science banner: Science, Open to All — an open-source, model-agnostic, self-hosted scientific AI research workbench" src="docs/images/readme/open-science-banner.png" />
</p>

## Table of Contents

- [Quick Start](#-quick-start)
- [Product Tour](#product-tour)
- [AIPOCH Open-Science `.science` Research Packages](#aipoch-open-science-science-research-packages)
- [AIPOCH Open-Science Paper and Citation](#aipoch-open-science-paper-and-citation)
- [Benchmark Performance](#benchmark-performance)
- [Core Capabilities](#core-capabilities)
- [Model Providers](#model-providers)
- [Data, Permissions, and Trust](#data-permissions-and-trust)
- [Development & Packaging](#development--packaging)
- [Frequently Asked Questions](#frequently-asked-questions)
- [Get Involved](#get-involved)
- [License](#license)
- [Star History](#star-history)

## 🚀 Quick Start

### 1. Download the app

Open the [official download page](https://aipoch.com/open-science/download) and choose the installer for your computer:

| Your computer                           | Choose                                     |
| --------------------------------------- | ------------------------------------------ |
| macOS 12+ — Apple Silicon (M1 or newer) | The macOS DMG for Apple Silicon / ARM64    |
| macOS 12+ — Intel                       | The macOS DMG for Intel / x64              |
| Windows x64                             | The Windows x64 installer (code-signed)    |
| Linux x64                               | The Linux x64 AppImage or Debian package   |
| Linux ARM64                             | The Linux ARM64 AppImage or Debian package |

Download from the [official download page](https://aipoch.com/open-science/download); see [download verification](SECURITY.md#verifying-your-download) if needed.

On macOS, you can also install with [Homebrew](https://brew.sh):

```bash
brew install --cask open-science
```

For the standalone CLI on macOS or Linux, use the separate [AIPOCH tap](https://github.com/aipoch/homebrew-tap):

```bash
brew install aipoch/tap/open-science
```

This Formula includes Node and runs without the desktop app; its release may differ from the desktop Cask. See the [standalone runtime guide](docs/standalone-runtime.md) for prerequisites and upgrades.

Windows reinstalls preserve research data. For a full cleanup, see the [data reset tool](scripts/windows-reset/README.md), which permanently deletes local data after confirmation.

### 2. Complete first-time setup

Follow the setup wizard: **Environment → Data location → Agent runtime → Model provider → Notebook runtime**.

Complete the required environment and agent-runtime checks and test your model connection. Python/R Notebook setup is optional; Notebook and data-location settings can be changed later.

<table>
  <tr>
    <td width="50%"><img src="docs/images/readme/onboarding-environment.jpg" alt="Automatic first-run environment checks in AIPOCH Open-Science"></td>
    <td width="50%"><img src="docs/images/readme/onboarding-model-provider.jpg" alt="First-run model provider configuration in AIPOCH Open-Science"></td>
  </tr>
  <tr>
    <td align="center"><sub>Host compatibility, storage, and network checks</sub></td>
    <td align="center"><sub>Provider, API Key, endpoint, and model validation</sub></td>
  </tr>
</table>

### 3. Start a research project

1. Click **New project**, open a session, and describe your research goal, inputs, and expected outputs.
2. Attach files, select a model and approval mode, then send the task. Use `@` to reference project files or `/` to choose a skill.
3. Review tool activity and any approval requests, preview the results, and check their available evidence in **Provenance**.

> Screenshots in this README illustrate the workflow. Labels, catalogs, and other interface details may differ from the version you install.

## Product Tour

### From a research request to a traceable result

Consider a representative bioinformatics task: reproduce a published differential-expression analysis, compare the regenerated results with the paper, and deliver the report, tables, and figures needed for review. The screenshots below are representative views from documented AIPOCH Open-Science workflows; they illustrate each stage rather than one continuous session.

#### 1. Define the research task and evidence

Describe the research question, source paper and datasets, required methods or thresholds, expected outputs, and acceptance criteria. Upload supporting files or reference an existing project artifact with `@`, so the agent starts from explicit inputs instead of hidden context.

<p align="center">
  <img src="docs/images/readme/product-tour-task.jpg" alt="AIPOCH Open-Science paper reproduction task with the research conclusion, generated artifacts, and source comparison visible in one workspace" width="900">
</p>

#### 2. Execute with inspectable scientific tools

The agent can combine scientific skills, permissioned research connectors, searches, file operations, and Python or R code in the shared Notebook. Generated figures can be reviewed beside the research summary, while the artifact record exposes captured producer code and execution evidence for inspection.

<p align="center">
  <img src="docs/images/readme/product-tour-execute.png" alt="AIPOCH Open-Science bioinformatics analysis showing the research summary, generated figure, and captured producer code side by side" width="900">
</p>

#### 3. Review reports, tables, and figures in place

The final response summarizes what reproduced, what differed, and which limitations matter. Generated Markdown reports, CSV tables, images, and other research artifacts remain attached to the session and are collected in the project file library, where they can be previewed beside the conversation and reused in follow-up work.

<p align="center">
  <img src="docs/images/readme/product-tour-output.jpg" alt="AIPOCH Open-Science reproduction result with differential-expression figures and generated files previewed beside the agent's explanation" width="900">
</p>

#### 4. Trace every artifact back to its evidence

Each generated artifact is stored as an immutable, checksummed version. Its **Provenance** view can expose the producing code and execution history, referenced inputs, observed environment inventory, producing conversation branch, and version-scoped Reviewer findings. Evidence that could not be verified is marked unavailable rather than inferred.

<p align="center">
  <img src="docs/images/readme/product-tour-provenance.jpg" alt="AIPOCH Open-Science research artifact preview with the Provenance entry for tracing a generated result" width="900">
</p>

## AIPOCH Open-Science `.science` Research Packages

Export a completed research session as a portable `.science` package for review, handoff, and archiving. Choose the conversation branches, file versions, Notebook records, and verification evidence to include, then import the package into another project or computer.

**Export → transfer → inspect**

1. Export a completed session and choose the contents to include.
2. Move the `.science` file to a collaborator or another computer.
3. Import it into a project. The right-hand **Research replay** shows the recorded process; the left-hand conversation lets you ask about it and follow fixed step references.

Imported records remain read-only. Watching a replay does not execute code, call a model, or restore credentials. Your first question creates an associated writable discussion; use **Create a copy to continue research** to run follow-up experiments. Re-executing a result still requires a complete recipe, required inputs, and an available runtime.

Side Chat conversations, private reading bookmarks, and credentials are excluded; included files depend on export selection. Received verification records describe the sender’s checks, not a rerun on this computer. See the [`.science` package guide](https://aipoch.com/docs/guides/research-packages/).

## AIPOCH Open-Science Paper and Citation

**[AIPOCH Open-Science: An Open-Source AI Research Workbench with Reproducible .science Packages](https://arxiv.org/abs/2610.17110)**

arXiv preprint · [v1](https://arxiv.org/abs/2610.17110v1) · Submitted October 12, 2026.

Our preprint introduces AIPOCH Open-Science, an open-source AI research workbench with portable `.science` packages for sharing research context, artifact versions, and verification records. Read the paper for the package exchange design and controlled evaluation.

If you use AIPOCH Open-Science in your research, you can cite the preprint:

<details>
<summary>BibTeX citation</summary>

```bibtex
@misc{ouyang2026aipochopenscienceopensourceai,
      title={AIPOCH Open-Science: An Open-Source AI Research Workbench with Reproducible .science Packages},
      author={Wen Ouyang and Bocheng Huang and Qianyu Yao and Fei Sun and Minying Deng and Haoyue Cheng and Wenwen Zhou and Lei Mou and Yusi Wei and Jiang Li and Kun Zhu and Lei Wang and Yi Feng and Jiaheng Dai and Ke Qian and Dan Wang and Yahui Wang and Chenyi Wang and Mingsheng Lyu and Yaqiang Zhang and Ping Zheng and Chunhua Tang and Xinge Ma and Xu Zhang and Youjia Fan and Can Lu and Zhijun Dai and Man Hu and Qiqi Xie and Beinan Liu and Yuanning Guo and Yunze Liu and Jinhong Jiang and Xianjun Fu and Mingwei Zhang and Yuanji Xu and Shilin Xia and Bowen Yang and Mingjun Yu and Jingdun Xie and Xuwei Chen and Xia Zou and Yuzhou Xue and Jianguo Zhou and Chunhao Cao and Donghao Tian and Lei Huang and Jinxiao Li and Shengrong Long and Zefeng Song and Honglin Li and Jiang Luo and Wenying Jiang and Shanshan Li and Lei Dai and Ning Jiang and Ying Cai and Chaohui Li and Chunyan Peng and Hetong Zhao and Angqing Li and Chunyan Yang and Chongyang Sun and Yong Li and Xinyu Shi and Wei Dai and Ming Peng and Chen Sang and Yuanyuan Han and Desong Qiu and Haixin Miao and Jian Xu and Yi Chen and Xiaoliang Shi and Tian Shen and Teng Hu and Shuhao Wang and Yingyong Hou and Huimei Wang},
      year={2026},
      eprint={2610.17110},
      archivePrefix={arXiv},
      primaryClass={cs.SE},
      url={https://arxiv.org/abs/2610.17110},
}
```

</details>

## Benchmark Performance

These results are historical reports from August–October 2026, not a new evaluation of v1.0.0.

Source reports: [September 29](https://hwtgofuh6ud.feishu.cn/wiki/Kl5cwupToi901BkEaQacM1V2n7e), [October 12](https://hwtgofuh6ud.feishu.cn/wiki/XZSbw7L87ibjQUk98qJcuqFUnKh) (access may be required).

### 🏆 AstaBench LitQA2-FullText-Search — 10/10 target-paper hits

AIPOCH Open-Science achieved **100% recall@30** on the official 10-query validation split using **DeepSeek v4-flash (max)** with literature-retrieval specialists and Skills. Every target paper appeared among the first 30 returned results. The score exceeds the three public validation results listed in the report, **20 percentage points** above the highest reference of **80%**. Three local repeats were reported, demonstrating target-paper retrieval on this set of scientific questions.

![AIPOCH Open-Science achieves 100% recall@30 and 10/10 target-paper hits on AstaBench LitQA2-FullText-Search validation; test and validation records use different questions](docs/images/readme/astabench-litqa2.png)

The figure includes both test and validation records; its ordering is numerical only. Recall@30 measures target-paper retrieval, not scientific question-answering accuracy.

### 🏆 ASI-Bench B1–B4 — Highest displayed scores in all four listed comparisons

AIPOCH Open-Science scored **79.35, 56.11, 59.67, and 59.46** on ASI-Bench B1, B2, B3, and B4 using **GPT-6 (gpt-6-astra / xhigh)** with domain specialists and Skills, the highest displayed values in the respective comparisons retained in the reports. The four conditions evaluate **executing a fully specified plan, organizing a workflow, selecting research methods independently, and conducting autonomous research with distracting background information**.

The same-model local Codex references scored 74.78, 56.09, 58.12, and 55.45, giving numerical differences of **+4.57, +0.02, +1.55, and +4.01 points**, respectively. Three local repeats were reported for B1/B2; B3/B4 each average three local runs of 60 tasks.

![AIPOCH Open-Science scores 79.35, 56.11, 59.67, and 59.46 on ASI-Bench B1–B4; the chart distinguishes local results from published references](docs/images/readme/asi-bench-b1-b4.jpg)

Local runs used seed31415. AIPOCH's B1 score covers 59 tasks, with one excluded due to the scorer issue described in the report. B3/B4 used v0.32.0 and a substitute judge. Published references differ in task instances, configurations, and judging; B2's 0.02-point margin is a numerical difference only.

### 🏆 Highest in the collected BiomniBench-DA Public 50 comparison — 79.05

AIPOCH Open-Science achieved **79.05** with **gpt-5.6-sol (xhigh)** in an internal evaluation on the 50-task set labeled BiomniBench-DA Public 50, the highest displayed score in the collected comparison. The result combines **81.04** from the Gemini 3.1 Pro judge and **77.06** from the DeepSeek v4-pro judge through an equal-weight mean, reflecting this configuration's biomedical data-analysis performance. See the [evaluation report](https://aipoch.com/blog/open-science-biomnibench-da).

![AIPOCH Open-Science records a 79.05 dual-judge mean on the internal BiomniBench-DA Public 50 evaluation, combining judge scores of 77.06 and 81.04](docs/images/readme/biomnibench-public50-leaderboard.png)

The comparison mixes different judge-coverage patterns and should not be interpreted as an official ranking under uniform judging conditions.

**Evaluation scope:** These are self-reported local/internal results. Leading the listed comparisons does not establish official first-place leaderboard status or statistically significant improvements.

## Core Capabilities

AIPOCH Open-Science combines project management, multi-model agent execution, Python and R notebooks, scientific data connectors, immutable artifact versions with provenance, and permissioned human-in-the-loop control in one local workspace. The installed app and [latest release notes](https://github.com/aipoch/open-science/releases/latest) are the source of truth for changing catalogs, packaging details, and newly added options.

| Area                                          | Core capability                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Scientific skills**                         | Extend research workflows with **23 built-in skills** and **525 skills** available from the [Skills Marketplace](https://github.com/aipoch/openscience-skill-marketplace), with one-click installation and updates. Create skills through conversation or completed work, and import packages or GitHub sources. Marketplace contributions are published after review; local imports do not publish skills.                                                      |
| **Connectors**                                | Access scientific resources through **36 built-in connectors**, or add custom local and remote MCP connectors. Manage tool-level permissions and import or export connector configurations.                                                                                                                                                                                                                                                                      |
| **Specialists and delegation**                | Install **10 Specialists** from the [Specialist Marketplace](https://github.com/aipoch/openscience-specialist-marketplace), or create and customize personal specialists for delegation from the main agent. Specialist packages support import and export; marketplace contributions are reviewed before publication, and local imports do not publish them.                                                                                                    |
| **Models and agent backends**                 | Use cloud models, compatible custom gateways, or Claude and Codex subscription logins. Choose Claude Code, OpenCode, Codex, or CodeBuddy as the agent backend, with model connection checks, image input, and reasoning controls.                                                                                                                                                                                                                                |
| **Projects, sessions, and research packages** | Organize projects with pinned sessions, message branches, side chats, and recoverable history. Export a **portable `.science` research package** and import it into another project or computer with conversation branches, selected file versions, Notebook records, and verification evidence. Imports are read-only and do not execute code or restore credentials; side chats and bookmarks are excluded, and included files depend on the export selection. |
| **Reviewer**                                  | Enable optional auto-review to check a completed agent turn's responses, execution logs, and related file evidence in a separate context. Get evidence-backed pass, warning, or failure checks, with a bounded cycle of main-agent corrections and re-review when issues are found. Review logs and issue-resolution states remain available; the review is limited to records available for that turn.                                                          |
| **Python, R, notebooks, and HPC**             | Run Python, R, Notebook, and shell workloads locally using managed environments or your own interpreters, with background execution and recorded history. Connect to remote hosts through SSH or submit work through Slurm; remote workloads require the host, software, resources, and permissions described in the remote-compute FAQ.                                                                                                                         |
| **Literature Library**                        | Import and manage references and PDFs with collections, tags, project links, notes, and duplicate merging. Find open-access full text, read PDFs and extract figures and tables, and use library sources in conversations for AI-assisted analysis. Generate bibliographies in your chosen citation style and export references as BibTeX or RIS.                                                                                                                |
| **Scientific files and previews**             | Upload individual files up to **10 GiB**, organize project files, and preview scientific data, PDFs, Office documents, images, code, and molecular structures. This upload limit does not guarantee that a model can read an entire file: model context, attachment parsing, and previews have separate limits. Large files usually need chunked reading or analysis with code.                                                                                  |
| **Artifacts and provenance**                  | Keep immutable artifact versions with available producer code, inputs, execution history, environment information, and review evidence. In the desktop app, replay eligible versions with a complete recipe, required inputs, and a usable runtime, then compare outputs and export verification records. Missing evidence may prevent verification, and replay checks do not establish scientific validity.                                                     |

Persistent PDF annotations and document notes are available. With a screening model configured, smart collections evaluate references against your inclusion/exclusion criteria; AI decisions remain separate from manual decisions and support human review.

In the desktop app, artifact provenance can also be exported as RO-Crate 1.1. A version-bound environment bundle can create a managed environment only when the captured bundle is complete and compatible with the target platform; this is separate from a full machine backup.

## Model Providers

AIPOCH Open-Science is model-agnostic at the product level: connect it to major cloud LLM providers, a custom gateway, or reuse an existing Claude or Codex subscription. Provider availability currently depends on the selected agent backend and the API protocols it supports. The following connection options are available:

| Provider mode                | How it works                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Built-in cloud providers** | Choose from the provider list shown by the installed app and authenticate with the requested key.                                                                                                                                                                                                                                                                                                                                                    |
| **Custom Gateway**           | Supply a Base URL and exact model ID with an API protocol supported by the selected agent backend (Messages, Chat Completions, or Responses), then run the connection test. Remote gateways require HTTPS and an API Key. Loopback endpoints such as `localhost`, `127.0.0.1`, or `[::1]` may use HTTP without a key; presets include Ollama, LM Studio, llama.cpp, and vLLM. A default API format does not guarantee server or model compatibility. |
| **Codex Subscription**       | Select the Codex agent framework, then choose Codex Subscription as the provider type.                                                                                                                                                                                                                                                                                                                                                               |
| **Claude Subscription**      | Sign in with a Claude subscription in two modes: **shared** (a browser login that stores credentials in your default `~/.claude` profile) or **isolated** (an app-managed `claude setup-token` run under an app-owned `CLAUDE_CONFIG_DIR`, fully isolated from `~/.claude/`, with a browser flow plus a paste-a-token fallback).                                                                                                                     |
| **xAI (Grok) OAuth**         | Use the built-in xAI (Grok) OAuth device sign-in. Access depends on your xAI account and the selected backend’s protocol support; validate the connection in the app.                                                                                                                                                                                                                                                                                |

There are 25 preset provider options, including OpenAI, Anthropic, DeepSeek, NVIDIA Build, and others; available models and regional endpoints depend on the installed version and selected agent backend. Check the provider selector and connection test in the app.

## Data, Permissions, and Trust

AIPOCH Open-Science stores project data, settings, artifact versions, and provenance evidence on the local computer. API Keys are kept locally and use the operating system's secure credential storage when it is available. Logs are local and are not uploaded automatically.

External data flow is still possible and should be reviewed:

- Model requests send the prompt and necessary context to the selected model provider.
- Web searches and remote connectors send their displayed parameters to external services.
- Local connectors may execute trusted commands on the computer.
- The application can also contact update servers, marketplace catalogs, and runtime or model download services.
- Attachments, `@` references, logs, and generated reports may contain sensitive research data.

Choose the narrowest permission profile that fits the task:

| Mode                 | Behavior                                                                                                                   | Recommended use                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `Ask for approval`   | Requests approval for actions not already covered by scoped grants or trusted application tool policies                    | New workflows, sensitive data, unfamiliar scripts         |
| `Auto-approve edits` | Uses the backend's native auto review when available; otherwise automatically allows clearly low-risk workspace operations | Trusted file-editing work with controlled external access |
| `Full access`        | Automatically allows edits, commands, network, and connectors                                                              | Clearly scoped, fully trusted, unattended work            |

The effective profile depends on the selected backend and existing grants. Connector, tool, and compute-network policies also apply; check the effective mode shown by the app.

Review connector parameters and tool activity before approving them. Never include API Keys, access tokens, patient identifiers, unpublished data, or sensitive local paths in screenshots or public issue logs.

## Development & Packaging

AIPOCH Open-Science has an ordinary Node backend and an Electron desktop client, built with React, TypeScript, Prisma/SQLite, and an ACP-based agent runtime.

Prerequisites for source development:

- Node.js 24 (see [`.nvmrc`](.nvmrc)) with npm
- Git
- Notebook execution optionally uses app-managed Python/R environments or a compatible interpreter you configure.

```bash
git clone https://github.com/aipoch/open-science.git
cd open-science
npm install
npm run dev
```

See the [development command and packaging reference](docs/development-quick-reference.md) and [contribution guide](CONTRIBUTING.md) for build commands and the development workflow.

### Localhost Web and standalone Node runtime

The same Web UI can run on an ordinary Node backend without Electron or a graphical display.
Electron starts or attaches to that same Node service. One runtime owns each data directory.

```bash
npm run dev:web       # Build and run the Node backend + Web UI
npm run pack:backend  # Build a target-specific standalone npm tarball
```

Install the tarball, then run `open-science start --no-open` and `open-science url` to open the
existing UI. See the [standalone runtime guide](docs/standalone-runtime.md) for installation,
secure credential storage, host capability boundaries and data compatibility. The desktop app and browser share that service. Quitting a desktop stops a server it started;
quitting a desktop attached to a CLI-started server only disconnects the desktop.

### Mobile remote access

The same localhost web UI can be reached from a phone or tablet through Remote.It pairing. Pair
a browser with a six-digit AIPOCH Open-Science code, approve it once on the desktop, and the workspace
stays reachable without exposing the loopback server directly. Browser trust is revocable, and
mode changes or service shutdown immediately invalidate active remote sessions.

Remote access requires the host to stay on and online, with AIPOCH Open-Science and the Remote.It agent running, and the host added to a signed-in Remote.It account. Browser approval has an expiry and can be revoked; see the [Remote control guide](docs/remote-control.md).

### Headless CLI and SDK

The headless CLI and zero-dependency Node.js SDK use the same local daemon, projects, sessions,
credentials, and permissions as the desktop and web interfaces. Detailed usage lives with the
publishable package so there is one command reference to maintain:

- [CLI guide](packages/open-science/CLI.md) - installation, service lifecycle, task automation,
  artifacts, output formats, and exit codes
- [SDK package overview](packages/open-science/README.md) - Node.js quick start and package entry point

## Frequently Asked Questions

### Why does the model connection test fail?

A: Check the API Key for missing characters or spaces, verify the Base URL and region, use the provider's exact model ID, and confirm network access and account balance. For a Claude subscription, retry the shared browser login or refresh the isolated `claude setup-token` credential, depending on the selected mode.

### Why is `Continue` disabled during setup?

A: The current step has not met its required condition. Fix any environment row marked `Action needed`, install or repair the selected agent runtime, or validate the model provider, depending on the active step. Notebook setup is optional and only affects Notebook execution.

### How do I run jobs on a remote HPC cluster?

A: **Remote Compute (SSH)** is always enabled and does not need to be enabled in Settings. Register an SSH compute host under **Settings → Compute**, make it available to the current session, and then use natural language or `/remote-compute-ssh`. You need a reachable SSH host, valid authentication, permission for the required directories, and the software, dependencies, and compute resources required by the workload. Direct SSH does not require a scheduler; Slurm mode requires a working Slurm environment and permission to submit jobs. “Always enabled” refers to the skill, not to the availability of every registered host.

### Is there a command-line interface?

A: Yes. Install the standalone Node package, or use **Settings → General → Command line tool → Install command** to control an already running desktop instance. For independent startup, use the standalone package and ordinary Node. The Debian package-owned launcher is an exception: it starts the bundled backend with the bundled Node runtime. Initialize the local profile, then control the service and submit research tasks without opening a browser:

```bash
# Initialize the local CLI profile and start the service in the background
open-science init
open-science start --no-open

# Create a project and run a task by its exact name
open-science project create "Systematic review"
open-science run --project "Systematic review" \
  --prompt-file ./task.md \
  --approval-profile auto \
  --skill literature-review \
  --wait --json

# Download a generated artifact
open-science artifacts list <session-id> --json
open-science artifacts download <artifact-id> --output ./report.md
```

See the [CLI guide](packages/open-science/CLI.md) for the full command reference, JSON/JSONL output formats, exit codes, and headless service options.

### How do I inspect where a generated result came from?

A: Open the generated artifact and choose **Provenance**. Select a version to inspect the content identity and the available producer code, execution history, inputs, environment inventory, producing conversation context, and reviewer evidence. Evidence AIPOCH Open-Science could not verify is marked unavailable.

### Can I revise an earlier request without losing the conversation that followed?

A: Yes. Edit a completed user message and resend it to create a new branch from that point. The original later turns remain available, and the revision arrows beside the message switch between the alternative paths.

## Get Involved

AIPOCH Open-Science welcomes bug reports, feature proposals, design discussions, community questions, and contributions through GitHub, Discord, X, and the AIPOCH website. Choose the channel that best matches your goal, then follow the linked contribution guidance and public-posting safety reminder before sharing project details.

| Channel                                                                  | Use it for                                                              |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| [GitHub Issues](https://github.com/aipoch/open-science/issues)           | Bugs, reproducible failures, and concrete feature proposals             |
| [GitHub Discussions](https://github.com/aipoch/open-science/discussions) | Design questions, roadmap proposals, and longer technical conversations |
| [Discord](https://discord.gg/zxQAYjReRv)                                 | Community help, contributor coordination, and informal discussion       |
| [X / @aipoch_ai](https://x.com/aipoch_ai)                                | Release announcements and build-in-public updates                       |
| [AIPOCH Open-Science website](https://aipoch.com/open-science)           | Official product overview and downloads                                 |

Before opening a public issue, remove API Keys, tokens, private file paths, unpublished data, patient identifiers, and other sensitive material from logs and screenshots. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow.

> ⭐ **Star the repo:** If this project has been helpful, we'd greatly appreciate a star on GitHub. Starring the repository encourages continued development. It only takes a second, but it has a meaningful impact on the project.

For remote access setup, see the [Remote control guide](docs/remote-control.md).

For shipped, partial, and planned capabilities, see the [Capability Map](docs/ROADMAP.md#capability-map).

## License

Apache License 2.0 — see [LICENSE](LICENSE).

## Star History

<a href="https://star-history.dera.page/#aipoch/open-science&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://star-history.dera.page/svg?repos=aipoch/open-science&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://star-history.dera.page/svg?repos=aipoch/open-science&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://star-history.dera.page/svg?repos=aipoch/open-science&type=date&legend=top-left" />
 </picture>
</a>

</details>
