import { readdir, readFile, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import type { SourceAdapter } from "./interfaces";
import type { NoteIR, Resource, PlatformConfig } from "../ir/schema";
import { IR_VERSION } from "../ir/schema";

function parseFrontmatter(text: string): { frontmatter: Record<string, unknown>; body: string } {
  if (!text.startsWith("---")) return { frontmatter: {}, body: text };

  const endIdx = text.indexOf("---", 3);
  if (endIdx === -1) return { frontmatter: {}, body: text };

  const fmBlock = text.slice(3, endIdx).trim();
  const body = text.slice(endIdx + 3).trim();

  const frontmatter: Record<string, unknown> = {};
  for (const line of fmBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    value = value.replace(/^["']|["']$/g, "");
    if (value.startsWith("- ")) {
      // Simple list: extract all list items
      frontmatter[key] = value.split(",").map((s: string) => s.trim().replace(/^- /, ""));
    } else {
      frontmatter[key] = value;
    }
  }

  return { frontmatter, body };
}

async function scanMarkdownFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith(".")) {
        results.push(...await scanMarkdownFiles(fullPath));
      }
    } else if (entry.isFile() && extname(entry.name) === ".md") {
      results.push(fullPath);
    }
  }

  return results;
}

export const localMarkdownReader: SourceAdapter = {
  platform: "local-markdown",
  version: "0.1.0",

  async healthCheck(config: PlatformConfig): Promise<boolean> {
    const dirPath = config.credential["dir_path"];
    if (!dirPath) return false;
    try {
      const s = await stat(dirPath);
      return s.isDirectory();
    } catch {
      return false;
    }
  },

  async listResources(config: PlatformConfig): Promise<Resource[]> {
    const dirPath = config.credential["dir_path"];
    if (!dirPath) throw new Error("dir_path not configured (credential.dir_path)");

    const files = await scanMarkdownFiles(dirPath);
    return files.map((f) => ({
      id: f,
      title: f.split(/[/\\]/).pop()?.replace(".md", "") ?? f,
      extra: { path: f },
    }));
  },

  async fetch(resource: Resource, _config: PlatformConfig): Promise<NoteIR[]> {
    const filePath = (resource.extra as Record<string, unknown>)?.path as string ?? resource.id;
    const content = await readFile(filePath, "utf-8");
    const { frontmatter, body } = parseFrontmatter(content);
    const filename = filePath.split(/[/\\]/).pop()?.replace(".md", "") ?? "untitled";
    const now = new Date().toISOString();

    return [
      {
        ir_version: IR_VERSION,
        source: "local-markdown",
        source_note_id: filePath,
        fetched_at: now,
        title: (frontmatter["title"] as string) ?? filename,
        content: body,
        content_type: "page",
        children: [],
        book_title: null,
        chapter_title: null,
        author: (frontmatter["author"] as string) ?? null,
        source_url: null,
        tags: Array.isArray(frontmatter["tags"])
          ? frontmatter["tags"] as string[]
          : [],
        extra: { filePath, ...frontmatter as Record<string, string> },
      },
    ];
  },
};
