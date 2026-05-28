import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { DestinationAdapter } from "./interfaces";
import type { NoteIR, PlatformConfig, WriteOptions, TransferResult } from "../ir/schema";
import { makeDedupMarker } from "../ir/schema";

function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*#\[\]]/g, "-").slice(0, 80).trim();
}

function noteToObsidianMarkdown(note: NoteIR): string {
  const lines: string[] = [];

  // Frontmatter
  lines.push("---");
  if (note.title) lines.push(`title: "${note.title}"`);
  if (note.author) lines.push(`author: "${note.author}"`);
  if (note.book_title) lines.push(`book: "${note.book_title}"`);
  if (note.chapter_title) lines.push(`chapter: "${note.chapter_title}"`);
  if (note.source_url) lines.push(`source_url: "${note.source_url}"`);
  if (note.tags.length > 0) {
    lines.push("tags:");
    for (const t of note.tags) lines.push(`  - ${t}`);
  }
  lines.push(`source: ${note.source}`);
  lines.push("---");
  lines.push("");

  // Body
  if (note.book_title) lines.push(`# ${note.book_title}`);
  if (note.chapter_title) lines.push(`## ${note.chapter_title}`);
  lines.push("");

  lines.push(`> ${note.content}`);
  lines.push("");

  for (const child of note.children) {
    lines.push(`- ${child.content}`);
    lines.push("");
  }

  return lines.join("\n");
}

export const obsidianWriter: DestinationAdapter = {
  platform: "obsidian",
  version: "0.1.0",

  async healthCheck(config: PlatformConfig): Promise<boolean> {
    const vaultPath = config.credential["vault_path"];
    if (!vaultPath) return false;
    try {
      await mkdir(vaultPath, { recursive: true });
      return true;
    } catch {
      return false;
    }
  },

  async write(
    notes: NoteIR[],
    config: PlatformConfig,
    options?: WriteOptions,
  ): Promise<TransferResult> {
    const vaultPath = config.credential["vault_path"];
    if (!vaultPath) {
      throw new Error("Obsidian vault_path not configured (credential.vault_path)");
    }

    const result: TransferResult = {
      source: notes[0]?.source ?? "unknown",
      target: "obsidian",
      notes_transferred: 0,
      notes_skipped: 0,
      errors: [],
    };

    for (const note of notes) {
      try {
        const marker = makeDedupMarker(note.source, note.content_type, note.source_note_id);
        const markdown = noteToObsidianMarkdown(note);
        const fullContent = markdown + `\n\n${marker}\n`;

        // File path: <vault>/<book_title>/<chapter_title>.md or <title>.md
        const folder = note.book_title
          ? sanitizeFilename(note.book_title)
          : sanitizeFilename(note.source);
        const filename = sanitizeFilename(
          note.chapter_title ?? note.title ?? note.source_note_id,
        ) + ".md";
        const filePath = join(vaultPath, folder, filename);

        if (options?.dryRun) {
          result.notes_transferred++;
          continue;
        }

        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, fullContent, "utf-8");

        result.notes_transferred++;
      } catch (err) {
        result.errors.push({
          source_note_id: note.source_note_id,
          reason: "write_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return result;
  },
};
