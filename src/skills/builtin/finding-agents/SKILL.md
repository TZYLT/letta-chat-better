---
name: finding-agents
description: Find other agents on the same server. Use when the user asks about other agents, wants to migrate memory from another agent, or needs to find an agent by name or tags.
---

# Finding Agents

This skill helps you find other agents on the same haruyuki server.

## When to Use This Skill

- User asks about other agents they have
- User wants to find a specific agent by name
- User wants to list agents with certain tags
- You need to find an agent ID for memory migration
- You found an agent_id via message search and need details about that agent

## CLI Usage

```bash
haruyuki agents list [options]
```

### Options

| Option | Description |
|--------|-------------|
| `--name <name>` | Exact name match |
| `--query <text>` | Fuzzy search by name |
| `--tags <tag1,tag2>` | Filter by tags (comma-separated) |
| `--match-all-tags` | Require ALL tags (default: ANY) |
| `--include-blocks` | Include agent.blocks in response |
| `--shared` | List agents shared with the current user |
| `--limit <n>` | Max results (default: 20) |

## Common Patterns

### Finding Haruyuki Agents

Agents created by Haruyuki are tagged with `origin:letta-code`. To find only Haruyuki agents:

```bash
haruyuki agents list --tags "origin:letta-code"
```

This is useful when the user is looking for agents they've worked with in Haruyuki CLI sessions.

### Finding All Accessible Agents

List agents owned by the current user, then list agents shared with them:

```bash
haruyuki agents list
haruyuki agents list --shared
```

Use `--query <text>` with either command to search by name.

## Examples

**List all agents (up to 20):**
```bash
haruyuki agents list
```

**Find agent by exact name:**
```bash
haruyuki agents list --name "ProjectX-v1"
```

**Search agents by name (fuzzy):**
```bash
haruyuki agents list --query "project"
```

**Find only Haruyuki agents:**
```bash
haruyuki agents list --tags "origin:letta-code"
```

**Find agents with multiple tags:**
```bash
haruyuki agents list --tags "frontend,production" --match-all-tags
```

**Include memory blocks in results:**
```bash
haruyuki agents list --query "project" --include-blocks
```

## Output

Returns the raw API response with full agent details. Key fields:
- `id` - Agent ID (e.g., `agent-abc123`)
- `name` - Agent name
- `description` - Agent description
- `tags` - Agent tags
- `blocks` - Memory blocks (if `--include-blocks` used)

## Related Skills

- **migrating-memory** - Once you find an agent, use this skill to copy/share memory blocks

### Finding Agents by Topic

If you need to find which agent worked on a specific topic:

1. Search messages across all agents:
   ```bash
   haruyuki messages search --query "topic" --all-agents --limit 10
   ```
2. Note the `agent_id` values from matching messages
3. Get agent details:
   ```bash
   haruyuki agents list --query "partial-name"
   ```
   Or use the agent_id directly in the Letta API
