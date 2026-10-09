#!/usr/bin/env node
/**
 * Cloud-egress guard (batch ⑧, decision P0 = option A).
 *
 * Purpose: this fork deleted the Cloud backend, so no production code may reach
 * Letta Cloud. `scripts/check-layer-boundaries.js` can only say "layer X must not
 * import layer Y"; this check needs the opposite shape — "nobody may import these
 * modules, except the places that are genuinely local".
 *
 * How the forbidden list was decided (the test applied to each module):
 *
 *   Delete the module. Does `letta --backend local` lose a feature? Yes -> the
 *   module carries domain logic the local backend shares -> EXEMPT.
 *   No -> the module exists only to reach Cloud -> FORBIDDEN.
 *
 * FORBIDDEN — every export is a call to a Letta Cloud route, and nothing on the
 * local backend path needs it:
 *   agents.ts                 GET  /v1/agents/:id/context
 *   conversations.ts          POST /v1/conversations (fork/summarize)
 *   conversation-enqueue.ts   POST /v1/agents/:id/messages (cloud turn delivery)
 *   environments.ts           GET/POST /v1/environments, /v1/agents/:id/sandboxes
 *   generate.ts               POST /v1/agents/:id/messages (one-shot generate)
 *   health.ts                 GET  /v1/health
 *   metadata.ts               GET  /v1/metadata/*  (billing tier, balance)
 *   reflection.ts             GET/PATCH cloud reflection config
 *   reflection-runs.ts        cloud reflection run records
 *   sandbox-files.ts          cloud sandbox file IO
 *   schedules.ts              cloud schedules (local `letta cron` is the only scheduler)
 *   search.ts                 POST /v1/_internal_search/cache-warm
 *
 * EXEMPT — in-repo path lives under `src/backend/api/` (see EXEMPT_PREFIXES), and
 * each one has a local reason to exist:
 *   request.ts, http-headers.ts  the single fetch seam; base URL comes from
 *                                `LETTA_BASE_URL`/settings and falls back to
 *                                localhost:8283, so `letta server` is a target
 *   client.ts                    the Letta SDK client; the only production use is
 *                                gated on `!backend.capabilities.localModelCatalog`
 *                                (self-hosted server, not Cloud)
 *   server-url.ts                `getServerUrl` / `isCloudServerUrl` — local URL
 *                                truth source (risk R11/F2: deleting it breaks
 *                                local memory and shell paths)
 *   memfs-git-proxy.ts           local memfs git remote resolution
 *   ephemeral-conversations.ts   the Cloud route exists, but the local backend
 *                                creates ephemeral conversations itself via
 *                                `createLocalEphemeralConversation`; the only
 *                                non-local use is a type-only import
 *   providers.ts                 BYOK provider records (decision Q8 = B keeps the
 *                                provider surface)
 *   agent-message.ts             shared message-shape normalization, no fetch
 *   mcp-servers.ts, unified-mcp.ts  MCP plumbing that happens to live here
 *
 * Known limit (deliberate, recorded in docs/15 §0.2 item 10): the `--computer`
 * paths and the headless cloud family are still active Cloud-egress call sites.
 * They are listed in TRANSITIONAL below, which is a closed set: a new file that
 * imports a forbidden module fails this check even if it touches the same cloud
 * routes, so the exemption cannot silently grow. Removing the family is tracked
 * as its own batch.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { glob } from "glob";

const rootDir = process.cwd();

/** Modules that exist only to reach Letta Cloud. */
const FORBIDDEN = [
  "agents",
  "conversations",
  "conversation-enqueue",
  "environments",
  "generate",
  "health",
  "metadata",
  "reflection",
  "reflection-runs",
  "sandbox-files",
  "schedules",
  "search",
];

/** Path prefixes that may import the forbidden modules. */
const EXEMPT_PREFIXES = ["src/backend/api/"];

/**
 * Active Cloud-egress call sites that predate this guard and are scheduled for
 * their own batch. Reported, never silently ignored.
 */
const TRANSITIONAL = [
  "src/headless-environment-response.ts",
  "src/headless-enqueue-wait.ts",
  "src/headless-listener-launch.ts",
  "src/headless-super-run-wait.ts",
  "src/headless-mod-adapter.ts",
  "src/headless-message-sender.ts",
  "src/agent/subagents/remote-turn-wait.ts",
  "src/agent/subagents/subagent-stream.ts",
  "src/agent/subagents/child-send-tracking.ts",
  "src/agent/conversation-description.ts",
  "src/cli/helpers/conversation-title.ts",
  "src/cli/helpers/reflection-completion.ts",
  "src/cli/helpers/reflection-launcher.ts",
  "src/cli/app/submit-diagnostics-commands.ts",
  "src/cli/commands/install-github-app.ts",
  "src/cli/app/AppCoordinator.tsx",
  "src/web/generate-memory-viewer.ts",
  "src/tools/impl/native-session-capture.ts",
  "src/tools/workflow/decide.ts",
  "src/hooks/prompt-executor.ts",
  "src/providers/openai-codex-provider.ts",
  "src/channels/feedback.ts",
  "src/channels/lifecycle-error-report.ts",
  "src/cli/app/use-feedback-handler.ts",
  "src/telemetry/reflection-threshold-feedback.ts",
];

const QUOTE = "[\"'`]";
const name = `(?:${FORBIDDEN.join("|")})`;
const STATIC_RE = new RegExp(`from\\s+${QUOTE}@/backend/api/${name}${QUOTE}`);
const DYNAMIC_RE = new RegExp(
  `import\\(\\s*${QUOTE}@/backend/api/${name}${QUOTE}`,
);

const files = (
  await glob("src/**/*.{ts,tsx}", {
    ignore: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts"],
  })
).sort();

const violations = [];
const transitional = [];

for (const file of files) {
  const normalized = file.replace(/\\/g, "/");
  if (EXEMPT_PREFIXES.some((prefix) => normalized.startsWith(prefix))) continue;

  const lines = readFileSync(join(rootDir, file), "utf-8").split("\n");
  lines.forEach((line, i) => {
    const isStatic = STATIC_RE.test(line);
    const isDynamic = !isStatic && DYNAMIC_RE.test(line);
    if (!isStatic && !isDynamic) return;

    const entry = {
      file: normalized,
      line: i + 1,
      source: line.trim(),
      kind: isStatic ? "static" : "dynamic",
    };
    if (TRANSITIONAL.includes(normalized)) {
      transitional.push(entry);
    } else {
      violations.push(entry);
    }
  });
}

if (violations.length > 0) {
  console.error("\n❌ Cloud-egress imports found:\n");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  (${v.kind})`);
    console.error(`    ${v.source}`);
  }
  console.error(
    `\nFound ${violations.length} cloud-egress import${violations.length === 1 ? "" : "s"}.`,
  );
  console.error(
    "These modules only reach Letta Cloud. Import the backend abstraction, or add the module to EXEMPT in scripts/check-cloud-egress.js with a reason.\n",
  );
  process.exit(1);
}

if (transitional.length > 0) {
  console.log(
    `⚠️  ${transitional.length} known transitional cloud-egress import(s) (tracked separately, not failing):`,
  );
  for (const t of transitional) {
    console.log(`    ${t.file}:${t.line}`);
  }
}

console.log(
  "✅ No new cloud-egress imports. (checked against the forbidden list in scripts/check-cloud-egress.js)",
);
