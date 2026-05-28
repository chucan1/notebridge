import { spawn } from "node:child_process";
import type { DestinationAdapter } from "./interfaces";
import type { NoteIR, PlatformConfig, WriteOptions, TransferResult } from "../ir/schema";
import { makeDedupMarker } from "../ir/schema";

function execGetNote(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("getnote", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    proc.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`getnote exit ${code}: ${err || out}`));
    });
  });
}

function noteToMarkdown(note: NoteIR): string {
  const lines: string[] = [];

  lines.push(`# ${note.book_title ?? note.title ?? "Untitled"}`);
  if (note.author) lines.push(`作者：${note.author}`);
  lines.push("");

  const childCount = note.children.length;
  lines.push(`> 共 1 条划线${childCount > 0 ? `，${childCount} 条想法` : ""}`);

  if (note.chapter_title) {
    lines.push(`## ${note.chapter_title}`);
  }
  lines.push(`> ${note.content}`);

  for (const child of note.children) {
    lines.push("");
    lines.push(`- ${child.content}`);
  }

  return lines.join("\n");
}

export const getnoteWriter: DestinationAdapter = {
  platform: "getnote",
  version: "0.1.0",

  async healthCheck(_config: PlatformConfig): Promise<boolean> {
    try {
      const out = await execGetNote(["auth", "status"]);
      return out.includes("Authenticated");
    } catch {
      return false;
    }
  },

  async write(
    notes: NoteIR[],
    _config: PlatformConfig,
    options?: WriteOptions,
  ): Promise<TransferResult> {
    const result: TransferResult = {
      source: notes[0]?.source ?? "unknown",
      target: "getnote",
      notes_transferred: 0,
      notes_skipped: 0,
      errors: [],
    };

    for (const note of notes) {
      const marker = makeDedupMarker(note.source, note.content_type, note.source_note_id);

      try {
        if (options?.dryRun) {
          result.notes_transferred++;
          continue;
        }

        const markdown = noteToMarkdown(note);
        const appendedContent = markdown + `\n\n${marker}`;

        const title = note.book_title
          ? `《${note.book_title}》读书笔记`
          : (note.title ?? "未命名笔记");

        const tags = [...new Set(["微信读书", "读书笔记", ...note.tags])];

        let lastErr: Error | null = null;
        let noteId = "";
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const out = await execGetNote([
              "save",
              appendedContent,
              "--title",
              title,
              ...tags.flatMap((t) => ["--tag", t]),
              "-o",
              "json",
            ]);
            const parsed = JSON.parse(out);
            noteId = parsed.note_id ?? parsed.data?.note_id ?? "";
            lastErr = null;
            break;
          } catch (e) {
            lastErr = e instanceof Error ? e : new Error(String(e));
            if (attempt < 2) {
              await new Promise((r) => setTimeout(r, (attempt + 1) * 1000));
            }
          }
        }

        if (lastErr) {
          result.errors.push({
            source_note_id: note.source_note_id,
            reason: "write_failed",
            detail: lastErr.message,
          });
          continue;
        }

        if (noteId) {
          result.notes_transferred++;
        } else {
          result.notes_skipped++;
        }
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
