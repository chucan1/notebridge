#!/usr/bin/env node
import { bootstrap } from "./bootstrap";
import { getSourceAdapter, getDestinationAdapter, listSourcePlatforms, listDestinationPlatforms } from "../adapters/registry";
import { run } from "../pipeline/runner";
import type { RunOptions } from "../ir/schema";
import { saveFlomoCookie, getConfigFilePath } from "../config";
import { createHash } from "node:crypto";

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
  listResources?: boolean;
  json?: boolean;
}

function parseArgs(): CLIArgs {
  const args: CLIArgs = { source: "", target: "" };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (!a.startsWith("-") && !args.source) { args.source = a; continue; }
    switch (a) {
      case "--source": case "-s": args.source = process.argv[++i] ?? ""; break;
      case "--to": case "-t": args.target = process.argv[++i] ?? ""; break;
      case "--book": case "-b": args.book = process.argv[++i] ?? ""; break;
      case "--resource": case "-r": args.resource = process.argv[++i] ?? ""; break;
      case "--incremental": args.incremental = true; break;
      case "--dry-run": args.dryRun = true; break;
      case "--grouping": case "-g": args.grouping = process.argv[++i] as "per_item" | "per_book" | "per_chapter"; break;
      case "--list-sources": args.listSources = true; break;
      case "--list-targets": args.listTargets = true; break;
      case "--list-resources": args.listResources = true; break;
      case "-o": if (process.argv[i + 1] === "json") { args.json = true; i++; } break;
      case "--help": case "-h": args.help = true; break;
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
  notebridge flomo --resource all --to getnote

Options:
  -s, --source      Source platform (weread, flomo, local-markdown, ...)
  -t, --to          Target platform (getnote, flomo, obsidian, ...)
  -b, --book        Book name to search (weread source)
  -r, --resource    Resource ID or path to import
  -g, --grouping    Output grouping: per_item, per_book, per_chapter (default: per_item)
  --incremental     Fetch only new notes since last sync
  --dry-run         Preview what would be written without actually writing
  --list-sources    List available source platforms
  --list-targets    List available destination platforms
  --list-resources  List available books/resources from the source
  -o json           Output result as JSON
  -h, --help        Show this help

Authentication:
  notebridge flomo auth     Set up flomo cookie-based auth
`.trim());
}

// ---- flomo auth ----

function authSignParams(params: Record<string, unknown>): string {
  const sortedKeys = Object.keys(params).sort();
  let payload = "";
  for (const key of sortedKeys) {
    const value = params[key];
    if (value === undefined || value === null || value === "" || value === false) continue;
    payload += `${key}=${String(value)}&`;
  }
  payload = payload.slice(0, -1);
  return createHash("md5").update(payload + "dbbc3dd73364b4084c3a69346e0ce2b2", "utf8").digest("hex");
}

function authSignedUrl(path: string, extra: Record<string, unknown> = {}): string {
  const params: Record<string, unknown> = {
    timestamp: Math.floor(Date.now() / 1000),
    api_key: "flomo_web", app_version: "4.0", platform: "web", webp: "1", tz: "8:0",
    ...extra,
  };
  params["sign"] = authSignParams(params);
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    search.append(k, String(v));
  }
  return `https://flomoapp.com${path}?${search.toString()}`;
}

async function flomoAuth(): Promise<void> {
  const cookie = process.argv[3] === "auth" ? process.argv[4] : "";

  if (!cookie || cookie.startsWith("-")) {
    console.log("Flomo 认证设置");
    console.log("==============");
    console.log("");
    console.log("1. 浏览器打开 https://flomoapp.com 并登录");
    console.log("2. F12 → Application → Cookies → flomoapp.com");
    console.log("3. 复制 flomo_session 的 Value");
    console.log("4. 复制 XSRF-TOKEN 的 Value");
    console.log("");
    console.log("然后运行 (Cookie 用引号包起来):");
    console.log('  notebridge flomo auth "flomo_session=XXX; XSRF-TOKEN=YYY"');
    process.exit(0);
  }

  console.log("验证 Cookie...");
  try {
    const url = authSignedUrl("/api/v1/memo/updated/", { limit: 1, latest_updated_at: 0 });
    const resp = await fetch(url, {
      headers: {
        "Cookie": cookie,
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0",
        "Origin": "https://v.flomoapp.com",
        "Referer": "https://v.flomoapp.com/",
      },
      signal: AbortSignal.timeout(15_000),
    });
    const data = await resp.json() as { code?: number; message?: string; data?: unknown[] };
    if (data.code !== 0) {
      console.error(`Cookie 无效: ${data.message} (code: ${data.code})`);
      console.error("请确认浏览器中 flomo 仍处于登录状态。");
      process.exit(1);
    }
    const count = Array.isArray(data?.data) ? data.data.length : 0;
    console.log(`Cookie 有效 (${count} 条 memo)`);
    await saveFlomoCookie(cookie);
    console.log(`Cookie 已保存到 ${getConfigFilePath()}`);
    process.exit(0);
  } catch (err) {
    console.error("连接失败:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

// ---- main ----

async function main(): Promise<void> {
  bootstrap();

  if (process.argv.length >= 3 && process.argv[2] === "flomo" && process.argv[3] === "auth") {
    await flomoAuth();
    return;
  }

  const args = parseArgs();

  if (args.help) { showHelp(); process.exit(0); }
  if (args.listSources) { console.log("Sources: " + listSourcePlatforms().join(", ")); process.exit(0); }
  if (args.listTargets) { console.log("Targets: " + listDestinationPlatforms().join(", ")); process.exit(0); }

  if (args.listResources) {
    if (!args.source) { console.error("Error: --list-resources requires source (e.g. notebridge weread --list-resources)"); process.exit(1); }
    const adapter = getSourceAdapter(args.source);
    const srcCfg = { credential: { api_key: process.env["WEREAD_API_KEY"] ?? "", cookie: process.env["FLOMO_COOKIE"] ?? "" }, options: {} };
    const resources = await adapter.listResources(srcCfg);
    for (const r of resources) console.log(`${r.id}\t${r.note_count ?? "?"} notes\t${r.title}${r.author ? " — " + r.author : ""}`);
    process.exit(0);
  }

  if (!args.source || !args.target) { console.error("Error: --source and --to are required. Use --help for usage."); process.exit(1); }

  const source = getSourceAdapter(args.source);
  const dest = getDestinationAdapter(args.target);

  const sourceConfig = {
    credential: {
      api_key: process.env["WEREAD_API_KEY"] ?? "",
      authorization: process.env["FLOMO_AUTHORIZATION"] ?? "",
      cookie: process.env["FLOMO_COOKIE"] ?? "",
      dir_path: args.resource ?? "",
    },
    options: {},
  };

  const destConfig = {
    credential: {
      api_key: process.env["GETNOTE_API_KEY"] ?? "",
      vault_path: process.env["OBSIDIAN_VAULT"] ?? "./obsidian-vault",
      webhook_url: process.env["FLOMO_WEBHOOK_URL"] ?? "",
    },
    options: {},
  };

  let resourceId = args.resource ?? "";
  if (args.book && !resourceId) {
    const resources = await source.listResources(sourceConfig);
    const match = resources.find((r) => r.title.includes(args.book!) || args.book!.includes(r.title));
    if (!match) {
      console.error(`Book not found: "${args.book}". Available books:`);
      for (const r of resources.slice(0, 20)) console.error(`  - ${r.title} (${r.id})`);
      process.exit(1);
    }
    resourceId = match.id;
    console.log(`Found: "${match.title}" (${match.id})`);
  }

  if (!resourceId) { console.error("Error: --book or --resource is required."); process.exit(1); }

  const resource = { id: resourceId, title: args.book ?? resourceId };
  const options: RunOptions = { incremental: args.incremental, dryRun: args.dryRun, grouping: args.grouping ?? "per_item" };

  console.log(`Transferring: ${args.source} → ${args.target}  [${options.dryRun ? "DRY RUN" : "LIVE"}]`);

  const result = await run(source, dest, resource, sourceConfig, destConfig, options);

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Done. Transferred: ${result.notes_transferred}, Skipped: ${result.notes_skipped}, Errors: ${result.errors.length}`);
    for (const err of result.errors) console.error(`  [${err.reason}] ${err.source_note_id}: ${err.detail}`);
  }

  if (result.errors.length > 0) process.exit(1);
}

main().catch((err) => { console.error("Fatal error:", err); process.exit(1); });
