# Haruyuki

English · [简体中文](README.md)

> [!WARNING]
> **AIGC disclosure (AI-generated content) and usage warning**
>
> Much of this project's **code and documentation was produced with AI assistance** (AI drafting plus
> review, decisions, and verification by the human maintainer). The commit history, [NOTICE](NOTICE),
> and [CONTRIBUTING.md](CONTRIBUTING.md) record the origin, reasoning, and verification of each change.
>
> - **It can be wrong**: AI-generated material may contain logic errors, stale information, security flaws,
>   misused dependencies, or plausible-sounding but incorrect conclusions. This project is provided
>   **"AS IS"**, **without warranty of any kind**; review, test, and assess the risk yourself before using
>   or redistributing it.
> - **Legal text is not legal advice**: the copyright, trademark, and licensing analysis in this repository
>   is engineering-level source research and **does not constitute legal advice**. Consult a qualified
>   lawyer before publishing, commercialising, enforcing rights, or signing agreements.
> - **Responsibility**: AI tools bear no responsibility; the human maintainer and the user own the final
>   decisions and their consequences.
> - **Reuse and quotation**: if your jurisdiction or platform requires labelling AI-generated content
>   (for example China's Interim Measures for the Management of Generative AI Services, or platform AIGC
>   labels), please **keep this disclosure** when you quote, screenshot, or reuse this project's content.
> - **Not an official release**: this is not an official Letta, Inc. product and has not been reviewed,
>   tested, or endorsed by them (see [§8](#8-license-and-legal-notices)).
> - **Bug reports and requests**: use this fork's own issue tracker —
>   <https://github.com/TZYLT/haruyuki/issues>. A `/feedback` report is written to a local log only; it is
>   never sent there automatically.

> **A local-first, companionship-oriented agent runtime — a heavily modified fork of `letta-code`.**
>
> This fork is **not affiliated with, sponsored by, or endorsed by Letta, Inc.** The names "Letta" and
> "Letta Code" are used **only to describe the origin of the code**, which `LICENSE` §6 expressly allows
> ("reasonable and customary use in describing the origin of the Work"); the **logo, wordmark, images, and
> ASCII art are neither used nor distributed** (upstream's Brand Assets Exclusion).
> Legal notices live in [NOTICE](NOTICE), third-party licenses in
> [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md), and the **rights-holder (infringement) contact is in
> [§8 → Rights-holder / infringement contact](#rights-holder--infringement-contact)**.

---

## 1. What this project is

Haruyuki is an agent runtime that runs on **your own machine**. It treats an agent's memory, identity, and
behaviour as **assets that evolve over long horizons**: memory is a git-versioned file tree, the system prompt
and tool list can be recompiled on demand, and reflection runs as a separate background agent. No service
sign-in, no state held by anyone else.

### Goals

| Goal | Meaning |
|---|---|
| **Companionship, not a tool window** | Built for one agent you live with over time: it remembers, keeps a stable self, and continues across sessions instead of starting from zero |
| **Full control over context** (top priority) | What your request looks like before it is sent should be **visible, explainable, and your decision**: when the system prompt, tool list, and memory enter the context prefix is triggered by you, not silently rewritten |
| **Genuinely local** | State, memory, logs, and credentials live in your filesystem; the runtime is fully functional with no cloud service |
| **Freedom to re-develop** | Diverged from upstream at `v0.34.2` (no upstream merges, no cherry-picks) to allow structural work — tree-shaped memory, vector recall, conversation forking and archiving (**directions, not implemented yet**) |
| **Auditable** | No mirroring of upstream documentation; every change relative to upstream is itemised in [CONTRIBUTING.md](CONTRIBUTING.md) |

### Highlights

| Highlight | Description |
|---|---|
| **Memory as a file tree** | MemFS: all context (memory blocks included) is tracked by git — diffable, revertible, pushable to your own remote |
| **Prefix freeze** | Prompt/tool/memory changes **never silently rewrite context already sent**; inspect pending changes with `/context-pending`, apply them with `/recompile` |
| **Topic trimming** | `/topic`, `/topics`, `/compact` — trim at a topic boundary you choose instead of dropping a percentage |
| **Background reflection (passive memory)** | A reflection agent runs alongside you and curates memory; `/reflect`, `/dream`, `/sleeptime` control when it fires |
| **Local backend** | One backend mode (`--backend local`): agents, conversations, memory, and transcripts all on this machine |
| **Skills and mods** | Bundled skills plus project/user-installed ones; mods hook lifecycle, turns, panels, commands, and tools |
| **Multi-agent** | Any agent can run as another agent's subagent (including built-in fork and recall subagents) |
| **Channels and a local server** | `haruyuki server` provides a local app-server, WebSocket, and Slack/Telegram channels |
| **Local-only diagnostics** | No telemetry; crash/boundary logs and `/feedback` write local files and nothing else |
| **Chinese-friendly** | A Chinese-oriented built-in personality (`Haruyuki-Chan`); the main README and planning docs are in Chinese |

---

## 2. What changed relative to upstream (summary)

> **This is only the summary. The itemised change list — with the reasoning and trade-offs behind each
> entry — is in [CONTRIBUTING.md → 相对上游的改动清单](CONTRIBUTING.md#相对上游的改动清单) (Chinese).**

1. **Cloud functionality removed wholesale**: the Letta Cloud backend and sign-in, teleport, remote-computer
   and environment routing, hosted sandboxes, hosted schedules, shared memory, usage/quota auto-swap, and the
   skills that existed only to drive those features.
2. **Outbound paths cut**: telemetry and third-party error/feedback reporting are gone; diagnostics are written
   to local log files.
3. **Renamed**: package, executable, config directory (`~/.haruyuki`), and environment prefix (`HARUYUKI_*`).
   Exactly eight names bound to an upstream SDK contract **keep the `LETTA_` prefix on purpose**.
4. **Brand and assets self-owned**: our own palette and mark; upstream's ASCII art on the OAuth callback page is
   gone (replaced by our mark) and the bundled tutorial avatar is an original image.
5. **Mechanics reworked or added**: prefix freeze, topic trimming, background reflection, the local backend and
   memory sync (see "Highlights" above).
6. **Documentation self-owned**: no mirrored upstream docs; this README, [CONTRIBUTING.md](CONTRIBUTING.md), and
   [NOTICE](NOTICE) are the authoritative description.

---

## 3. Install

Requirements: **Bun ≥ 1.3.2** (to build) and **Node ≥ 22.19** (to run the artifact).

### Option 1 — build from source (recommended)

```bash
git clone <this repository>
cd LettaCodeBetter
bun install
bun run build        # writes haruyuki.js in the repo root (gitignored)
node ./haruyuki.js   # start the interactive UI
```

> The build output is a **single-file bundle** (~21 MB) with production dependencies inlined.
> `--version` should print `0.1.0 (Haruyuki)`.

### Option 2 — the npm package

```bash
npm install -g haruyuki         # or npx haruyuki
npm install -g haruyuki@beta    # prerelease channel (beta first, latest last)
```

> The `haruyuki` package on npm is published by this fork's maintainer, **not** by Letta, Inc. The tarball
> ships `LICENSE`, `NOTICE`, `THIRD-PARTY-NOTICES.md`, and `CONTRIBUTING.md` (the change list).

Connect a model (either way works):

```bash
haruyuki connect openai        # or anthropic, z.ai, ... — follow the prompts
# or use /connect inside a session
```

---

## 4. Quick start

```bash
haruyuki                                      # TUI: resume this project's last conversation
haruyuki --new-agent --personality tutorial   # create a tutorial agent
haruyuki --new                                # new conversation (keeps agent memory)
haruyuki -p "describe yourself in one line" --output-format json   # headless, with stats
```

Inside a session, start with `/help`, `/init` (initialize memory), `/model`, `/skills`, `/doctor`.

---

## 5. Command surface (taken from the source routing table)

### CLI subcommands

| Command | Purpose |
|---|---|
| `memory …` | MemFS memory: `status` / `diff` / `resolve` / `backup(s)` / `restore` / `export` / `pull` / `tokens` |
| `agents …` | List and query agents (JSON output) |
| `model …` | Get, list, or set models and reasoning tiers (JSON output) |
| `messages …` | `search` / `list` / `transcript` |
| `steps …` | `trace`: follow one execution step by step |
| `mcp …` | List, search, and call MCP tools available to an agent |
| `mods …` | Local mods: `list` / `package` / `enable` / `disable` / `remove` |
| `skills …` | List or delete installed skills |
| `install …` | Install a skill or mod package |
| `connect …` | Configure providers from the terminal |
| `secret …` | Manage secrets for shell commands |
| `cron …` | Local scheduled tasks |
| `channels …` | External channels (Slack / Telegram / custom) |
| `server …` | Local app-server and channel gateway (`--listen [url]`) |
| `local-backend migrate-transcripts` | Migrate the local transcript store |

### Common slash commands

| Command | Purpose |
|---|---|
| `/init` `/memory` `/memfs` `/palace` | Initialize and inspect memory; toggle MemFS; open the memory viewer |
| `/reflect` `/dream` `/sleeptime` | Reflection and background-reflection triggers |
| `/topic` `/topics` `/compact` | Mark a topic boundary, list topic blocks, trim at a boundary |
| `/context-pending` `/recompile` | Inspect pending prefix changes / apply them (evicts the cache, may cost more) |
| `/model` `/reasoning-tab` `/toolset` `/system` `/personality` | Model, reasoning tier, toolset, system prompt, personality |
| `/skills` `/skill-creator` `/mods` `/hooks` `/mcp` `/secret` | Skills, mods, hooks, MCP, secrets |
| `/search` `/subagents` `/workflows` `/bg` `/context` `/usage` | Search, subagents, workflows, background processes, context usage, usage stats |
| `/fork` `/btw` `/new` `/resume` `/pin` `/profiles` `/rename` | Conversation and agent management |
| `/memory-repository` `/reload` `/statusline` `/feedback` `/help` | Memory remote, reload settings and mods, statusline, feedback (local log), help |

---

## 6. Platform notes and known limitations

| Item | Detail |
|---|---|
| Windows | **Automatic reflection is off by default** (even when saved `/sleeptime` settings enable it); manual `/reflect` and `/dream` still work. To opt in, set `HARUYUKI_ENABLE_WINDOWS_AUTO_REFLECTION=1` in the environment of the Haruyuki process |
| Sandboxing | A kernel-level filesystem sandbox exists only on macOS (seatbelt) and Linux (bwrap). **Windows has no kernel backend** — a code fact, see `src/sandbox/availability.ts` — so the cross-agent memory guard falls back to static path checks |
| Kernel sandbox verification | The end-to-end kernel check (set `HARUYUKI_HOME` → let an agent write memory → confirm it is not denied) has **not been run on macOS/Linux yet** |
| Prefix recovery verification | Narrow/wide terminal rendering and the `/context-pending` → `/recompile` recovery flow have **not been verified on a real terminal yet** |
| Legacy flags | `--computer`, `--no-wait`, `--memfs-startup` and friends are still listed in `--help` for upstream compatibility; this fork does not promise their cloud semantics work |
| Unimplemented directions | Tree-shaped memory, vector recall, and conversation forking/archiving remain **directions**, not shipped features |

---

## 7. Data, logs, and privacy

- Agent state, memory, and transcripts live in `~/.haruyuki` (or wherever `HARUYUKI_HOME` points) and in your own
  provider account. This fork sends **no telemetry** and forwards no diagnostics to third parties.
- Crash/boundary-error logs and `/feedback` reports are written to local files (`~/.haruyuki/logs/`).
- `haruyuki memory backup` snapshots memory before risky edits; the memory directory is itself a git repository,
  so every change is committed.
- The eight shared `LETTA_*` variables only affect how local paths and provider credentials are read; they cause
  no outbound calls.

---

## 8. License and legal notices

### License

This project is licensed under the **Apache License 2.0** — see [LICENSE](LICENSE).
That file is the upstream text, redistributed verbatim, and it contains two parts that must be kept:

1. `Copyright 2025, Letta authors` — the upstream copyright line;
2. the **Brand Assets Exclusion** — the Letta name, Letta Code name, logo, wordmark, **images**, and **ASCII
   art** are explicitly **not** licensed under Apache-2.0 and may not be used in derivative works without
   written permission from Letta, Inc.

### This is a modified version

This repository is a **derivative work** of `letta-code`; its source files have been changed (the itemised list
is in [CONTRIBUTING.md](CONTRIBUTING.md#相对上游的改动清单), Chinese). As required by Apache-2.0 §4(b), the
**repository-level "changed files" notice** lives in [NOTICE](NOTICE) and in this section rather than being
repeated in every individual file.

Upstream ships **no** `NOTICE` file; the one in this fork is added by the fork and must be kept by downstream
recipients.

**Scope of the copyright claim**: this fork claims copyright **only over its own additions and
modifications** (`Copyright 2026 TZYLT`), never over the repository as a whole; the upstream portions remain
`Copyright 2025, Letta authors`. The claim rests on **the maintainer's intellectual contribution** —
architecture and design, selection and arrangement, review and correction. AI is a tool in this project and
**does not waive any right**; the AIGC disclosure is a labelling statement, not a disclaimer. See
[NOTICE](NOTICE) §1, "Scope of the copyright claim".

### Third-party components

`haruyuki.js` is a single-file bundle that inlines most production dependencies, and `vendor/` carries two
patched third-party sources (Ink and ink-text-input). Their license texts, every package's copyright line, and
the result of the NOTICE-file scan over the closure (currently zero hits) are listed in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). That file is generated by
`node scripts/generate-third-party-notices.cjs`; regenerate it whenever dependencies change.

The `@letta-ai/*` packages inside the dependency closure are published by Letta, Inc. as separate npm packages;
the assets they ship are not part of this project's distribution.

### Trademarks and brand assets

"Letta", "Letta Code", and the Letta logo are trademarks and/or brand assets of Letta, Inc. They are used here
only to identify the origin of the code (nominative use) and to satisfy Apache-2.0's attribution requirements.
Using this project grants you no rights to the Letta marks.

To comply with the Brand Assets Exclusion, this fork **neither uses nor distributes** any Letta logo, wordmark,
brand image, or brand ASCII art. The upstream `LETTA` ASCII art on the OAuth callback page has been removed
(replaced with this fork's own `❄ haruyuki` mark), and the bundled tutorial avatar has been replaced with an
original image generated for this fork.

### No affiliation

This project is independently maintained by a third party (TZYLT, `TZY143@126.com`) and has **no affiliation,
partnership, sponsorship, or endorsement relationship with Letta, Inc.** Upstream provides no warranty and no
support for anything in this fork.

### Rights-holder / infringement contact

This fork is a third-party modified version of `letta-code`. If you are a rights holder and believe that any
content in this repository (text, code, images, or other material) infringes your rights, please write to:

> **TZY143@126.com**

To speed things up, please include: (1) who you are and the rights you rely on; (2) the exact location of the
material (file path, line number, or URL); (3) what you would like us to do (remove, replace, add attribution,
…).

We will **act promptly once the claim is verified**: remove or replace the material, or point to a verifiable
licence. Pending clarification, the affected files can be taken down first. This fork does **not** mirror any
`docs.letta.com` documentation text and does not use any Letta brand asset — if something was missed, tell us
and we will handle it the same way.

### Disclaimer

The software is provided **"AS IS"**, without warranty of any kind. You are responsible for your model
provider's terms and costs, for your own data compliance, and for the behavioural differences between this fork
and upstream.

---

## 9. Upstream and credits

Haruyuki is derived from [letta-code](https://github.com/letta-ai/letta-code), built by the authors of
[MemGPT](https://arxiv.org/abs/2310.08560) and
[sleep-time compute](https://arxiv.org/abs/2504.13171) (now called "dreaming"). Upstream code is licensed under
Apache-2.0, and this fork is grateful for it. Apart from attribution and technical identifiers, this project has
no relationship with upstream.
