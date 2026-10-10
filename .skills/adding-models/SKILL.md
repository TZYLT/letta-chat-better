---
name: adding-models
description: Guide for adding new LLM models to Haruyuki. Use when the user wants to add support for a new model, needs to know valid model handles, or wants to update model-specific compatibility behavior. Covers runtime catalog sources, CI test matrices, and handle validation.
---

# Adding Models

This skill guides you through adding a new LLM model to Haruyuki.

## Quick Reference

**Key files**:
- `src/agent/remote-model-catalog.ts` - Runtime catalog loading and projection
- `src/agent/model-catalog.ts` - Model lookup and compatibility aliases
- `.github/workflows/ci.yml` - CI test matrix (optional)
- `src/tools/manager.ts` - Toolset detection logic (rarely needed)

## Workflow

### Step 1: Find Valid Model Handles

First identify the agent source. These inputs are deliberately different:

| Agent source | Rows shown | Labels, presets, and capabilities |
|---|---|---|
| Local (this fork's only mode) | pi-ai inventory | pi-ai metadata |
| Custom App Server | Server runtime inventory | Server runtime metadata |

This fork is local-only: there is no hosted catalog to query, and nothing in this
build calls one. The hosted and BYOK row handling described in upstream notes does
not apply here.

List what the running build actually resolves instead of querying a remote
service:

```bash
haruyuki model list                # JSON rows: id / handle / capabilities
haruyuki model get --agent <id>    # the model that agent actually resolves to now
```

Use only handles that appear there. Do not hand-write a catalog from memory, and do
not copy handles out of another product's documentation — a handle the local
runtime cannot resolve fails at request time, and that failure looks like a
provider error.

Common provider prefixes:
- `anthropic/` - Claude models
- `openai/` - GPT models  
- `google_ai/` - Gemini models
- `google_vertex/` - Vertex AI
- `openrouter/` - Various providers

### Step 2: Update the Owning Catalog

Haruyuki does not bundle a model catalog:

- Local model inventory comes from pi-ai and the active provider runtimes.
- This fork has no hosted catalog and no BYOK row merging; do not reintroduce
  either.

Add the model at the source that owns it. A provider model belongs in pi-ai or that provider's discovery runtime.

Only change this repository when the model needs Haruyuki-specific compatibility behavior, such as preserving an established CLI alias or recognizing a new provider for toolset selection. Keep that logic narrow and derive the handle and metadata from the runtime catalog rather than copying model definitions here.

### Step 3: Test the Model

Test with headless mode:

```bash
bun run src/index.ts --new --model <model-id> -p "hi, what model are you?"
```

Example:
```bash
bun run src/index.ts --new --model gemini-3-flash -p "hi, what model are you?"
```

### Step 4: Add a Regression Test (Optional)

This fork has no CI workflow (`.github/` does not exist here); the gate is the
local check suite plus the unit tests. To keep a new model honest, extend the
focused tests next to the code that owns the handle:

```bash
bun test src/agent/available-models.test.ts
bun test src/agent/model-catalog.test.ts
bun run check                                 # 14 repo guards
```

## Toolset Detection

Models are automatically assigned toolsets based on provider:
- `openai/*` → `codex` toolset
- `google_ai/*` or `google_vertex/*` → `gemini` toolset
- Others → `default` toolset

This is handled by `isGeminiModel()` and `isOpenAIModel()` in `src/tools/manager.ts`. You typically don't need to modify this unless adding a new provider.

## Common Issues

**"Handle not found" error**: The model handle is incorrect. Run `haruyuki model list` to see the handles this build resolves.

**Model works but wrong toolset**: Check `src/tools/manager.ts` to ensure the provider prefix is recognized.
