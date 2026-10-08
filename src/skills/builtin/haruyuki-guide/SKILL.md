---
name: haruyuki-guide
description: Answer questions about this build from the reference documents bundled with it. Load before answering anything about commands, flags, slash commands, settings keys, file layout, or agent behavior — and never answer those from memory.
---

# Haruyuki Guide

You are running inside this build, but your training data about its commands,
flags, settings, UI, and file layout is out of date, and most of it describes a
hosted service this build does not use. Users lose trust fastest when an agent
confidently invents product details. This skill defines how to answer questions
about this build: read its own bundled reference, inspect the live session, and
read this repository's source when the reference is silent.

## Source route (in order)

1. **Self-inspection first for questions about THIS agent.** "What model are you
   using?", "what tools do you have?", "what's in your memory?" are questions
   about the running session, not about the product. Load the
   `self-configuration` skill for model or settings questions and use its
   backend-aware active configuration report. Use the system prompt, agent
   info, tool schemas, and MemFS for the other live facts. Do not infer active
   state from recent/default preference lists.
2. **Read the bundled reference index.** Run:

   ```bash
   node <SKILL_DIR>/scripts/read-local-docs.mjs
   ```

   It lists every reference document shipped with this build, with each
   document's heading outline and line ranges, so you can pick the one that
   matches the question.
3. **Read one document, or search all of them.** This route is offline: the
   reader only reads files from this skill's own `docs/` directory.

   ```bash
   node <SKILL_DIR>/scripts/read-local-docs.mjs --doc <slug>
   node <SKILL_DIR>/scripts/read-local-docs.mjs --search "<text>"
   ```

   `--search` prints `document.md:line: text` hits, so you can locate a flag or
   settings key and then read the section around it.
4. **When the reference does not cover it, say so and go to the source.** The
   authority for this build is its own code: `letta --help`, `<command>
   --help`, the slash commands listed by `/help`, and the source file that
   implements the behavior. Do not answer from the upstream project's hosted
   documentation, blog posts, or marketing copy — this build has diverged from
   it, so its commands, settings, and limits do not describe what runs here.
   Never silently fall back to memory.
5. **When `docs/` is empty, the reader says so.** That is a real answer: tell
   the user the detail is not documented yet, then ground the reply in source
   you actually read. Do not fill the gap with invented specifics.

## Match a document to the user's setup

Read each document's `applies_to` frontmatter before using its instructions:

```yaml
applies_to:
  backends: [local]
  interfaces: [cli, desktop, sdk]
```

- **Backends** describe where the agent lives. Every agent in this build runs on
  the `local` backend; a document written for a hosted backend does not apply
  to it.
- **Interfaces** name the surface the instructions are written for: `cli` for
  this terminal UI, `desktop` for the app-server surface, `sdk` for the
  programmatic client. Answer for the surface the user is actually on, and say
  when a feature belongs to a different one.
- Do NOT use context from documents marked `status: legacy` unless providing
  historical context.

## Inspect or change your model from the CLI

- `letta model list [--byok | --hosted] [--structured-outputs]` lists the active
  backend's models with their catalog IDs, reasoning levels, and
  structured-output support.
- `letta model set [handle] [--reasoning <level>] [--default]` selects a model,
  or changes reasoning only.
- `letta model get [--default]` shows the effective model and the redacted
  model settings.
- Run `letta model --help` before using a flag that is not listed here.

## Hard rules

- **Never invent CLI commands, flags, slash commands, settings keys, config
  file shapes, or UI paths.** If the reference and the source both fail to show
  it, say you are not sure or that it does not exist — do not guess a
  plausible-sounding name.
- **Distinguish surfaces.** The terminal UI, the desktop/app-server surface, and
  the programmatic client have different affordances. Answer for the surface
  the user is actually on; say when a feature lives on a different one.
- **Always read, never recall**, for anything volatile: the provider and model
  catalog, storage locations, defaults, and the exact wording of settings keys.
- **If the feature genuinely doesn't exist here**, say so plainly. This build
  has no hosted status page and no support community, so the answer lives in
  this repository: offer to read the relevant source with the user.

## Keeping this route honest

Reference documents are written for this build and every entry cites the source
file it came from. If a document contradicts the source, the source wins — say
so, and report the drift instead of quietly following the document. Read the
documents in place; do not copy them into another cache or rewrite them.
