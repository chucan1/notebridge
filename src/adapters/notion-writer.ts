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

  // Heading: use note title first (highlight text), book name as subtitle
  const heading = note.title || note.book_title || "Untitled";
  blocks.push({
    object: "block",
    type: "heading_2",
    heading_2: {
      rich_text: [{ type: "text", text: { content: heading.slice(0, 100) } }],
    },
  });

  // Context: book + author + chapter
  const context = [note.book_title, note.author ? `— ${note.author}` : null, note.chapter_title].filter(Boolean).join(" · ");
  if (context && note.book_title !== heading) {
    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [{ type: "text", text: { content: context, link: null }, annotations: { italic: true, color: "gray" } }],
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

// Minimal blocks for database mode (no inline tags — use native properties instead)
function noteToBlocksMinimal(note: NoteIR): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];

  // Content as quote
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

  // Source link
  if (note.source_url && /^https?:\/\//i.test(note.source_url)) {
    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [{ type: "text", text: { content: note.source_url, link: { url: note.source_url } } }],
      },
    });
  }

  // Chapter context
  if (note.chapter_title) {
    blocks.unshift({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [{ type: "text", text: { content: `📖 ${note.chapter_title}`, link: null }, annotations: { italic: true, color: "gray" } }],
      },
    });
  }

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

// Auto-detect database schema: find title and multi-select properties
async function detectDbSchema(databaseId: string, token: string): Promise<{ titleProp: string; tagProp: string | null }> {
  try {
    // v2026-03-11: get database → data_source → properties
    const db = await fetch(`${NOTION_API}/databases/${databaseId}`, {
      headers: { "Authorization": `Bearer ${token}`, "Notion-Version": NOTION_VERSION },
      signal: AbortSignal.timeout(15_000),
    }).then(r => r.json()) as { data_sources?: Array<{ id: string }> };

    const dsId = db.data_sources?.[0]?.id;
    if (!dsId) throw new Error("No data source found");

    const ds = await fetch(`${NOTION_API}/data_sources/${dsId}`, {
      headers: { "Authorization": `Bearer ${token}`, "Notion-Version": NOTION_VERSION },
      signal: AbortSignal.timeout(15_000),
    }).then(r => r.json()) as { properties?: Record<string, { type: string }> };

    let titleProp = "Name";
    let tagProp: string | null = null;
    for (const [name, prop] of Object.entries(ds.properties ?? {})) {
      if (prop.type === "title") titleProp = name;
      if (prop.type === "multi_select" && !tagProp) tagProp = name;
    }
    return { titleProp, tagProp };
  } catch {
    return { titleProp: "Name", tagProp: null };
  }
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
    const databaseId = config.credential["database_id"] || config.options["database_id"] as string;
    const parentId = config.credential["parent_id"] || config.options["parent_id"] as string;

    if (!databaseId && !parentId) {
      throw new Error("Notion database_id or parent_id required. Create a Notion database/page and share it with your integration.");
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

        const pageTitle = note.book_title
          ? `《${note.book_title}》笔记`
          : (note.title || "Untitled");

        let page: { id: string };

        if (databaseId) {
          // Database mode: auto-detect schema, create page with native properties
          const schema = await detectDbSchema(databaseId, token);
          const titleProp = config.options["title_property"] as string || schema.titleProp;
          const tagProp = config.options["tag_property"] as string || schema.tagProp || "Tags";

          const properties: Record<string, unknown> = {
            [titleProp]: {
              title: [{ type: "text", text: { content: pageTitle } }],
            },
          };
          // Set tags as native multi-select
          if (note.tags.length > 0 && schema.tagProp) {
            properties[tagProp] = {
              multi_select: note.tags.map(t => ({ name: t.replace(/^#/, "") })),
            };
          }
          page = await notionPost("/pages", {
            parent: { database_id: databaseId },
            properties,
          }, token) as { id: string };
        } else {
          // Page mode: create sub-page
          page = await notionPost("/pages", {
            parent: { page_id: parentId },
            properties: { title: { title: [{ type: "text", text: { content: pageTitle } }] } },
          }, token) as { id: string };
        }

        // Append content blocks (no inline tags for database mode)
        const blocks = databaseId ? noteToBlocksMinimal(note) : noteToBlocks(note);
        if (blocks.length > 0) {
          await notionPatch(`/blocks/${page.id}/children`, { children: blocks }, token);
        }

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
