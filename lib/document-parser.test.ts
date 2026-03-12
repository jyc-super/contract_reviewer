import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parsePdf, parseDocx, DocumentParseError } from "./document-parser";

const MOCK_SECTIONS = [
  {
    heading: "Contract Terms",
    level: 1,
    content: "Contract body text.",
    page_start: 1,
    page_end: 1,
    zone_hint: "contract_agreement",
  },
];

function mockFetchSuccess() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string) => {
      if (url.includes("/health")) {
        return Promise.resolve({ ok: true, json: async () => ({ docling: true, models_ready: true }) });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ sections: MOCK_SECTIONS, total_pages: 1, warnings: [] }),
      });
    })
  );
}

function mockFetchUnavailable() {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
}

function mockFetchParseFailed(status = 422) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string) => {
      if (url.includes("/health")) {
        return Promise.resolve({ ok: true, json: async () => ({ docling: true, models_ready: true }) });
      }
      return Promise.resolve({
        ok: false,
        status,
        text: async () => "Parse failed",
      });
    })
  );
}

describe("document-parser", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("parsePdf", () => {
    it("returns ParseResult with parser: 'docling' on success", async () => {
      mockFetchSuccess();
      const result = await parsePdf(Buffer.from("pdf"), "test.pdf");
      expect(result.parser).toBe("docling");
      expect(Array.isArray(result.zones)).toBe(true);
      expect(Array.isArray(result.clauses)).toBe(true);
    });

    it("throws DocumentParseError with DOCLING_UNAVAILABLE when sidecar is down", async () => {
      vi.useFakeTimers();
      mockFetchUnavailable();
      const promise = parsePdf(Buffer.from("pdf"), "test.pdf");
      const assertion = expect(promise).rejects.toMatchObject({
        name: "DocumentParseError",
        code: "DOCLING_UNAVAILABLE",
      });
      await vi.advanceTimersByTimeAsync(32_000);
      await assertion;
    });

    it("throws DocumentParseError with DOCLING_PARSE_FAILED when parse returns 422", async () => {
      mockFetchParseFailed(422);
      await expect(parsePdf(Buffer.from("pdf"), "test.pdf")).rejects.toMatchObject({
        name: "DocumentParseError",
        code: "DOCLING_PARSE_FAILED",
      });
    });

    it("error is instance of DocumentParseError", async () => {
      vi.useFakeTimers();
      mockFetchUnavailable();
      const promise = parsePdf(Buffer.from("pdf"), "test.pdf");
      const assertion = expect(promise).rejects.toBeInstanceOf(DocumentParseError);
      await vi.advanceTimersByTimeAsync(32_000);
      await assertion;
    });
  });

  describe("parseDocx", () => {
    it("returns ParseResult with parser: 'docling' on success", async () => {
      mockFetchSuccess();
      const result = await parseDocx(Buffer.from("docx"), "test.docx");
      expect(result.parser).toBe("docling");
    });

    it("throws DocumentParseError with DOCLING_UNAVAILABLE when sidecar is down", async () => {
      vi.useFakeTimers();
      mockFetchUnavailable();
      const promise = parseDocx(Buffer.from("docx"), "test.docx");
      const assertion = expect(promise).rejects.toBeInstanceOf(DocumentParseError);
      await vi.advanceTimersByTimeAsync(32_000);
      await assertion;
    });

    it("throws DocumentParseError with DOCLING_PARSE_FAILED when parse returns error", async () => {
      mockFetchParseFailed(500);
      await expect(parseDocx(Buffer.from("docx"), "test.docx")).rejects.toMatchObject({
        code: "DOCLING_PARSE_FAILED",
      });
    });
  });

  describe("DocumentParseError", () => {
    it("has correct name and code properties", () => {
      const err = new DocumentParseError("DOCLING_UNAVAILABLE", "test message");
      expect(err.name).toBe("DocumentParseError");
      expect(err.code).toBe("DOCLING_UNAVAILABLE");
      expect(err.message).toBe("test message");
      expect(err).toBeInstanceOf(Error);
    });
  });
});
