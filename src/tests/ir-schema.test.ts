import { describe, it, expect } from "vitest";
import {
  IR_VERSION,
  SUPPORTED_IR_VERSIONS,
  makeDedupMarker,
  parseDedupMarker,
  validateIRVersion,
} from "../ir/schema";

describe("IR Schema", () => {
  it("should have IR_VERSION defined", () => {
    expect(IR_VERSION).toBe("0.1");
    expect(SUPPORTED_IR_VERSIONS).toContain("0.1");
  });

  it("should validate supported IR versions", () => {
    expect(() => validateIRVersion("0.1")).not.toThrow();
  });

  it("should reject unsupported IR versions", () => {
    expect(() => validateIRVersion("0.2")).toThrow("Unsupported IR version");
    expect(() => validateIRVersion("1.0")).toThrow("Unsupported IR version");
  });
});

describe("Dedup markers", () => {
  it("should generate a stable marker string", () => {
    const marker = makeDedupMarker("weread", "highlight", "bookmark_123");
    expect(marker).toBe("[notebridge:weread:highlight:bookmark_123]");
  });

  it("should parse source_note_id from a marker", () => {
    const text = "Some content\n\n[notebridge:weread:highlight:bookmark_123]\n";
    const id = parseDedupMarker(text);
    expect(id).toBe("bookmark_123");
  });

  it("should return null for text without marker", () => {
    expect(parseDedupMarker("just some text")).toBeNull();
  });
});
