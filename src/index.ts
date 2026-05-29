// Core types
export type {
  NoteIR,
  ExtraFields,
  ContentType,
  TransferResult,
  TransferError,
  Resource,
  PlatformConfig,
  WriteOptions,
  RunOptions,
  DedupMode,
  GroupingMode,
} from "./ir/schema";

export {
  IR_VERSION,
  SUPPORTED_IR_VERSIONS,
  makeDedupMarker,
  parseDedupMarker,
  validateIRVersion,
} from "./ir/schema";

// Adapter interfaces
export type { SourceAdapter, DestinationAdapter } from "./adapters/interfaces";

// Registry
export {
  registerSource,
  registerDestination,
  getSourceAdapter,
  getDestinationAdapter,
  listSourcePlatforms,
  listDestinationPlatforms,
} from "./adapters/registry";

// Pipeline
export { run } from "./pipeline/runner";

// Built-in adapters
export { wereadReader } from "./adapters/weread-reader";
export { flomoReader } from "./adapters/flomo-reader";
export { notionReader } from "./adapters/notion-reader";
export { getnoteWriter } from "./adapters/getnote-writer";
export { notionWriter } from "./adapters/notion-writer";
export { flomoWriter } from "./adapters/flomo-writer";
export { obsidianWriter } from "./adapters/obsidian-writer";
export { localMarkdownReader } from "./adapters/local-markdown-reader";
