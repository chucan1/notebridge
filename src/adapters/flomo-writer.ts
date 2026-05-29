import type { DestinationAdapter } from "./interfaces";
import type { NoteIR, PlatformConfig, WriteOptions, TransferResult } from "../ir/schema";
import { makeDedupMarker } from "../ir/schema";

function noteToFlomoContent(note: NoteIR): string {
  const lines: string[] = [];

  if (note.book_title) {
    lines.push(`**${note.book_title}**`);
  }
  if (note.chapter_title) {
    lines.push(`*${note.chapter_title}*`);
  }
  if (lines.length) lines.push("");

  lines.push(note.content);

  if (note.children.length > 0) {
    lines.push("");
    for (const child of note.children) {
      lines.push(`> ${child.content}`);
    }
  }

  if (note.source_url) {
    lines.push("");
    lines.push(note.source_url);
  }

  return lines.join("\n");
}

export const flomoWriter: DestinationAdapter = {
  platform: "flomo",
  version: "0.1.0",

  async healthCheck(config: PlatformConfig): Promise<boolean> {
    try {
      const url = config.credential["webhook_url"];
      if (!url) return false;
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "notebridge health check", content_type: "markdown" }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = await resp.json() as { code?: number };
      return data.code === 0;
    } catch {
      return false;
    }
  },

  async write(
    notes: NoteIR[],
    config: PlatformConfig,
    options?: WriteOptions,
  ): Promise<TransferResult> {
    const webhookUrl = config.credential["webhook_url"];
    if (!webhookUrl) {
      throw new Error("Flomo webhook URL not configured (credential.webhook_url)");
    }

    const result: TransferResult = {
      source: notes[0]?.source ?? "unknown",
      target: "flomo",
      notes_transferred: 0,
      notes_skipped: 0,
      errors: [],
    };

    for (const note of notes) {
      try {
        if (options?.dryRun) {
          result.notes_transferred++;
          continue;
        }

        const content = noteToFlomoContent(note);
        const marker = makeDedupMarker(note.source, note.content_type, note.source_note_id);
        // Append dedup marker as invisible HTML comment
        const fullContent = content + `\n<!-- ${marker} -->`;

        // Add tags as #hashtags
        const tagStr = note.tags.map((t) => `#${t.replace(/^#/, "")}`).join(" ");

        const resp = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: `${fullContent} ${tagStr}`,
            content_type: "markdown",
          }),
          signal: AbortSignal.timeout(15_000),
        });

        const data = await resp.json() as { code?: number; message?: string };
        if (data.code === 0) {
          result.notes_transferred++;
        } else {
          result.errors.push({
            source_note_id: note.source_note_id,
            reason: "write_failed",
            detail: data.message ?? "Unknown flomo error",
          });
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
