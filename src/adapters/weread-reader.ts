import type { SourceAdapter } from "./interfaces";
import type { NoteIR, Resource, PlatformConfig } from "../ir/schema";
import { IR_VERSION } from "../ir/schema";

const GATEWAY = "https://i.weread.qq.com/api/agent/gateway";
const SKILL_VERSION = "1.0.3";

// Real API types per weread-skills notes.md

interface NotebookItem {
  bookId: string;
  book: { bookId: string; title: string; author: string; cover: string };
  noteCount: number;
  reviewCount: number;
  bookmarkCount: number;
  sort: number;
}

interface UpdatedBookmark {
  bookmarkId: string;
  bookId: string;
  chapterUid: number;
  markText: string;
  createTime: number;
  type: number;
  range: string;
  colorStyle: number;
}

interface ChapterInfo {
  chapterUid: number;
  chapterIdx: number;
  title: string;
}

interface ReviewItem {
  review: {
    reviewId: string;
    content: string;
    createTime: number;
    star: number;
    chapterName: string;
    isFinish: number;
  };
}

async function apiCall<T>(apiName: string, params: Record<string, unknown>, apiKey: string): Promise<T> {
  const body = JSON.stringify({ api_name: apiName, skill_version: SKILL_VERSION, ...params });
  const resp = await fetch(GATEWAY, {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new Error(`WeRead API error: ${resp.status} ${resp.statusText}`);
  return resp.json() as T;
}

function notebookToResource(item: NotebookItem): Resource {
  return {
    id: item.bookId,
    title: item.book.title,
    author: item.book.author,
    note_count: item.noteCount + item.reviewCount + item.bookmarkCount,
    extra: { cover: item.book.cover },
  };
}

export const wereadReader: SourceAdapter = {
  platform: "weread",
  version: "0.1.0",

  async healthCheck(config: PlatformConfig): Promise<boolean> {
    try {
      const key = config.credential["api_key"];
      if (!key) return false;
      await apiCall("/user/notebooks", { count: 1 }, key);
      return true;
    } catch { return false; }
  },

  async listResources(config: PlatformConfig): Promise<Resource[]> {
    const key = config.credential["api_key"];
    if (!key) throw new Error("WeRead API key not configured");

    const all: NotebookItem[] = [];
    let lastSort: number | undefined;
    do {
      const params: Record<string, unknown> = { count: 100 };
      if (lastSort !== undefined) params["lastSort"] = lastSort;
      const resp = await apiCall<{ books: NotebookItem[]; hasMore: number }>(
        "/user/notebooks", params, key,
      );
      all.push(...(resp.books ?? []));
      if (resp.books?.length > 0 && resp.hasMore) {
        lastSort = resp.books[resp.books.length - 1].sort;
      } else {
        lastSort = undefined;
      }
    } while (lastSort !== undefined);

    return all
      .filter((b) => b.noteCount + b.reviewCount + b.bookmarkCount > 0)
      .map(notebookToResource);
  },

  async fetch(resource: Resource, config: PlatformConfig): Promise<NoteIR[]> {
    const key = config.credential["api_key"];
    if (!key) throw new Error("WeRead API key not configured");

    const bookId = resource.id;
    const bookTitle = resource.title;
    const author = resource.author ?? "";
    const now = new Date().toISOString();
    const notes: NoteIR[] = [];

    // 1. Fetch highlights (bookmarklist)
    let chapters = new Map<number, string>();
    let bookmarks: UpdatedBookmark[] = [];
    try {
      const bmResp = await apiCall<{
        updated: UpdatedBookmark[];
        chapters: ChapterInfo[];
        book: { bookId: string };
      }>("/book/bookmarklist", { bookId }, key);
      bookmarks = bmResp.updated ?? [];
      for (const ch of bmResp.chapters ?? []) {
        chapters.set(ch.chapterUid, ch.title);
      }
    } catch {
      // If no highlights, proceed with empty list
    }

    for (const bm of bookmarks) {
      const chName = chapters.get(bm.chapterUid) ?? `章节 ${bm.chapterUid}`;
      const [rangeStart, rangeEnd] = (bm.range ?? "0-0").split("-");
      const sourceUrl = rangeEnd
        ? `weread://bestbookmark?bookId=${bookId}&chapterUid=${bm.chapterUid}&rangeStart=${rangeStart}&rangeEnd=${rangeEnd}`
        : `weread://reading?bId=${bookId}&chapterUid=${bm.chapterUid}`;

      notes.push({
        ir_version: IR_VERSION,
        source: "weread",
        source_note_id: `bookmark_${bm.bookmarkId}`,
        fetched_at: now,
        title: bm.markText.slice(0, 50),
        content: bm.markText,
        content_type: "highlight",
        children: [],
        book_title: bookTitle,
        chapter_title: chName,
        author,
        source_url: sourceUrl,
        tags: [],
        extra: { bookId, chapterUid: String(bm.chapterUid), range: bm.range },
      });
    }

    // 2. Fetch personal reviews/thoughts
    let allReviews: ReviewItem[] = [];
    let synckey: number | undefined;
    do {
      const params: Record<string, unknown> = { bookid: bookId, count: 20 };
      if (synckey !== undefined) params["synckey"] = synckey;
      const revResp = await apiCall<{ reviews: ReviewItem[]; hasMore: number; synckey: number }>(
        "/review/list/mine", params, key,
      );
      allReviews.push(...(revResp.reviews ?? []));
      if (revResp.hasMore && revResp.reviews?.length > 0) {
        synckey = revResp.synckey;
      } else {
        synckey = undefined;
      }
    } while (synckey !== undefined);

    for (const item of allReviews) {
      const r = item.review;
      if (!r.content?.trim()) continue;

      notes.push({
        ir_version: IR_VERSION,
        source: "weread",
        source_note_id: `review_${r.reviewId}`,
        fetched_at: now,
        title: r.content.slice(0, 50),
        content: r.content,
        content_type: "thought",
        children: [],
        book_title: bookTitle,
        chapter_title: r.chapterName ?? null,
        author,
        source_url: null,
        tags: [],
        extra: { bookId, reviewId: r.reviewId },
      });
    }

    return notes;
  },

  async fetchIncremental(resource, since, config) {
    const all = await this.fetch(resource, config);
    return all.filter((n) => new Date(n.fetched_at) >= since);
  },
};
