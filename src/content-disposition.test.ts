import { describe, it, expect } from "vitest";
import { extractFilename, sanitizeFilename } from "./inbound.js";

/**
 * Tests for issue #225 fixes:
 * - extractFilename decoding
 * - channel.ts filename decoding
 *
 * Note: Content-Disposition is now built server-side by the presigned route
 * (BuildContentDisposition) and replayed verbatim by the adapter; the old
 * adapter-side rfc5987Encode / buildContentDisposition / uploadFileToCOS
 * helpers were removed with the COS SDK. See api-fetch.test.ts for the
 * presigned PUT replay coverage.
 */

// ---------------------------------------------------------------------------
// sanitizeFilename + extractFilename — path traversal defense (P1-2)
// ---------------------------------------------------------------------------
describe("sanitizeFilename — path traversal defense", () => {
  it("strips leading directory components", () => {
    expect(sanitizeFilename("foo/bar.txt")).toBe("bar.txt");
    expect(sanitizeFilename("/etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("a\\b\\c.txt")).toBe("c.txt");
  });

  it("rejects bare traversal segments", () => {
    expect(sanitizeFilename("..")).toBe("file");
    expect(sanitizeFilename(".")).toBe("file");
    expect(sanitizeFilename("")).toBe("file");
  });

  it("rejects names containing null bytes", () => {
    expect(sanitizeFilename("foo\0.txt")).toBe("file");
  });

  it("caps length at 200 chars", () => {
    const longName = "a".repeat(250) + ".txt";
    const result = sanitizeFilename(longName);
    expect(result.length).toBe(200);
  });
});

describe("extractFilename — path traversal via URL-encoded segments (P1-2)", () => {
  it("URL-encoded ..%2F..%2Fetc%2Fpasswd does NOT escape temp dir", () => {
    // Before fix: extractFilename returned "../../etc/passwd" and a caller
    // doing `path.join("/tmp/octo-upload", filename)` resolved to
    // `/etc/passwd`. After fix: basename() strips path separators.
    const result = extractFilename("https://attacker.example/path/..%2F..%2Fetc%2Fpasswd");
    expect(result).toBe("passwd");
    expect(result).not.toContain("/");
    expect(result).not.toContain("..");
  });

  it("absolute-path filename gets basenamed", () => {
    expect(extractFilename("https://x.com/%2Fetc%2Fshadow")).toBe("shadow");
  });

  it("null byte injection is rejected", () => {
    expect(extractFilename("https://x.com/foo%00.txt")).toBe("file");
  });

  it("clean unicode filenames pass through", () => {
    expect(extractFilename("https://x.com/path/%E4%B8%AD%E6%96%87.txt")).toBe("中文.txt");
  });
});

// ---------------------------------------------------------------------------
// extractFilename — percent-decoding
// ---------------------------------------------------------------------------
describe("extractFilename — percent-decoding", () => {
  // Replicate the extractFilename logic for direct unit testing
  function extractFilename(url: string): string {
    try {
      const pathname = new URL(url).pathname;
      const parts = pathname.split("/");
      const raw = parts[parts.length - 1] || "file";
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    } catch {
      return "file";
    }
  }

  it("ASCII URL returns filename unchanged", () => {
    expect(extractFilename("https://cdn.example.com/path/report.xlsx")).toBe("report.xlsx");
  });

  it("percent-encoded Chinese characters are decoded", () => {
    expect(extractFilename("https://cdn.example.com/path/%E5%AE%A1%E6%9F%A5.xlsx")).toBe("审查.xlsx");
  });

  it("percent-encoded spaces are decoded", () => {
    expect(extractFilename("https://cdn.example.com/path/my%20report.xlsx")).toBe("my report.xlsx");
  });

  it("malformed percent sequence returns raw string", () => {
    expect(extractFilename("https://cdn.example.com/path/file%GG.txt")).toBe("file%GG.txt");
  });

  it("URL with no path returns 'file'", () => {
    expect(extractFilename("https://cdn.example.com/")).toBe("file");
  });

  it("invalid URL returns 'file'", () => {
    expect(extractFilename("not-a-url")).toBe("file");
  });
});

// ---------------------------------------------------------------------------
// channel.ts filename decoding (replicated logic)
// ---------------------------------------------------------------------------
describe("channel.ts filename decoding", () => {
  const path = { basename: (p: string) => p.split("/").pop() || "" };

  function decodeFilename(mediaUrl: string): string {
    const urlPath = new URL(mediaUrl).pathname;
    const rawFilename = path.basename(urlPath) || "file";
    try {
      return decodeURIComponent(rawFilename);
    } catch {
      return rawFilename;
    }
  }

  it("decodes percent-encoded Chinese filename from URL", () => {
    expect(decodeFilename("https://cdn.example.com/uploads/%E5%AE%A1%E6%9F%A5.xlsx")).toBe("审查.xlsx");
  });

  it("keeps ASCII filename unchanged", () => {
    expect(decodeFilename("https://cdn.example.com/uploads/report.xlsx")).toBe("report.xlsx");
  });

  it("decodes spaces in filename", () => {
    expect(decodeFilename("https://cdn.example.com/uploads/my%20file.txt")).toBe("my file.txt");
  });
});
