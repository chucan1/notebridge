import type { DestinationAdapter } from "./interfaces";
import type { NoteIR, PlatformConfig, WriteOptions, TransferResult } from "../ir/schema";
import { makeDedupMarker } from "../ir/schema";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";

async function resolveToken(config: PlatformConfig): Promise<string> {
  const token = config.credential["api_key"] || process.env["NOTION_API_KEY"];
  if (!token) throw new Error("Notion API key not configured");
  return token;
}

function noteToBlocks(note: NoteIR): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];

  // Heading
  const title = note.book_title || note.title || "Untitled";
  blocks.push({
    object: "block",
    type: "heading_1",
    heading_1: {
      rich_text: [{ type: "text", text: { content: title } }],
    },
  });

  // Subtitle (author + chapter)
  const subtitle = [note.author, note.chapter_title].filter(Boolean).join(" · ");
  if (subtitle) {
    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [{ type: "text", text: { content: subtitle, link: null }, annotations: { italic: true } }],
      },
    });
  }

  // Content
  if (note.content) {
    blocks.push({
      object: "block",
      type: "quote",
      quote: {
        rich_text: [{ type: "text", text: { content: note.content } }],
      },
    });
  }

  // Children (thoughts)
  for (const child of note.children) {
    blocks.push({
      object: "block",
      type: "bulleted_list_item",
      bulleted_list_item: {
        rich_text: [{ type: "text", text: { content: child.content } }],
      },
    });
  }

  // Source link — only http/https URLs (Notion rejects custom schemes like weread://)
  if (note.source_url && /^https?:\/\//i.test(note.source_url)) {
    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [{ type: "text", text: { content: note.source_url, link: { url: note.source_url } } }],
      },
    });
  }

  // Tags
  if (note.tags.length > 0) {
    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [{ type: "text", text: { content: note.tags.map(t => `#${t.replace(/^#/, "")}`).join(" ") }, annotations: { code: true } }],
      },
    });
  }

  // Dedup marker
  const marker = makeDedupMarker(note.source, note.content_type, note.source_note_id);
  blocks.push({
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: [{ type: "text", text: { content: marker } }],
    },
  });

  return blocks;
}

async function notionPost(path: string, body: unknown, token: string): Promise<unknown> {
  const resp = await fetch(`${NOTION_API}${path}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Notion API error ${resp.status}: ${err.slice(0, 200)}`);
  }
  return resp.json();
}

async function notionPatch(path: string, body: unknown, token: string): Promise<unknown> {
  const resp = await fetch(`${NOTION_API}${path}`, {
    method: "PATCH",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Notion API error ${resp.status}: ${err.slice(0, 200)}`);
  }
  return resp.json();
}

export const notionWriter: DestinationAdapter = {
  platform: "notion",
  version: "0.1.0",

  async healthCheck(config: PlatformConfig): Promise<boolean> {
    try {
      const token = await resolveToken(config);
      const resp = await fetch(`${NOTION_API}/users/me`, {
        headers: {
          "Authorization": `Bearer ${token}`,
          "Notion-Version": NOTION_VERSION,
        },
        signal: AbortSignal.timeout(10_000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  },

  async write(
    notes: NoteIR[],
    config: PlatformConfig,
    options?: WriteOptions,
  ): Promise<TransferResult> {
    const token = await resolveToken(config);
    const parentId = config.credential["parent_id"] || config.options["parent_id"] as string;
    if (!parentId) {
      throw new Error("Notion parent_id not configured (credential.parent_id). Create a Notion page and share it with your integration.");
    }

    const result: TransferResult = {
      source: notes[0]?.source ?? "unknown",
      target: "notion",
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

        const title = note.book_title
          ? `《${note.book_title}》笔记`
          : (note.title || "Untitled");

        // Create page as child of parent
        const page = await notionPost("/pages", {
          parent: { page_id: parentId },
          properties: {
            title: {
              title: [{ type: "text", text: { content: title } }],
            },
          },
        }, token) as { id: string };

        // Append content blocks
        const blocks = noteToBlocks(note);
        await notionPatch(`/blocks/${page.id}/children`, {
          children: blocks,
        }, token);

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
