import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isDoclingAvailable, parseWithDoclingRequired, DoclingParseError } from "./docling-adapter";

const MOCK_SECTIONS = [
  {
    heading: "Contract Terms",
    level: 1,
    content: "This is the contract content.",
    page_start: 1,
    page_end: 2,
    zone_hint: "contract_agreement",
  },
];

describe("docling-adapter", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("isDoclingAvailable", () => {
    it("returns true when health endpoint returns {docling: true}", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ docling: true, models_ready: true }),
        })
      );
      expect(await isDoclingAvailable()).toBe(true);
    });

    it("returns false when fetch throws (connection refused)", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Connection refused")));
      expect(await isDoclingAvailable()).toBe(false);
    });

    it("returns false when response is not ok", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          json: async () => ({}),
        })
      );
      expect(await isDoclingAvailable()).toBe(false);
    });

    it("returns false when docling field is false", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ docling: false }),
        })
      );
      expect(await isDoclingAvailable()).toBe(false);
    });
  });

  describe("parseWithDoclingRequired", () => {
    it("throws DOCLING_UNAVAILABLE when sidecar is not available", async () => {
      vi.useFakeTimers();
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

      const buf = Buffer.from("fake pdf content");
      const promise = parseWithDoclingRequired(buf, "test.pdf");
      // Attach rejection handler before advancing timers to prevent UnhandledRejection warning.
      const assertion = expect(promise).rejects.toMatchObject({ code: "DOCLING_UNAVAILABLE" });
      await vi.advanceTimersByTimeAsync(32_000);
      await assertion;
    });

    it("throws DOCLING_PARSE_FAILED when parse returns 422", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: string) => {
          if (url.includes("/health")) {
            return Promise.resolve({ ok: true, json: async () => ({ docling: true, models_ready: true }) });
          }
          return Promise.resolve({
            ok: false,
            status: 422,
            text: async () => "Unprocessable Entity",
          });
        })
      );

      const buf = Buffer.from("fake pdf content");
      await expect(parseWithDoclingRequired(buf, "test.pdf")).rejects.toMatchObject({
        code: "DOCLING_PARSE_FAILED",
      });
    });

    it("throws DOCLING_UNAVAILABLE when parse returns 503", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: string) => {
          if (url.includes("/health")) {
            return Promise.resolve({ ok: true, json: async () => ({ docling: true, models_ready: true }) });
          }
          return Promise.resolve({
            ok: false,
            status: 503,
            text: async () => "Service Unavailable",
          });
        })
      );

      const buf = Buffer.from("fake pdf content");
      await expect(parseWithDoclingRequired(buf, "test.pdf")).rejects.toMatchObject({
        code: "DOCLING_UNAVAILABLE",
      });
    });

    it("returns parsed result with zones and clauses on success", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: string) => {
          if (url.includes("/health")) {
            return Promise.resolve({ ok: true, json: async () => ({ docling: true, models_ready: true }) });
          }
          return Promise.resolve({
            ok: true,
            json: async () => ({
              sections: MOCK_SECTIONS,
              total_pages: 2,
              warnings: [],
            }),
          });
        })
      );

      const buf = Buffer.from("fake pdf content");
      const result = await parseWithDoclingRequired(buf, "test.pdf");

      expect(result.zones.length).toBeGreaterThan(0);
      expect(result.clauses.length).toBeGreaterThan(0);
      expect(result.totalPages).toBe(2);
      expect(result.warnings).toEqual([]);
    });

    it("retries exactly 2 times on parse failure (3 total attempts)", async () => {
      let parseCallCount = 0;

      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: string) => {
          if (url.includes("/health")) {
            return Promise.resolve({ ok: true, json: async () => ({ docling: true, models_ready: true }) });
          }
          parseCallCount++;
          return Promise.resolve({
            ok: false,
            status: 422,
            text: async () => "Parse error",
          });
        })
      );

      const buf = Buffer.from("fake pdf content");
      await expect(parseWithDoclingRequired(buf, "test.pdf")).rejects.toBeInstanceOf(DoclingParseError);
      // DOCLING_PARSE_RETRIES = 2 → 1 original + 2 retries = 3 total
      expect(parseCallCount).toBe(3);
    });

    it("succeeds on second attempt after first parse fails", async () => {
      let parseCallCount = 0;

      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: string) => {
          if (url.includes("/health")) {
            return Promise.resolve({ ok: true, json: async () => ({ docling: true, models_ready: true }) });
          }
          parseCallCount++;
          if (parseCallCount === 1) {
            return Promise.resolve({ ok: false, status: 503, text: async () => "unavailable" });
          }
          return Promise.resolve({
            ok: true,
            json: async () => ({ sections: MOCK_SECTIONS, total_pages: 1, warnings: [] }),
          });
        })
      );

      const buf = Buffer.from("fake pdf content");
      const result = await parseWithDoclingRequired(buf, "test.pdf");
      expect(result.clauses.length).toBeGreaterThan(0);
      expect(parseCallCount).toBe(2);
    });

    it("Buffer→Uint8Array→Blob conversion does not corrupt data", async () => {
      const originalContent = "PDF binary content with special bytes: \x00\x01\x02\xFF";
      const buf = Buffer.from(originalContent, "binary");
      let capturedBlob: Blob | null = null;

      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: string, options?: RequestInit) => {
          if (url.includes("/health")) {
            return Promise.resolve({ ok: true, json: async () => ({ docling: true, models_ready: true }) });
          }
          const form = options?.body as FormData;
          capturedBlob = form?.get("file") as Blob;
          return Promise.resolve({
            ok: true,
            json: async () => ({ sections: MOCK_SECTIONS, total_pages: 1, warnings: [] }),
          });
        })
      );

      await parseWithDoclingRequired(buf, "test.pdf");

      expect(capturedBlob).not.toBeNull();
      expect(capturedBlob!.size).toBe(buf.length);
    });
  });
});
