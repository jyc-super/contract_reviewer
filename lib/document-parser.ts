/**
 * Docling 또는 fallback 파서를 래핑하는 추상 레이어.
 * DOCLING_SERVICE_URL 설정 시 해당 서비스 호출, 실패 또는 미설정 시 pdf-parse/mammoth fallback.
 */

import { extractTextByPage } from "./pipeline/steps/extract-text";

export interface ParsedPage {
  page: number;
  text: string;
}

export interface SectionHeader {
  id: string;
  page: number;
  label: "section_header";
  text: string;
}

export interface ParsedDocument {
  pages: ParsedPage[];
  sectionHeaders: SectionHeader[];
}

const DOCLING_SERVICE_URL = process.env.DOCLING_SERVICE_URL;

async function callDoclingService(file: File): Promise<ParsedDocument | null> {
  if (!DOCLING_SERVICE_URL?.trim()) return null;
  const url = DOCLING_SERVICE_URL.replace(/\/$/, "") + "/parse";
  const formData = new FormData();
  formData.append("file", file);
  try {
    const res = await fetch(url, {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const pages = Array.isArray(json?.pages)
      ? (json.pages as Array<{ page?: number; text?: string }>).map((p, i) => ({
          page: typeof p.page === "number" ? p.page : i + 1,
          text: typeof p.text === "string" ? p.text : "",
        }))
      : [];
    const sectionHeaders: SectionHeader[] = Array.isArray(json?.sectionHeaders)
      ? (json.sectionHeaders as Array<{ id?: string; page?: number; text?: string }>).map(
          (h, i) => ({
            id: typeof h.id === "string" ? h.id : `sh-${i + 1}`,
            page: typeof h.page === "number" ? h.page : 1,
            label: "section_header" as const,
            text: typeof h.text === "string" ? h.text : "",
          })
        )
      : [];
    return { pages, sectionHeaders };
  } catch {
    return null;
  }
}

export async function parseWithDocling(
  file: File
): Promise<ParsedDocument> {
  const docling = await callDoclingService(file);
  if (docling && docling.pages.length > 0) {
    return docling;
  }

  const pages = await extractTextByPage(file);
  const sectionHeaders: SectionHeader[] = [];
  return {
    pages: pages.map((p) => ({ page: p.page, text: p.text })),
    sectionHeaders,
  };
}

