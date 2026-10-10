# Haruyuki（春雪）

[English](README.en.md) · 简体中文

> [!WARNING]
> **AIGC 声明（AI 生成内容）与使用警告**
>
> 本项目的**代码与文档大量由 AI 辅助生成**（AI 起草 ＋ 人类维护者审阅、裁决与验证）。
> 提交历史、`NOTICE` 与 [CONTRIBUTING.md](CONTRIBUTING.md) 逐项记录了改动的来源、理由与验证方式。
>
> - **可能出错**：AI 生成的内容可能包含**逻辑错误、过时信息、安全缺陷、依赖误用，或"看起来合理但实际错误"的结论**。
>   本项目按 **"AS IS"** 提供，**不附带任何明示或默示担保**；使用或再分发前请自行审查、测试与评估风险。
> - **法律表述不是法律意见**：仓库内涉及版权、商标与许可的分析属**工程性来源调查**，**不构成法律意见**。
>   正式发布、商用、维权或签署协议前，请咨询执业律师。
> - **责任归属**：AI 工具不承担任何责任；最终取舍与后果由**人类维护者与使用者**承担。
> - **转述与再利用**：若你所在司法辖区或平台要求标注 AI 生成内容（例如《生成式人工智能服务管理暂行办法》，
>   或各平台的 AIGC 标注规则），请在转述、截图或再利用本项目内容时**保留本声明**。
> - **不是官方发行**：本项目非 Letta, Inc. 官方产品，未经其审阅、测试或背书（详见 [§八](#八许可与法律声明)）。
> - **报 bug / 提需求**：走本项目自己的 issue tracker —— <https://github.com/TZYLT/haruyuki/issues>；
>   会话内用 `/feedback` 写的报告只落本地日志，不会自动发到那里。

> **本地优先的陪伴向 agent 运行时 —— `letta-code` 的深度改造分支。**
>
> 本分支与 Letta, Inc. **无关联、未获其赞助或背书**。名称 "Letta" / "Letta Code" **仅用于指称代码来源**
> —— `LICENSE` §6 明文允许"描述作品来源的合理惯常使用"；其 **logo、wordmark、图片与 ASCII art 等品牌资产
> 一律不使用、不分发**（上游品牌排除条款）。
> 法律声明见 [NOTICE](NOTICE)，第三方组件许可见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)；
> **权利人（侵权）通知渠道见 [§八 → 权利通知与侵权联系](#权利通知与侵权联系)**。

---

## 一、这个项目是什么

Haruyuki 是一个跑在**你自己机器上**的 agent 运行时。它把 agent 的记忆、身份与行为当作**可以长期演进的资产**：
记忆是一棵 git 版本化的文件树，系统提示与工具清单可以按需重编译，反思（reflection）作为独立的后台 agent 运行。
它不要求你登录任何服务，也不把状态放在别人那里。

### 目标

| 目标 | 含义 |
|---|---|
| **陪伴向，而不是工具向** | 面向长期相处的单一 agent：它记得住、有稳定的自我、能跨会话延续，而不是每次从零开始的问答窗口 |
| **对上下文有完全控制权**（第一优先） | 你的请求在发出前长什么样，应当**可见、可解释、可决定**：系统提示、工具清单、记忆何时写进上下文前缀，由你显式触发而非被自动改写 |
| **彻底的本地自持** | 状态、记忆、日志、密钥都在本机文件系统里；不依赖任何云服务即可完整工作 |
| **再开发自由度** | 自上游 `v0.34.2` 起**彻底分家**（不合并上游、不 cherry-pick），以便做结构性改造 —— 例如树状记忆、向量召回、会话分叉归档（**方向，尚未实现**） |
| **可审计** | 不镜像上游文档；每一处相对上游的改动都逐项登记（见 [CONTRIBUTING.md](CONTRIBUTING.md)） |

### 特色

| 特色 | 说明 |
|---|---|
| **记忆即文件树** | MemFS：全部上下文（含记忆块）由 git 跟踪，可 diff、可回滚、可推到自己的远端仓库 |
| **前缀冻结** | 提示/工具/记忆的改动**不会静默改写已发出的上下文**；`/context-pending` 看待应用项，`/recompile` 显式应用 |
| **话题裁切** | `/topic`、`/topics`、`/compact` —— 按你选的话题边界裁上下文，而不是按比例丢尾巴 |
| **后台反思（被动记忆）** | 反思 agent 与你并行运行，自己整理记忆；`/reflect`、`/dream`、`/sleeptime` 控制触发方式 |
| **本地后端** | 单一后端模式（`--backend local`）：agent、会话、记忆、transcript 全在本机 |
| **技能与 mod** | 内置技能 ＋ 项目/用户自装技能；mod 可挂钩生命周期、回合、面板、命令与工具 |
| **多 agent** | 任意 agent 可作为另一个 agent 的 subagent（含 fork、recall 等内置 subagent） |
| **渠道与本地服务** | `haruyuki server` 提供本地 app-server ＋ WebSocket ＋ Slack/Telegram 渠道 |
| **完全本地诊断** | 无遥测；崩溃与边界错误、`/feedback` 都只写本地日志 |
| **中文可用** | 默认内置人格含中文取向的 `Haruyuki-Chan`；本 README 与规划文档均为中文 |

---

## 二、相对上游改了什么（概要）

> **这里只给概要。逐项改动清单（含每一项的理由与取舍）在
> [CONTRIBUTING.md → 相对上游的改动清单](CONTRIBUTING.md#相对上游的改动清单)。**

1. **云功能整体移除**：Letta Cloud 后端与登录、teleport、远程电脑/环境路由、托管沙箱、云计划任务、共享记忆、用量与配额切换，以及依赖云的功能技能。
2. **出站链路切断**：遥测与第三方错误/反馈上报全部删除，改为写本地日志文件。
3. **改名**：包名、可执行文件、配置目录（`~/.haruyuki`）与环境变量前缀（`HARUYUKI_*`）。
   仅有 8 个与上游 SDK 契约绑定的名字**刻意保留 `LETTA_` 前缀**。
4. **品牌与素材自持**：自有配色与标记；上游 OAuth 回调页的 ASCII art 已删除并换为自有标记，随包的默认头像已替换为原创图像。
5. **机制调整与新增**：前缀冻结、话题裁切、后台反思、本地后端与记忆同步等（见上表"特色"）。
6. **文档自持**：不镜像上游文档正文；本 README ＋ [CONTRIBUTING.md](CONTRIBUTING.md) ＋ [NOTICE](NOTICE) 是权威说明。

---

## 三、安装

前置：**Bun ≥ 1.3.2**（构建用）与 **Node ≥ 22.19**（运行产物用）。

### 方式一：从源码构建（推荐）

```bash
git clone <本仓库地址>
cd LettaCodeBetter
bun install
bun run build        # 产出仓根 haruyuki.js（已 gitignore）
node ./haruyuki.js   # 启动交互界面
```

> 构建产物是**单文件 bundle**（约 21 MB），它把生产依赖内联其中；`--version` 应打印 `0.1.0 (Haruyuki)`。

### 方式二：npm 包

```bash
npm install -g haruyuki         # 或 npx haruyuki
npm install -g haruyuki@beta    # 预发布版（先占 beta，latest 最后动）
```

> npm 上的 `haruyuki` 由本分支维护者发布，**不是** Letta, Inc. 的官方发行；包内已含 `LICENSE`、`NOTICE`、
> `THIRD-PARTY-NOTICES.md` 与 `CONTRIBUTING.md`（改动清单）。

对接模型（任选其一）：

```bash
haruyuki connect openai        # 或 anthropic / z.ai 等，按提示填 API key
# 也可以直接在会话里用 /connect
```

---

## 四、快速开始

```bash
haruyuki                                      # 交互 TUI：恢复本项目上次的会话
haruyuki --new-agent --personality tutorial   # 建一个教程 agent
haruyuki --new                                # 新建会话（保留 agent 记忆）
haruyuki -p "用一句话说明你自己" --output-format json   # headless，带统计
```

交互会话里先试这几条：`/help`、`/init`（初始化记忆）、`/model`（换模型）、`/skills`、`/doctor`。

---

## 五、命令面（按源码路由表整理）

### CLI 子命令

| 命令 | 用途 |
|---|---|
| `memory …` | MemFS 记忆：`status` / `diff` / `resolve` / `backup(s)` / `restore` / `export` / `pull` / `tokens` |
| `agents …` | agent 列表与查询（JSON 输出） |
| `model …` | 查询/设置模型与推理档位（JSON 输出） |
| `messages …` | 消息 `search` / `list` / `transcript` |
| `steps …` | `trace`：按 step 追一次执行的细节 |
| `mcp …` | 列出、检索、调用 agent 可用的 MCP 工具 |
| `mods …` | 本地 mod：`list` / `package` / `enable` / `disable` / `remove` |
| `skills …` | 列出或删除已装技能 |
| `install …` | 安装技能或 mod 包 |
| `connect …` | 在终端里配置 provider |
| `secret …` | 管理 shell 命令可用的密钥 |
| `cron …` | 本地计划任务 |
| `channels …` | 外部渠道（Slack / Telegram / 自定义） |
| `server …` | 本地 app-server ＋ 渠道网关（`--listen [url]`） |
| `local-backend migrate-transcripts` | 迁移本地 transcript 存储 |

### 常用 slash 命令

| 命令 | 用途 |
|---|---|
| `/init` `/memory` `/memfs` `/palace` | 初始化、查看记忆；MemFS 开关；打开记忆查看器 |
| `/reflect` `/dream` `/sleeptime` | 反思与后台反思的触发设置 |
| `/topic` `/topics` `/compact` | 标记话题边界、列出话题块、按边界裁切上下文 |
| `/context-pending` `/recompile` | 查看待应用的前缀改动 / 显式应用（会失效缓存，可能增加开销） |
| `/model` `/reasoning-tab` `/toolset` `/system` `/personality` | 模型、推理档位、工具集、系统提示、人格 |
| `/skills` `/skill-creator` `/mods` `/hooks` `/mcp` `/secret` | 技能、mod、钩子、MCP、密钥 |
| `/search` `/subagents` `/workflows` `/bg` `/context` `/usage` | 检索、子 agent、workflow、后台进程、上下文占用、用量 |
| `/fork` `/btw` `/new` `/resume` `/pin` `/profiles` `/rename` | 会话与 agent 管理 |
| `/memory-repository` `/reload` `/statusline` `/feedback` `/help` | 记忆仓远端、重载设置与 mod、状态栏、反馈（写本地日志）、帮助 |

---

## 六、平台与已知限制

| 项 | 说明 |
|---|---|
| Windows | **自动反思默认关闭**（包含已保存的 `/sleeptime` 设置）；手动 `/reflect`、`/dream` 可用。要打开自动反思，在启动 Haruyuki 的进程里设 `HARUYUKI_ENABLE_WINDOWS_AUTO_REFLECTION=1` |
| 沙箱 | 内核级文件沙箱只在 macOS（seatbelt）与 Linux（bwrap）可用；**Windows 没有内核后端**（代码事实，见 `src/sandbox/availability.ts`），跨 agent 记忆围栏退回到静态路径守卫 |
| 内核沙箱验收 | ⑪-C 的 kernel 端到端（设 `HARUYUKI_HOME` → agent 写一次记忆 → 不被拒）**尚未在 macOS/Linux 上跑过** |
| 前缀恢复验收 | 窄/宽终端下的视觉与 `/context-pending` → `/recompile` 的恢复流程**尚未实机验收** |
| 遗留接口 | `--computer`、`--no-wait`、`--memfs-startup` 等参数仍在帮助里（上游兼容面），本分支不承诺其云端语义可用 |
| 未实现的路线 | 树状记忆、向量召回、会话分叉归档等结构性改造仍是**方向**，未落地 |

---

## 七、数据、日志与隐私

- 所有 agent 状态、记忆与 transcript 都在 `~/.haruyuki`（或 `HARUYUKI_HOME` 指向的位置）与你自己的 provider 账号里；
  本分支**不上报遥测**，也不把诊断内容发给第三方。
- 崩溃/边界错误日志、`/feedback` 报告都写本地文件（`~/.haruyuki/logs/`）。
- `haruyuki memory backup` 可在动记忆前留快照；记忆目录本身是 git 仓，任何改动都有提交记录。
- 与上游共用的 8 个 `LETTA_*` 环境变量只影响**本地路径与 provider 凭据**的读取，不产生出站调用。

---

## 八、许可与法律声明

### 许可证

本项目以 **Apache License 2.0** 授权，全文见 [LICENSE](LICENSE)。
`LICENSE` 是上游原样分发的文本，包含两处必须原样保留的内容：

1. `Copyright 2025, Letta authors` —— 上游版权行；
2. **Brand Assets Exclusion**（品牌资产排除条款）—— 明确 Letta 名称、Letta Code 名称、logo、wordmark、
   **图片**与 **ASCII art** **不在** Apache-2.0 授权范围内，未经 Letta, Inc. 书面许可不得用于衍生作品。

### 这是一个修改版

本仓库是 `letta-code` 的**衍生作品**，源码文件已被修改（逐项清单见 [CONTRIBUTING.md](CONTRIBUTING.md#相对上游的改动清单)）。
按 Apache-2.0 §4(b) 的要求，**仓库级"已修改"声明**写在 [NOTICE](NOTICE) 与本节里，而不是逐个文件重复。
上游项目**没有** `NOTICE` 文件；本分支的 `NOTICE` 由本分支添加，下游再分发时须一并保留。

**版权声明的范围**：本分支**仅对自己新增与修改的部分**主张版权（`Copyright 2026 TZYLT`），**不主张整个仓库**；
上游部分仍是 `Copyright 2025, Letta authors`。主张的**依据是维护者的智力贡献**（架构与设计、取舍与编排、审阅与修正）——
AI 在本项目中是工具，**不构成放弃权利**；AIGC 声明是**标识**，不是免责。
详见 [NOTICE](NOTICE) §1「Scope of the copyright claim」。

### 第三方组件

`haruyuki.js` 是单文件 bundle，内联了大量生产依赖；`vendor/` 下还有两份打过补丁的第三方源码
（Ink、ink-text-input）。它们的许可原文、每个包的版权行，以及闭包内 NOTICE 文件的扫描结果
（当前为 0 命中）逐条列在 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) ——
该文件由 `node scripts/generate-third-party-notices.cjs` 生成，依赖变化后请重新生成。

依赖闭包里的 `@letta-ai/*` 包由 Letta, Inc. 作为独立 npm 包发布，其自带资产不属于本项目的分发物。

### 商标与品牌资产

"Letta"、"Letta Code" 及 Letta logo 是 Letta, Inc. 的商标/品牌资产。本项目**仅以指称来源的方式**
（nominative use）使用这些名称，以满足 Apache-2.0 的署名要求；使用本项目**不会**为你带来任何 Letta 商标权利。

为遵守品牌资产排除条款，本分支**不使用也不分发**任何 Letta logo、wordmark、品牌图片或品牌 ASCII art：
上游 OAuth 回调页的 `LETTA` ASCII 图形已删除（换成自有的 `❄ haruyuki` 标记），
上游随包的那张教程头像已替换为本分支自行生成的原创图像。

### 无关联声明

本项目由第三方（TZYLT，`TZY143@126.com`）独立维护，**与 Letta, Inc. 无任何隶属、合作、
赞助或背书关系**。上游对本分支的任何内容不作担保，也不承担支持义务。

### 权利通知与侵权联系

本分支是第三方对 `letta-code` 的修改版。若你是权利人，认为本仓库中的任何内容
（文字、代码、图片或其他素材）侵犯了你的权利，请联系：

> **TZY143@126.com**

为便于快速处理，来信请尽量包含：① 你的身份与权利依据；② 涉嫌内容的具体位置
（文件路径、行号或 URL）；③ 你希望的处理方式（移除 / 替换 / 补充署名等）。

我们会**在核实后尽快处理**：移除或替换相关内容，或给出可核验的授权依据；在争议澄清前，
相关文件可先行下线。本分支**不镜像** `docs.letta.com` 的任何文档正文，也不使用 Letta 的任何品牌资产 ——
若仍有遗漏，请直接指出，我们按上述方式处理。

### 免责声明

软件按 **"AS IS"** 基础提供，不附带任何明示或默示担保。你需自行负责：模型 provider 的
使用条款与费用、你的数据合规、以及本分支相对上游的行为差异。

---

## 九、上游与致谢

Haruyuki 派生自 [letta-code](https://github.com/letta-ai/letta-code) —— 由
[MemGPT](https://arxiv.org/abs/2310.08560) 与
[sleep-time compute](https://arxiv.org/abs/2504.13171)（即现在的 "dreaming"）的作者们开发。
上游代码以 Apache-2.0 授权，本分支在此致谢。除署名与技术标识外，本项目与上游无其他关系。
