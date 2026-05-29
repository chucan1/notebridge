import type { SourceAdapter } from "./interfaces";
import type { NoteIR, Resource, PlatformConfig } from "../ir/schema";
import { IR_VERSION } from "../ir/schema";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";

interface NotionPage {
  id: string;
  title: string;
  properties?: Record<string, unknown>;
  url?: string;
}

interface NotionBlock {
  id: string;
  type: string;
  has_children?: boolean;
  [type: string]: unknown;
}

async function notionGet(path: string, token: string): Promise<unknown> {
  const resp = await fetch(`${NOTION_API}${path}`, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Notion API error ${resp.status}: ${err.slice(0, 200)}`);
  }
  return resp.json();
}

async function resolveToken(config: PlatformConfig): Promise<string> {
  const token = config.credential["api_key"] || process.env["NOTION_API_KEY"];
  if (!token) throw new Error("Notion API key not configured. Set NOTION_API_KEY or credential.api_key");
  return token;
}

// Extract plain text from Notion rich text array
function richTextToString(richText: unknown): string {
  if (Array.isArray(richText)) {
    return richText.map((t: Record<string, unknown>) =>
      (t as { plain_text?: string })?.plain_text ?? ""
    ).join("");
  }
  return String(richText ?? "");
}

// Convert Notion blocks to markdown
function blockToMarkdown(block: NotionBlock): string {
  const type = block.type;
  const data = (block as Record<string, unknown>)[type] as Record<string, unknown> | undefined;

  switch (type) {
    case "paragraph":
      return richTextToString(data?.rich_text) || "";
    case "heading_1":
      return "# " + richTextToString(data?.rich_text);
    case "heading_2":
      return "## " + richTextToString(data?.rich_text);
    case "heading_3":
      return "### " + richTextToString(data?.rich_text);
    case "bulleted_list_item":
      return "- " + richTextToString(data?.rich_text);
    case "numbered_list_item":
      return "1. " + richTextToString(data?.rich_text);
    case "to_do":
      return (data?.checked ? "- [x] " : "- [ ] ") + richTextToString(data?.rich_text);
    case "quote":
      return "> " + richTextToString(data?.rich_text);
    case "code":
      return "```\n" + richTextToString(data?.rich_text) + "\n```";
    case "divider":
      return "---";
    case "callout":
      return "> " + richTextToString(data?.rich_text);
    case "image":
      return data?.type === "external"
        ? `![](${(data?.external as Record<string,string>)?.url})`
        : `[Image: ${(data?.file as Record<string,string>)?.url}]`;
    default:
      return richTextToString(data?.rich_text) || "";
  }
}

// Fetch all blocks recursively (handles has_children)
async function getAllBlocks(blockId: string, token: string): Promise<NotionBlock[]> {
  const all: NotionBlock[] = [];
  let cursor: string | undefined;

  do {
    const params = new URLSearchParams({ page_size: "100" });
    if (cursor) params.set("start_cursor", cursor);
    const resp = await notionGet(
      `/blocks/${blockId}/children?${params.toString()}`,
      token,
    ) as { results: NotionBlock[]; has_more: boolean; next_cursor: string | null };
    all.push(...resp.results);
    cursor = resp.has_more ? (resp.next_cursor ?? undefined) : undefined;
  } while (cursor);

  // Recursively get children for nested blocks
  for (const block of all) {
    if (block.has_children) {
      block["children"] = await getAllBlocks(block.id, token);
    }
  }

  return all;
}

function blocksToNoteIR(page: NotionPage, blocks: NotionBlock[]): NoteIR {
  const firstHeading = blocks.find(b => b.type?.startsWith("heading"));
  const headingData = firstHeading ? (firstHeading as Record<string, unknown>)[firstHeading.type!] as Record<string, unknown> : null;
  const headingRichText = headingData?.rich_text as Array<{ plain_text: string }> | undefined;
  const title = page.title || headingRichText?.[0]?.plain_text || "Untitled";
  let content = blocks.map(blockToMarkdown).filter(Boolean).join("\n\n");

  // Also flatten nested blocks
  for (const block of blocks) {
    const children = (block as Record<string, unknown>)["children"] as NotionBlock[] | undefined;
    if (children) {
      content += "\n\n" + children.map(blockToMarkdown).filter(Boolean).join("\n\n");
    }
  }

  return {
    ir_version: IR_VERSION,
    source: "notion",
    source_note_id: page.id,
    fetched_at: new Date().toISOString(),
    title: title.slice(0, 50),
    content,
    content_type: "page",
    children: [],
    book_title: null,
    chapter_title: null,
    author: null,
    source_url: page.url ?? `https://notion.so/${page.id.replace(/-/g, "")}`,
    tags: [],
    extra: { pageId: page.id },
  };
}

export const notionReader: SourceAdapter = {
  platform: "notion",
  version: "0.1.0",

  async healthCheck(config: PlatformConfig): Promise<boolean> {
    try {
      const token = await resolveToken(config);
      await notionGet("/users/me", token);
      return true;
    } catch {
      return false;
    }
  },

  async listResources(config: PlatformConfig): Promise<Resource[]> {
    const token = await resolveToken(config);
    const searchResp = await fetch(`${NOTION_API}/search`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ page_size: 50, filter: { property: "object", value: "page" } }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!searchResp.ok) {
      const err = await searchResp.text();
      throw new Error(`Notion search error ${searchResp.status}: ${err.slice(0, 200)}`);
    }
    const searchData = await searchResp.json() as { results?: Array<{ id: string; icon?: unknown; properties?: Record<string, unknown>; url?: string }> };

    return (searchData.results ?? []).map(p => {
      // Extract title from properties
      const props = p.properties ?? {};
      const titleProp = Object.values(props).find(
        (v: unknown) => (v as { type?: string })?.type === "title"
      ) as { title?: Array<{ plain_text: string }> } | undefined;
      const title = titleProp?.title?.map(t => t.plain_text).join("") ?? p.id.slice(0, 8);
      return {
        id: p.id,
        title,
        extra: { url: p.url },
      };
    });
  },

  async fetch(resource: Resource, config: PlatformConfig): Promise<NoteIR[]> {
    const token = await resolveToken(config);
    const blocks = await getAllBlocks(resource.id, token);
    const page: NotionPage = {
      id: resource.id,
      title: resource.title,
      url: (resource.extra as Record<string, unknown>)?.url as string,
    };
    return [blocksToNoteIR(page, blocks)];
  },
};
