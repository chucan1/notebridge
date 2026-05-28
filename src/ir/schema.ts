// Note IR schema v0.1 — the universal intermediate representation for note data
// See design doc: ~/.gstack/projects/chucan1-weread-to-getnote/*-design-*.md

export const IR_VERSION = "0.1";
export const SUPPORTED_IR_VERSIONS = ["0.1"];

export type ContentType = "highlight" | "thought" | "card" | "page" | "block" | "mixed";

export interface NoteIR {
  ir_version: string;
  source: string;
  source_note_id: string;
  fetched_at: string;

  title: string | null;
  content: string;
  content_type: ContentType;

  children: NoteIR[];

  book_title: string | null;
  chapter_title: string | null;
  author: string | null;
  source_url: string | null;

  tags: string[];
  extra: ExtraFields;
}

// Typed extra fields per platform, per design doc
export interface ExtraFields {
  // weread-specific
  bookId?: string;
  chapterUid?: string;
  range?: string;
  reviewId?: string;
  // flomo-specific
  memoId?: string;
  color?: string;
  // obsidian-specific
  filePath?: string;
  aliases?: string[];
  cssClasses?: string[];
  // notion-specific
  blockId?: string;
  parentId?: string;
  databaseId?: string;
  // getnote-specific
  noteId?: string;
  topicId?: string;
  // catch-all for unrecognized keys
  _custom?: Record<string, string>;
}

export interface TransferResult {
  source: string;
  target: string;
  notes_transferred: number;
  notes_skipped: number;
  errors: TransferError[];
}

export interface TransferError {
  source_note_id: string;
  reason: string;
  detail: string;
}

export interface Resource {
  id: string;
  title: string;
  author?: string;
  note_count?: number;
  extra?: Record<string, unknown>;
}

export type DedupMode = "skip" | "overwrite";

export type GroupingMode = "per_item" | "per_book" | "per_chapter";

export interface WriteOptions {
  dedup?: DedupMode;
  dryRun?: boolean;
  grouping?: GroupingMode;
}

export interface PlatformConfig {
  credential: Record<string, string>;
  options: Record<string, unknown>;
}

export interface RunOptions extends WriteOptions {
  incremental?: boolean;
}

// Dedup marker format
export function makeDedupMarker(source: string, type: string, sourceNoteId: string): string {
  return `[notebridge:${source}:${type}:${sourceNoteId}]`;
}

export function parseDedupMarker(text: string): string | null {
  const m = text.match(/\[notebridge:([^:]+):([^:]+):([^\]]+)\]/);
  return m ? m[3] : null; // return source_note_id
}

// IR version validation
export function validateIRVersion(version: string): void {
  if (!SUPPORTED_IR_VERSIONS.includes(version)) {
    throw new Error(
      `Unsupported IR version: ${version}. Supported: ${SUPPORTED_IR_VERSIONS.join(", ")}`
    );
  }
}
