#!/usr/bin/env node

/**
 * Reads the reference documents bundled with this skill.
 *
 * This route is offline by design: the documents live in this repository, so
 * there is no index to fetch, no ETag to verify, and no cache to keep. The
 * reader only lists, prints, and searches files under `docs/`.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, "..");
const DEFAULT_DOCS_DIRECTORY = path.join(SKILL_DIRECTORY, "docs");

/** Search hits printed before the reader stops and reports the remainder. */
const MAX_SEARCH_HITS = 60;

class DocsLookupError extends Error {
  constructor(message) {
    super(message);
    this.name = "DocsLookupError";
  }
}

function parseArguments(argv) {
  const options = {
    docsDir: DEFAULT_DOCS_DIRECTORY,
    doc: undefined,
    search: undefined,
    statusJson: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--docs-dir") options.docsDir = argv[++index];
    else if (value === "--doc") options.doc = argv[++index];
    else if (value === "--search") options.search = argv[++index];
    else if (value === "--status-json") options.statusJson = true;
    else throw new DocsLookupError(`Unknown argument: ${value}`);
  }
  if (!options.docsDir)
    throw new DocsLookupError("--docs-dir cannot be empty.");
  if (options.doc !== undefined && !options.doc)
    throw new DocsLookupError("--doc needs a document name.");
  if (options.search !== undefined && !options.search)
    throw new DocsLookupError("--search needs a search string.");
  return { ...options, docsDir: path.resolve(options.docsDir) };
}

async function collectDocuments(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const documents = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      documents.push(...(await collectDocuments(file)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      documents.push(file);
    }
  }
  return documents;
}

/**
 * Outline a document: its headings with the line range each one covers.
 *
 * Fences are tracked so a `#` comment inside a shell example is not mistaken
 * for a heading.
 */
export function createOutline(body) {
  const lines = body.split(/\r?\n/);
  const headings = [];
  let fence = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      fence = fence === marker ? null : (fence ?? marker);
      continue;
    }
    if (fence) continue;
    const heading = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
    if (heading) {
      headings.push({
        depth: heading[1].length,
        title: heading[2],
        line: index + 1,
      });
    }
  }

  const markdown = headings
    .map((heading, position) => {
      const next = headings
        .slice(position + 1)
        .find((candidate) => candidate.depth <= heading.depth);
      const end = (next ? next.line : lines.length) - 1;
      const indent = "  ".repeat(heading.depth - 1);
      return `${indent}${heading.title} (lines ${heading.line}-${Math.max(heading.line, end)})`;
    })
    .join("\n");

  return {
    headings,
    markdown,
    lineCount: lines.length,
    headingCount: headings.length,
  };
}

function slugFor(file, docsDirectory) {
  const relative = path.relative(docsDirectory, file);
  return relative.replace(/\.md$/, "").split(path.sep).join("/");
}

async function readDocuments(directory) {
  const files = await collectDocuments(directory);
  const documents = [];
  for (const file of files) {
    const body = await readFile(file, "utf8");
    const { size } = await stat(file);
    const outline = createOutline(body);
    documents.push({
      name: path.basename(file, ".md"),
      slug: slugFor(file, directory),
      body,
      bytes: size,
      lineCount: outline.lineCount,
      headings: outline.headings,
      outline: outline.markdown,
    });
  }
  return documents;
}

function emptyCorpusMessage(directory) {
  return [
    `No reference documents are bundled yet: ${path.join(directory, "*.md")} does not exist or is empty.`,
    "Answer from this repository's own source and runtime output instead, and say when a detail is not documented.",
  ].join("\n");
}

function indexOutput(directory, documents) {
  if (documents.length === 0) return emptyCorpusMessage(directory);
  return [
    `Reference documents: ${directory}`,
    "",
    ...documents.flatMap((document) => [
      `## ${document.slug} (${document.lineCount} lines)`,
      document.outline.length > 0 ? document.outline : "  (no headings)",
      "",
    ]),
  ]
    .join("\n")
    .trimEnd();
}

function resolveRequestedDocument(query, documents) {
  const normalized = query.replace(/\.md$/, "").split("\\").join("/");
  const exact = documents.find((document) => document.slug === normalized);
  if (exact) return exact;
  const byName = documents.filter((document) => document.name === normalized);
  return byName.length === 1 ? byName[0] : null;
}

function searchDocuments(documents, query) {
  const needle = query.toLowerCase();
  const hits = [];
  let total = 0;
  for (const document of documents) {
    const lines = document.body.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].toLowerCase().includes(needle)) continue;
      total += 1;
      if (hits.length < MAX_SEARCH_HITS) {
        hits.push(`${document.slug}.md:${index + 1}: ${lines[index].trim()}`);
      }
    }
  }
  return { hits, total };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const documents = await readDocuments(options.docsDir);
  const status = {
    docsDir: options.docsDir,
    documentCount: documents.length,
    documents: documents.map((document) => ({
      slug: document.slug,
      bytes: document.bytes,
      lineCount: document.lineCount,
      headings: document.headings.length,
    })),
  };

  if (options.doc !== undefined) {
    const document = resolveRequestedDocument(options.doc, documents);
    if (!document) {
      const available = documents.map((entry) => entry.slug).join(", ");
      throw new DocsLookupError(
        documents.length === 0
          ? emptyCorpusMessage(options.docsDir)
          : `No reference document named "${options.doc}". Available: ${available}`,
      );
    }
    process.stdout.write(`${document.body.trimEnd()}\n`);
  } else if (options.search !== undefined) {
    const { hits, total } = searchDocuments(documents, options.search);
    if (total === 0) {
      process.stdout.write(
        `${
          documents.length === 0
            ? emptyCorpusMessage(options.docsDir)
            : `No matches for "${options.search}" in ${documents.length} reference document(s).`
        }\n`,
      );
    } else {
      process.stdout.write(
        [
          ...hits,
          ...(total > hits.length
            ? [`... ${total - hits.length} more match(es) not shown.`]
            : []),
          "",
        ].join("\n"),
      );
    }
    status.search = { query: options.search, matches: total };
  } else {
    process.stdout.write(`${indexOutput(options.docsDir, documents)}\n`);
  }

  if (options.statusJson) console.error(JSON.stringify(status));
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}

export { DEFAULT_DOCS_DIRECTORY };
