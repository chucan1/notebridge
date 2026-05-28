#!/usr/bin/env node
import { bootstrap } from "./bootstrap";
import { getSourceAdapter, getDestinationAdapter, listSourcePlatforms, listDestinationPlatforms } from "../adapters/registry";
import { run } from "../pipeline/runner";
import type { RunOptions } from "../ir/schema";

interface CLIArgs {
  source: string;
  target: string;
  book?: string;
  resource?: string;
  incremental?: boolean;
  dryRun?: boolean;
  grouping?: "per_item" | "per_book" | "per_chapter";
  help?: boolean;
  listSources?: boolean;
  listTargets?: boolean;
}

function parseArgs(): CLIArgs {
  const args: CLIArgs = {
    source: "",
    target: "",
  };

  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    // First positional arg without leading -- is the source
    if (!a.startsWith("-") && !args.source) {
      args.source = a;
      continue;
    }
    switch (a) {
      case "--source":
      case "-s":
        args.source = process.argv[++i] ?? "";
        break;
      case "--to":
      case "-t":
        args.target = process.argv[++i] ?? "";
        break;
      case "--book":
      case "-b":
        args.book = process.argv[++i] ?? "";
        break;
      case "--resource":
      case "-r":
        args.resource = process.argv[++i] ?? "";
        break;
      case "--incremental":
        args.incremental = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--grouping":
      case "-g":
        args.grouping = process.argv[++i] as "per_item" | "per_book" | "per_chapter";
        break;
      case "--list-sources":
        args.listSources = true;
        break;
      case "--list-targets":
        args.listTargets = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        break;
    }
  }

  return args;
}

function showHelp(): void {
  console.log(`
notebridge — Multi-platform note bridge

Usage:
  notebridge <source> --to <target> [options]

Examples:
  notebridge weread --book "三体" --to getnote
  notebridge weread --book "黑客与画家" --to obsidian --dry-run
  notebridge local-markdown --resource ./notes --to getnote

Options:
  -s, --source      Source platform (weread, local-markdown, ...)
  -t, --to          Target platform (getnote, obsidian, ...)
  -b, --book        Book name to search (weread source)
  -r, --resource    Resource ID or path to import
  -g, --grouping    Output grouping: per_item, per_book, per_chapter (default: per_item)
  --incremental     Fetch only new notes since last sync
  --dry-run         Preview what would be written without actually writing
  --list-sources    List available source platforms
  --list-targets    List available destination platforms
  -h, --help        Show this help
`.trim());
}

async function main(): Promise<void> {
  bootstrap();
  const args = parseArgs();

  if (args.help) {
    showHelp();
    process.exit(0);
  }

  if (args.listSources) {
    console.log("Sources: " + listSourcePlatforms().join(", "));
    process.exit(0);
  }

  if (args.listTargets) {
    console.log("Targets: " + listDestinationPlatforms().join(", "));
    process.exit(0);
  }

  if (!args.source || !args.target) {
    console.error("Error: --source and --to are required. Use --help for usage.");
    process.exit(1);
  }

  const source = getSourceAdapter(args.source);
  const dest = getDestinationAdapter(args.target);

  // Load credentials from environment
  const sourceConfig = {
    credential: {
      api_key: process.env["WEREAD_API_KEY"] ?? "",
      dir_path: args.resource ?? "",
    },
    options: {},
  };

  const destConfig = {
    credential: {
      api_key: process.env["GETNOTE_API_KEY"] ?? "",
      vault_path: process.env["OBSIDIAN_VAULT"] ?? "./obsidian-vault",
    },
    options: {},
  };

  // Resolve resource
  let resourceId = args.resource ?? "";
  if (args.book && !resourceId) {
    // Search weread for book
    const resources = await source.listResources(sourceConfig);
    const match = resources.find(
      (r) => r.title.includes(args.book!) || args.book!.includes(r.title),
    );
    if (!match) {
      console.error(`Book not found: "${args.book}". Available books:`);
      for (const r of resources.slice(0, 20)) {
        console.error(`  - ${r.title} (${r.id})`);
      }
      process.exit(1);
    }
    resourceId = match.id;
    console.log(`Found: "${match.title}" (${match.id})`);
  }

  if (!resourceId) {
    console.error("Error: --book or --resource is required. Use --help for usage.");
    process.exit(1);
  }

  const resource = { id: resourceId, title: args.book ?? resourceId };

  const options: RunOptions = {
    incremental: args.incremental,
    dryRun: args.dryRun,
    grouping: args.grouping ?? "per_item",
  };

  console.log(
    `Transferring: ${args.source} → ${args.target}  [${options.dryRun ? "DRY RUN" : "LIVE"}]`,
  );

  const result = await run(source, dest, resource, sourceConfig, destConfig, options);

  console.log(
    `Done. Transferred: ${result.notes_transferred}, Skipped: ${result.notes_skipped}, Errors: ${result.errors.length}`,
  );

  for (const err of result.errors) {
    console.error(`  [${err.reason}] ${err.source_note_id}: ${err.detail}`);
  }

  if (result.errors.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
