import { describe, it, expect } from "vitest";
import {
  registerSource,
  registerDestination,
  getSourceAdapter,
  getDestinationAdapter,
  listSourcePlatforms,
  listDestinationPlatforms,
} from "../adapters/registry";
import type { SourceAdapter, DestinationAdapter } from "../adapters/interfaces";
import { run } from "../pipeline/runner";
import { IR_VERSION } from "../ir/schema";

function makeMockSource(): SourceAdapter {
  return {
    platform: "mock-source",
    version: "0.1.0",
    async healthCheck() { return true; },
    async listResources() {
      return [{ id: "1", title: "Test Book", author: "Test Author" }];
    },
    async fetch() {
      return [
        {
          ir_version: IR_VERSION,
          source: "mock-source",
          source_note_id: "note_1",
          fetched_at: new Date().toISOString(),
          title: "Test note",
          content: "This is a test highlight",
          content_type: "highlight",
          children: [],
          book_title: "Test Book",
          chapter_title: "Chapter 1",
          author: "Test Author",
          source_url: null,
          tags: [],
          extra: {},
        },
      ];
    },
  };
}

function makeMockDestination(): DestinationAdapter {
  return {
    platform: "mock-dest",
    version: "0.1.0",
    async healthCheck() { return true; },
    async write(notes, _config, _options) {
      return {
        source: notes[0]?.source ?? "unknown",
        target: "mock-dest",
        notes_transferred: notes.length,
        notes_skipped: 0,
        errors: [],
      };
    },
  };
}

describe("Adapter Registry", () => {
  it("should register and retrieve an adapter", () => {
    const src = makeMockSource();
    registerSource(src);
    expect(getSourceAdapter("mock-source")).toBe(src);
    expect(listSourcePlatforms()).toContain("mock-source");
  });

  it("should throw on duplicate registration", () => {
    const src = makeMockSource();
    src.platform = "mock-source-dup";
    registerSource(src);
    expect(() => registerSource(src)).toThrow("already registered");
  });

  it("should throw for unknown adapter", () => {
    expect(() => getSourceAdapter("nonexistent")).toThrow("No source adapter");
    expect(() => getDestinationAdapter("nonexistent")).toThrow("No destination adapter");
  });

  it("should list platforms", () => {
    const dest = makeMockDestination();
    registerDestination(dest);
    expect(listDestinationPlatforms()).toContain("mock-dest");
  });
});

describe("Pipeline Runner", () => {
  it("should complete a basic transfer", async () => {
    const src = makeMockSource();
    const dest = makeMockDestination();
    const result = await run(
      src,
      dest,
      { id: "1", title: "Test Book" },
      { credential: {}, options: {} },
      { credential: {}, options: {} },
    );
    expect(result.notes_transferred).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("should return error on source health check failure", async () => {
    const src = makeMockSource();
    src.healthCheck = async () => false;
    const dest = makeMockDestination();
    const result = await run(
      src,
      dest,
      { id: "1", title: "Test Book" },
      { credential: {}, options: {} },
      { credential: {}, options: {} },
    );
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].reason).toBe("auth_expired");
    expect(result.notes_transferred).toBe(0);
  });

  it("should support dry run via options", async () => {
    const src = makeMockSource();
    const dest = makeMockDestination();
    let actualWrite = false;
    dest.write = async () => {
      actualWrite = true;
      return { source: "mock", target: "mock", notes_transferred: 0, notes_skipped: 0, errors: [] };
    };
    // dryRun is passed through to write(), but PipelineRunner doesn't skip write for dryRun
    // — dryRun is handled by the writer. We pass it as a RunOption and it flows to write().
    const result = await run(
      src, dest, { id: "1", title: "T" },
      { credential: {}, options: {} },
      { credential: {}, options: {} },
      { dryRun: true },
    );
    expect(actualWrite).toBe(true); // PipelineRunner always calls write, writer decides
  });

  it("should catch fetch errors", async () => {
    const src = makeMockSource();
    src.fetch = async () => { throw new Error("Network timeout"); };
    const dest = makeMockDestination();
    const result = await run(
      src, dest, { id: "1", title: "T" },
      { credential: {}, options: {} },
      { credential: {}, options: {} },
    );
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].reason).toBe("fetch_failed");
    expect(result.notes_transferred).toBe(0);
  });
});
