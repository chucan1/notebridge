import { createHash } from "node:crypto";
import type { SourceAdapter } from "./interfaces";
import type { NoteIR, Resource, PlatformConfig } from "../ir/schema";
import { IR_VERSION } from "../ir/schema";
import { loadConfig } from "../config";

const FLOMO_BASE = "https://flomoapp.com";
const SIGN_SECRET = "dbbc3dd73364b4084c3a69346e0ce2b2";

function getTz(): string {
  const offset = -new Date().getTimezoneOffset();
  const hours = Math.trunc(offset / 60);
  const minutes = offset % 60;
  return `${hours}:${minutes}`;
}

function signParams(params: Record<string, unknown>): string {
  const sortedKeys = Object.keys(params).sort();
  let payload = "";
  for (const key of sortedKeys) {
    const value = params[key];
    if (value === undefined || value === null || value === "" || value === false) continue;
    if (Array.isArray(value)) {
      const sorted = [...value].map(String).sort((a, b) => String(a).localeCompare(String(b)));
      for (const item of sorted) {
        payload += `${key}[]=${String(item)}&`;
      }
      continue;
    }
    payload += `${key}=${String(value)}&`;
  }
  payload = payload.slice(0, -1);
  return createHash("md5").update(payload + SIGN_SECRET, "utf8").digest("hex");
}

function buildSignedQuery(extra: Record<string, unknown> = {}): string {
  const base: Record<string, unknown> = {
    timestamp: Math.floor(Date.now() / 1000),
    api_key: "flomo_web",
    app_version: "4.0",
    platform: "web",
    webp: "1",
    tz: getTz(),
    ...extra,
  };
  base["sign"] = signParams(base);

  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) search.append(`${key}[]`, String(item));
    } else {
      search.append(key, String(value));
    }
  }
  return search.toString();
}

async function resolveCookie(config: PlatformConfig): Promise<string> {
  // 1. From credential (env var or CLI arg)
  const cred = config.credential["cookie"];
  if (cred) return cred;

  // 2. From saved config
  const saved = await loadConfig();
  const savedCookie = saved.credentials?.flomo?.cookie;
  if (savedCookie) return savedCookie;

  throw new Error(
    "Flomo 认证未配置。\n" +
      "1. 浏览器打开 https://flomoapp.com 并登录\n" +
      "2. 运行: notebridge flomo auth\n" +
      "3. 按提示复制 Cookie\n" +
      "或设置环境变量: FLOMO_COOKIE=xxx"
  );
}

async function flomoGet(path: string, query: string, cookie: string): Promise<unknown> {
  const url = `${FLOMO_BASE}${path}?${query}`;
  const resp = await fetch(url, {
    headers: {
      "Cookie": cookie,
      "Accept": "application/json, text/plain, */*",
      "User-Agent": "Mozilla/5.0",
      "Origin": "https://flomoapp.com",
      "Referer": "https://flomoapp.com/",
      "X-Timezone": "Asia/Shanghai",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new Error(`Flomo API error: ${resp.status}`);
  return resp.json();
}

interface FlomoMemo {
  slug: string;
  content: string;
  tags?: string[];
  url?: string;
  created_at?: string;
}

function extractMemos(raw: unknown): FlomoMemo[] {
  if (Array.isArray(raw)) return raw as FlomoMemo[];
  if (typeof raw === "object" && raw !== null) {
    const obj = raw as Record<string, unknown>;
    for (const key of ["memos", "memo_list", "items", "list", "data", "result"]) {
      if (Array.isArray(obj[key])) return obj[key] as FlomoMemo[];
    }
  }
  return [];
}

function memoToNoteIR(memo: FlomoMemo): NoteIR {
  return {
    ir_version: IR_VERSION,
    source: "flomo",
    source_note_id: memo.slug,
    fetched_at: new Date().toISOString(),
    title: (memo.content ?? "").slice(0, 50),
    content: memo.content ?? "",
    content_type: "card",
    children: [],
    book_title: null,
    chapter_title: null,
    author: null,
    source_url: memo.url ?? null,
    tags: memo.tags ?? [],
    extra: { memoId: memo.slug },
  };
}

export const flomoReader: SourceAdapter = {
  platform: "flomo",
  version: "0.1.0",

  async healthCheck(config: PlatformConfig): Promise<boolean> {
    try {
      const token = await resolveCookie(config);
      await flomoGet("/api/v1/memo/updated/", buildSignedQuery({ limit: 1, latest_updated_at: 0, latest_slug: "" }), token);
      return true;
    } catch {
      return false;
    }
  },

  async listResources(config: PlatformConfig): Promise<Resource[]> {
    const token = await resolveCookie(config);
    try {
      const raw = await flomoGet("/api/v1/memo/updated/", buildSignedQuery({ limit: 200, latest_updated_at: 0, latest_slug: "" }), token);
      const memos = extractMemos(raw);
      return [{ id: "all", title: "All Flomo Memos", note_count: memos.length }];
    } catch {
      return [{ id: "all", title: "All Flomo Memos", note_count: 0 }];
    }
  },

  async fetch(_resource: Resource, config: PlatformConfig): Promise<NoteIR[]> {
    const token = await resolveCookie(config);
    // Paginate through all memos
    const allMemos: FlomoMemo[] = [];
    let cursor = { latest_updated_at: 0, latest_slug: "" };
    while (true) {
      const raw = await flomoGet("/api/v1/memo/updated/", buildSignedQuery({
        limit: 200,
        latest_updated_at: cursor.latest_updated_at,
        latest_slug: cursor.latest_slug,
      }), token);
      const batch = extractMemos(raw);
      if (batch.length === 0) break;
      allMemos.push(...batch);
      if (batch.length < 200) break;
      const last = batch[batch.length - 1] as unknown as Record<string, unknown>;
      cursor = { latest_updated_at: (last.updated_at as number) ?? 0, latest_slug: last.slug as string };
    }
    return allMemos.map(memoToNoteIR);
  },

  async fetchIncremental(resource, since, config) {
    const all = await this.fetch(resource, config);
    return all.filter((n) => new Date(n.fetched_at) >= since);
  },
};
