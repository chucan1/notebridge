import { readdir, readFile, stat } from "node:fs/promises";
import { join, extname, basename } from "node:path";
import type { SourceAdapter } from "./interfaces";
import type { NoteIR, Resource, PlatformConfig } from "../ir/schema";
import { IR_VERSION } from "../ir/schema";

const SKIP_DIRS = new Set([".obsidian", ".trash", ".git", "node_modules", "_templates", "templates"]);
const SKIP_FILES = new Set(["canvas"]);

interface Frontmatter {
  title?: string;
  author?: string;
  tags?: string[];
  aliases?: string[];
  date?: string;
  created?: string;
  updated?: string;
  cssclasses?: string[];
  [key: string]: unknown;
}

function parseYamlFrontmatter(text: string): { fm: Frontmatter; body: string } {
  if (!text.trimStart().startsWith("---")) return { fm: {}, body: text };
  const endIdx = text.indexOf("\n---", 3);
  if (endIdx === -1) return { fm: {}, body: text };

  const fmBlock = text.slice(3, endIdx).trim();
  const body = text.slice(endIdx + 4).trim();
  const fm: Frontmatter = {};

  for (const line of fmBlock.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // tags: [tag1, tag2] or tags:\n  - tag1\n  - tag2
    const tagMatch = trimmed.match(/^tags:\s*\[(.+)\]$/);
    if (tagMatch) {
      fm.tags = tagMatch[1].split(",").map(s => s.trim().replace(/^["']|["']$/g, ""));
      continue;
    }
    if (trimmed.startsWith("- ") && fm.tags === undefined) {
      // Inside a YAML list (simplified — for tags under previous key)
      continue;
    }

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, "");

    // Handle inline arrays: [a, b]
    if (value.startsWith("[") && value.endsWith("]")) {
      fm[key] = value.slice(1, -1).split(",").map(s => s.trim().replace(/^["']|["']$/g, ""));
      continue;
    }

    // Handle YAML list indentation (next lines starting with -)
    if (value === "") {
      continue; // list items handled differently
    }

    fm[key] = value;
  }

  // Handle indented list for tags
  const tagListMatch = fmBlock.match(/^tags:\s*\n((?:\s+-\s+.+\n?)+)/m);
  if (tagListMatch) {
    fm.tags = tagListMatch[1].split("\n")
      .filter(l => l.trim().startsWith("- "))
      .map(l => l.trim().replace(/^-\s+/, "").replace(/^["']|["']$/g, ""));
  }

  return { fm, body };
}

// Convert Obsidian wikilinks [[page]] and embeds ![[page]] to markdown
function resolveWikilinks(text: string): string {
  // ![[embed]] — keep as embed reference
  text = text.replace(/!\[\[([^\]]+)\]\]/g, (_, target: string) => {
    const [page, alias] = target.split("|");
    return `> 📎 ${alias || page}`;
  });
  // [[page]] or [[page|alias]]
  text = text.replace(/\[\[([^\]]+)\]\]/g, (_, target: string) => {
    const [page, alias] = target.split("|");
    const name = alias || page;
    return `[${name}](${page.replace(/\s+/g, "-")}.md)`;
  });
  return text;
}

async function scanVault(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".") && SKIP_DIRS.has(entry.name)) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith("_")) {
        results.push(...await scanVault(fullPath));
      }
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      if (ext === ".md" && !SKIP_FILES.has(entry.name)) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

export const obsidianReader: SourceAdapter = {
  platform: "obsidian",
  version: "0.1.0",

  async healthCheck(config: PlatformConfig): Promise<boolean> {
    const vaultPath = config.credential["vault_path"] || config.options["vault_path"] as string;
    if (!vaultPath) return false;
    try {
      const s = await stat(vaultPath);
      return s.isDirectory();
    } catch {
      return false;
    }
  },

  async listResources(config: PlatformConfig): Promise<Resource[]> {
    const vaultPath = config.credential["vault_path"] || config.options["vault_path"] as string;
    if (!vaultPath) throw new Error("Obsidian vault_path not configured");

    const files = await scanVault(vaultPath);
    return files.map(f => {
      const relPath = f.replace(vaultPath, "").replace(/^[/\\]/, "");
      const name = basename(f, ".md");
      return {
        id: f,
        title: name,
        note_count: 1,
        extra: { path: f, relativePath: relPath },
      };
    });
  },

  async fetch(resource: Resource, config: PlatformConfig): Promise<NoteIR[]> {
    const vaultPath = config.credential["vault_path"] || config.options["vault_path"] as string;
    const filePath = (resource.extra as Record<string, unknown>)?.path as string ?? resource.id;
    const raw = await readFile(filePath, "utf-8");
    const { fm, body } = parseYamlFrontmatter(raw);
    const relPath = filePath.replace(vaultPath || "", "").replace(/^[/\\]/, "");
    const filename = basename(filePath, ".md");
    const now = new Date().toISOString();

    // Resolve wikilinks in content
    const resolvedContent = resolveWikilinks(body);

    // Extract tags from frontmatter + content
    const contentTags = (resolvedContent.match(/#([\w一-鿿/-]+)/g) ?? [])
      .map(t => t.replace(/^#/, ""))
      .filter(t => t.length > 0);
    const allTags = [...new Set([...(fm.tags ?? []), ...contentTags])];

    const title = fm.title || filename;

    return [{
      ir_version: IR_VERSION,
      source: "obsidian",
      source_note_id: relPath,
      fetched_at: now,
      title: title.slice(0, 50),
      content: resolvedContent,
      content_type: "page",
      children: [],
      book_title: null,
      chapter_title: null,
      author: fm.author || null,
      source_url: null,
      tags: allTags,
      extra: {
        filePath: relPath,
        aliases: fm.aliases,
        cssClasses: fm.cssclasses,
      },
    }];
  },
};
