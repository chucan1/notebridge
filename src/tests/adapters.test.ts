import { describe, it, expect } from "vitest";
import { IR_VERSION, makeDedupMarker } from "../ir/schema";
import type { NoteIR } from "../ir/schema";

// Test sanitizeFilename (copy from obsidian-writer for testing)
function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*#\[\]]/g, "-").slice(0, 80).trim();
}

// Test noteToObsidianMarkdown (copy from obsidian-writer for testing)
function noteToObsidianMarkdown(note: NoteIR): string {
  const lines: string[] = [];
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

// Test frontmatter parser (copy from local-markdown-reader for testing)
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
      frontmatter[key] = value.split(",").map((s: string) => s.trim().replace(/^- /, ""));
    } else {
      frontmatter[key] = value;
    }
  }
  return { frontmatter, body };
}

// Test grouping logic (extract from PipelineRunner)
function groupPerBook(notes: NoteIR[]): NoteIR[] {
  const groups = new Map<string, NoteIR[]>();
  for (const n of notes) {
    const key = `${n.source}:${n.book_title ?? "unknown"}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(n);
  }
  return [...groups.values()].map((group) => {
    if (group.length <= 1) return group[0];
    const first = group[0];
    return {
      ...first,
      content_type: "mixed" as const,
      content: group.map((n) => n.content).join("\n\n---\n\n"),
      children: group.flatMap((n) => n.children),
      tags: [...new Set(group.flatMap((n) => n.tags))],
    };
  });
}

const sampleNote: NoteIR = {
  ir_version: IR_VERSION,
  source: "weread",
  source_note_id: "bm_1",
  fetched_at: "2026-05-29T00:00:00Z",
  title: "人在年轻时",
  content: "人在年轻时，最头痛的一件事就是决定自己这一生要做什么。",
  content_type: "highlight",
  children: [
    {
      ir_version: IR_VERSION,
      source: "weread",
      source_note_id: "rev_1",
      fetched_at: "2026-05-29T00:00:00Z",
      title: null,
      content: "深有感触。",
      content_type: "thought",
      children: [],
      book_title: "黑客与画家",
      chapter_title: "第3章",
      author: "Paul Graham",
      source_url: null,
      tags: [],
      extra: {},
    },
  ],
  book_title: "黑客与画家",
  chapter_title: "第3章",
  author: "Paul Graham",
  source_url: "weread://reading?bId=123&chapterUid=3",
  tags: ["微信读书", "读书笔记"],
  extra: { bookId: "123", chapterUid: "3", range: "900-2004" },
};

describe("Obsidian Writer", () => {
  it("should sanitize filenames", () => {
    expect(sanitizeFilename('hello:world')).toBe("hello-world");
    expect(sanitizeFilename('a/b\\c')).toBe("a-b-c");
    expect(sanitizeFilename('x'.repeat(100))).toHaveLength(80);
  });

  it("should generate valid markdown with frontmatter", () => {
    const md = noteToObsidianMarkdown(sampleNote);
    expect(md).toContain("---");
    expect(md).toContain('title: "人在年轻时"');
    expect(md).toContain('book: "黑客与画家"');
    expect(md).toContain('author: "Paul Graham"');
    expect(md).toContain("tags:");
    expect(md).toContain("  - 微信读书");
    expect(md).toContain("source: weread");
    expect(md).toContain("# 黑客与画家");
    expect(md).toContain("## 第3章");
    expect(md).toContain("> 人在年轻时");
    expect(md).toContain("- 深有感触。");
  });

  it("should handle notes without book info", () => {
    const note: NoteIR = {
      ...sampleNote,
      book_title: null,
      chapter_title: null,
      author: null,
      children: [],
      tags: [],
    };
    const md = noteToObsidianMarkdown(note);
    expect(md).not.toContain("book:");
    expect(md).not.toContain("# null");
    expect(md).not.toContain("tags:");
  });
});

describe("Local Markdown Reader", () => {
  it("should parse frontmatter from markdown", () => {
    const text = `---
title: My Note
author: Test Author
tags:
  - tag1
  - tag2
---
This is the body content.`;
    const { frontmatter, body } = parseFrontmatter(text);
    expect(frontmatter["title"]).toBe("My Note");
    expect(frontmatter["author"]).toBe("Test Author");
    expect(body.trim()).toBe("This is the body content.");
  });

  it("should handle markdown without frontmatter", () => {
    const text = "# Just a heading\n\nSome content.";
    const { frontmatter, body } = parseFrontmatter(text);
    expect(frontmatter).toEqual({});
    expect(body).toContain("# Just a heading");
  });

  it("should handle malformed frontmatter (no closing ---)", () => {
    const text = "---\ntitle: Broken\nNo closing";
    const { frontmatter } = parseFrontmatter(text);
    expect(frontmatter).toEqual({});
  });

  it("should strip quotes from frontmatter values", () => {
    const text = '---\ntitle: "Quoted Title"\nauthor: \'Author Name\'\n---\nBody.';
    const { frontmatter } = parseFrontmatter(text);
    expect(frontmatter["title"]).toBe("Quoted Title");
    expect(frontmatter["author"]).toBe("Author Name");
  });
});

describe("Pipeline Grouping", () => {
  const note1: NoteIR = { ...sampleNote, source_note_id: "bm_1", book_title: "Book A", chapter_title: "Ch1", content: "Note 1" };
  const note2: NoteIR = { ...sampleNote, source_note_id: "bm_2", book_title: "Book A", chapter_title: "Ch2", content: "Note 2" };
  const note3: NoteIR = { ...sampleNote, source_note_id: "bm_3", book_title: "Book B", chapter_title: "Ch1", content: "Note 3" };

  it("should group notes by book", () => {
    const result = groupPerBook([note1, note2, note3]);
    expect(result).toHaveLength(2); // Book A (merged), Book B (single)
    const bookA = result.find((n) => n.book_title === "Book A")!;
    expect(bookA.content_type).toBe("mixed");
    expect(bookA.content).toContain("Note 1");
    expect(bookA.content).toContain("Note 2");
    expect(bookA.content).toContain("---");
  });

  it("should not merge single notes in a group", () => {
    const result = groupPerBook([note3]);
    expect(result).toHaveLength(1);
    expect(result[0].content_type).toBe("highlight"); // unchanged
  });

  it("should deduplicate tags when merging", () => {
    const n1 = { ...note1, tags: ["tag-a", "tag-b"] };
    const n2 = { ...note2, tags: ["tag-b", "tag-c"] };
    const result = groupPerBook([n1, n2]);
    expect(result[0].tags.sort()).toEqual(["tag-a", "tag-b", "tag-c"]);
  });
});

describe("Dedup Marker in Content", () => {
  it("should append marker to markdown output", () => {
    const marker = makeDedupMarker("weread", "highlight", "bm_1");
    const fullContent = noteToObsidianMarkdown(sampleNote) + `\n\n${marker}\n`;
    expect(fullContent).toContain("[notebridge:weread:highlight:bm_1]");
  });

  it("should be detectable via simple string match", () => {
    const marker = makeDedupMarker("weread", "highlight", "bm_123");
    const content = "Some notes.\n\n" + marker + "\n";
    expect(content.includes("[notebridge:weread:highlight:bm_123]")).toBe(true);
    expect(content.includes("[notebridge:weread:highlight:bm_999]")).toBe(false);
  });
});
