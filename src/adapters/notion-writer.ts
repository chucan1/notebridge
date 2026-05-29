import type { DestinationAdapter } from "./interfaces";
import type { NoteIR, PlatformConfig, WriteOptions, TransferResult } from "../ir/schema";
import { makeDedupMarker } from "../ir/schema";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";

// Notion rate limit: ~3 requests/second. Track and throttle.
let lastRequestTime = 0;
async function throttle(): Promise<void> {
  const now = Date.now();
  const minGap = 350; // ms between requests (~2.85 req/s)
  const wait = Math.max(0, lastRequestTime + minGap - now);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastRequestTime = Date.now();
}

async function resolveToken(config: PlatformConfig): Promise<string> {
  const token = config.credential["api_key"] || process.env["NOTION_API_KEY"];
  if (!token) throw new Error("Notion API key not configured");
  return token;
}

// Parse Markdown text into Notion rich_text array with annotations
function markdownToRichText(text: string): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  // Match: **bold**, *italic*, ~~strike~~, `code`, [link](url), ![](url), and plain text
  const pattern = /(\*\*(.+?)\*\*|\*(.+?)\*|~~(.+?)~~|`(.+?)`|\[(.+?)\]\((.+?)\)|!\[.*?\]\((.+?)\)|([^*~`\[\]!]+))/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match[2]) { // **bold**
      result.push({ type: "text", text: { content: match[2] }, annotations: { bold: true } });
    } else if (match[3]) { // *italic*
      result.push({ type: "text", text: { content: match[3] }, annotations: { italic: true } });
    } else if (match[4]) { // ~~strike~~
      result.push({ type: "text", text: { content: match[4] }, annotations: { strikethrough: true } });
    } else if (match[5]) { // `code`
      result.push({ type: "text", text: { content: match[5] }, annotations: { code: true } });
    } else if (match[6] && match[7]) { // [text](url)
      result.push({ type: "text", text: { content: match[6], link: { url: match[7] } } });
    } else if (match[8]) { // ![](url) — image
      result.push({ type: "text", text: { content: "[Image: " + match[8] + "]" }, annotations: { color: "gray" } });
    } else if (match[9]) { // plain text
      result.push({ type: "text", text: { content: match[9] } });
    }
  }
  return result.length > 0 ? result : [{ type: "text", text: { content: text } }];
}

// Detect image URLs in content and create image blocks
function extractImageBlocks(note: NoteIR): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  const imgRegex = /!\[.*?\]\((https?:\/\/[^\s)]+)\)/g;
  let match;
  while ((match = imgRegex.exec(note.content)) !== null) {
    blocks.push({
      object: "block",
      type: "image",
      image: { type: "external", external: { url: match[1] } },
    });
  }
  return blocks;
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
    blocks.push(...extractImageBlocks(note));
    blocks.push({
      object: "block",
      type: "quote",
      quote: {
        rich_text: markdownToRichText(note.content.replace(/!\[.*?\]\(https?:\/\/[^\s)]+\)/g, "")),
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
  await throttle();
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
  await throttle();
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

// Auto-map NoteIR data to database properties
function mapNoteProperties(
  note: NoteIR,
  props: Record<string, string>, // name → type
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, type] of Object.entries(props)) {
    const lower = name.toLowerCase();
    if (lower === "title" || type === "title") continue; // handled separately

    if ((lower.includes("tag") || lower.includes("标签")) && type === "multi_select") {
      result[name] = { multi_select: note.tags.map(t => ({ name: t.replace(/^#/, "") })) };
    } else if ((lower.includes("date") || lower.includes("日期") || lower.includes("created")) && type === "date") {
      result[name] = { date: { start: note.fetched_at?.slice(0, 10) } };
    } else if ((lower.includes("url") || lower.includes("链接") || lower.includes("source")) && type === "url") {
      if (note.source_url) result[name] = { url: note.source_url };
    } else if ((lower.includes("author") || lower.includes("作者")) && type === "rich_text") {
      if (note.author) result[name] = { rich_text: [{ type: "text", text: { content: note.author } }] };
    } else if ((lower.includes("chapter") || lower.includes("章节")) && type === "rich_text") {
      if (note.chapter_title) result[name] = { rich_text: [{ type: "text", text: { content: note.chapter_title } }] };
    } else if ((lower.includes("book") || lower.includes("书名")) && type === "rich_text") {
      if (note.book_title) result[name] = { rich_text: [{ type: "text", text: { content: note.book_title } }] };
    }
  }
  return result;
}

// Auto-detect database schema: find title and multi-select properties
async function detectDbSchema(databaseId: string, token: string): Promise<{ titleProp: string; tagProp: string | null; properties: Record<string, string> }> {
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
    const allProps: Record<string, string> = {};
    for (const [name, prop] of Object.entries(ds.properties ?? {})) {
      allProps[name] = prop.type;
      if (prop.type === "title") titleProp = name;
      if (prop.type === "multi_select" && !tagProp) tagProp = name;
    }
    return { titleProp, tagProp, properties: allProps };
  } catch {
    return { titleProp: "Name", tagProp: null, properties: {} };
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

        // Check if page with same title already exists (upsert)
        let existingPageId: string | null = null;
        try {
          const searchBody: Record<string, unknown> = {
            query: pageTitle,
            filter: { property: "object", value: "page" },
            page_size: 5,
          };
          if (databaseId) {
            // Search within database
            const dbSearch = await fetch(`${NOTION_API}/databases/${databaseId}/query`, {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${token}`,
                "Notion-Version": NOTION_VERSION,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                page_size: 5,
                filter: { property: "title", title: { equals: pageTitle } },
              }),
              signal: AbortSignal.timeout(15_000),
            });
            if (dbSearch.ok) {
              const data = await dbSearch.json() as { results: Array<{ id: string }> };
              if (data.results.length > 0) existingPageId = data.results[0].id;
            }
          }
        } catch { /* search failed, create new */ }

        let page: { id: string };

        if (databaseId) {
          // Database mode: auto-detect schema, create page with native properties
          const schema = await detectDbSchema(databaseId, token);
          const titleProp = config.options["title_property"] as string || schema.titleProp;
          const tagProp = config.options["tag_property"] as string || schema.tagProp || "Tags";

          // Build properties: auto-mapped + tags + title
          const mappedProps = mapNoteProperties(note, schema.properties);
          const properties: Record<string, unknown> = {
            ...mappedProps,
            [titleProp]: {
              title: [{ type: "text", text: { content: pageTitle } }],
            },
          };
          // Tags override: use auto-mapped tag property
          if (note.tags.length > 0 && schema.tagProp && !mappedProps[schema.tagProp]) {
            properties[schema.tagProp] = {
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
