import { createHash } from "node:crypto";
import type { SourceAdapter } from "./interfaces";
import type { NoteIR, Resource, PlatformConfig } from "../ir/schema";
import { IR_VERSION } from "../ir/schema";
import { loadConfig } from "../config";

const FLOMO_BASE = "https://flomoapp.com";
const SIGN_SECRET = "dbbc3dd73364b4084c3a69346e0ce2b2";
const API_KEY = "flomo_web";
const APP_VERSION = "4.0";
const PLATFORM = "web";

async function resolveToken(config: PlatformConfig): Promise<string> {
  // 1. From credential (environment variable or CLI arg)
  const cred = config.credential["authorization"];
  if (cred) return cred;

  // 2. From saved config
  const saved = await loadConfig();
  const savedToken = saved.credentials?.flomo?.authorization;
  if (savedToken) return savedToken;

  // 3. Missing — give clear guidance
  throw new Error(
    "Flomo 认证未配置。\n" +
      "获取方式：浏览器登录 flomoapp.com → F12 → Network → 复制 Authorization 头的 Bearer 值 → 运行:\n" +
      "  notebridge flomo auth\n" +
      "或设置环境变量: export FLOMO_AUTHORIZATION=xxx"
  );
}

interface FlomoMemo {
  slug: string;
  content: string;
  html?: string;
  tags: string[];
  url: string;
  created_at: string;
  updated_at: string;
}

function signParams(params: Record<string, unknown>): string {
  const sortedKeys = Object.keys(params).sort();
  let payload = "";
  for (const key of sortedKeys) {
    const value = params[key];
    if (value === undefined || value === null || value === "" || value === false) continue;
    if (Array.isArray(value)) {
      const sorted = [...value].map(String).sort();
      for (const item of sorted) {
        payload += `${key}[]=${encodeURIComponent(String(item))}&`;
      }
      continue;
    }
    payload += `${key}=${encodeURIComponent(String(value))}&`;
  }
  payload = payload.slice(0, -1);
  return createHash("md5").update(`${payload}${SIGN_SECRET}`, "utf8").digest("hex");
}

function buildQuery(extra: Record<string, unknown> = {}): URLSearchParams {
  const params: Record<string, unknown> = {
    timestamp: Math.floor(Date.now() / 1000),
    api_key: API_KEY,
    app_version: APP_VERSION,
    platform: PLATFORM,
    webp: "1",
    ...extra,
  };
  params["sign"] = signParams(params);

  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    search.append(key, String(value));
  }
  return search;
}

async function flomoFetch(
  path: string,
  query: URLSearchParams,
  authToken: string,
): Promise<unknown> {
  const url = `${FLOMO_BASE}${path}?${query.toString()}`;
  const resp = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${authToken}`,
      "Accept": "application/json, text/plain, */*",
      "User-Agent": "Mozilla/5.0",
      "Origin": FLOMO_BASE,
      "Referer": `${FLOMO_BASE}/`,
      "X-Timezone": "Asia/Shanghai",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    throw new Error(`Flomo API error: ${resp.status} ${resp.statusText}`);
  }
  return resp.json();
}

function memoToNoteIR(memo: FlomoMemo): NoteIR {
  return {
    ir_version: IR_VERSION,
    source: "flomo",
    source_note_id: memo.slug,
    fetched_at: new Date().toISOString(),
    title: memo.content.slice(0, 50),
    content: memo.content,
    content_type: "card",
    children: [],
    book_title: null,
    chapter_title: null,
    author: null,
    source_url: memo.url,
    tags: memo.tags,
    extra: { memoId: memo.slug },
  };
}

export const flomoReader: SourceAdapter = {
  platform: "flomo",
  version: "0.1.0",

  async healthCheck(config: PlatformConfig): Promise<boolean> {
    try {
      const token = await resolveToken(config);
      await flomoFetch("/api/v1/memo/latest_updated_desc", buildQuery(), token);
      return true;
    } catch {
      return false;
    }
  },

  async listResources(config: PlatformConfig): Promise<Resource[]> {
    const token = await resolveToken(config);

    const data = await flomoFetch("/api/v1/memo/latest_updated_desc", buildQuery(), token) as { data?: FlomoMemo[] };
    const memos = data?.data ?? [];

    return [{
      id: "all",
      title: "All Flomo Memos",
      note_count: memos.length,
    }];
  },

  async fetch(resource: Resource, config: PlatformConfig): Promise<NoteIR[]> {
    const token = await resolveToken(config);

    const data = await flomoFetch(
      "/api/v1/memo/latest_updated_desc",
      buildQuery(),
      token,
    ) as { data?: FlomoMemo[] };

    return (data.data ?? []).map(memoToNoteIR);
  },

  async fetchIncremental(resource, since, config) {
    const all = await this.fetch(resource, config);
    return all.filter((n) => new Date(n.fetched_at) >= since);
  },
};
