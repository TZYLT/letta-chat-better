#!/usr/bin/env node
/**
 * Enforces the prefix-freeze "application points" contract.
 *
 * A conversation's frozen prefix may only be rewritten at an application point:
 * a new conversation, compaction, or an explicit recompile. Two features were
 * added and later removed precisely because they rewrote the prefix from
 * somewhere else — `updateAgent({system})` clearing every compiled snapshot, and
 * `/personality` recompiling locally right after a memory commit. Neither was
 * caught by review, so the rule is now a check.
 *
 * Rules:
 *   1. Every guarded symbol may appear only in the files below, each of which is
 *      an application point, a backend definition, or a read-only caller.
 *   2. `local-backend.ts` may only record whitelisted freeze reasons, which is
 *      what the application points are keyed on.
 *   3. Banned symbols must not come back.
 *
 * To add a legitimate new application point, add its file here WITH a reason.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { glob } from "glob";

const rootDir = process.cwd();

/** Symbols that rewrite or apply a frozen prefix, and who may mention them. */
const GUARDED = [
  {
    symbol: "compileAndMaybePersistSystemPrompt",
    allowed: ["src/backend/local/local-backend.ts"],
    why: "compiling a snapshot IS applying a prefix; only LocalBackend may do it, and only for a whitelisted reason",
  },
  {
    symbol: "recompileConversation",
    allowed: [
      "src/agent/modify.ts", // recompileAgentSystemPrompt -> the manual application point
      "src/backend/backend.ts", // interface + default (remote) implementation
      "src/backend/dev/fake-headless-backend.ts", // test double for the backend interface
      "src/backend/local/local-backend.ts", // the local implementation
      "src/web/local-memory-context.ts", // read-only: dry_run, never persisted
      "src/websocket/listener/commands/agents-conversations.ts", // explicit remote recompile command
    ],
    why: "only an explicit recompile may reach this",
  },
  {
    symbol: "recompileAgentSystemPrompt",
    allowed: ["src/agent/modify.ts", "src/cli/helpers/recompile-command.ts"],
    why: "the /recompile command is a user-invoked application point",
  },
];

/** Removed ways to rewrite the prefix silently. They must not return. */
const BANNED = [
  {
    symbol: "clearCompiledSystemPromptsForAgent",
    why: "deleting compiled snapshots makes the next turn recompile and rewrite the prefix (R-07)",
  },
];

/** The only freeze reasons an application point may record. */
const ALLOWED_FREEZE_REASONS = new Set([
  "conversation_created",
  "compaction",
  "manual_recompile",
]);

const FREEZE_REASON_OWNER = "src/backend/local/local-backend.ts";

let violations = 0;

function report(file, line, message, why) {
  if (violations === 0) {
    console.error("\n❌ Prefix-freeze application-point violations:\n");
  }
  console.error(`  ${file}${line ? `:${line}` : ""}`);
  console.error(`    ${message}`);
  console.error(`    ↳ ${why}\n`);
  violations++;
}

const files = (
  await glob("src/**/*.{ts,tsx}", {
    cwd: rootDir,
    ignore: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts"],
  })
)
  // glob returns OS separators on Windows; the allowlists are POSIX.
  .map((file) => file.replace(/\\/g, "/"))
  .sort();

for (const file of files) {
  const content = readFileSync(join(rootDir, file), "utf-8");
  const lines = content.split("\n");

  for (const rule of GUARDED) {
    if (rule.allowed.includes(file)) continue;
    lines.forEach((line, index) => {
      if (line.includes(rule.symbol)) {
        report(
          file,
          index + 1,
          `mentions ${rule.symbol}`,
          rule.why,
        );
      }
    });
  }

  for (const rule of BANNED) {
    lines.forEach((line, index) => {
      if (line.includes(rule.symbol)) {
        report(file, index + 1, `mentions banned ${rule.symbol}`, rule.why);
      }
    });
  }
}

const owner = readFileSync(join(rootDir, FREEZE_REASON_OWNER), "utf-8");
owner.split("\n").forEach((line, index) => {
  const match = line.match(/reason:\s*"([^"]+)"/);
  if (match && !ALLOWED_FREEZE_REASONS.has(match[1])) {
    report(
      FREEZE_REASON_OWNER,
      index + 1,
      `records freeze reason "${match[1]}"`,
      `only ${[...ALLOWED_FREEZE_REASONS].join(", ")} are application points`,
    );
  }
});

if (violations > 0) {
  console.error(
    `Found ${violations} application-point violation${violations === 1 ? "" : "s"}.`,
  );
  console.error(
    "A prefix change must be registered, not applied: apply it at a new conversation, compaction, or /recompile.\n",
  );
  process.exit(1);
} else {
  console.log("✅ No prefix-freeze application-point violations found.");
}
