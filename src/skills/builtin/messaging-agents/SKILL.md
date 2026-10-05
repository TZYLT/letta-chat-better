---
name: messaging-agents
description: Send a message to another Letta agent, continue a thread with one, check on it, or reply to a message another agent sent you. Use when you need to ask, inform, or coordinate with another agent, or when a message from another agent arrives.
---

# Messaging Agents

## What you are addressing

An **agent** is a persistent identity: its memory and configuration are shared
by all of its conversations. A **conversation** is one message thread on an
agent. Address a conversation ID to continue a thread; address an agent ID to
open a new thread with that agent. When your send identifies you as the sender,
a new thread is created hidden so agent-to-agent traffic does not clutter the
recipient's conversation list.

## Where agent state lives

Letta Code keeps agent state in a local store on this machine. Agent IDs start
with `agent-local-`.

This CLI has no Cloud backend, no `computer` selector, and no teleport: there
is no Cloud service to deliver messages on your behalf. "Local backend"
describes where state is stored, and it is unrelated to subagents you launch
with the Agent tool.

## How a send reaches the recipient

A send runs the recipient's turn in the `letta -p` process you launched.

With only `--agent`, the CLI chooses the launch settings and normally creates a
new conversation.

Cloud delivery is not supported by this CLI: `--no-wait`, `--computer`, and
`SendAgentMessage` have no local equivalent.

The recipient learns who is asking only when the send identifies a sender:
`--from-agent`, or the caller IDs from the agent's shell environment
(`AGENT_ID`/`LETTA_AGENT_ID` and `CONVERSATION_ID`/`LETTA_CONVERSATION_ID`).
An identified send attaches a system reminder telling the recipient how to get
its answer back to you. A `letta -p` with neither carries no sender or reply
instructions; the recipient receives your text as user input, plus whatever
context its harness normally adds.

An explicit `--from-agent` different from the agent identified by your
environment does not inherit the current conversation as its return address.

## Waiting or not

- **Waiting send** (`letta -p` without `--no-wait`). The process normally returns
  the recipient's final message, in `result` with JSON output. When a sender is
  identified, the recipient is told to put its answer in that message.
- **Non-waiting send** (`SendAgentMessage`, or `letta -p --no-wait`). Not
  supported by this CLI: acceptance and delivery were Cloud-side, and a receipt
  did not guarantee a reply.

A waiting send occupies the CLI process, not necessarily you. Run it in the
background (your shell tool may already do this for long-running commands) and
read its output when it finishes. That keeps you working, but it does not
change the recipient's instructions: the answer still arrives as process
output, not as a message to your conversation.

For a managed child task with a completion notification, use the Agent tool.

## Send and keep working

Not supported by this CLI. `SendAgentMessage` and `letta -p --no-wait` depended
on Cloud accepting the message and returning a receipt. Use a waiting send in
the background instead (see above) when you want to keep working.

## Send and wait

```bash
letta -p --from-agent $LETTA_AGENT_ID --agent <agent-id> --output-format json "message"
letta -p --from-agent $LETTA_AGENT_ID --conversation <conversation-id> --output-format json "follow-up"
```

`result` normally holds the recipient's final message; `conversation_id` is
the thread to continue. `--from-agent` names you and must be an agent on the
same backend as the recipient.

If your agent ID starts with `agent-local-`, add `--backend local` so the
command uses the local store: `letta --backend local -p …`. The flag applies to
that command only.

The recipient's turn runs inside the process you launched, so
`--tools`, `--permission-mode`, and the working directory you give it apply to
that turn.

## Replying to another agent

When another agent identifies itself, its message arrives with a system
reminder naming its agent ID and, when it had one, its conversation ID.

- If the reminder says the sender will only see your final message: answer in
  your response. Nothing more is needed.
- If the reminder asks for an explicit reply: non-waiting sends are not
  supported by this CLI, so reply with a waiting send
  (`letta -p --agent <sender-agent-id> --conversation <sender-conversation-id> "reply"`).
  Your ordinary output is not forwarded to the sender.
- If it says no return conversation was supplied: your output is not forwarded
  and there is no thread to reply into. Answer as you normally would.

A message without such a reminder carries no sender or reply instructions;
respond to it as you would to any input.

## Checking on a conversation

Recent messages are the quick progress check. This command
requests recent messages and prints the returned messages oldest to newest (add
`--backend local` in the same cases as for sends):

```bash
letta messages list --conversation <conversation-id> --limit 10
```

`letta messages status --conversation <id>` is Cloud only, so this CLI does not
support it. Read the messages to see what was processed.
`letta messages transcript --conversation <id>` exports the
thread; check `truncated` before treating it as complete.
`letta messages --help` lists the options.

## Finding an agent

```bash
letta agents list --query "name"
letta messages search --query "topic" --all-agents   # discovery; results include agent_id
```

Load the `finding-agents` skill for more search options.

## Choosing a computer

Remote computers and Cloud delivery are not available in this CLI, so there is
no `computer` selector for sends or the Agent tool.

## Gotchas

- `SendAgentMessage`, `--no-wait`, `--computer`, and `messages status` are
  Cloud-only; this CLI does not support them.
- Do not rely on `--agent` alone to select message delivery. Add
  `--from-agent $LETTA_AGENT_ID` to deliver and identify yourself;
  pass `--conversation <id>` to reach an existing thread.
- Execution flags (`--tools`, `--permission-mode`, `--model`, `--system`, and
  similar) configure a launch when using the `--agent`-only path; the recipient
  keeps its own configuration.
- `--conversation default` needs `--agent`; `default` is scoped to an agent.
- If a send's outcome is unknown (a timed-out wait), read the thread before
  resending.

## Related

- `letta --help` and each subcommand's `--help` are the reference for flags;
  this skill explains the concepts and the common recipes.
- `finding-agents`: locate agents by name, tags, or search.
