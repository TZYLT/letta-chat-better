#!/usr/bin/env node

/**
 * Verifies that every `file:line` citation in the bundled reference documents
 * still points at a real line.
 *
 * Why this exists: those documents claim that every statement is traceable to a
 * source in this repository. That claim is only worth something if it is
 * checkable, and line numbers drift the moment anyone edits an unrelated part of
 * a file. This script turns "traceable" into a command.
 *
 * It checks existence and range, not meaning: a citation that points at the
 * wrong line inside the right file still passes. Reviewing the wording against
 * the cited line is the reviewer's job.
 *
 * Usage:
 *
 *   node scripts/check-reference-citations.mjs
 *   node scripts/check-reference-citations.mjs --verbose
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const REPOSITORY_ROOT = process.cwd();
const DOCS_DIRECTORY = path.join(
  REPOSITORY_ROOT,
  "src",
  "skills",
  "builtin",
  "haruyuki-guide",
  "docs",
);

/**
 * A backticked repository path, with an optional line or line range.
 *
 * Only paths that really are repository paths count. The documents also name
 * runtime artifacts in backticks — `MEMORY.md`, `settings.json`,
 * `.memfs.config.json` — and those are not citations of this repository.
 */
const CITATION =
  /`((?:src|scripts|skills|docs|vendor|assets|bin|hooks|\.skills|\.husky)\/[A-Za-z0-9_./@-]+\.(?:ts|tsx|mjs|cjs|js|json|md)|(?:package|tsconfig|biome|bunfig|build|image-resize-worker)\.[A-Za-z0-9]+|(?:AGENTS|CLAUDE|CONTRIBUTING|LICENSE|NOTICE|THIRD-PARTY-NOTICES|README|README\.en)\.md)(?::(\d+)(?:-(\d+))?)?`/g;

class CitationError extends Error {
  constructor(message) {
    super(message);
    this.name = "CitationError";
  }
}

function markdownFiles(directory) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new CitationError(`No reference documents at ${directory}.`);
    }
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

function lineCount(file) {
  const text = readFileSync(file, "utf8");
  if (text.length === 0) return 0;
  const newlines = (text.match(/\n/g) ?? []).length;
  return text.endsWith("\n") ? newlines : newlines + 1;
}

function main() {
  const verbose = process.argv.includes("--verbose");
  const documents = markdownFiles(DOCS_DIRECTORY);
  if (documents.length === 0) {
    throw new CitationError("The reference documents directory is empty.");
  }

  const lineCounts = new Map();
  const failures = [];
  const missingFiles = new Map();
  let citationCount = 0;

  for (const document of documents) {
    const relativeDocument = path
      .relative(REPOSITORY_ROOT, document)
      .split(path.sep)
      .join("/");
    const lines = readFileSync(document, "utf8").split(/\r?\n/);

    lines.forEach((line, index) => {
      for (const match of line.matchAll(CITATION)) {
        const target = match[1];
        if (target.startsWith("http")) return;
        citationCount += 1;

        const documentLine = index + 1;
        const absolute = path.join(REPOSITORY_ROOT, target);

        let exists = true;
        try {
          exists = statSync(absolute).isFile();
        } catch {
          exists = false;
        }
        if (!exists) {
          missingFiles.set(target, (missingFiles.get(target) ?? 0) + 1);
          failures.push(
            `${relativeDocument}:${documentLine} cites a missing file: ${target}`,
          );
          continue;
        }

        const start = match[2] ? Number(match[2]) : null;
        if (start === null) continue;
        const end = match[3] ? Number(match[3]) : start;

        if (!lineCounts.has(target)) lineCounts.set(target, lineCount(absolute));
        const total = lineCounts.get(target);

        if (start < 1 || end > total || end < start) {
          failures.push(
            `${relativeDocument}:${documentLine} cites ${target}:${start}${match[3] ? `-${end}` : ""}, but that file has ${total} lines`,
          );
        } else if (verbose) {
          process.stdout.write(
            `ok ${relativeDocument}:${documentLine} -> ${target}:${start}\n`,
          );
        }
      }
    });
  }

  if (failures.length > 0) {
    process.stderr.write("❌ Dangling or out-of-range citations:\n\n");
    for (const failure of failures) process.stderr.write(`  ${failure}\n`);
    process.stderr.write(
      `\n${failures.length} of ${citationCount} citation(s) need fixing.\n`,
    );
    return 1;
  }

  process.stdout.write(
    `✅ ${citationCount} citation(s) across ${documents.length} document(s) resolve to real lines.\n`,
  );
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(
    `Error: ${error instanceof CitationError ? error.message : (error?.stack ?? String(error))}\n`,
  );
  process.exitCode = 1;
}
