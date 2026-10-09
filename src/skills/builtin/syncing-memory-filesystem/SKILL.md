---
name: syncing-memory-filesystem
description: Diagnose and repair MemFS repository setup, checkout problems, optional backup remotes, or merge/rebase conflicts. Do not load for routine memory reads or edits.
---

# MemFS Repository Repair

Use this skill only when the Git repository behind an agent's memory is not
setting up or syncing correctly. For ordinary memory reads and edits, use the
memory files without loading this skill. Delegate incidental upkeep during another
task to the background `memory` subagent. When memory repair is the user's main
request, diagnose and repair it directly, then verify the result before reporting
success. If a memory worker you launched may still be running, wait for it: re-read
its output file until it ends with `[Task completed]` or `[Task failed]` before
editing memory files or changing Git state. While the harness reports a repair in
progress, leave both alone as well; that worker edits `$MEMORY_DIR` in place.

## Current Model

MemFS is a Git repository projected onto the computer where the agent is
running. `$MEMORY_DIR` is the repository root. There is no second `memory/`
directory inside it.

The repository is local-only. It has no hosted remote, so nothing is pushed or
pulled for it and no server credentials are involved.

The repository can use either memory layout. Inspect its current tree and the
memory rules in the system prompt before editing files:

```text
Root layout                         Existing layout
$MEMORY_DIR/                        $MEMORY_DIR/
├── MEMORY.md     # root index      ├── system/     # in-context memory
├── persona.md    # core memory     ├── reference/  # deferred memory
├── <topic>/                        └── skills/     # agent-owned skills
│   └── MEMORY.md # child index
└── skills/       # agent-owned skills
```

The agent doing the memory work commits its changes, and those commits stay on
this machine. There is no remote, so the harness runs no post-turn sync and
never pushes memory anywhere.

Committed memory changes do not alter the current compiled prompt immediately.
Use `/recompile` when the current conversation must see changed core memory
right away. Otherwise, the next prompt compilation or conversation will use
the committed revision.

## Start With the Harness

Prefer the harness commands over manual API calls, remote construction, or
credential-helper edits:

```text
/memfs status    # show whether MemFS is enabled and its path
/memfs enable    # initialize or repair MemFS setup
/memfs sync      # sync blocks and files now
```

From a shell, the standalone status and pull commands are:

```bash
haruyuki memory status --agent "$AGENT_ID"
haruyuki memory pull --agent "$AGENT_ID"
```

`haruyuki memory pull` is a no-op and says so: there is no remote to pull from.

Do not reproduce `/memfs enable` by PATCHing agent tags or constructing a Git
remote by hand. The enable flow also updates the system prompt mode, recompiles
the agent, persists local settings, preserves and adds tags, initializes the
checkout, installs hooks, configures identity, and seeds default memory files.

## Inspect a Broken Checkout

Use `$MEMORY_DIR` instead of a hard-coded `~/.haruyuki/agents/...` path; let the
harness resolve the active root.

```bash
git -C "$MEMORY_DIR" status --short --branch
git -C "$MEMORY_DIR" remote get-url origin | sed -E 's#(https?://)[^/@]+@#\1<redacted>@#'
git -C "$MEMORY_DIR" log -5 --oneline
```

The `origin` remote is normally absent. It is present only when the user set
the optional backup remote described below.

Do not print credential-helper values or tokens. Do not change global Git
configuration. The harness installs or refreshes repository-local hooks and
identity when MemFS is enabled.

If the checkout is missing `.git/`, use `/memfs enable`. There is no upstream
to be behind, so a memory problem is never fixed by pulling.

## Uncommitted Changes

Raw file edits must preserve the active layout's rules:

- In the root layout, root and child `MEMORY.md` indexes have no frontmatter.
  Every other memory Markdown file has exactly `name` and `description`.
- In the existing layout, Markdown files under `system/` and `reference/` need
  a non-empty `description`. `read_only` is protected and cannot be added,
  removed, or changed by the agent.

```markdown
---
description: What this memory file contains
---

Memory content goes here.
```

Review the complete diff before committing. Stage named memory files only and
create a new commit. Those commits stay on this machine; the harness does not
push MemFS anywhere.

## Merge or Rebase Conflicts

The harness runs no post-turn sync and does not push memory, so it cannot
produce a conflict by itself. A merge or rebase can still appear if the user
pushed the optional backup remote, or ran Git in the memory repository
themselves. The instructions below are for that case.

Start by reading the current Git operation and every conflicted file:

```bash
git -C "$MEMORY_DIR" status
git -C "$MEMORY_DIR" diff --name-only --diff-filter=U
```

Resolve the conflict markers without deleting required frontmatter, then stage
the resolved files by name. Finish the operation Git reports:

```bash
git -C "$MEMORY_DIR" add <resolved-memory-path>

# If git status says a rebase is in progress:
GIT_EDITOR=true git -C "$MEMORY_DIR" rebase --continue

# If git status says a merge is in progress:
git -C "$MEMORY_DIR" commit
```

Do not start a new merge when a rebase is already in progress. Do not reset,
abort, or discard either side without the user's approval. When the repository
is clean and the merge or rebase is complete, there is nothing further to push.

## Optional Backup Remote

`/memory-repository` mirrors the agent's `main` branch to an additional Git
URL. It is the only remote a memory repository can have.

```text
/memory-repository set git@github.com:you/my-memory.git
/memory-repository status
/memory-repository push
/memory-repository unset
```

`set` stores `letta.memoryRepository.url` in the MemFS repository's local Git
config, installs the post-commit hook, and attempts an initial push. Later
commits on `main` start a background mirror push. Mirror failures do not block
the commit; `/memory-repository status` shows the recent push log.

Use normal SSH or Git credential handling for the backup URL. Avoid embedding a
token in the URL because the URL is stored in `.git/config`. Use
`/memory-repository push` only for this optional backup remote, never as a way
to synchronize MemFS itself.

## Failure Checklist

1. Confirm `$MEMORY_DIR` points to the active agent's repository.
2. Confirm the only remote, if any, is the user's own backup.
3. Inspect `git status`, the origin URL, and the current Git operation.
4. Use `/memfs enable` for a missing checkout; a pull will not help.
5. Preserve the active layout's indexes and frontmatter, then finish any
   existing merge or rebase.
6. Leave memory commits local; do not add a remote or push to fix a memory
   problem.
7. If the command still fails, rerun it with `HARUYUKI_DEBUG=1` and report the
   redacted error. Never print or copy credential-helper values.
